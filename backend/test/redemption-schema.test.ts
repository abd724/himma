/**
 * S6-2 — redemption/attendance/reservation schema certification (docs/35
 * §7, §9, §10; migration 0018; owner items 3–8, 17–18, 21–22, 26). Real
 * PostgreSQL — the structural invariants the services stand on.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { confirmFreeEntitlementPurchase } from '../src/modules/entitlement/services/entitlement-acquisition';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import { confirmFreeBooking } from '../src/modules/booking/services/booking-lifecycle';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createCustomer,
  createFulfillmentRevision,
  createPriceOption,
  createSession,
  publishProgram,
  type BookingFixture,
  type Customer,
} from './helpers/booking-fixtures';
import { addMembership } from './helpers/provider-fixtures';
import { createUser } from './helpers/identity-fixtures';
import { createMigratedTestDb, type TestDb } from './helpers/test-db';

let testDb: TestDb;
let f: BookingFixture;
let customer: Customer;
let staffMembershipId: string;
let freePackOption: string;
let freeCapacityOption: string;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  await createActivePolicyTemplate(testDb.db);
  customer = await createCustomer(testDb.db);
  staffMembershipId = await addMembership(testDb.db, await createUser(testDb.db), f.org.orgId, 'owner');
  freePackOption = await createPriceOption(f, { kind: 'package', amountFils: 0, sessionsCount: 3 });
  await createFulfillmentRevision(f, freePackOption, {
    usageKind: 'finite',
    validityKind: 'daysFromConfirmation',
    validityDays: 30,
  });
  freeCapacityOption = await createPriceOption(f, { kind: 'free' });
});

afterAll(async () => {
  await testDb.drop();
});

/** A confirmed free entitlement through the REAL acquisition path. */
async function makeEntitlement(who: Customer = customer): Promise<string> {
  const quote = await requestEntitlementQuote({ db: testDb.db }, { accountId: who.accountId }, {
    programId: f.programId,
    priceOptionId: freePackOption,
    participantId: who.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const run = await confirmFreeEntitlementPurchase({ db: testDb.db }, { accountId: who.accountId }, {
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'purchaseConfirmed') throw new Error(run.outcome.kind);
  return run.outcome.purchase.entitlement!.entitlementId;
}

/** A confirmed session Booking through the REAL capacity path. */
async function makeSessionBooking(
  who: Customer = customer,
): Promise<{ bookingId: string; sessionId: string }> {
  const sessionId = await createSession(f);
  const quote = await requestQuote({ db: testDb.db }, { accountId: who.accountId }, {
    programId: f.programId,
    priceOptionId: freeCapacityOption,
    unit: { kind: 'session', id: sessionId },
    participantId: who.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold({ db: testDb.db }, { accountId: who.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: who.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const confirmed = await confirmFreeBooking({ db: testDb.db }, { accountId: who.accountId }, {
    holdId: hold.outcome.hold.holdId,
    idempotencyKey: newId(),
  });
  if (confirmed.outcome.kind !== 'bookingConfirmed') throw new Error(confirmed.outcome.kind);
  return { bookingId: confirmed.outcome.booking.bookingId, sessionId };
}

function credentialValues(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: newId(),
    token_digest: `tok-${newId()}`,
    alias_digest: `alias-${newId()}`,
    account_id: customer.accountId,
    participant_id: customer.participantId,
    organization_id: f.org.orgId,
    expires_at: new Date(Date.now() + 600_000),
    ...overrides,
  };
}

async function insertCredential(values: Record<string, unknown>): Promise<string> {
  await testDb.db.insertInto('redemption_credential').values(values as never).execute();
  return values.id as string;
}

describe('redemption_credential structure', () => {
  it('exactly one unambiguous target; booking targets carry their occurrence; live-only creation', async () => {
    const entitlementId = await makeEntitlement();
    const { bookingId, sessionId } = await makeSessionBooking();
    // Both targets → refused; neither → refused.
    await expect(
      insertCredential(
        credentialValues({ entitlement_id: entitlementId, booking_id: bookingId, session_id: sessionId }),
      ),
      // The shape trigger (branch identity) or the one-target CHECK bites —
      // either way an ambiguous double-target row is uninsertable.
    ).rejects.toThrow(/ck_redemption_credential_one_target|must equal the booking/);
    await expect(insertCredential(credentialValues({}))).rejects.toThrow(
      /ck_redemption_credential_one_target/,
    );
    // A booking target without its occurrence → refused (the shape trigger
    // demands the booking's session identity before the CHECK even runs).
    await expect(
      insertCredential(credentialValues({ booking_id: bookingId })),
    ).rejects.toThrow(/ck_redemption_credential_occurrence|must equal the booking/);
    // A walk-in with an occurrence → refused.
    await expect(
      insertCredential(
        credentialValues({ entitlement_id: entitlementId, session_id: sessionId }),
      ),
    ).rejects.toThrow(/ck_redemption_credential_occurrence/);
    // Non-live creation → refused by the shape trigger.
    await expect(
      insertCredential(credentialValues({ entitlement_id: entitlementId, state: 'used' })),
    ).rejects.toThrow(/must be created live/);
  });

  it('org/branch/occurrence must equal the TARGET row truth (shape trigger)', async () => {
    const entitlementId = await makeEntitlement();
    // Wrong organization on a walk-in credential → refused.
    const orgB = await createBookingFixture(testDb.db);
    await expect(
      insertCredential(
        credentialValues({ entitlement_id: entitlementId, organization_id: orgB.org.orgId }),
      ),
    ).rejects.toThrow(/org\/branch must equal the entitlement/);
    // A booking target with the WRONG session id → refused.
    const bookingA = await makeSessionBooking();
    const otherSession = await createSession(f);
    const sessionBranch = await sql<{ branch_id: string }>`
      SELECT branch_id FROM session WHERE id = ${bookingA.sessionId}`.execute(testDb.db);
    await expect(
      insertCredential(
        credentialValues({
          booking_id: bookingA.bookingId,
          session_id: otherSession,
          branch_id: sessionBranch.rows[0]!.branch_id,
        }),
      ),
    ).rejects.toThrow(/org\/occurrence\/branch must equal the booking/);
  });

  it('one LIVE credential per target; alias uniqueness among an org’s live credentials; lifecycle machine', async () => {
    const entitlementId = await makeEntitlement();
    const first = await insertCredential(credentialValues({ entitlement_id: entitlementId }));
    await expect(
      insertCredential(credentialValues({ entitlement_id: entitlementId })),
    ).rejects.toThrow(/uq_redemption_credential_live_entitlement/);
    // Alias collision among LIVE credentials of one org → refused.
    const otherEntitlement = await makeEntitlement(await createCustomer(testDb.db));
    const aliasRow = await sql<{ alias_digest: string }>`
      SELECT alias_digest FROM redemption_credential WHERE id = ${first}`.execute(testDb.db);
    await expect(
      insertCredential(
        credentialValues({
          entitlement_id: otherEntitlement,
          account_id: undefined,
          participant_id: undefined,
          alias_digest: aliasRow.rows[0]!.alias_digest,
        }),
      ),
    ).rejects.toThrow(/uq_redemption_credential_live_alias|null value/);
    // Lifecycle: identity frozen; live → superseded; terminal frozen.
    await expect(
      sql`UPDATE redemption_credential SET expires_at = now() WHERE id = ${first}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/immutable/);
    // used requires used_at + redeemed_by (paired CHECK).
    await expect(
      sql`UPDATE redemption_credential SET state = 'used' WHERE id = ${first}`.execute(testDb.db),
    ).rejects.toThrow(/ck_redemption_credential_used_facts/);
    await sql`UPDATE redemption_credential SET state = 'superseded' WHERE id = ${first}`.execute(
      testDb.db,
    );
    await expect(
      sql`UPDATE redemption_credential SET state = 'live' WHERE id = ${first}`.execute(testDb.db),
    ).rejects.toThrow(/terminal/);
    await expect(
      sql`DELETE FROM redemption_credential WHERE id = ${first}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbid/i);
    // The superseded alias is reusable (live-scope only) — a fresh live
    // credential may carry it.
    await insertCredential(
      credentialValues({
        entitlement_id: entitlementId,
        alias_digest: aliasRow.rows[0]!.alias_digest,
      }),
    );
  });

  it('foreign account/participant substitution dies on the composite FKs', async () => {
    const entitlementId = await makeEntitlement();
    const stranger = await createCustomer(testDb.db);
    await expect(
      insertCredential(
        credentialValues({
          entitlement_id: entitlementId,
          account_id: stranger.accountId,
          participant_id: stranger.participantId,
        }),
      ),
    ).rejects.toThrow(/fk_redemption_credential_entitlement/);
  });
});

describe('attendance_record structure', () => {
  async function usedCredential(entitlementId: string): Promise<string> {
    const id = await insertCredential(credentialValues({ entitlement_id: entitlementId }));
    await sql`UPDATE redemption_credential
              SET state = 'used', used_at = now(),
                  redeemed_by_staff_membership_id = ${staffMembershipId}
              WHERE id = ${id}`.execute(testDb.db);
    return id;
  }

  function attendanceValues(credentialId: string, overrides: Record<string, unknown>) {
    return {
      id: newId(),
      organization_id: f.org.orgId,
      account_id: customer.accountId,
      participant_id: customer.participantId,
      credential_id: credentialId,
      validated_by_staff_membership_id: staffMembershipId,
      ...overrides,
    };
  }

  it('requires a CONSUMED credential with matching identity; credential_id is structurally single-use', async () => {
    const entitlementId = await makeEntitlement();
    const live = await insertCredential(credentialValues({ entitlement_id: entitlementId }));
    await expect(
      testDb.db
        .insertInto('attendance_record')
        .values(attendanceValues(live, { entitlement_id: entitlementId }) as never)
        .execute(),
    ).rejects.toThrow(/requires a consumed credential/);
    await sql`UPDATE redemption_credential
              SET state = 'used', used_at = now(),
                  redeemed_by_staff_membership_id = ${staffMembershipId}
              WHERE id = ${live}`.execute(testDb.db);
    // Wrong entitlement linkage → refused (must equal the credential's).
    const otherEntitlement = await makeEntitlement();
    await expect(
      testDb.db
        .insertInto('attendance_record')
        .values(attendanceValues(live, { entitlement_id: otherEntitlement }) as never)
        .execute(),
    ).rejects.toThrow(/attendance entitlement must equal its credential/);
    await testDb.db
      .insertInto('attendance_record')
      .values(attendanceValues(live, { entitlement_id: entitlementId }) as never)
      .execute();
    // Single-use backstop: a second attendance on the same credential is
    // impossible, whatever any handler does.
    await expect(
      testDb.db
        .insertInto('attendance_record')
        .values(attendanceValues(live, { entitlement_id: entitlementId }) as never)
        .execute(),
    ).rejects.toThrow(/uq_attendance_record_credential/);
    // Append-only.
    await expect(
      sql`UPDATE attendance_record SET source = 'qr' WHERE credential_id = ${live}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/append-only|forbid/i);
    await expect(
      sql`DELETE FROM attendance_record WHERE credential_id = ${live}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbid/i);
  });

  it('the finite floor is a structural backstop: consuming rows can never exceed uses_total', async () => {
    const entitlementId = await makeEntitlement(); // 3 uses
    for (let i = 0; i < 3; i += 1) {
      const used = await usedCredential(entitlementId);
      // Supersede-free path: each used credential releases the live slot.
      await testDb.db
        .insertInto('attendance_record')
        .values(attendanceValues(used, { entitlement_id: entitlementId }) as never)
        .execute();
    }
    const fourth = await usedCredential(entitlementId);
    await expect(
      testDb.db
        .insertInto('attendance_record')
        .values(attendanceValues(fourth, { entitlement_id: entitlementId }) as never)
        .execute(),
    ).rejects.toThrow(/has no remaining uses/);
  });

  it('one attendance per session-backed Booking occurrence (partial unique — deliberately NOT a broad UNIQUE(booking_id))', async () => {
    const { bookingId, sessionId } = await makeSessionBooking();
    const branch = await sql<{ branch_id: string }>`
      SELECT branch_id FROM session WHERE id = ${sessionId}`.execute(testDb.db);
    const makeUsedBookingCredential = async (): Promise<string> => {
      const id = await insertCredential(
        credentialValues({
          booking_id: bookingId,
          session_id: sessionId,
          branch_id: branch.rows[0]!.branch_id,
        }),
      );
      await sql`UPDATE redemption_credential
                SET state = 'used', used_at = now(),
                    redeemed_by_staff_membership_id = ${staffMembershipId}
                WHERE id = ${id}`.execute(testDb.db);
      return id;
    };
    const first = await makeUsedBookingCredential();
    await testDb.db
      .insertInto('attendance_record')
      .values(
        attendanceValues(first, { booking_id: bookingId, session_id: sessionId, branch_id: branch.rows[0]!.branch_id }) as never,
      )
      .execute();
    // A regenerated credential cannot create duplicate attendance for the
    // SAME participant/Booking occurrence.
    const second = await makeUsedBookingCredential();
    await expect(
      testDb.db
        .insertInto('attendance_record')
        .values(
          attendanceValues(second, { booking_id: bookingId, session_id: sessionId, branch_id: branch.rows[0]!.branch_id }) as never,
        )
        .execute(),
    ).rejects.toThrow(/uq_attendance_record_session_booking/);
  });
});

describe('entitlement_reservation structure (S6-3 operates it; S6-2 pins it)', () => {
  it('binds exactly one Entitlement + one Booking with pinned ownership/lineage; append-only', async () => {
    const entitlementId = await makeEntitlement();
    const { bookingId } = await makeSessionBooking();
    // Foreign participant/lineage substitution dies structurally.
    const stranger = await createCustomer(testDb.db);
    await expect(
      testDb.db
        .insertInto('entitlement_reservation')
        .values({
          booking_id: bookingId,
          entitlement_id: entitlementId,
          account_id: stranger.accountId,
          participant_id: stranger.participantId,
          organization_id: f.org.orgId,
          program_id: f.programId,
        } as never)
        .execute(),
    ).rejects.toThrow(/fk_entitlement_reservation/);
    await testDb.db
      .insertInto('entitlement_reservation')
      .values({
        booking_id: bookingId,
        entitlement_id: entitlementId,
        account_id: customer.accountId,
        participant_id: customer.participantId,
        organization_id: f.org.orgId,
        program_id: f.programId,
      } as never)
      .execute();
    // One reservation per Booking (PK) + append-only.
    await expect(
      testDb.db
        .insertInto('entitlement_reservation')
        .values({
          booking_id: bookingId,
          entitlement_id: entitlementId,
          account_id: customer.accountId,
          participant_id: customer.participantId,
          organization_id: f.org.orgId,
          program_id: f.programId,
        } as never)
        .execute(),
    ).rejects.toThrow(/pk_entitlement_reservation/);
    await expect(
      sql`DELETE FROM entitlement_reservation WHERE booking_id = ${bookingId}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbid/i);
  });
});

describe('grants and hygiene', () => {
  it('no DELETE anywhere; attendance/reservation are INSERT-only; no raw-secret column exists', async () => {
    const grants = await sql<{ table_name: string; privilege_type: string }>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'himma_app' AND table_name IN
        ('redemption_credential', 'attendance_record', 'entitlement_reservation',
         'redemption_lookup_attempt')`.execute(testDb.db);
    expect(grants.rows.some((row) => row.privilege_type === 'DELETE')).toBe(false);
    const insertOnly = ['attendance_record', 'entitlement_reservation'];
    expect(
      grants.rows.some(
        (row) => insertOnly.includes(row.table_name) && row.privilege_type === 'UPDATE',
      ),
    ).toBe(false);
    // Digest-only secret storage: no column is SHAPED for a raw code/token.
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'redemption_credential'
        AND column_name ~ '(^code$|display_code|raw|plain|secret$|^token$)'`.execute(testDb.db);
    expect(columns.rows).toEqual([]);
  });
});
