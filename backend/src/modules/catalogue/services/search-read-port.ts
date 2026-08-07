/**
 * SearchReadPort (docs/28 §12) — the ONE search boundary. The HTTP layer
 * depends on this port; the PostgreSQL implementation below is the launch
 * engine (FTS + pg_trgm + taxonomy synonyms over `program_search_document`,
 * docs/23 §10.5 Tier 1), and a future dedicated engine is a later adapter
 * behind the same contract, never a rewrite. No other module may implement
 * search matching.
 *
 * Matching (English launch): a candidate matches when the weighted
 * search_vector matches `websearch_to_tsquery('english', q)` OR the title /
 * provider display name is trigram-similar (`%`, typo tolerance) OR the
 * normalized query exactly names an active activity type's label or one of
 * its `synonyms_en` (query-build synonym expansion).
 *
 * Ranking (deterministic, docs/28 §11 — text rank + exact/synonym boosts +
 * published-recency tiebreak; nothing popularity/rating/personalization
 * based exists):
 *   score = ts_rank(search_vector, tsquery)          — weights A>B>C>D
 *         + 2.0 iff lower(title) = normalized query  — exact-title boost
 *         + 1.0 iff the listing's activity type was synonym/label-matched
 *         + 0.5 × greatest(similarity(title, q), similarity(display, q))
 *   ORDER BY score DESC, published_at DESC, program_id ASC.
 * An empty query browses the eligible catalogue (score 0 ⇒ published
 * recency, id tiebreak). `price` sorts by the §14 derived value (free ⇒ 0,
 * else min active option; listings with no active option last); `newest`
 * sorts by published recency.
 *
 * Visibility: every query requires `psd.active` AND membership in the live
 * `visibleProgramIds` predicate, and hydration re-reads through the same
 * predicate — a stale document can never surface an ineligible listing.
 *
 * Pagination: opaque keyset cursor carrying the sort mode and the full
 * ordering key of the last row (score/published/id · price/id ·
 * published/id), so relevance pagination never duplicates or drops rows on
 * stable data. Malformed/forged cursors are a typed `invalidCursor`.
 */
import { sql, type RawBuilder } from 'kysely';

import type { Db } from '../../../db/kysely';
import { withTransaction } from '../../../db/transaction';
import {
  loadPublicSearchResultsInTrx,
  visibleProgramIds,
  type PublicSearchResult,
} from './public-catalogue-read';

export const SEARCH_SORTS = ['recommended', 'price', 'newest'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** Formats mirror the mock ProgramFormatFilter over real price kinds. */
export const SEARCH_FORMATS = ['dropIn', 'monthly', 'term', 'package', 'camp'] as const;
export type SearchFormat = (typeof SEARCH_FORMATS)[number];

export type SearchPriceBand = 'under-100' | '100-500' | 'over-500';

/**
 * The §11 filter vocabulary — ONLY dimensions the current domain truthfully
 * supports. Schedule/date/time, availability, rating, popularity, and
 * proximity filters stay reserved with their owning later slices.
 */
export interface SearchFilters {
  ladiesOnly?: boolean;
  audience?: 'adults' | 'children';
  ageMin?: number;
  ageMax?: number;
  areaId?: string;
  categoryId?: string;
  activityTypeId?: string;
  formats?: SearchFormat[];
  setting?: 'indoor' | 'outdoor';
  priceBand?: SearchPriceBand;
  free?: boolean;
  trial?: boolean;
  skillLevel?: 'beginner' | 'intermediate' | 'advanced';
  /** Editorial collection whose preset resolves server-side (docs/28 §11). */
  collectionId?: string;
}

export interface SearchQueryInput {
  q?: string;
  sort?: SearchSort;
  filters?: SearchFilters;
  limit?: number;
  cursor?: string;
}

export type SearchOutcome =
  | { kind: 'results'; results: PublicSearchResult[]; nextCursor: string | null }
  | { kind: 'invalidCursor' }
  | { kind: 'collectionNotFound' };

export interface SearchReadPort {
  search(input: SearchQueryInput): Promise<SearchOutcome>;
}

// -- opaque relevance cursor --------------------------------------------------

const CURSOR_VERSION = 'psc1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

type CursorKeys = (string | number | null)[];

function encodeSearchCursor(sort: SearchSort, keys: CursorKeys): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, s: sort, k: keys }), 'utf8').toString(
    'base64url',
  );
}

/** Strictly validates shape, sort binding, and key types — anything else is
 *  a typed invalidCursor, never an error leak. */
function decodeSearchCursor(cursor: string, sort: SearchSort): CursorKeys | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { v, s, k } = parsed as { v?: unknown; s?: unknown; k?: unknown };
  if (v !== CURSOR_VERSION || s !== sort || !Array.isArray(k)) return undefined;
  const keys = k as CursorKeys;
  const isUuid = (value: unknown): value is string =>
    typeof value === 'string' && UUID_PATTERN.test(value);
  const isTimestamp = (value: unknown): value is string =>
    typeof value === 'string' && TIMESTAMP_PATTERN.test(value);
  switch (sort) {
    case 'recommended':
      if (keys.length !== 3) return undefined;
      if (typeof keys[0] !== 'number' || !Number.isFinite(keys[0])) return undefined;
      if (!isTimestamp(keys[1]) || !isUuid(keys[2])) return undefined;
      return keys;
    case 'newest':
      if (keys.length !== 2 || !isTimestamp(keys[0]) || !isUuid(keys[1])) return undefined;
      return keys;
    case 'price':
      if (keys.length !== 2 || !isUuid(keys[1])) return undefined;
      if (keys[0] !== null && !(typeof keys[0] === 'string' && /^\d{1,15}$/.test(keys[0]))) {
        return undefined;
      }
      return keys;
  }
}

/** Canonical query normalization: trim, collapse whitespace, lowercase.
 *  Empty results in browse mode; length bounds are enforced at the HTTP
 *  schema. Input is always parameterized — no client search syntax. */
export function normalizeSearchQuery(q: string | undefined): string | undefined {
  const normalized = (q ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

interface RankedRow {
  id: string;
  score: number;
  published_key: string;
  price_key: string | null;
}

const DEFAULT_PAGE_SIZE = 20;

export class PostgresSearchReadPort implements SearchReadPort {
  constructor(private readonly deps: { db: Db }) {}

  async search(input: SearchQueryInput): Promise<SearchOutcome> {
    const sort: SearchSort = input.sort ?? 'recommended';
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), 50);
    const qNorm = normalizeSearchQuery(input.q);

    let cursorKeys: CursorKeys | undefined;
    if (input.cursor !== undefined) {
      cursorKeys = decodeSearchCursor(input.cursor, sort);
      if (cursorKeys === undefined) return { kind: 'invalidCursor' };
    }

    return withTransaction(this.deps.db, async (trx) => {
      const filters = { ...(input.filters ?? {}) };

      // Server-side collection resolution (docs/28 §11; D-S4-3): presets are
      // DB-managed data. Only truthfully-supported presets resolve —
      // available_today / after_school / offers stay inert until their
      // authoritative data exists (the 0007 comments record this posture).
      if (filters.collectionId !== undefined) {
        const collection = await trx
          .selectFrom('collection')
          .select([
            'preset_ladies_only',
            'preset_child_relevant',
            'preset_camps',
            'preset_indoor',
          ])
          .where('id', '=', filters.collectionId)
          .where('state', '=', 'published')
          .executeTakeFirst();
        if (collection === undefined) return { kind: 'collectionNotFound' as const };
        if (collection.preset_ladies_only) filters.ladiesOnly = filters.ladiesOnly ?? true;
        if (collection.preset_child_relevant && filters.audience === undefined) {
          filters.audience = 'children';
        }
        if (collection.preset_camps && filters.formats === undefined) {
          filters.formats = ['camp'];
        }
        if (collection.preset_indoor && filters.setting === undefined) {
          filters.setting = 'indoor';
        }
      }

      // Query-build synonym expansion (docs/28 §12): the normalized query
      // matched against active activity-type labels/synonyms.
      let synonymTypeIds: string[] = [];
      if (qNorm !== undefined) {
        const matched = await sql<{ id: string }>`
          SELECT id FROM activity_type
          WHERE active AND (
            lower(label_en) = ${qNorm}
            OR EXISTS (SELECT 1 FROM unnest(synonyms_en) syn WHERE lower(syn) = ${qNorm})
          )`.execute(trx);
        synonymTypeIds = matched.rows.map((row) => row.id);
      }

      const tsquery = sql`websearch_to_tsquery('english', ${qNorm ?? ''})`;
      const scoreExpr: RawBuilder<unknown> =
        qNorm === undefined
          ? sql`0.0::float8`
          : sql`(
              ts_rank(psd.search_vector, ${tsquery})::float8
              + CASE WHEN lower(psd.title_en) = ${qNorm} THEN 2.0::float8 ELSE 0.0::float8 END
              + CASE WHEN psd.activity_type_id = ANY(${synonymTypeIds}::uuid[])
                     THEN 1.0::float8 ELSE 0.0::float8 END
              + 0.5::float8 * GREATEST(similarity(psd.title_en, ${qNorm}),
                                       similarity(psd.display_name, ${qNorm}))::float8
            )`;
      // §14 derived price value: free ⇒ 0, else min active paid option.
      const priceExpr = sql`(CASE WHEN 'free' = ANY(psd.price_kinds)
                                  THEN 0::bigint ELSE psd.min_price_fils END)`;

      const conditions: RawBuilder<unknown>[] = [
        sql`psd.active`,
        // The live §6 predicate — the projection is never trusted alone.
        sql`psd.program_id IN (${visibleProgramIds(trx)})`,
      ];
      if (qNorm !== undefined) {
        conditions.push(
          sql`(psd.search_vector @@ ${tsquery}
               OR psd.title_en % ${qNorm}
               OR psd.display_name % ${qNorm}
               OR psd.activity_type_id = ANY(${synonymTypeIds}::uuid[]))`,
        );
      }
      if (filters.ladiesOnly === true) {
        conditions.push(sql`psd.gender_eligibility = 'women'`);
      }
      if (filters.audience === 'adults') {
        conditions.push(sql`(psd.all_ages OR psd.max_age IS NULL OR psd.max_age >= 18)`);
      }
      if (filters.audience === 'children') {
        conditions.push(sql`(psd.all_ages OR (psd.max_age IS NOT NULL AND psd.max_age <= 17))`);
      }
      if (filters.ageMin !== undefined || filters.ageMax !== undefined) {
        const bandMin = filters.ageMin ?? 0;
        const bandMax = filters.ageMax ?? 1000;
        conditions.push(
          sql`(psd.all_ages OR (COALESCE(psd.min_age, 0) <= ${bandMax}
               AND COALESCE(psd.max_age, 1000) >= ${bandMin}))`,
        );
      }
      if (filters.areaId !== undefined) {
        conditions.push(sql`${filters.areaId}::uuid = ANY(psd.area_ids)`);
      }
      if (filters.categoryId !== undefined) {
        conditions.push(sql`psd.category_id = ${filters.categoryId}::uuid`);
      }
      if (filters.activityTypeId !== undefined) {
        conditions.push(sql`psd.activity_type_id = ${filters.activityTypeId}::uuid`);
      }
      if (filters.formats !== undefined && filters.formats.length > 0) {
        conditions.push(sql`psd.price_kinds && ${filters.formats}::text[]`);
      }
      if (filters.setting !== undefined) {
        conditions.push(sql`psd.setting = ${filters.setting}`);
      }
      if (filters.free === true) {
        conditions.push(sql`'free' = ANY(psd.price_kinds)`);
      }
      if (filters.trial === true) {
        // LIVE evaluation, not the projected has_trial boolean: an offer's
        // effective window opens/closes by pure time passage, which emits
        // no mutation event — the projected flag is refresh-time metadata
        // and would go stale at every window boundary. Same live-truth
        // discipline as the visibility predicate (docs/28 §13c).
        conditions.push(
          sql`EXISTS (
            SELECT 1 FROM offer f
            WHERE f.program_id = psd.program_id
              AND f.state = 'active'
              AND f.kind IN ('freeTrial', 'paidTrial')
              AND (f.effective_start IS NULL OR f.effective_start <= now())
              AND (f.effective_end IS NULL OR f.effective_end > now())
          )`,
        );
      }
      if (filters.skillLevel !== undefined) {
        conditions.push(
          sql`(psd.skill_level = ${filters.skillLevel} OR psd.skill_level = 'all-levels')`,
        );
      }
      if (filters.priceBand === 'under-100') {
        conditions.push(sql`${priceExpr} < 10000`);
      } else if (filters.priceBand === '100-500') {
        conditions.push(sql`${priceExpr} BETWEEN 10000 AND 50000`);
      } else if (filters.priceBand === 'over-500') {
        conditions.push(sql`${priceExpr} > 50000`);
      }

      // Keyset continuation for the deterministic order of each sort.
      if (cursorKeys !== undefined) {
        if (sort === 'recommended') {
          const [score, published, id] = cursorKeys as [number, string, string];
          conditions.push(
            sql`((${scoreExpr}) < ${score}::float8
                 OR ((${scoreExpr}) = ${score}::float8
                     AND (psd.published_at < ${published}::timestamptz
                          OR (psd.published_at = ${published}::timestamptz
                              AND psd.program_id > ${id}::uuid))))`,
          );
        } else if (sort === 'newest') {
          const [published, id] = cursorKeys as [string, string];
          conditions.push(
            sql`(psd.published_at < ${published}::timestamptz
                 OR (psd.published_at = ${published}::timestamptz
                     AND psd.program_id > ${id}::uuid))`,
          );
        } else {
          const [priceKey, id] = cursorKeys as [string | null, string];
          conditions.push(
            priceKey === null
              ? sql`((${priceExpr}) IS NULL AND psd.program_id > ${id}::uuid)`
              : sql`((${priceExpr}) > ${priceKey}::bigint
                     OR ((${priceExpr}) = ${priceKey}::bigint AND psd.program_id > ${id}::uuid)
                     OR (${priceExpr}) IS NULL)`,
          );
        }
      }

      const orderExpr: RawBuilder<unknown> =
        sort === 'recommended'
          ? sql`score DESC, psd.published_at DESC, psd.program_id ASC`
          : sort === 'newest'
            ? sql`psd.published_at DESC, psd.program_id ASC`
            : sql`(${priceExpr}) ASC NULLS LAST, psd.program_id ASC`;

      const ranked = await sql<RankedRow>`
        SELECT psd.program_id AS id,
               (${scoreExpr}) AS score,
               psd.published_at::text AS published_key,
               (${priceExpr})::text AS price_key
        FROM program_search_document psd
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY ${orderExpr}
        LIMIT ${limit + 1}`.execute(trx);

      const page = ranked.rows.slice(0, limit);
      const results = await loadPublicSearchResultsInTrx(
        trx,
        page.map((row) => row.id),
      );

      let nextCursor: string | null = null;
      if (ranked.rows.length > limit && page.length > 0) {
        const last = page[page.length - 1]!;
        const keys: CursorKeys =
          sort === 'recommended'
            ? [Number(last.score), last.published_key, last.id]
            : sort === 'newest'
              ? [last.published_key, last.id]
              : [last.price_key, last.id];
        nextCursor = encodeSearchCursor(sort, keys);
      }

      return { kind: 'results' as const, results, nextCursor };
    });
  }
}
