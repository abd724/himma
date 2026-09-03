/**
 * W6-2 — the search-projection consumer under the outbox dispatcher on real
 * PostgreSQL (docs/37 §11; docs/28 §13): organization-scope events converge
 * `program_search_document` from LIVE catalogue truth; duplicates and
 * out-of-order deliveries are harmless; ineligible organizations drop out
 * of public discovery; other organizations' rows are untouched; two
 * dispatchers may drain the same queue concurrently.
 */
import { sql } from 'kysely';

import { withTransaction } from '../src/db/transaction';
import { appendOutboxEvent } from '../src/outbox/outbox';
import { dispatchOutboxBatch } from '../src/worker/outbox-dispatcher';
import { createSearchProjectionHandler } from '../src/worker/search-projection-handler';
import {
  createBookingFixture,
  publishProgram,
  type BookingFixture,
} from './helpers/booking-fixtures';
import { createRacePool } from './helpers/race-harness';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

let testDb: TestDb;
const handlers = [createSearchProjectionHandler()];

/** A live organization with a PUBLISHED program on an active branch — search-eligible. */
async function eligibleOrg(): Promise<BookingFixture> {
  const f = await createBookingFixture(testDb.db);
  await sql`UPDATE organization_public_profile SET published = true WHERE organization_id = ${f.org.orgId}`.execute(testDb.db);
  await sql`INSERT INTO program_branch (program_id, branch_id, organization_id, active)
            VALUES (${f.programId}, ${f.org.branchIds[0]}, ${f.org.orgId}, true)
            ON CONFLICT DO NOTHING`.execute(testDb.db);
  await publishProgram(f);
  return f;
}

async function emitOrgEvent(orgId: string, eventType = 'organization.profile_updated'): Promise<string> {
  return withTransaction(testDb.db, async (trx) => {
    const appended = await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: orgId,
      eventType,
      payload: { organizationId: orgId },
    });
    return appended.id;
  });
}

async function doc(programId: string): Promise<{ active: boolean; display_name: string } | undefined> {
  const rows = await sql<{ active: boolean; display_name: string }>`
    SELECT active, display_name FROM program_search_document WHERE program_id = ${programId}
  `.execute(testDb.db);
  return rows.rows[0];
}

const drain = () => dispatchOutboxBatch(testDb.db, handlers, { batchSize: 100, maxAttempts: 3 });

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

describe('organization-scope convergence through the worker', () => {
  it('a publication becomes discoverable through the relay with no manual step; replays are no-ops', async () => {
    const f = await eligibleOrg();
    expect(await doc(f.programId)).toBeUndefined();
    await emitOrgEvent(f.org.orgId, 'organization.profile_published');
    const first = await drain();
    expect(first.delivered).toBeGreaterThanOrEqual(1);
    expect(await doc(f.programId)).toMatchObject({ active: true });
    // Duplicate delivery: identical outcome, no churn.
    const replay = await drain();
    expect(replay.claimed).toBe(0);
    expect(await doc(f.programId)).toMatchObject({ active: true });
  });

  it('display-name changes, stale/out-of-order events, and ineligibility all converge on LIVE truth; other orgs untouched', async () => {
    const a = await eligibleOrg();
    const b = await eligibleOrg();
    await emitOrgEvent(a.org.orgId);
    await emitOrgEvent(b.org.orgId);
    await drain();
    const bBefore = await doc(b.programId);
    expect(bBefore?.active).toBe(true);

    // Two events for A are appended BEFORE the rename lands; the handler
    // recomputes from live truth at delivery time, so both converge on the
    // NEW name — order and payload age are irrelevant.
    await emitOrgEvent(a.org.orgId);
    await emitOrgEvent(a.org.orgId);
    await sql`UPDATE organization_public_profile SET display_name = 'Renamed Provider W6'
              WHERE organization_id = ${a.org.orgId}`.execute(testDb.db);
    await drain();
    expect(await doc(a.programId)).toMatchObject({ active: true, display_name: 'Renamed Provider W6' });
    expect(await doc(b.programId)).toEqual(bBefore);

    // Suspension makes A ineligible → its document deactivates; B stays.
    await sql`UPDATE organization SET verification_state = 'suspended', suspended_at = now()
              WHERE id = ${a.org.orgId}`.execute(testDb.db);
    await emitOrgEvent(a.org.orgId, 'organization.suspended');
    await drain();
    expect(await doc(a.programId)).toMatchObject({ active: false });
    expect(await doc(b.programId)).toEqual(bBefore);

    // Reinstatement converges back — and a late-arriving STALE 'suspended'
    // event cannot re-deactivate the reinstated organization.
    await sql`UPDATE organization SET verification_state = 'live', suspended_at = NULL
              WHERE id = ${a.org.orgId}`.execute(testDb.db);
    await emitOrgEvent(a.org.orgId, 'organization.suspended');
    await emitOrgEvent(a.org.orgId, 'organization.reinstated');
    await drain();
    expect(await doc(a.programId)).toMatchObject({ active: true });
  });

  it('two dispatchers drain the same organization backlog concurrently without corrupting the projection', async () => {
    const f = await eligibleOrg();
    for (let i = 0; i < 30; i += 1) await emitOrgEvent(f.org.orgId);
    const poolA = await createRacePool(testDb.config, 3);
    const poolB = await createRacePool(testDb.config, 3);
    try {
      const run = async (db: typeof poolA.db) => {
        let claimed = 0;
        for (let pass = 0; pass < 20; pass += 1) {
          const summary = await dispatchOutboxBatch(db, handlers, { batchSize: 5, maxAttempts: 3 });
          claimed += summary.claimed;
          if (summary.claimed === 0) break;
        }
        return claimed;
      };
      const [a, b] = await Promise.all([run(poolA.db), run(poolB.db)]);
      // ≥ 30: the fixture's own program events ride the same queue (unhandled → published).
      expect(a + b).toBeGreaterThanOrEqual(30);
    } finally {
      await poolA.destroy();
      await poolB.destroy();
    }
    expect(await doc(f.programId)).toMatchObject({ active: true });
    const inbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM inbox_event WHERE consumer = 'search-projection'
        AND event_id IN (SELECT id FROM outbox_event WHERE aggregate_id = ${f.org.orgId})
    `.execute(testDb.db);
    expect(Number(inbox.rows[0]?.n)).toBe(30);
    const documents = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program_search_document WHERE organization_id = ${f.org.orgId}
    `.execute(testDb.db);
    expect(Number(documents.rows[0]?.n)).toBe(1);
  });
});
