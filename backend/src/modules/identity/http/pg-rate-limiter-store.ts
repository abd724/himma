/**
 * W6-1 — the production `RateLimiterStore`: PostgreSQL-backed, shared
 * across every API replica, durable across restarts (docs/37 §9; docs/23
 * §10.7; docs/36 IN-07).
 *
 * Pattern: the certified S6-2 `redemption_lookup_attempt` window-upsert —
 * the window bucket is computed IN SQL from the database clock (one truth
 * for all replicas; process clocks never skew a security window), and the
 * increment is a single atomic `INSERT … ON CONFLICT … DO UPDATE`
 * (concurrent consumers serialize on the row; no lost increments).
 *
 * Semantics preserve the certified in-memory contract exactly where it is
 * security-relevant: fixed (not sliding) windows; `cost 0` is a peek
 * (`allowed = hits < limit`); `cost > 0` counts then allows while the
 * window total stays within the limit; denial returns the seconds until
 * the window resets (≥ 1). The one deliberate difference is window
 * anchoring: buckets are epoch-aligned (the cross-instance precedent)
 * rather than first-hit-anchored — the same fixed-window worst case, now
 * consistent across replicas by construction.
 *
 * Keys arrive PRE-DIGESTED (`rateLimitDigest` + a route dimension) — raw
 * emails/tokens/IPs never reach a row. Oversized/malformed key material is
 * refused BEFORE storage. Superseded window rows are inert (never read
 * again) and are cleaned by the W6-3 retention job.
 *
 * Why PostgreSQL, not Redis: docs/37 §9 — the limited surfaces are
 * auth-shaped (limits 5–20/min/key), trivially inside PostgreSQL comfort at
 * the approved tiers; no new stateful infrastructure dependency.
 */
import { sql } from 'kysely';

import type { Db } from '../../../db/kysely';
import type { RateDecision, RateLimiterStore, RateLimitRule } from './rate-limiter';

const MAX_KEY_LENGTH = 128;
/** Printable, no whitespace/control characters — digests + route prefixes. */
const KEY_PATTERN = /^[!-~]{1,128}$/;

export class RateLimiterKeyError extends Error {}

function assertSafeKey(key: string): void {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
    throw new RateLimiterKeyError(
      'rate-limit key material must be a printable digest-shaped string (1–128 chars, no whitespace); refusing before storage',
    );
  }
}

function assertSaneRule(rule: RateLimitRule): void {
  if (!Number.isInteger(rule.limit) || rule.limit < 1) {
    throw new RateLimiterKeyError('rate-limit rule limit must be a positive integer');
  }
  if (!Number.isInteger(rule.windowMs) || rule.windowMs < 1) {
    throw new RateLimiterKeyError('rate-limit rule windowMs must be a positive integer');
  }
}

interface WindowRow {
  hits: number | string;
  retry_after: number | string;
}

export class PgRateLimiterStore implements RateLimiterStore {
  constructor(private readonly db: Db) {}

  async consume(key: string, rule: RateLimitRule, cost: number): Promise<RateDecision> {
    assertSafeKey(key);
    assertSaneRule(rule);
    if (!Number.isInteger(cost) || cost < 0) {
      throw new RateLimiterKeyError('rate-limit cost must be a non-negative integer');
    }

    const windowMs = rule.windowMs;
    // Epoch-aligned bucket from the DATABASE clock — identical on every
    // replica regardless of process clock skew.
    const bucket = sql<Date>`to_timestamp(floor(extract(epoch FROM now()) * 1000 / ${windowMs}) * ${windowMs} / 1000.0)`;
    const retryAfter = sql<number>`GREATEST(1, CEIL(EXTRACT(EPOCH FROM ((${bucket} + make_interval(secs => ${windowMs} / 1000.0)) - now()))))::int`;

    if (cost === 0) {
      const peek = await sql<WindowRow>`
        SELECT hits, ${retryAfter} AS retry_after
        FROM rate_limit_window
        WHERE limiter_key = ${key} AND window_start = ${bucket}
      `.execute(this.db);
      const row = peek.rows[0];
      const hits = row === undefined ? 0 : Number(row.hits);
      const allowed = hits < rule.limit;
      return {
        allowed,
        retryAfterSeconds: allowed || row === undefined ? (allowed ? 0 : 1) : Number(row.retry_after),
      };
    }

    const result = await sql<WindowRow>`
      INSERT INTO rate_limit_window (limiter_key, window_start, hits)
      VALUES (${key}, ${bucket}, ${cost})
      ON CONFLICT (limiter_key, window_start)
      DO UPDATE SET hits = rate_limit_window.hits + EXCLUDED.hits
      RETURNING hits, ${retryAfter} AS retry_after
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('rate_limit_window upsert returned no row');
    }
    const hits = Number(row.hits);
    const allowed = hits <= rule.limit;
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Number(row.retry_after),
    };
  }
}
