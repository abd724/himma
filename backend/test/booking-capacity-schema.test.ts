/**
 * W4 Slice 5 · S5-1 — booking & capacity schema foundation (docs/32; owner
 * rulings D-1…D-9; docs/24 §2.3–§3.4, §5.4–5.6, §6). Real PostgreSQL:
 * proves the DATABASE-LAYER invariants directly — the capacity CHECK in
 * both directions (overselling + floor), non-negative counters,
 * exactly-one org-bound unit targets, hold/booking/unit state machines and
 * immutability triggers, purchaser≠participant representability, live
 * double-booking uniques, the paid-booking intermediate state (an ACTIVE
 * hold under a pending_payment booking — consumption is a separate paired
 * boundary), quote immutability + total==Σ(lines), grants,
 * and the expected schema objects. Deliberately NOT proven here: the
 * racing-transaction claim algorithm — that is the S5-2 concurrency gate;
 * these CHECKs are its final backstop, not its implementation.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { createProgram } from '../src/modules/catalogue/services/program-management';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import {
  createAccount,
  createSelfParticipant,
  createUser,
} from './helpers/identity-fixtures';
import { createProviderOrg } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let orgA: { orgId: string; branchIds: string[] };
let orgB: { orgId: string; branchIds: string[] };
let programA: string;
let programB: string;
let accountParent: string;
let participantSelf: string;
let participantChild: string;
let accountOther: string;
let participantOther: string;

const FUTURE = new Date('2026-09-01T08:00:00.000Z');
const FUTURE_END = new Date('2026-09-01T09:00:00.000Z');

async function makeProgram(org: { orgId: string; branchIds: string[] }): Promise<string> {
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
  const typeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${typeId}, ${category.rows[0]!.id}, ${`s5-type-${typeId.replace(/-/g, '').slice(-12)}`}, 'S5 Type')`.execute(
    testDb.db,
  );
  const scope: OrgScope = {
    organizationId: org.orgId,
    membershipId: newId(),
    role: 'owner',
    capabilities: capabilitiesForRole('owner'),
    branchScope: 'all',
    organizationState: 'live',
  };
  const created = await createProgram({ db: testDb.db }, scope, { userId: newId() }, {
    titleEn: 'S5 Schema Program',
    activityTypeId: typeId,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  return created.program.id;
}

async function makeSession(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = newId();
  const values: Record<string, unknown> = {
    id,
    program_id: programA,
    organization_id: orgA.orgId,
    branch_id: orgA.branchIds[0],
    start_at: FUTURE,
    end_at: FUTURE_END,
    capacity: 5,
    registration_cutoff_at: FUTURE,
    ...overrides,
  };
  await testDb.db.insertInto('session').values(values as never).execute();
  return id;
}

/** Quote + one base line in ONE transaction (the deferred total trigger
 *  validates at commit). */
async function makeQuote(input: {
  accountId: string;
  participantId: string;
  sessionId?: string;
  cohortId?: string;
  totalFils?: number;
}): Promise<string> {
  const id = newId();
  await testDb.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('price_quote')
      .values({
        id,
        organization_id: orgA.orgId,
        program_id: programA,
        account_id: input.accountId,
        participant_id: input.participantId,
        option_kind: 'dropIn',
        session_id: input.sessionId ?? null,
        cohort_id: input.cohortId ?? null,
        total_fils: input.totalFils ?? 5000,
        price_kind: 'oneOff',
        expires_at: FUTURE,
      } as never)
      .execute();
    await trx
      .insertInto('price_quote_line')
      .values({
        id: newId(),
        quote_id: id,
        line_no: 1,
        kind: 'base',
        label_en: '1 session',
        amount_fils: input.totalFils ?? 5000,
      } as never)
      .execute();
  });
  return id;
}

async function makeHold(input: {
  sessionId?: string;
  cohortId?: string;
  accountId?: string;
  participantId?: string;
  quoteId?: string;
}): Promise<string> {
  const accountId = input.accountId ?? accountParent;
  const participantId = input.participantId ?? participantChild;
  const quoteId =
    input.quoteId ??
    (await makeQuote({
      accountId,
      participantId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.cohortId !== undefined ? { cohortId: input.cohortId } : {}),
    }));
  const id = newId();
  await testDb.db
    .insertInto('capacity_hold')
    .values({
      id,
      organization_id: orgA.orgId,
      session_id: input.sessionId ?? null,
      camp_week_id: null,
      cohort_id: input.cohortId ?? null,
      account_id: accountId,
      participant_id: participantId,
      quote_id: quoteId,
      expires_at: FUTURE,
    } as never)
    .execute();
  return id;
}

async function makeBooking(input: {
  sessionId?: string;
  cohortId?: string;
  holdId: string;
  accountId?: string;
  participantId?: string;
  quoteId?: string;
}): Promise<string> {
  const accountId = input.accountId ?? accountParent;
  const participantId = input.participantId ?? participantChild;
  const quoteId =
    input.quoteId ??
    (await makeQuote({
      accountId,
      participantId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.cohortId !== undefined ? { cohortId: input.cohortId } : {}),
    }));
  const id = newId();
  await testDb.db
    .insertInto('booking')
    .values({
      id,
      account_id: accountId,
      participant_id: participantId,
      program_id: programA,
      organization_id: orgA.orgId,
      branch_id: orgA.branchIds[0],
      option_kind: input.cohortId !== undefined ? 'monthly' : 'dropIn',
      session_id: input.sessionId ?? null,
      camp_week_id: null,
      cohort_id: input.cohortId ?? null,
      quote_id: quoteId,
      hold_id: input.holdId,
    } as never)
    .execute();
  return id;
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  orgA = await createProviderOrg(testDb.db, { state: 'live', branches: 2 });
  orgB = await createProviderOrg(testDb.db, { state: 'live', branches: 1 });
  programA = await makeProgram(orgA);
  programB = await makeProgram(orgB);
  const parentUser = await createUser(testDb.db);
  accountParent = await createAccount(testDb.db, parentUser);
  participantSelf = await createSelfParticipant(testDb.db, accountParent);
  participantChild = newId();
  await testDb.db
    .insertInto('participant')
    .values({
      id: participantChild,
      account_id: accountParent,
      kind: 'child',
      first_name: 'Child',
      date_of_birth: new Date('2018-03-01'),
    } as never)
    .execute();
  const otherUser = await createUser(testDb.db);
  accountOther = await createAccount(testDb.db, otherUser);
  participantOther = await createSelfParticipant(testDb.db, accountOther);
});

afterAll(async () => {
  await testDb.drop();
});

describe('capacity authority — the database is the final layer (docs/23 §10.1)', () => {
  it('negative capacity and negative counters are impossible', async () => {
    await expect(makeSession({ capacity: -1 })).rejects.toThrow(/ck_session_capacity/);
    const id = await makeSession();
    await expect(
      sql`UPDATE session SET held_count = -1 WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/ck_session_capacity/);
    await expect(
      sql`UPDATE session SET booked_count = -1 WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/ck_session_capacity/);
  });

  it('booked + held can NEVER exceed capacity — direct SQL cannot bypass it, on ALL THREE unit kinds', async () => {
    const sessionId = await makeSession({ capacity: 2 });
    await expect(
      sql`UPDATE session SET held_count = 3 WHERE id = ${sessionId}`.execute(testDb.db),
    ).rejects.toThrow(/ck_session_capacity/);
    await expect(
      sql`UPDATE session SET booked_count = 2, held_count = 1 WHERE id = ${sessionId}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/ck_session_capacity/);
    // Camp week and cohort carry the SAME check (one shared model).
    await expect(
      sql`INSERT INTO camp_week (id, program_id, organization_id, branch_id, start_date, end_date,
                                 daily_start_time, daily_end_time, capacity, booked_count,
                                 registration_cutoff_at)
          VALUES (${newId()}, ${programA}, ${orgA.orgId}, ${orgA.branchIds[0]}, '2026-09-07',
                  '2026-09-11', '09:00', '13:00', 10, 11, ${FUTURE})`.execute(testDb.db),
    ).rejects.toThrow(/ck_camp_week_capacity/);
    await expect(
      sql`INSERT INTO enrolment_cohort (id, program_id, organization_id, branch_id,
                                        effective_start, effective_end, capacity, held_count,
                                        enrolment_cutoff_at)
          VALUES (${newId()}, ${programA}, ${orgA.orgId}, ${orgA.branchIds[0]}, '2026-09-01',
                  '2026-12-01', 3, 4, ${FUTURE})`.execute(testDb.db),
    ).rejects.toThrow(/ck_enrolment_cohort_capacity/);
  });

  it('the capacity FLOOR: capacity cannot be lowered below booked + held (the same CHECK, symmetric)', async () => {
    const id = await makeSession({ capacity: 5, booked_count: 2, held_count: 1 });
    await expect(
      sql`UPDATE session SET capacity = 2 WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/ck_session_capacity/);
    // Reduction down TO the floor is legal.
    await sql`UPDATE session SET capacity = 3 WHERE id = ${id}`.execute(testDb.db);
    const row = await testDb.db
      .selectFrom('session')
      .select(['capacity'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.capacity).toBe(3);
  });

  it('the shared unit machine: valid flips work; invalid transitions and terminal edits are trigger-refused', async () => {
    const id = await makeSession();
    await sql`UPDATE session SET state = 'full' WHERE id = ${id}`.execute(testDb.db);
    await sql`UPDATE session SET state = 'open' WHERE id = ${id}`.execute(testDb.db);
    await expect(
      sql`UPDATE session SET state = 'completed' WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/invalid session transition/);
    await sql`UPDATE session SET state = 'closed' WHERE id = ${id}`.execute(testDb.db);
    await sql`UPDATE session SET state = 'completed' WHERE id = ${id}`.execute(testDb.db);
    await expect(
      sql`UPDATE session SET capacity = 9 WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/terminal/);
    // Identity/ownership immutable on every unit (shared trigger).
    const other = await makeSession();
    await expect(
      sql`UPDATE session SET branch_id = ${orgA.branchIds[1]} WHERE id = ${other}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('D-9: a generated/eligible session opens registration by default', async () => {
    const id = await makeSession();
    const row = await testDb.db
      .selectFrom('session')
      .select(['state'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('open');
  });
});

describe('structural target integrity (never route code)', () => {
  it('a hold must target EXACTLY one unit', async () => {
    const sessionId = await makeSession();
    const quote = await makeQuote({
      accountId: accountParent,
      participantId: participantChild,
      sessionId,
    });
    await expect(
      testDb.db
        .insertInto('capacity_hold')
        .values({
          id: newId(),
          organization_id: orgA.orgId,
          session_id: null,
          camp_week_id: null,
          cohort_id: null,
          account_id: accountParent,
          participant_id: participantChild,
          quote_id: quote,
          expires_at: FUTURE,
        } as never)
        .execute(),
    ).rejects.toThrow(/ck_capacity_hold_one_unit/);
  });

  it('cross-organization unit targeting is impossible (org-bound composite FKs)', async () => {
    const sessionId = await makeSession(); // org A session
    const quote = await makeQuote({
      accountId: accountParent,
      participantId: participantChild,
      sessionId,
    });
    await expect(
      testDb.db
        .insertInto('capacity_hold')
        .values({
          id: newId(),
          organization_id: orgB.orgId, // wrong org for this session
          session_id: sessionId,
          camp_week_id: null,
          cohort_id: null,
          account_id: accountParent,
          participant_id: participantChild,
          quote_id: quote,
          expires_at: FUTURE,
        } as never)
        .execute(),
    ).rejects.toThrow(/fk_capacity_hold_session/);
  });

  it('purchaser and participant are DISTINCT but bound: a parent books for a child; a foreign account’s participant is refused', async () => {
    const sessionId = await makeSession();
    // Parent purchaser + child participant: representable.
    const holdId = await makeHold({ sessionId });
    const bookingId = await makeBooking({ sessionId, holdId });
    const row = await testDb.db
      .selectFrom('booking')
      .select(['account_id', 'participant_id'])
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow();
    expect(row.account_id).toBe(accountParent);
    expect(row.participant_id).toBe(participantChild);
    expect(row.account_id).not.toBe(row.participant_id);
    // Someone else's participant under this purchaser: composite-FK refused.
    const sessionId2 = await makeSession();
    const quote = await makeQuote({
      accountId: accountParent,
      participantId: participantChild,
      sessionId: sessionId2,
    });
    await expect(
      testDb.db
        .insertInto('capacity_hold')
        .values({
          id: newId(),
          organization_id: orgA.orgId,
          session_id: sessionId2,
          camp_week_id: null,
          cohort_id: null,
          account_id: accountParent,
          participant_id: participantOther,
          quote_id: quote,
          expires_at: FUTURE,
        } as never)
        .execute(),
    ).rejects.toThrow(/fk_capacity_hold_participant/);
  });

  it('a booking’s hold must carry the SAME unit (composite-FK-matched)', async () => {
    const session1 = await makeSession();
    const session2 = await makeSession();
    const holdOn1 = await makeHold({ sessionId: session1 });
    await expect(makeBooking({ sessionId: session2, holdId: holdOn1 })).rejects.toThrow(
      /fk_booking_hold_session/,
    );
  });

  it('cohort ⇄ schedule association is pinned to ONE program (cross-program refused)', async () => {
    const scheduleB = newId();
    await sql`INSERT INTO recurring_schedule (id, program_id, organization_id, weekdays,
                                              start_time, end_time, effective_start)
              VALUES (${scheduleB}, ${programB}, ${orgB.orgId}, '{6}', '10:00', '11:00',
                      '2026-09-01')`.execute(testDb.db);
    const cohortA = newId();
    await sql`INSERT INTO enrolment_cohort (id, program_id, organization_id, branch_id,
                                            effective_start, effective_end, capacity,
                                            enrolment_cutoff_at)
              VALUES (${cohortA}, ${programA}, ${orgA.orgId}, ${orgA.branchIds[0]}, '2026-09-01',
                      '2026-12-01', 10, ${FUTURE})`.execute(testDb.db);
    await expect(
      sql`INSERT INTO enrolment_cohort_schedule (cohort_id, schedule_id, program_id)
          VALUES (${cohortA}, ${scheduleB}, ${programA})`.execute(testDb.db),
    ).rejects.toThrow(/fk_ecs_schedule/);
  });

  it('session generation identity is unique per (schedule, occurrence_date)', async () => {
    const scheduleA = newId();
    await sql`INSERT INTO recurring_schedule (id, program_id, organization_id, weekdays,
                                              start_time, end_time, effective_start)
              VALUES (${scheduleA}, ${programA}, ${orgA.orgId}, '{1,3}', '16:00', '17:00',
                      '2026-09-01')`.execute(testDb.db);
    await makeSession({ schedule_id: scheduleA, occurrence_date: new Date('2026-09-07') });
    await expect(
      makeSession({ schedule_id: scheduleA, occurrence_date: new Date('2026-09-07') }),
    ).rejects.toThrow(/uq_session_generation/);
    // A schedule-generated session without its occurrence identity is refused.
    await expect(makeSession({ schedule_id: scheduleA })).rejects.toThrow(
      /ck_session_generation_identity/,
    );
  });
});

describe('hold facts and machine (docs/24 §5.5)', () => {
  it('invalid states, consumed-without-booking, and quantity ≠ 1 (D-2) are refused', async () => {
    const sessionId = await makeSession();
    const quote = await makeQuote({
      accountId: accountParent,
      participantId: participantSelf,
      sessionId,
    });
    const base = {
      organization_id: orgA.orgId,
      session_id: sessionId,
      camp_week_id: null,
      cohort_id: null,
      account_id: accountParent,
      participant_id: participantSelf,
      quote_id: quote,
      expires_at: FUTURE,
    };
    await expect(
      testDb.db
        .insertInto('capacity_hold')
        .values({ id: newId(), ...base, state: 'weird' } as never)
        .execute(),
    ).rejects.toThrow(/ck_capacity_hold_state/);
    await expect(
      testDb.db
        .insertInto('capacity_hold')
        .values({ id: newId(), ...base, state: 'consumed' } as never)
        .execute(),
    ).rejects.toThrow(/ck_capacity_hold_consumed_pairing/);
    await expect(
      testDb.db
        .insertInto('capacity_hold')
        .values({ id: newId(), ...base, quantity: 2 } as never)
        .execute(),
    ).rejects.toThrow(/ck_capacity_hold_quantity/);
  });

  it('holds permit state transitions only; identity/TTL are immutable; terminal rows are frozen', async () => {
    const sessionId = await makeSession();
    const holdId = await makeHold({ sessionId, participantId: participantSelf });
    await expect(
      sql`UPDATE capacity_hold SET expires_at = now() WHERE id = ${holdId}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
    await sql`UPDATE capacity_hold SET state = 'released' WHERE id = ${holdId}`.execute(testDb.db);
    await expect(
      sql`UPDATE capacity_hold SET state = 'active' WHERE id = ${holdId}`.execute(testDb.db),
    ).rejects.toThrow(/terminal/);
  });

  it('one LIVE hold per (account, participant, unit): duplicates refused while active, legal after release', async () => {
    const sessionId = await makeSession();
    await makeHold({ sessionId, participantId: participantSelf });
    await expect(makeHold({ sessionId, participantId: participantSelf })).rejects.toThrow(
      /uq_capacity_hold_live_session/,
    );
    // A DIFFERENT participant under the same account is a separate claim.
    await makeHold({ sessionId, participantId: participantChild });
  });
});

describe('booking facts and machine (docs/24 §5.6)', () => {
  it('confirmation facts are state-gated: confirmed requires reference code + policy snapshot + confirmed_at', async () => {
    const sessionId = await makeSession();
    const holdId = await makeHold({ sessionId });
    const bookingId = await makeBooking({ sessionId, holdId });
    await expect(
      sql`UPDATE booking SET state = 'confirmed' WHERE id = ${bookingId}`.execute(testDb.db),
    ).rejects.toThrow(/ck_booking_confirmation_facts/);
    // No policy template content exists (D-8: fail-closed, nothing seeded) —
    // a schema-level probe row proves the *shape*; it is created as draft
    // and never activated, inventing no launch policy.
    const templateId = newId();
    await sql`INSERT INTO cancellation_policy_template (id, template_version, title_en, rules)
              VALUES (${templateId}, 1, 'Schema probe (never active)', '{}'::jsonb)`.execute(
      testDb.db,
    );
    await sql`UPDATE booking
              SET state = 'confirmed', reference_code = ${'REF-' + bookingId.slice(0, 8)},
                  policy_template_id = ${templateId}, confirmed_at = now()
              WHERE id = ${bookingId}`.execute(testDb.db);
    // Write-once confirmation facts.
    await expect(
      sql`UPDATE booking SET reference_code = 'REWRITTEN' WHERE id = ${bookingId}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/write-once/);
    // Machine: confirmed can never return to pending_payment.
    await expect(
      sql`UPDATE booking SET state = 'pending_payment' WHERE id = ${bookingId}`.execute(testDb.db),
    ).rejects.toThrow(/invalid booking transition/);
  });

  it('terminal bookings are immutable; pending → expired is the TTL unwind path', async () => {
    const sessionId = await makeSession();
    const holdId = await makeHold({ sessionId });
    const bookingId = await makeBooking({ sessionId, holdId });
    await sql`UPDATE booking SET state = 'expired' WHERE id = ${bookingId}`.execute(testDb.db);
    await expect(
      sql`UPDATE booking SET state = 'pending_payment' WHERE id = ${bookingId}`.execute(testDb.db),
    ).rejects.toThrow(/terminal/);
  });

  it('live double-booking is refused per unit+participant — incl. D-4 one participant per cohort enrolment — and a dead booking frees the slot', async () => {
    const cohortId = newId();
    await sql`INSERT INTO enrolment_cohort (id, program_id, organization_id, branch_id,
                                            effective_start, effective_end, capacity,
                                            enrolment_cutoff_at)
              VALUES (${cohortId}, ${programA}, ${orgA.orgId}, ${orgA.branchIds[0]}, '2026-09-01',
                      '2026-12-01', 10, ${FUTURE})`.execute(testDb.db);
    const hold1 = await makeHold({ cohortId });
    const booking1 = await makeBooking({ cohortId, holdId: hold1 });
    const hold2 = await makeHold({ cohortId, participantId: participantSelf });
    await expect(
      makeBooking({ cohortId, holdId: hold2, participantId: participantChild }),
    ).rejects.toThrow(/uq_booking_live_cohort|fk_booking_hold_cohort/);
    // Enrolment subtype rows pin the booking's own cohort and stay clean of
    // billing: only participation columns exist.
    await testDb.db
      .insertInto('enrolment')
      .values({ booking_id: booking1, cohort_id: cohortId, cadence: 'monthly' } as never)
      .execute();
    const enrolmentColumns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'enrolment'`.execute(testDb.db);
    const names = enrolmentColumns.rows.map((row) => row.column_name).sort();
    expect(names).toEqual(
      ['billing_anchor_date', 'booking_id', 'cadence', 'cohort_id', 'created_at', 'renewal_policy'].sort(),
    );
    for (const name of names) {
      expect(name).not.toMatch(/gateway|mandate|card|token|payment|subscription/);
    }
    // The unwind: expire the live duplicate-blocker (booking AND its hold —
    // exactly what the §7.2 transaction does), then the slot reopens.
    await sql`UPDATE booking SET state = 'expired' WHERE id = ${booking1}`.execute(testDb.db);
    await sql`UPDATE capacity_hold SET state = 'expired' WHERE id = ${hold1}`.execute(testDb.db);
    const hold3 = await makeHold({ cohortId, participantId: participantChild, accountId: accountParent });
    await makeBooking({ cohortId, holdId: hold3, participantId: participantChild });
  });
});

describe('the paid-booking intermediate state (docs/24 §5.5/§5.6 seam; S5-1 owner probe)', () => {
  it('a pending_payment booking rests on an ACTIVE hold: the hold is NOT consumed, the seat stays HELD, and consumption remains a separate paired boundary', async () => {
    const sessionId = await makeSession();
    const quoteId = await makeQuote({
      accountId: accountParent,
      participantId: participantChild,
      sessionId,
    });
    // The S5-2 claim shape: hold row + held_count seat in ONE transaction.
    const holdId = newId();
    await testDb.db.transaction().execute(async (trx) => {
      await sql`UPDATE session SET held_count = held_count + 1 WHERE id = ${sessionId}`.execute(trx);
      await trx
        .insertInto('capacity_hold')
        .values({
          id: holdId,
          organization_id: orgA.orgId,
          session_id: sessionId,
          camp_week_id: null,
          cohort_id: null,
          account_id: accountParent,
          participant_id: participantChild,
          quote_id: quoteId,
          expires_at: FUTURE,
        } as never)
        .execute();
    });
    const bookingId = await makeBooking({ sessionId, holdId, quoteId });

    // The legitimate intermediate state S5-3/payments depend on: the booking
    // rests at pending_payment, its hold stays ACTIVE with no consumption
    // fact, and the seat is still counted in held_count — never booked_count.
    const state = await sql<{
      booking_state: string;
      hold_state: string;
      consumed_by_booking_id: string | null;
      booked_count: number;
      held_count: number;
    }>`
      SELECT b.state AS booking_state, h.state AS hold_state, h.consumed_by_booking_id,
             s.booked_count, s.held_count
      FROM booking b
      JOIN capacity_hold h ON h.id = b.hold_id
      JOIN session s ON s.id = b.session_id
      WHERE b.id = ${bookingId}`.execute(testDb.db);
    expect(state.rows[0]).toEqual({
      booking_state: 'pending_payment',
      hold_state: 'active',
      consumed_by_booking_id: null,
      booked_count: 0,
      held_count: 1,
    });

    // The live-uniqueness rules still bite around the intermediate state.
    await expect(makeHold({ sessionId })).rejects.toThrow(/uq_capacity_hold_live_session/);
    await expect(makeBooking({ sessionId, holdId })).rejects.toThrow(/uq_booking_live_session/);

    // An ACTIVE hold can never carry consumption facts: a fact-only UPDATE is
    // trigger-refused, and ck_capacity_hold_consumed_pairing refuses the row
    // shape outright (proven at INSERT, where no transition trigger runs).
    await expect(
      sql`UPDATE capacity_hold SET consumed_by_booking_id = ${bookingId}
          WHERE id = ${holdId}`.execute(testDb.db),
    ).rejects.toThrow(/permits state transitions only/);
    await expect(
      sql`INSERT INTO capacity_hold (id, organization_id, session_id, account_id, participant_id,
                                     quote_id, expires_at, state, consumed_by_booking_id)
          VALUES (${newId()}, ${orgA.orgId}, ${sessionId}, ${accountOther}, ${participantOther},
                  ${quoteId}, ${FUTURE}, 'active', ${bookingId})`.execute(testDb.db),
    ).rejects.toThrow(/ck_capacity_hold_consumed_pairing/);

    // consumed REQUIRES the pairing, and the pairing must be a real booking.
    await expect(
      sql`UPDATE capacity_hold SET state = 'consumed' WHERE id = ${holdId}`.execute(testDb.db),
    ).rejects.toThrow(/ck_capacity_hold_consumed_pairing/);
    await expect(
      sql`UPDATE capacity_hold SET state = 'consumed', consumed_by_booking_id = ${newId()}
          WHERE id = ${holdId}`.execute(testDb.db),
    ).rejects.toThrow(/fk_capacity_hold_consumed_by/);
    // The later confirmation boundary: consumed WITH its booking pairing commits.
    await sql`UPDATE capacity_hold SET state = 'consumed', consumed_by_booking_id = ${bookingId}
              WHERE id = ${holdId}`.execute(testDb.db);
  });
});

describe('price_quote — the immutable commercial snapshot', () => {
  it('a quote whose total does not equal its line sum cannot COMMIT (deferred trigger)', async () => {
    const sessionId = await makeSession();
    // A matching quote commits fine (makeQuote writes total == line sum).
    await makeQuote({
      accountId: accountParent,
      participantId: participantSelf,
      sessionId,
      totalFils: 5000,
    });
    // A mismatching quote (total 9999, one 5000 line) is refused AT COMMIT.
    await expect(
      testDb.db.transaction().execute(async (trx) => {
        const quoteId = newId();
        await trx
          .insertInto('price_quote')
          .values({
            id: quoteId,
            organization_id: orgA.orgId,
            program_id: programA,
            account_id: accountParent,
            participant_id: participantSelf,
            option_kind: 'dropIn',
            session_id: sessionId,
            camp_week_id: null,
            cohort_id: null,
            total_fils: 9999,
            price_kind: 'oneOff',
            expires_at: FUTURE,
          } as never)
          .execute();
        await trx
          .insertInto('price_quote_line')
          .values({
            id: newId(),
            quote_id: quoteId,
            line_no: 1,
            kind: 'base',
            label_en: '1 session',
            amount_fils: 5000,
          } as never)
          .execute();
      }),
    ).rejects.toThrow(/does not equal its line sum/);
    // A quote with NO lines at all is equally uncommittable unless total = 0.
    await expect(
      testDb.db
        .insertInto('price_quote')
        .values({
          id: newId(),
          organization_id: orgA.orgId,
          program_id: programA,
          account_id: accountParent,
          participant_id: participantSelf,
          option_kind: 'free',
          session_id: sessionId,
          camp_week_id: null,
          cohort_id: null,
          total_fils: 100,
          price_kind: 'free',
          expires_at: FUTURE,
        } as never)
        .execute(),
    ).rejects.toThrow(/does not equal its line sum/);
  });

  it('quotes and lines are append-only; direct UPDATE/DELETE are trigger-refused and ungranted', async () => {
    const sessionId = await makeSession();
    const quoteId = await makeQuote({
      accountId: accountParent,
      participantId: participantSelf,
      sessionId,
    });
    await expect(
      sql`UPDATE price_quote SET total_fils = 1 WHERE id = ${quoteId}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbid/i);
    await expect(
      sql`DELETE FROM price_quote WHERE id = ${quoteId}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbid/i);
  });
});

describe('schema objects, grants, and append-only surfaces', () => {
  it('all S5-1 tables, the expiry index, and the live-uniqueness indexes exist', async () => {
    // S6-1 owning-slice amendment (docs/35 §11, D-S6-2): package_entitlement
    // was SUPERSEDED and dropped in 0017 (never authoritative, provably
    // empty, no write path ever existed) — 11 S5-1 tables remain, and the
    // supersession is asserted below.
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN
        ('recurring_schedule', 'session', 'camp_week', 'enrolment_cohort',
         'enrolment_cohort_schedule', 'cancellation_policy_template', 'price_quote',
         'price_quote_line', 'capacity_hold', 'booking', 'enrolment', 'package_entitlement')`.execute(
      testDb.db,
    );
    expect(tables.rows).toHaveLength(11);
    expect(tables.rows.map((row) => row.table_name)).not.toContain('package_entitlement');
    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN
        ('ix_capacity_hold_active_expiry', 'uq_capacity_hold_live_session',
         'uq_capacity_hold_live_camp_week', 'uq_capacity_hold_live_cohort',
         'uq_session_generation', 'uq_booking_live_session', 'uq_booking_live_camp_week',
         'uq_booking_live_cohort')`.execute(testDb.db);
    expect(indexes.rows).toHaveLength(8);
  });

  it('himma_app holds NO DELETE anywhere in the domain, and no UPDATE on the append-only snapshot tables', async () => {
    const grants = await sql<{ table_name: string; privilege_type: string }>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'himma_app' AND table_name IN
        ('recurring_schedule', 'session', 'camp_week', 'enrolment_cohort',
         'enrolment_cohort_schedule', 'cancellation_policy_template', 'price_quote',
         'price_quote_line', 'capacity_hold', 'booking', 'enrolment')`.execute(
      testDb.db,
    );
    expect(grants.rows.some((row) => row.privilege_type === 'DELETE')).toBe(false);
    const appendOnly = ['price_quote', 'price_quote_line', 'enrolment'];
    expect(
      grants.rows.some(
        (row) => appendOnly.includes(row.table_name) && row.privilege_type === 'UPDATE',
      ),
    ).toBe(false);
  });

  it('policy template CONTENT is immutable (only the lifecycle state moves) and no launch content is seeded', async () => {
    const seeded = await sql<{ n: string }>`
      SELECT count(*) AS n FROM cancellation_policy_template
      WHERE title_en <> 'Schema probe (never active)'`.execute(testDb.db);
    expect(Number(seeded.rows[0]?.n)).toBe(0); // D-8: nothing invented
    const id = newId();
    await sql`INSERT INTO cancellation_policy_template (id, template_version, title_en, rules)
              VALUES (${id}, 1, 'Immutability probe', '{"windows": []}'::jsonb)`.execute(testDb.db);
    await expect(
      sql`UPDATE cancellation_policy_template SET rules = '{"windows": [1]}'::jsonb
          WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
    await sql`UPDATE cancellation_policy_template SET state = 'active' WHERE id = ${id}`.execute(
      testDb.db,
    );
    await expect(
      sql`UPDATE cancellation_policy_template SET state = 'draft' WHERE id = ${id}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/invalid cancellation_policy_template transition/);
  });

  it('the certified idempotency_key store is ready for the S5-2 primitive (shape reconciled, no schema change needed)', async () => {
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'idempotency_key'`.execute(testDb.db);
    const names = columns.rows.map((row) => row.column_name);
    for (const required of ['principal_ref', 'endpoint_scope', 'idempotency_key', 'response_snapshot', 'status', 'expires_at']) {
      expect(names).toContain(required);
    }
  });
});
