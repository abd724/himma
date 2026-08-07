/**
 * Search projection maintenance (docs/28 §9.11/§13) — Slice-4 search
 * foundation.
 *
 * `program_search_document` is DERIVED state: every refresh recomputes a
 * document entirely from the authoritative catalogue tables inside the
 * caller's transaction, so refreshes are idempotent, replay-safe, and
 * immune to stale/out-of-order triggers — an old event can never resurrect
 * old content because event payloads are never applied, only current truth.
 * A program that is publicly eligible (the docs/28 §6 predicate) gets an
 * ACTIVE document; an ineligible program's document is DEACTIVATED (never
 * deleted — the platform's no-DELETE posture). Nothing here ever writes a
 * source-of-record row.
 *
 * Maintenance paths (docs/28 §13):
 *  (a) SAME-TRANSACTION — catalogue services call the refresh helpers for
 *      publish/pause/archive, content edits, branch associations, offers,
 *      sensitive-revision application, and taxonomy label/synonym changes;
 *  (b) EVENT-DRIVEN — organization-side changes (lifecycle transitions,
 *      storefront publish/unpublish, display-name edits, branch changes)
 *      ride the existing outbox: `processSearchProjectionEvents` consumes
 *      `organization.*` events through the inbox-deduplicated
 *      'search-projection' consumer. Until an event is consumed the live
 *      §6 predicate at query time keeps stale documents invisible;
 *  (c) FULL REBUILD — `rebuildAllSearchDocuments` is the idempotent
 *      reconciliation job (`rebuilt_at` watermark).
 */
import { sql } from 'kysely';

import type { Db } from '../../../db/kysely';
import { withTransaction, type Trx } from '../../../db/transaction';
import { markInboxProcessed } from '../../../outbox/outbox';

export const SEARCH_PROJECTION_CONSUMER = 'search-projection';

/**
 * Recompute the documents for a set of programs from live truth: eligible
 * programs are upserted ACTIVE with fully rebuilt content; programs that
 * are no longer eligible have any existing document deactivated. The §6
 * eligibility conditions here are the same predicate the read side joins —
 * the projection only ever narrows what search scans, never authorizes.
 */
export async function refreshProgramSearchDocumentsInTrx(
  trx: Trx,
  programIds: string[],
): Promise<void> {
  if (programIds.length === 0) return;

  await sql`
    INSERT INTO program_search_document
      (program_id, organization_id, active, title_en, display_name, search_vector,
       category_id, activity_type_id, area_ids, branch_ids, min_age, max_age, all_ages,
       gender_eligibility, skill_level, setting, price_kinds, min_price_fils, has_trial,
       published_at, rebuilt_at)
    SELECT p.id, p.organization_id, true, p.title_en, opp.display_name,
      -- English launch weighting (docs/28 §12): title A · type label +
      -- synonyms B · category label C · storefront display name D.
      setweight(to_tsvector('english', p.title_en), 'A')
        || setweight(to_tsvector('english',
             aty.label_en || ' ' || array_to_string(aty.synonyms_en, ' ')), 'B')
        || setweight(to_tsvector('english', cat.label_en), 'C')
        || setweight(to_tsvector('english', opp.display_name), 'D'),
      cat.id, aty.id,
      COALESCE(br.area_ids, '{}'), COALESCE(br.branch_ids, '{}'),
      p.min_age, p.max_age, p.all_ages, p.gender_eligibility, p.skill_level, p.setting,
      COALESCE(opt.kinds, '{}'), opt.min_paid, COALESCE(tr.has_trial, false),
      p.published_at, now()
    FROM program p
    JOIN organization org ON org.id = p.organization_id
    JOIN organization_public_profile opp ON opp.organization_id = p.organization_id
    JOIN activity_type aty ON aty.id = p.activity_type_id
    JOIN category cat ON cat.id = aty.category_id
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT b2.area_id) FILTER (WHERE b2.area_id IS NOT NULL) AS area_ids,
             array_agg(pb.branch_id) AS branch_ids
      FROM program_branch pb
      JOIN branch b2 ON b2.id = pb.branch_id
      WHERE pb.program_id = p.id AND pb.active AND b2.active
    ) br ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT o.kind) AS kinds, min(o.amount_fils) AS min_paid
      FROM program_price_option o
      WHERE o.program_id = p.id AND o.state = 'active'
    ) opt ON true
    LEFT JOIN LATERAL (
      SELECT true AS has_trial
      FROM offer f
      WHERE f.program_id = p.id AND f.state = 'active'
        AND f.kind IN ('freeTrial', 'paidTrial')
        AND (f.effective_start IS NULL OR f.effective_start <= now())
        AND (f.effective_end IS NULL OR f.effective_end > now())
      LIMIT 1
    ) tr ON true
    WHERE p.id = ANY(${programIds}::uuid[])
      AND p.listing_state = 'published'
      AND org.verification_state = 'live'
      AND opp.published = true
      AND br.branch_ids IS NOT NULL
    ON CONFLICT (program_id) DO UPDATE SET
      active = EXCLUDED.active,
      title_en = EXCLUDED.title_en,
      display_name = EXCLUDED.display_name,
      search_vector = EXCLUDED.search_vector,
      category_id = EXCLUDED.category_id,
      activity_type_id = EXCLUDED.activity_type_id,
      area_ids = EXCLUDED.area_ids,
      branch_ids = EXCLUDED.branch_ids,
      min_age = EXCLUDED.min_age,
      max_age = EXCLUDED.max_age,
      all_ages = EXCLUDED.all_ages,
      gender_eligibility = EXCLUDED.gender_eligibility,
      skill_level = EXCLUDED.skill_level,
      setting = EXCLUDED.setting,
      price_kinds = EXCLUDED.price_kinds,
      min_price_fils = EXCLUDED.min_price_fils,
      has_trial = EXCLUDED.has_trial,
      published_at = EXCLUDED.published_at,
      rebuilt_at = now()`.execute(trx);

  await sql`
    UPDATE program_search_document psd
    SET active = false, rebuilt_at = now()
    WHERE psd.program_id = ANY(${programIds}::uuid[])
      AND psd.active = true
      AND NOT EXISTS (
        SELECT 1
        FROM program p
        JOIN organization org ON org.id = p.organization_id
        JOIN organization_public_profile opp ON opp.organization_id = p.organization_id
        WHERE p.id = psd.program_id
          AND p.listing_state = 'published'
          AND org.verification_state = 'live'
          AND opp.published = true
          AND EXISTS (
            SELECT 1 FROM program_branch pb
            JOIN branch b2 ON b2.id = pb.branch_id
            WHERE pb.program_id = p.id AND pb.active AND b2.active
          )
      )`.execute(trx);
}

async function idsForOrganization(trx: Trx, organizationId: string): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM program WHERE organization_id = ${organizationId} AND listing_state = 'published'
    UNION
    SELECT program_id FROM program_search_document WHERE organization_id = ${organizationId}`.execute(
    trx,
  );
  return rows.rows.map((row) => row.id);
}

/** Organization-scope refresh: display-name, storefront, lifecycle, and
 *  branch changes touch every document of the organization. */
export async function refreshOrganizationSearchDocumentsInTrx(
  trx: Trx,
  organizationId: string,
): Promise<void> {
  await refreshProgramSearchDocumentsInTrx(trx, await idsForOrganization(trx, organizationId));
}

/** Taxonomy label/synonym maintenance (docs/28 §13a) — every document of
 *  the changed activity type rebuilds its vector in the same transaction. */
export async function refreshActivityTypeSearchDocumentsInTrx(
  trx: Trx,
  activityTypeId: string,
): Promise<void> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM program WHERE activity_type_id = ${activityTypeId} AND listing_state = 'published'
    UNION
    SELECT program_id FROM program_search_document WHERE activity_type_id = ${activityTypeId}`.execute(
    trx,
  );
  await refreshProgramSearchDocumentsInTrx(trx, rows.rows.map((row) => row.id));
}

/** Category-label maintenance — refreshes every document under the
 *  category (via its activity types). */
export async function refreshCategorySearchDocumentsInTrx(
  trx: Trx,
  categoryId: string,
): Promise<void> {
  const rows = await sql<{ id: string }>`
    SELECT p.id FROM program p
    JOIN activity_type aty ON aty.id = p.activity_type_id
    WHERE aty.category_id = ${categoryId} AND p.listing_state = 'published'
    UNION
    SELECT program_id FROM program_search_document WHERE category_id = ${categoryId}`.execute(trx);
  await refreshProgramSearchDocumentsInTrx(trx, rows.rows.map((row) => row.id));
}

/**
 * Idempotent full reconciliation (docs/28 §13b): refresh every program that
 * is currently eligible or currently has a document. Safe to run at any
 * time; never mutates source-of-record rows.
 */
export async function rebuildAllSearchDocuments(deps: { db: Db }): Promise<{ refreshed: number }> {
  return withTransaction(deps.db, async (trx) => {
    const rows = await sql<{ id: string }>`
      SELECT id FROM program WHERE listing_state = 'published'
      UNION
      SELECT program_id FROM program_search_document`.execute(trx);
    const ids = rows.rows.map((row) => row.id);
    await refreshProgramSearchDocumentsInTrx(trx, ids);
    return { refreshed: ids.length };
  });
}

export interface ProcessSearchEventsResult {
  processed: number;
  duplicates: number;
}

/**
 * Event-driven maintenance (docs/28 §13): consume `organization.*` outbox
 * events through the inbox-deduplicated 'search-projection' consumer and
 * refresh the organization's documents from live truth. At-least-once
 * delivery yields exactly-once effects (inbox); duplicates and replays are
 * no-ops; ordering is irrelevant because refresh ignores event payloads.
 * There is no standing relay worker yet (Slice-1 deferral) — this function
 * is the callable consumer for tooling, tests, and the future relay.
 */
export async function processSearchProjectionEvents(
  deps: { db: Db },
  options: { limit?: number } = {},
): Promise<ProcessSearchEventsResult> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const pending = await deps.db
    .selectFrom('outbox_event')
    .leftJoin('inbox_event', (join) =>
      join
        .onRef('inbox_event.event_id', '=', 'outbox_event.id')
        .on('inbox_event.consumer', '=', SEARCH_PROJECTION_CONSUMER),
    )
    .select(['outbox_event.id as id', 'outbox_event.aggregate_id as aggregate_id'])
    .where('outbox_event.aggregate_type', '=', 'organization')
    .where('outbox_event.event_type', 'like', 'organization.%')
    .where('inbox_event.event_id', 'is', null)
    .orderBy('outbox_event.occurred_at')
    .orderBy('outbox_event.id')
    .limit(limit)
    .execute();

  let processed = 0;
  let duplicates = 0;
  for (const event of pending) {
    await withTransaction(deps.db, async (trx) => {
      const firstDelivery = await markInboxProcessed(trx, SEARCH_PROJECTION_CONSUMER, event.id);
      if (!firstDelivery) {
        duplicates += 1;
        return;
      }
      await refreshOrganizationSearchDocumentsInTrx(trx, event.aggregate_id);
      processed += 1;
    });
  }
  return { processed, duplicates };
}
