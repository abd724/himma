/**
 * W6-1 — the PostgreSQL rate-limit store (docs/37 §9; docs/36 IN-07):
 * atomic concurrent consumption on real PostgreSQL, multi-connection and
 * multi-pool ("two API processes") sharing, restart durability, window
 * expiry, key isolation, and fail-closed key hygiene. Thresholds are the
 * certified defaults — never weakened for the tests.
 */
import { sql } from 'kysely';

import { createDb } from '../src/db/kysely';
import { createPool } from '../src/db/pool';
import { PgRateLimiterStore, RateLimiterKeyError } from '../src/modules/identity/http/pg-rate-limiter-store';
import { createRateLimiterStore, rateLimitDigest } from '../src/modules/identity/http/rate-limiter';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let store: PgRateLimiterStore;
let counter = 0;

function freshKey(): string {
  counter += 1;
  return `test:${rateLimitDigest(`key-${counter}-${Date.now()}`)}`;
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  store = new PgRateLimiterStore(testDb.db);
});

afterAll(async () => {
  await testDb.drop();
});

describe('PgRateLimiterStore — certified consume() semantics on PostgreSQL', () => {
  it('counts within a fixed window and denies with a positive Retry-After beyond the limit', async () => {
    const key = freshKey();
    const rule = { limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i += 1) {
      const decision = await store.consume(key, rule, 1);
      expect(decision.allowed).toBe(true);
      expect(decision.retryAfterSeconds).toBe(0);
    }
    const denied = await store.consume(key, rule, 1);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('cost 0 is a peek: it never increments and reports the standing decision', async () => {
    const key = freshKey();
    const rule = { limit: 2, windowMs: 60_000 };
    expect((await store.consume(key, rule, 0)).allowed).toBe(true);
    await store.consume(key, rule, 1);
    await store.consume(key, rule, 1);
    // At the limit: a peek denies without counting.
    expect((await store.consume(key, rule, 0)).allowed).toBe(false);
    const rows = await sql<{ hits: number }>`
      SELECT hits FROM rate_limit_window WHERE limiter_key = ${key}
    `.execute(testDb.db);
    expect(Number(rows.rows[0]?.hits)).toBe(2);
  });

  it('N concurrent consumers against limit L admit exactly L (no lost increments, no over-admission)', async () => {
    const key = freshKey();
    const rule = { limit: 5, windowMs: 60_000 };
    const attempts = 24;
    const decisions = await Promise.all(
      Array.from({ length: attempts }, () => store.consume(key, rule, 1)),
    );
    const allowed = decisions.filter((d) => d.allowed).length;
    expect(allowed).toBe(5);
    const rows = await sql<{ hits: number }>`
      SELECT hits FROM rate_limit_window WHERE limiter_key = ${key}
    `.execute(testDb.db);
    expect(Number(rows.rows[0]?.hits)).toBe(attempts);
  });

  it('two separate pools (two API processes) share one limit, and a process restart never resets the window', async () => {
    const key = freshKey();
    const rule = { limit: 6, windowMs: 60_000 };
    const poolB = createPool(testDb.config);
    const dbB = createDb(poolB);
    try {
      const storeB = new PgRateLimiterStore(dbB);
      const decisions = await Promise.all([
        ...Array.from({ length: 8 }, () => store.consume(key, rule, 1)),
        ...Array.from({ length: 8 }, () => storeB.consume(key, rule, 1)),
      ]);
      expect(decisions.filter((d) => d.allowed).length).toBe(6);
      // "Restart": a brand-new store instance (fresh process state) still
      // sees the exhausted window — the security window is durable.
      const restarted = new PgRateLimiterStore(dbB);
      expect((await restarted.consume(key, rule, 1)).allowed).toBe(false);
    } finally {
      await dbB.destroy();
    }
  });

  it('an expired window admits the next window cleanly', async () => {
    const key = freshKey();
    const rule = { limit: 1, windowMs: 1_000 };
    expect((await store.consume(key, rule, 1)).allowed).toBe(true);
    expect((await store.consume(key, rule, 1)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await store.consume(key, rule, 1)).allowed).toBe(true);
  });

  it('different keys and different rule dimensions never collide', async () => {
    const keyA = freshKey();
    const keyB = freshKey();
    const rule = { limit: 1, windowMs: 60_000 };
    expect((await store.consume(keyA, rule, 1)).allowed).toBe(true);
    expect((await store.consume(keyB, rule, 1)).allowed).toBe(true);
    expect((await store.consume(keyA, rule, 1)).allowed).toBe(false);
    expect((await store.consume(keyB, rule, 1)).allowed).toBe(false);
  });

  it('malformed/oversized key material refuses BEFORE storage; sane-rule guards hold', async () => {
    const rule = { limit: 5, windowMs: 60_000 };
    await expect(store.consume('', rule, 1)).rejects.toThrow(RateLimiterKeyError);
    await expect(store.consume('has space', rule, 1)).rejects.toThrow(RateLimiterKeyError);
    await expect(store.consume('x'.repeat(129), rule, 1)).rejects.toThrow(RateLimiterKeyError);
    await expect(store.consume(freshKey(), { limit: 0, windowMs: 60_000 }, 1)).rejects.toThrow(
      RateLimiterKeyError,
    );
    await expect(store.consume(freshKey(), rule, -1)).rejects.toThrow(RateLimiterKeyError);
    const stored = await sql<{ n: string }>`
      SELECT count(*) AS n FROM rate_limit_window WHERE char_length(limiter_key) > 128 OR limiter_key ~ '\\s'
    `.execute(testDb.db);
    expect(Number(stored.rows[0]?.n)).toBe(0);
  });

  it('production composition cannot fall back to the in-memory limiter (unchanged refusal)', () => {
    expect(() => createRateLimiterStore('production')).toThrow(/refused/);
  });
});
