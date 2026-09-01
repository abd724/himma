/**
 * Booking/capacity test fixtures (S5-2). Same shapes as the S5-1 schema
 * suite: real org + program via the certified services, capacity units and
 * quotes via direct SQL (their owning provider APIs are S5-4/S5-3 work).
 */
import { sql, type Kysely } from 'kysely';

import { newId } from '../../src/db/ids';
import type { DB } from '../../src/db/kysely';
import type { UnitRef } from '../../src/modules/booking/services/booking-shared';
import { unitSpec } from '../../src/modules/booking/services/booking-shared';
import { createProgram } from '../../src/modules/catalogue/services/program-management';
import { capabilitiesForRole } from '../../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../../src/modules/provider/services/provider-principal';
import { createAccount, createSelfParticipant, createUser } from './identity-fixtures';
import { createProviderOrg } from './provider-fixtures';

/**
 * The fixture "future" anchor. Originally the LITERAL 2026-09-01T08:00Z —
 * which became the PAST on 2026-09-01 and time-bombed the battery
 * (quotes expired, cutoffs closed). Now computed at module load: always a
 * TUESDAY 08:00Z two-to-three weeks ahead, preserving every relationship
 * the literal had (Tuesday session · camp the following Mon–Fri ·
 * cohort effective from the same civil day). Tests never depended on the
 * absolute instant — only on it being safely in the future.
 */
function upcomingTuesday(extraWeeks: number): Date {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0),
  );
  const TUESDAY = 2;
  const delta = ((TUESDAY - d.getUTCDay() + 7) % 7) + 7 * extraWeeks;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const FUTURE = upcomingTuesday(2);
export const FUTURE_END = new Date(FUTURE.getTime() + 3_600_000);
/** The camp week: the Monday after FUTURE through that Friday. */
export const CAMP_START_DATE = isoDate(addDays(FUTURE, 6));
export const CAMP_END_DATE = isoDate(addDays(FUTURE, 10));
/** The cohort: effective from FUTURE's civil day for ~3 months. */
export const COHORT_START_DATE = isoDate(FUTURE);
export const COHORT_END_DATE = isoDate(addDays(FUTURE, 91));

export interface BookingFixture {
  db: Kysely<DB>;
  org: { orgId: string; branchIds: string[] };
  programId: string;
}

export async function createBookingFixture(db: Kysely<DB>): Promise<BookingFixture> {
  const org = await createProviderOrg(db, { state: 'live', branches: 1 });
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(db);
  const typeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${typeId}, ${category.rows[0]!.id},
                    ${`s52-type-${typeId.replace(/-/g, '').slice(-12)}`}, 'S5-2 Type')`.execute(db);
  const scope: OrgScope = {
    organizationId: org.orgId,
    membershipId: newId(),
    role: 'owner',
    capabilities: capabilitiesForRole('owner'),
    branchScope: 'all',
    organizationState: 'live',
  };
  const created = await createProgram({ db }, scope, { userId: newId() }, {
    titleEn: 'S5-2 Hold Program',
    activityTypeId: typeId,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  return { db, org, programId: created.program.id };
}

export async function createSession(
  f: BookingFixture,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = newId();
  await f.db
    .insertInto('session')
    .values({
      id,
      program_id: f.programId,
      organization_id: f.org.orgId,
      branch_id: f.org.branchIds[0],
      start_at: FUTURE,
      end_at: FUTURE_END,
      capacity: 5,
      registration_cutoff_at: FUTURE,
      ...overrides,
    } as never)
    .execute();
  return id;
}

export async function createCampWeek(f: BookingFixture, capacity = 5): Promise<string> {
  const id = newId();
  await sql`INSERT INTO camp_week (id, program_id, organization_id, branch_id, start_date,
                                   end_date, daily_start_time, daily_end_time, capacity,
                                   registration_cutoff_at)
            VALUES (${id}, ${f.programId}, ${f.org.orgId}, ${f.org.branchIds[0]},
                    ${CAMP_START_DATE}, ${CAMP_END_DATE}, '09:00', '13:00', ${capacity},
                    ${FUTURE})`.execute(f.db);
  return id;
}

export async function createCohort(f: BookingFixture, capacity = 5): Promise<string> {
  const id = newId();
  await sql`INSERT INTO enrolment_cohort (id, program_id, organization_id, branch_id,
                                          effective_start, effective_end, capacity,
                                          enrolment_cutoff_at)
            VALUES (${id}, ${f.programId}, ${f.org.orgId}, ${f.org.branchIds[0]},
                    ${COHORT_START_DATE}, ${COHORT_END_DATE}, ${capacity}, ${FUTURE})`.execute(f.db);
  return id;
}

/** Walks the certified §5.3 machine to `published` (quote issuance requires
 *  a bookable listing; every edge below is trigger-legal). */
export async function publishProgram(f: BookingFixture): Promise<void> {
  for (const state of ['submitted', 'in_review', 'approved']) {
    await sql`UPDATE program SET listing_state = ${state} WHERE id = ${f.programId}`.execute(f.db);
  }
  await sql`UPDATE program SET listing_state = 'published', published_at = now()
            WHERE id = ${f.programId}`.execute(f.db);
}

export async function createPriceOption(
  f: BookingFixture,
  input: { kind: string; amountFils?: number | null; sessionsCount?: number | null },
): Promise<string> {
  const id = newId();
  await sql`INSERT INTO program_price_option (id, program_id, organization_id, kind,
                                              amount_fils, sessions_count, label_en)
            VALUES (${id}, ${f.programId}, ${f.org.orgId}, ${input.kind},
                    ${input.amountFils ?? null}, ${input.sessionsCount ?? null},
                    ${input.kind})`.execute(f.db);
  return id;
}

export async function createOffer(
  f: BookingFixture,
  input: { kind: string; trialAmountFils?: number; state?: string },
): Promise<string> {
  const id = newId();
  await sql`INSERT INTO offer (id, organization_id, program_id, kind, label_en,
                               trial_amount_fils, state)
            VALUES (${id}, ${f.org.orgId}, ${f.programId}, ${input.kind}, ${input.kind},
                    ${input.trialAmountFils ?? null}, ${input.state ?? 'active'})`.execute(f.db);
  return id;
}

/** S6-1: an ACTIVE immutable fulfillment revision for an entitlement-
 *  producing option (docs/35 §3) — tests create revisions through this
 *  fixture boundary; no provider route exists until W2-13. */
export async function createFulfillmentRevision(
  f: BookingFixture,
  priceOptionId: string,
  terms: {
    usageKind: 'finite' | 'unlimited';
    usesTotal?: number | null;
    validityKind?: 'daysFromConfirmation' | 'fixedEndDate' | 'none';
    validityDays?: number | null;
    validityEndDate?: string | null;
    reservationRequired?: boolean;
    walkInAllowed?: boolean;
    branchId?: string | null;
    revisionNo?: number;
  },
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO price_option_fulfillment_revision
      (id, price_option_id, program_id, organization_id, revision_no, usage_kind,
       uses_total, validity_kind, validity_days, validity_end_date,
       reservation_required, walk_in_allowed, branch_id)
    VALUES (${id}, ${priceOptionId}, ${f.programId}, ${f.org.orgId},
            ${terms.revisionNo ?? 1}, ${terms.usageKind}, ${terms.usesTotal ?? null},
            ${terms.validityKind ?? 'none'}, ${terms.validityDays ?? null},
            ${terms.validityEndDate ?? null}, ${terms.reservationRequired ?? false},
            ${terms.walkInAllowed ?? true}, ${terms.branchId ?? null})`.execute(f.db);
  return id;
}

/** D-8 test composition: a deterministic FICTIONAL template (draft → active)
 *  proving the snapshot mechanics — production seeds nothing. */
/** D-W5-7: the provider's ACTIVE agreed commission term (bps; no default
 *  exists anywhere — every paid-checkout fixture states its rate). */
export async function createCommissionTerm(
  db: Kysely<DB>,
  organizationId: string,
  rateBps: number,
): Promise<string> {
  const id = newId();
  await sql`INSERT INTO organization_commission_term (id, organization_id, rate_bps)
            VALUES (${id}, ${organizationId}, ${rateBps})`.execute(db);
  return id;
}

export async function createActivePolicyTemplate(db: Kysely<DB>): Promise<string> {
  const id = newId();
  await sql`INSERT INTO cancellation_policy_template (id, template_version, title_en, rules)
            VALUES (${id}, 1, 'Test fixture policy (fictional)', '{"windows": []}'::jsonb)`.execute(db);
  await sql`UPDATE cancellation_policy_template SET state = 'active' WHERE id = ${id}`.execute(db);
  return id;
}

export interface Customer {
  accountId: string;
  participantId: string;
}

export async function createCustomer(db: Kysely<DB>): Promise<Customer> {
  const userId = await createUser(db);
  const accountId = await createAccount(db, userId);
  const participantId = await createSelfParticipant(db, accountId);
  return { accountId, participantId };
}

export async function createQuote(
  f: BookingFixture,
  input: {
    customer: Customer;
    unit: UnitRef;
    expiresAt?: Date;
  },
): Promise<string> {
  const spec = unitSpec(input.unit.kind);
  const id = newId();
  const optionKind = input.unit.kind === 'session' ? 'dropIn' : input.unit.kind === 'campWeek' ? 'camp' : 'monthly';
  await f.db.transaction().execute(async (trx) => {
    await sql`INSERT INTO price_quote (id, organization_id, program_id, account_id,
                                       participant_id, option_kind, ${sql.id(spec.holdColumn)},
                                       total_fils, price_kind, expires_at)
              VALUES (${id}, ${f.org.orgId}, ${f.programId}, ${input.customer.accountId},
                      ${input.customer.participantId}, ${optionKind}, ${input.unit.id},
                      5000, 'oneOff', ${input.expiresAt ?? FUTURE})`.execute(trx);
    await sql`INSERT INTO price_quote_line (id, quote_id, line_no, kind, label_en, amount_fils)
              VALUES (${newId()}, ${id}, 1, 'base', '1 unit', 5000)`.execute(trx);
  });
  return id;
}

/** A ready-to-claim contender: distinct account + participant + unit quote. */
export async function createContender(
  f: BookingFixture,
  unit: UnitRef,
): Promise<Customer & { quoteId: string }> {
  const customer = await createCustomer(f.db);
  const quoteId = await createQuote(f, { customer, unit });
  return { ...customer, quoteId };
}

export interface UnitReconciliation {
  capacity: number;
  bookedCount: number;
  heldCount: number;
  activeHolds: number;
  activeUnexpiredHolds: number;
  state: string;
}

/**
 * Counter-reconciliation utility (docs/32 §1.2.5 / owner §15): the stored
 * `held_count` must equal the number of `active` hold rows for the unit —
 * including lapsed-but-not-yet-transitioned ones (they hold their seat until
 * an authoritative §7.2 transition returns it; historical expired/released/
 * consumed rows are excluded by state, never by mutation). The caller
 * asserts `heldCount === activeHolds` after every bounded scenario.
 */
export async function reconcileUnit(
  db: Kysely<DB>,
  unit: UnitRef,
): Promise<UnitReconciliation> {
  const spec = unitSpec(unit.kind);
  const row = await sql<{
    capacity: number;
    booked_count: number;
    held_count: number;
    state: string;
    active_holds: string;
    active_unexpired: string;
  }>`
    SELECT u.capacity, u.booked_count, u.held_count, u.state,
           (SELECT count(*) FROM capacity_hold h
             WHERE h.${sql.id(spec.holdColumn)} = u.id AND h.state = 'active') AS active_holds,
           (SELECT count(*) FROM capacity_hold h
             WHERE h.${sql.id(spec.holdColumn)} = u.id AND h.state = 'active'
               AND h.expires_at > now()) AS active_unexpired
    FROM ${sql.id(spec.table)} u WHERE u.id = ${unit.id}`.execute(db);
  const r = row.rows[0]!;
  return {
    capacity: r.capacity,
    bookedCount: r.booked_count,
    heldCount: r.held_count,
    activeHolds: Number(r.active_holds),
    activeUnexpiredHolds: Number(r.active_unexpired),
    state: r.state,
  };
}
