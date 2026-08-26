/**
 * S4-1 — ProgramPriceOption schema (migration 0008; D-S4-1 / Amendment A1;
 * docs/28 §3, §9.6b, §14; docs/24 §2.2/§2.6 as amended). Real PostgreSQL:
 * one Program, many commercial options; stable opaque option ids;
 * deterministic ordering; integer-fils money with the kind/amount/sessions
 * ties; immutable ownership; archive-only retirement; and the money
 * boundary — no authoritative single Program price anywhere.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let orgA: string;
let orgB: string;
let activityType: string;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  orgA = newId();
  await sql`INSERT INTO organization (id, legal_name, trade_name)
            VALUES (${orgA}, 'Falcon Academy LLC', 'Falcon Academy')`.execute(testDb.db);
  orgB = newId();
  await sql`INSERT INTO organization (id, legal_name, trade_name)
            VALUES (${orgB}, 'Other Provider LLC', 'Other Provider')`.execute(testDb.db);
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'martial-arts'`.execute(testDb.db);
  activityType = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityType}, ${category.rows[0]!.id}, 'test-jiu-jitsu', 'Jiu-jitsu')`.execute(
    testDb.db,
  );
});

afterAll(async () => {
  await testDb.drop();
});

async function makeProgram(title: string, organizationId?: string): Promise<string> {
  const id = newId();
  await sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility)
            VALUES (${id}, ${organizationId ?? orgA}, ${activityType}, ${title}, 'indoor', 'mixed')`.execute(
    testDb.db,
  );
  return id;
}

async function makeOption(
  programId: string,
  overrides: {
    kind?: string;
    amountFils?: number | null;
    sessionsCount?: number | null;
    labelEn?: string | null;
    sortHint?: number;
    organizationId?: string;
    state?: string;
  } = {},
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO program_price_option (id, program_id, organization_id, kind, amount_fils,
                                      sessions_count, label_en, sort_hint, state)
    VALUES (${id}, ${programId}, ${overrides.organizationId ?? orgA},
            ${overrides.kind ?? 'monthly'},
            ${'amountFils' in overrides ? overrides.amountFils : 50000},
            ${overrides.sessionsCount ?? null}, ${overrides.labelEn ?? null},
            ${overrides.sortHint ?? 0}, ${overrides.state ?? 'active'})`.execute(testDb.db);
  return id;
}

describe('one listing, many commercial options (D-S4-1)', () => {
  it('Adult Beginner Jiu-Jitsu carries Trial + Monthly + 3 Months as ONE program', async () => {
    const program = await makeProgram('Adult Beginner Jiu-Jitsu');
    // Trial arrives via the Offer entity — never a price-option kind, never a duplicate listing.
    await sql`INSERT INTO offer (id, program_id, organization_id, kind, label_en)
              VALUES (${newId()}, ${program}, ${orgA}, 'freeTrial', 'Free trial class')`.execute(
      testDb.db,
    );
    await makeOption(program, { kind: 'monthly', amountFils: 60000, labelEn: 'Monthly', sortHint: 10 });
    await makeOption(program, { kind: 'term', amountFils: 150000, labelEn: '3 months', sortHint: 20 });

    const programs = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program WHERE title_en = 'Adult Beginner Jiu-Jitsu'`.execute(
      testDb.db,
    );
    expect(Number(programs.rows[0]?.n)).toBe(1);
    const options = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program_price_option
      WHERE program_id = ${program} AND state = 'active'`.execute(testDb.db);
    expect(Number(options.rows[0]?.n)).toBe(2);
  });

  it('options keep stable opaque ids through label and ordering churn (selection is by id)', async () => {
    const program = await makeProgram('Gym Access');
    const monthly = await makeOption(program, { kind: 'monthly', amountFils: 25000, labelEn: 'Monthly', sortHint: 10 });
    await makeOption(program, { kind: 'term', amountFils: 65000, labelEn: '3 months', sortHint: 20 });
    await makeOption(program, { kind: 'term', amountFils: 220000, labelEn: 'Annual', sortHint: 30 });

    await sql`UPDATE program_price_option SET label_en = 'Monthly membership', sort_hint = 99
              WHERE id = ${monthly}`.execute(testDb.db);
    const row = await sql<{ id: string; version: number }>`
      SELECT id, version FROM program_price_option WHERE id = ${monthly}`.execute(testDb.db);
    expect(row.rows[0]?.id).toBe(monthly);
    expect(row.rows[0]?.version).toBe(2);
  });

  it('orders options deterministically by (sort_hint, id)', async () => {
    const program = await makeProgram('Swedish Massage');
    const sixty = await makeOption(program, { kind: 'dropIn', amountFils: 30000, labelEn: '60 minutes', sortHint: 10 });
    const ninety = await makeOption(program, { kind: 'dropIn', amountFils: 42000, labelEn: '90 minutes', sortHint: 20 });
    const pack = await makeOption(program, {
      kind: 'package',
      amountFils: 135000,
      sessionsCount: 5,
      labelEn: '5 sessions',
      sortHint: 30,
    });
    const ordered = await sql<{ id: string }>`
      SELECT id FROM program_price_option WHERE program_id = ${program}
      ORDER BY sort_hint, id`.execute(testDb.db);
    expect(ordered.rows.map((r) => r.id)).toEqual([sixty, ninety, pack]);
  });
});

describe('money rules (integer fils; docs/24 §6.1)', () => {
  it('enforces the approved launch kind subset exactly', async () => {
    const program = await makeProgram('Kind vocabulary');
    await makeOption(program, { kind: 'dropIn', amountFils: 10000 });
    await makeOption(program, { kind: 'camp', amountFils: 90000 });
    await makeOption(program, { kind: 'free', amountFils: null });
    // S6-1 owning-slice amendment (docs/35 §3; D-S6-3): `membership` joined
    // the COMMERCIAL vocabulary — commercial only; fulfillment semantics
    // live in price_option_fulfillment_revision, never in this enum.
    await makeOption(program, { kind: 'membership', amountFils: 10000 });
    for (const kind of ['weekly', 'freeTrial', 'private']) {
      await expect(makeOption(program, { kind, amountFils: 10000 })).rejects.toThrow();
    }
  });

  it('S6-1: entitlement kinds may carry a genuine ZERO amount; capacity kinds still cannot', async () => {
    const program = await makeProgram('Zero-price entitlement products');
    await makeOption(program, { kind: 'membership', amountFils: 0 });
    await makeOption(program, { kind: 'package', amountFils: 0, sessionsCount: 3 });
    await expect(makeOption(program, { kind: 'dropIn', amountFils: 0 })).rejects.toThrow();
    await expect(makeOption(program, { kind: 'camp', amountFils: 0 })).rejects.toThrow();
  });

  it('ties amount to kind: paid kinds require positive fils, free requires NULL', async () => {
    const program = await makeProgram('Amount ties');
    await expect(makeOption(program, { kind: 'monthly', amountFils: null })).rejects.toThrow();
    await expect(makeOption(program, { kind: 'monthly', amountFils: 0 })).rejects.toThrow();
    await expect(makeOption(program, { kind: 'monthly', amountFils: -100 })).rejects.toThrow();
    await expect(makeOption(program, { kind: 'free', amountFils: 100 })).rejects.toThrow();
  });

  it('ties sessions_count to the package kind only, and keeps it a count, not an entitlement', async () => {
    const program = await makeProgram('Package ties');
    await makeOption(program, { kind: 'package', amountFils: 135000, sessionsCount: 5 });
    await expect(makeOption(program, { kind: 'package', amountFils: 135000 })).rejects.toThrow();
    await expect(
      makeOption(program, { kind: 'package', amountFils: 135000, sessionsCount: 0 }),
    ).rejects.toThrow();
    await expect(
      makeOption(program, { kind: 'monthly', amountFils: 50000, sessionsCount: 5 }),
    ).rejects.toThrow();
    // No redemption/usage columns exist — the entitlement ledger is a later slice.
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'program_price_option'
        AND column_name ~ '(used|remaining|redeem|expiry|balance)'`.execute(testDb.db);
    expect(columns.rows).toEqual([]);
  });

  it('money is bigint fils under the shared domain — no floating-point column anywhere in the catalogue', async () => {
    const moneyColumns = await sql<{ table_name: string; column_name: string; domain_name: string | null; data_type: string }>`
      SELECT table_name, column_name, domain_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('program', 'program_price_option', 'offer', 'program_revision')
        AND column_name LIKE '%fils%'`.execute(testDb.db);
    expect(moneyColumns.rows.length).toBeGreaterThanOrEqual(2);
    for (const column of moneyColumns.rows) {
      expect(column.domain_name).toBe('money_fils');
      expect(column.data_type).toBe('bigint');
    }
    const floats = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('area', 'category', 'activity_type', 'collection', 'program',
                           'program_price_option', 'program_branch', 'program_media',
                           'offer', 'program_revision')
        AND data_type IN ('real', 'double precision', 'money', 'numeric')`.execute(testDb.db);
    expect(floats.rows).toEqual([]);
  });
});

describe('money boundary: no authoritative single Program price (D-S4-1; docs/28 §14)', () => {
  it('program has no legacy price/amount column — pricing lives only on options', async () => {
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'program'
        AND column_name ~ '(price|amount|fils|cost|fee|currency|from_)'`.execute(testDb.db);
    expect(columns.rows).toEqual([]);
  });

  it('the public From-price is derivable at read time from ACTIVE options only', async () => {
    const program = await makeProgram('Derived from-price');
    await makeOption(program, { kind: 'dropIn', amountFils: 30000, sortHint: 10 });
    await makeOption(program, { kind: 'term', amountFils: 150000, sortHint: 20 });
    const archivedCheap = await makeOption(program, { kind: 'dropIn', amountFils: 1000, sortHint: 30 });
    await sql`UPDATE program_price_option SET state = 'archived' WHERE id = ${archivedCheap}`.execute(
      testDb.db,
    );
    const derived = await sql<{ min_fils: string | null; has_free: boolean }>`
      SELECT min(amount_fils) AS min_fils,
             bool_or(kind = 'free') AS has_free
      FROM program_price_option
      WHERE program_id = ${program} AND state = 'active'`.execute(testDb.db);
    expect(Number(derived.rows[0]?.min_fils)).toBe(30000);
    expect(derived.rows[0]?.has_free).toBe(false);
  });
});

describe('ownership and lifecycle', () => {
  it('an option can never attach to another organization or migrate between programs', async () => {
    const program = await makeProgram('Ownership');
    // Forged organization id is refused by the composite FK.
    await expect(
      makeOption(program, { organizationId: orgB }),
    ).rejects.toThrow(/foreign key/i);
    // A program of org B cannot receive an option claiming org A.
    const foreign = await makeProgram('Foreign', orgB);
    await expect(makeOption(foreign, { organizationId: orgA })).rejects.toThrow(/foreign key/i);

    const option = await makeOption(program);
    await expect(
      sql`UPDATE program_price_option SET program_id = ${foreign} WHERE id = ${option}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`UPDATE program_price_option SET id = ${newId()} WHERE id = ${option}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
  });

  it('retirement is archive-only: no delete grant, no silent reactivation, frozen history', async () => {
    const program = await makeProgram('Archive');
    const option = await makeOption(program);
    await sql`UPDATE program_price_option SET state = 'archived' WHERE id = ${option}`.execute(
      testDb.db,
    );
    // An archived option is frozen: no reactivation, no edits.
    await expect(
      sql`UPDATE program_price_option SET state = 'active' WHERE id = ${option}`.execute(testDb.db),
    ).rejects.toThrow(/archived|immutable/);
    await expect(
      sql`UPDATE program_price_option SET label_en = 'Rewritten' WHERE id = ${option}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/archived|immutable/);
    await expect(
      sql`INSERT INTO program_price_option (id, program_id, organization_id, kind, amount_fils, state)
          VALUES (${newId()}, ${program}, ${orgA}, 'monthly', 50000, 'retired')`.execute(testDb.db),
    ).rejects.toThrow();
  });

  it('optimistic concurrency: stale option writers lose deterministically', async () => {
    const program = await makeProgram('CAS');
    const option = await makeOption(program);
    const first = await sql`UPDATE program_price_option SET amount_fils = 55000
                            WHERE id = ${option} AND version = 1`.execute(testDb.db);
    const second = await sql`UPDATE program_price_option SET amount_fils = 60000
                             WHERE id = ${option} AND version = 1`.execute(testDb.db);
    expect(first.numAffectedRows).toBe(1n);
    expect(second.numAffectedRows).toBe(0n);
    const row = await sql<{ amount_fils: string; version: number }>`
      SELECT amount_fils, version FROM program_price_option WHERE id = ${option}`.execute(testDb.db);
    expect(Number(row.rows[0]?.amount_fils)).toBe(55000);
    expect(row.rows[0]?.version).toBe(2);
  });

  it('a draft program may exist with zero options; completeness is data the approved layer can enforce', async () => {
    const program = await makeProgram('Incomplete draft');
    const active = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program_price_option
      WHERE program_id = ${program} AND state = 'active'`.execute(testDb.db);
    // The ≥1-active-option publication rule is service-enforced (docs/28 §9.6b);
    // the schema exposes exactly the data that rule needs.
    expect(Number(active.rows[0]?.n)).toBe(0);
  });
});
