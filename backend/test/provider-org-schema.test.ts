/**
 * S3-1 — Organization, OrganizationPublicProfile, and Branch schema
 * foundation (docs/27 §2–§4, §12, Amendment A1). Real PostgreSQL:
 * the §5.1 lifecycle machine DB-enforced, structural public/private
 * separation, composite branch ownership, future-listing compatibility,
 * origin/classification seams, and himma_app grants.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

async function makeOrganization(
  overrides: {
    state?: string;
    orgKind?: string;
    origin?: string;
    suspendedAt?: Date | null;
    offboardedAt?: Date | null;
  } = {},
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO organization (id, legal_name, trade_name, org_kind, origin,
                              verification_state, suspended_at, offboarded_at)
    VALUES (${id}, ${'Test Legal Entity LLC'}, ${'Test Provider'},
            ${overrides.orgKind ?? 'provider'}, ${overrides.origin ?? 'admin_created'},
            ${overrides.state ?? 'draft'}, ${overrides.suspendedAt ?? null},
            ${overrides.offboardedAt ?? null})`.execute(testDb.db);
  return id;
}

async function orgState(id: string): Promise<{ state: string; version: number }> {
  const row = await sql<{ verification_state: string; version: number }>`
    SELECT verification_state, version FROM organization WHERE id = ${id}`.execute(testDb.db);
  const first = row.rows[0];
  if (first === undefined) throw new Error('missing organization');
  return { state: first.verification_state, version: first.version };
}

async function transition(
  id: string,
  toState: string,
  extra: { suspendedAt?: Date | null; offboardedAt?: Date | null } = {},
): Promise<void> {
  await sql`
    UPDATE organization
    SET verification_state = ${toState},
        suspended_at = ${extra.suspendedAt ?? null},
        offboarded_at = ${extra.offboardedAt ?? null}
    WHERE id = ${id}`.execute(testDb.db);
}

async function makeBranch(
  organizationId: string,
  overrides: { active?: boolean; geo?: string | null } = {},
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO branch (id, organization_id, label, area_label, address_line,
                        geo_point, facilities, active)
    VALUES (${id}, ${organizationId}, ${'Main Branch'}, ${'Khalifa City'},
            ${'Street 12, Unit 3'}, ${overrides.geo ?? '(54.4,24.4)'},
            ${sql.raw(`ARRAY['Parking','Showers']::text[]`)}, ${overrides.active ?? true})`.execute(
    testDb.db,
  );
  return id;
}

describe('organization foundation', () => {
  it('creates with approved defaults: draft, provider kind, admin_created origin', async () => {
    const id = newId();
    await sql`INSERT INTO organization (id, legal_name, trade_name)
              VALUES (${id}, ${'Legal LLC'}, ${'Trade Name'})`.execute(testDb.db);
    const row = await sql<{
      verification_state: string;
      org_kind: string;
      origin: string;
      version: number;
    }>`SELECT verification_state, org_kind, origin, version
       FROM organization WHERE id = ${id}`.execute(testDb.db);
    expect(row.rows[0]).toEqual({
      verification_state: 'draft',
      org_kind: 'provider',
      origin: 'admin_created',
      version: 1,
    });
  });

  it('rejects invalid lifecycle values, kinds, and origins (seams are constrained, widening stays additive)', async () => {
    await expect(makeOrganization({ state: 'imaginary' })).rejects.toThrow();
    // D-S3-4: only 'provider' exists today; 'partner' arrives by CHECK widening.
    await expect(makeOrganization({ orgKind: 'partner' })).rejects.toThrow();
    // D-S3-2: only 'admin_created' exists today; self-signup widens later.
    await expect(makeOrganization({ origin: 'self_signup' })).rejects.toThrow();
  });

  it('walks every approved §5.1 edge including rejection/resubmission and reinstatement', async () => {
    const id = await makeOrganization();
    await transition(id, 'submitted');
    await transition(id, 'in_review');
    await transition(id, 'rejected');
    await transition(id, 'submitted');
    await transition(id, 'in_review');
    await transition(id, 'verified');
    await transition(id, 'live');
    await transition(id, 'suspended', { suspendedAt: new Date() });
    await transition(id, 'live');
    await transition(id, 'suspended', { suspendedAt: new Date() });
    await transition(id, 'offboarded', { offboardedAt: new Date() });
    expect((await orgState(id)).state).toBe('offboarded');
  });

  it('refuses invalid transition skips at the database layer', async () => {
    const draft = await makeOrganization();
    await expect(transition(draft, 'live')).rejects.toThrow();
    await expect(transition(draft, 'in_review')).rejects.toThrow();
    await expect(transition(draft, 'verified')).rejects.toThrow();

    const submitted = await makeOrganization({ state: 'submitted' });
    await expect(transition(submitted, 'verified')).rejects.toThrow();
    await expect(transition(submitted, 'live')).rejects.toThrow();

    const verified = await makeOrganization({ state: 'verified' });
    await expect(transition(verified, 'suspended', { suspendedAt: new Date() })).rejects.toThrow();
    const live = await makeOrganization({ state: 'live' });
    await expect(transition(live, 'verified')).rejects.toThrow();
    await expect(transition(live, 'draft')).rejects.toThrow();
  });

  it('ties suspension/offboarding timestamps to their states', async () => {
    // suspended requires suspended_at; live must clear it.
    const live = await makeOrganization({ state: 'live' });
    await expect(transition(live, 'suspended')).rejects.toThrow();
    await transition(live, 'suspended', { suspendedAt: new Date() });
    // Reinstating clears the suspension timestamp (CHECK enforces).
    await transition(live, 'live');
    const cleared = await sql<{ suspended_at: Date | null }>`
      SELECT suspended_at FROM organization WHERE id = ${live}`.execute(testDb.db);
    expect(cleared.rows[0]?.suspended_at).toBeNull();
    // offboarded requires offboarded_at.
    const live2 = await makeOrganization({ state: 'live' });
    await expect(transition(live2, 'offboarded')).rejects.toThrow();
  });

  it('offboarded is terminal: no further state change or edit of any kind', async () => {
    const id = await makeOrganization({ state: 'live' });
    await transition(id, 'offboarded', { offboardedAt: new Date() });
    await expect(transition(id, 'live')).rejects.toThrow();
    await expect(
      sql`UPDATE organization SET trade_name = 'Renamed' WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow();
  });

  it('optimistic versioning bumps on update and CAS admits one winner', async () => {
    const id = await makeOrganization();
    expect((await orgState(id)).version).toBe(1);
    const first = await sql`
      UPDATE organization SET trade_name = 'A' WHERE id = ${id} AND version = 1`.execute(
      testDb.db,
    );
    const second = await sql`
      UPDATE organization SET trade_name = 'B' WHERE id = ${id} AND version = 1`.execute(
      testDb.db,
    );
    expect(Number(first.numAffectedRows)).toBe(1);
    expect(Number(second.numAffectedRows)).toBe(0);
    expect((await orgState(id)).version).toBe(2);
  });

  it('identity/provenance columns are immutable', async () => {
    const id = await makeOrganization();
    await expect(
      sql`UPDATE organization SET origin = 'admin_created', org_kind = 'provider',
          created_at = now() WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow();
  });
});

describe('organization public profile (storefront record)', () => {
  async function makeProfile(
    organizationId: string,
    published = false,
  ): Promise<void> {
    await sql`
      INSERT INTO organization_public_profile (organization_id, display_name, published)
      VALUES (${organizationId}, ${'Test Provider'}, ${published})`.execute(testDb.db);
  }

  it('admits exactly one profile per organization and refuses orphans', async () => {
    const org = await makeOrganization();
    await makeProfile(org);
    await expect(makeProfile(org)).rejects.toThrow();
    await expect(makeProfile(newId())).rejects.toThrow();
  });

  it('may exist and be marked published BEFORE go-live — but the effective public predicate stays false until live AND published', async () => {
    const org = await makeOrganization();
    await makeProfile(org, true);
    // The A1 visibility rule the future read model applies:
    const visible = await sql<{ n: string }>`
      SELECT count(*) AS n
      FROM organization o
      JOIN organization_public_profile p ON p.organization_id = o.id
      WHERE o.id = ${org} AND o.verification_state = 'live' AND p.published = true`.execute(
      testDb.db,
    );
    expect(Number(visible.rows[0]?.n)).toBe(0);

    // Walk the org live: now (and only now) the predicate holds.
    await transition(org, 'submitted');
    await transition(org, 'in_review');
    await transition(org, 'verified');
    await transition(org, 'live');
    const nowVisible = await sql<{ n: string }>`
      SELECT count(*) AS n
      FROM organization o
      JOIN organization_public_profile p ON p.organization_id = o.id
      WHERE o.id = ${org} AND o.verification_state = 'live' AND p.published = true`.execute(
      testDb.db,
    );
    expect(Number(nowVisible.rows[0]?.n)).toBe(1);

    // Suspension removes effective visibility regardless of the flag.
    await transition(org, 'suspended', { suspendedAt: new Date() });
    const suspended = await sql<{ n: string }>`
      SELECT count(*) AS n
      FROM organization o
      JOIN organization_public_profile p ON p.organization_id = o.id
      WHERE o.id = ${org} AND o.verification_state = 'live' AND p.published = true`.execute(
      testDb.db,
    );
    expect(Number(suspended.rows[0]?.n)).toBe(0);
  });

  it('cannot be re-pointed at another organization', async () => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    await makeProfile(orgA);
    await expect(
      sql`UPDATE organization_public_profile SET organization_id = ${orgB}
          WHERE organization_id = ${orgA}`.execute(testDb.db),
    ).rejects.toThrow();
  });
});

describe('structural public/private separation', () => {
  it('the public profile and branch tables contain no private/sensitive provider fields', async () => {
    const columns = await sql<{ table_name: string; column_name: string; data_type: string }>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('organization_public_profile', 'branch')`.execute(testDb.db);
    const offenders = columns.rows.filter((r) =>
      /(bank|iban|payout|licen[cs]e|verification|note|comment|secret|token|password|credential|staff|legal|commission|internal)/i.test(
        r.column_name,
      ),
    );
    expect(offenders).toEqual([]);
    // No generic JSON blob on the PUBLIC PROFILE that could hide private
    // data (branch opening_hours jsonb is the one approved structured
    // exception, on branch only).
    const profileJson = columns.rows.filter(
      (r) =>
        r.table_name === 'organization_public_profile' &&
        (r.data_type === 'json' || r.data_type === 'jsonb'),
    );
    expect(profileJson).toEqual([]);
  });

  it('the organization table carries no bank/payout/licence-content/commission columns either', async () => {
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'organization'`.execute(testDb.db);
    const offenders = columns.rows.filter((r) =>
      /(bank|iban|payout|commission|cadence|licen[cs]e_(doc|content|payload)|password|secret|token)/i.test(
        r.column_name,
      ),
    );
    expect(offenders).toEqual([]);
    // The full approved column set — the shape is locked.
    expect(columns.rows.map((r) => r.column_name).sort()).toEqual([
      'commercial_terms_ref',
      'created_at',
      'id',
      'legal_name',
      'offboarded_at',
      'org_kind',
      'origin',
      'suspended_at',
      'trade_name',
      'updated_at',
      'verification_state',
      'version',
    ]);
  });
});

describe('branch ownership and lifecycle', () => {
  it('belongs to exactly one organization and exposes the composite ownership key', async () => {
    const org = await makeOrganization();
    const branch = await makeBranch(org);
    await expect(
      sql`INSERT INTO branch (id, organization_id, label, area_label)
          VALUES (${newId()}, ${newId()}, 'Orphan', 'Nowhere')`.execute(testDb.db),
    ).rejects.toThrow();
    // The composite key (id, organization_id) exists and matches.
    const composite = await sql<{ n: string }>`
      SELECT count(*) AS n FROM branch WHERE id = ${branch} AND organization_id = ${org}`.execute(
      testDb.db,
    );
    expect(Number(composite.rows[0]?.n)).toBe(1);
  });

  it('is immutable in ownership and survives deactivation as a row', async () => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const branch = await makeBranch(orgA);
    await expect(
      sql`UPDATE branch SET organization_id = ${orgB} WHERE id = ${branch}`.execute(testDb.db),
    ).rejects.toThrow();
    await sql`UPDATE branch SET active = false WHERE id = ${branch}`.execute(testDb.db);
    const row = await sql<{ active: boolean }>`
      SELECT active FROM branch WHERE id = ${branch}`.execute(testDb.db);
    expect(row.rows[0]?.active).toBe(false);
  });

  it('rejects out-of-range coordinates', async () => {
    const org = await makeOrganization();
    await expect(makeBranch(org, { geo: '(54.4,999)' })).rejects.toThrow();
    await expect(makeBranch(org, { geo: '(999,24.4)' })).rejects.toThrow();
    await makeBranch(org, { geo: null });
  });

  it('carries no listing/session/capacity/pricing/instructor fields', async () => {
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'branch'`.execute(testDb.db);
    const offenders = columns.rows.filter((r) =>
      /(listing|program|session|schedule|capacity|price|pricing|instructor|coach|booking|member)/i.test(
        r.column_name,
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe('future listing compatibility (structural proof — no listing schema is created by S3-1)', () => {
  it('the approved Program/Listing ownership shape attaches to the S3-1 keys without altering them', async () => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const branch = await makeBranch(org);
    const foreignBranch = await makeBranch(otherOrg);

    // Scratch probe of the docs/24 §1.4 shape — created and dropped here;
    // S3-1 ships NO listing table.
    await sql`
      CREATE TABLE listing_probe (
        id              uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organization (id)
      )`.execute(testDb.db);
    await sql`
      CREATE TABLE listing_branch_probe (
        listing_id      uuid NOT NULL REFERENCES listing_probe (id),
        branch_id       uuid NOT NULL,
        organization_id uuid NOT NULL,
        FOREIGN KEY (branch_id, organization_id)
          REFERENCES branch (id, organization_id)
      )`.execute(testDb.db);
    try {
      const listing = newId();
      await sql`INSERT INTO listing_probe (id, organization_id)
                VALUES (${listing}, ${org})`.execute(testDb.db);
      // Same-org branch association works.
      await sql`INSERT INTO listing_branch_probe (listing_id, branch_id, organization_id)
                VALUES (${listing}, ${branch}, ${org})`.execute(testDb.db);
      // A branch of ANOTHER organization is structurally refused.
      await expect(
        sql`INSERT INTO listing_branch_probe (listing_id, branch_id, organization_id)
            VALUES (${listing}, ${foreignBranch}, ${org})`.execute(testDb.db),
      ).rejects.toThrow();
    } finally {
      await sql`DROP TABLE listing_branch_probe`.execute(testDb.db);
      await sql`DROP TABLE listing_probe`.execute(testDb.db);
    }
  });

  it('the S3-1 spine tables exist and no later-slice booking/session table was smuggled in', async () => {
    // Amended by S4-1 (catalogue tables) and again by S5-1 (docs/32: the
    // owner-approved booking/capacity foundation legitimately ships
    // session/camp_week/enrolment_cohort/recurring_schedule/capacity_hold/
    // booking/enrolment/price_quote — locked by
    // booking-capacity-schema.test.ts) and again by W5-1 (docs/33 §17: the
    // owner-approved 0015 payment foundation legitimately ships
    // payment_intent/payment_attempt/payment_transaction/gateway_event —
    // locked by payment-schema.test.ts). This guard now covers only the
    // entities that remain future slices: refunds, payouts, credits.
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`.execute(
      testDb.db,
    );
    const names = tables.rows.map((r) => r.table_name);
    expect(
      names.filter((n) =>
        /^(refund|payout|payout_statement|credit_ledger_entry|reconciliation_event)$/.test(n),
      ),
    ).toEqual([]);
    for (const required of ['organization', 'organization_public_profile', 'branch']) {
      expect(names).toContain(required);
    }
  });
});

describe('application-role permissions', () => {
  it('himma_app can select/insert/update the three tables but never delete', async () => {
    const org = await makeOrganization();
    await withTransaction(testDb.db, async (trx) => {
      await sql`SET LOCAL ROLE himma_app`.execute(trx);
      const id = newId();
      await sql`INSERT INTO organization (id, legal_name, trade_name)
                VALUES (${id}, 'App Legal', 'App Trade')`.execute(trx);
      await sql`UPDATE organization SET trade_name = 'App Trade 2' WHERE id = ${id}`.execute(trx);
      await sql`INSERT INTO organization_public_profile (organization_id, display_name)
                VALUES (${id}, 'App Trade 2')`.execute(trx);
      await sql`INSERT INTO branch (id, organization_id, label, area_label)
                VALUES (${newId()}, ${id}, 'B', 'Area')`.execute(trx);
      await sql`SELECT count(*) FROM organization`.execute(trx);
    });
    for (const table of ['organization', 'organization_public_profile', 'branch']) {
      await expect(
        withTransaction(testDb.db, async (trx) => {
          await sql`SET LOCAL ROLE himma_app`.execute(trx);
          await sql.raw(`DELETE FROM ${table}`).execute(trx);
        }),
      ).rejects.toThrow(/permission denied/i);
    }
    void org;
  });
});
