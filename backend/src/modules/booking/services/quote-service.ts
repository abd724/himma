/**
 * PriceQuote issuance — the S5-3 quote seam (docs/24 §2.6, §3.2, §4.1;
 * docs/32 §10; owner rulings D-6 quote TTL 15 min, D-7 trials derive from
 * Offers). The server-computed money truth for one `(program, option, unit,
 * participant)` intent: IMMUTABLE after creation (S5-1 append-only guards +
 * the deferred total==Σ(lines) trigger), base lines only, `tax_treatment =
 * 'notConfigured'` until the owner's VAT ruling (§18 #11 — structure
 * complete, config empty), integer fils, AED. A quote NEVER reserves
 * capacity — the §7.1 hold transaction is the only reservation authority.
 *
 * Trial derivation (D-7): a trial applies the program's ACTIVE trial Offer
 * to the ordinary quote — `freeTrial` prices the base line at 0 (the 0008
 * CHECK pins freeTrial to a NULL amount), `paidTrial` at its
 * `trial_amount_fils`. `discount`/`promo` offers are informational catalogue
 * content (0008) and refuse quote application. No new price kind exists.
 *
 * S5-5 additions at this boundary: (1) the docs/24 §2.5 participant
 * eligibility evaluation deferred by S5-3 — child suitability is PURELY
 * age-based, computed against the unit's start date with per-session
 * overrides (null = inherit); adults are NEVER gender-filtered
 * automatically and the participant model carries no gender, so the
 * certified server rule set is exactly the age gate (docs/24 §2.5.1–2);
 * (2) the D-10 advisory precheck — a participant who already holds the
 * lifetime freeTrial redemption for the Program is refused a trial quote
 * up front (the transactional AUTHORITY lives in confirmFreeBooking).
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import { withTransaction } from '../../../db/transaction';
import {
  DEFAULT_QUOTE_TTL_SECONDS,
  unitSpec,
  type BookingServiceDeps,
  type CustomerActor,
  type UnitRef,
} from './booking-shared';

export interface RequestQuoteInput {
  programId: string;
  priceOptionId: string;
  unit: UnitRef;
  participantId: string;
  /** D-7: an active trial Offer to apply (freeTrial → 0, paidTrial → amount). */
  offerId?: string;
}

export interface QuoteView {
  quoteId: string;
  programId: string;
  organizationId: string;
  participantId: string;
  optionKind: string;
  unitKind: UnitRef['kind'];
  unitId: string;
  offerId?: string;
  totalFils: number;
  currency: 'AED';
  priceKind: 'oneOff' | 'cadence' | 'free';
  taxTreatment: 'notConfigured';
  lines: Array<{ lineNo: number; kind: 'base'; labelEn: string; amountFils: number }>;
  expiresAt: string; // ISO
}

export type RequestQuoteResult =
  | { kind: 'quoteIssued'; quote: QuoteView }
  | { kind: 'programNotFound' }
  | { kind: 'programNotBookable' }
  | { kind: 'priceOptionNotFound' }
  | { kind: 'unitNotFound' }
  | { kind: 'participantNotFound' }
  /** docs/24 §2.5: the child participant's age at the unit's start date
   *  falls outside the effective (program ⊕ session-override) range. */
  | { kind: 'participantIneligible' }
  /** D-10: this participant already redeemed their lifetime freeTrial for
   *  this Program (advisory here; authoritative at confirmation). */
  | { kind: 'trialAlreadyRedeemed' }
  | { kind: 'offerNotFound' }
  | { kind: 'offerNotApplicable' };

/** Full years between date of birth and the unit's start date (UTC civil). */
function ageAtDate(dateOfBirth: Date, at: Date): number {
  let age = at.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = at.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

const PRICE_KIND_BY_OPTION: Record<string, 'oneOff' | 'cadence' | 'free'> = {
  dropIn: 'oneOff',
  camp: 'oneOff',
  package: 'oneOff',
  monthly: 'cadence',
  term: 'cadence',
  free: 'free',
};

export async function requestQuote(
  deps: BookingServiceDeps,
  actor: CustomerActor,
  input: RequestQuoteInput,
): Promise<RequestQuoteResult> {
  const ttlSeconds = deps.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
  const spec = unitSpec(input.unit.kind);
  return withTransaction(deps.db, async (trx) => {
    const program = await trx
      .selectFrom('program')
      .select(['id', 'organization_id', 'listing_state', 'min_age', 'max_age', 'all_ages'])
      .where('id', '=', input.programId)
      .executeTakeFirst();
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (program.listing_state !== 'published') return { kind: 'programNotBookable' as const };

    const participant = await trx
      .selectFrom('participant')
      .select(['id', 'kind', 'date_of_birth'])
      .where('id', '=', input.participantId)
      .where('account_id', '=', actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (participant === undefined) return { kind: 'participantNotFound' as const };

    const option = await trx
      .selectFrom('program_price_option')
      .select(['id', 'kind', 'amount_fils', 'label_en', 'state'])
      .where('id', '=', input.priceOptionId)
      .where('program_id', '=', input.programId)
      .executeTakeFirst();
    if (option === undefined || option.state !== 'active') {
      return { kind: 'priceOptionNotFound' as const };
    }

    const unitRow = await sql<{
      id: string;
      program_id: string;
      start_on: Date;
      override_min_age: number | null;
      override_max_age: number | null;
      override_all_ages: boolean | null;
    }>`
      SELECT id, program_id,
             ${sql.raw(
               input.unit.kind === 'session'
                 ? `start_at AS start_on, override_min_age, override_max_age, override_all_ages`
                 : input.unit.kind === 'campWeek'
                   ? `start_date AS start_on, NULL::int AS override_min_age,
                      NULL::int AS override_max_age, NULL::boolean AS override_all_ages`
                   : `effective_start AS start_on, NULL::int AS override_min_age,
                      NULL::int AS override_max_age, NULL::boolean AS override_all_ages`,
             )}
      FROM ${sql.id(spec.table)} WHERE id = ${input.unit.id}`.execute(trx);
    const unit = unitRow.rows[0];
    if (unit?.program_id !== input.programId) {
      return { kind: 'unitNotFound' as const };
    }

    // docs/24 §2.5 (owner-final): child suitability is PURELY age-based,
    // computed against the unit's start date; session overrides are
    // nullable mirrors (null = inherit); adults are never auto-filtered.
    if (participant.kind === 'child') {
      const allAges = unit.override_all_ages ?? program.all_ages;
      if (!allAges) {
        const minAge = unit.override_min_age ?? program.min_age;
        const maxAge = unit.override_max_age ?? program.max_age;
        if (minAge !== null || maxAge !== null) {
          if (participant.date_of_birth === null) {
            return { kind: 'participantIneligible' as const }; // fail closed
          }
          const age = ageAtDate(participant.date_of_birth, unit.start_on);
          if ((minAge !== null && age < minAge) || (maxAge !== null && age > maxAge)) {
            return { kind: 'participantIneligible' as const };
          }
        }
      }
    }

    // Money derivation: the option's catalogue amount, overridden by an
    // applied trial Offer (D-7). Integer fils, AED — nothing else exists.
    let totalFils =
      option.kind === 'free' ? 0 : Number(option.amount_fils ?? Number.NaN);
    let labelEn = option.label_en ?? option.kind;
    if (input.offerId !== undefined) {
      const offer = await trx
        .selectFrom('offer')
        .select(['id', 'kind', 'state', 'trial_amount_fils', 'effective_start', 'effective_end', 'label_en'])
        .where('id', '=', input.offerId)
        .where('program_id', '=', input.programId)
        .executeTakeFirst();
      if (offer === undefined) return { kind: 'offerNotFound' as const };
      const now = new Date();
      const inWindow =
        (offer.effective_start === null || offer.effective_start <= now) &&
        (offer.effective_end === null || offer.effective_end > now);
      if (offer.state !== 'active' || !inWindow) return { kind: 'offerNotApplicable' as const };
      if (offer.kind === 'freeTrial') {
        // D-10 advisory precheck: the lifetime (participant, program)
        // entitlement — the transactional authority re-decides at the
        // §7.3 confirmation boundary.
        const redeemed = await trx
          .selectFrom('trial_redemption')
          .select('booking_id')
          .where('participant_id', '=', input.participantId)
          .where('program_id', '=', input.programId)
          .executeTakeFirst();
        if (redeemed !== undefined) return { kind: 'trialAlreadyRedeemed' as const };
        totalFils = 0;
      } else if (offer.kind === 'paidTrial') {
        totalFils = Number(offer.trial_amount_fils);
      } else {
        // discount/promo are informational catalogue content (0008) — they
        // never change money until their owner-decided pricing rules exist.
        return { kind: 'offerNotApplicable' as const };
      }
      labelEn = offer.label_en;
    }
    if (!Number.isInteger(totalFils) || totalFils < 0) {
      // A paid option without an amount cannot exist under the 0008 CHECKs;
      // fail closed rather than quote garbage if it ever did.
      return { kind: 'priceOptionNotFound' as const };
    }

    const quoteId = newId();
    const priceKind = PRICE_KIND_BY_OPTION[option.kind]!;
    const inserted = await sql<{ expires_at: Date }>`
      INSERT INTO price_quote (id, organization_id, program_id, account_id, participant_id,
                               option_kind, price_option_id, offer_id, ${sql.id(spec.holdColumn)},
                               total_fils, price_kind, expires_at)
      VALUES (${quoteId}, ${program.organization_id}, ${input.programId}, ${actor.accountId},
              ${input.participantId}, ${option.kind}, ${option.id}, ${input.offerId ?? null},
              ${input.unit.id}, ${totalFils}, ${priceKind},
              now() + make_interval(secs => ${ttlSeconds}))
      RETURNING expires_at`.execute(trx);
    await sql`
      INSERT INTO price_quote_line (id, quote_id, line_no, kind, label_en, amount_fils)
      VALUES (${newId()}, ${quoteId}, 1, 'base', ${labelEn}, ${totalFils})`.execute(trx);

    // Audit-only (docs/32 §17: quotes are not domain state changes — no outbox).
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.accountId,
      principalContext: 'customer',
      action: 'quote.created',
      entityType: 'price_quote',
      entityId: quoteId,
    });

    return {
      kind: 'quoteIssued' as const,
      quote: {
        quoteId,
        programId: input.programId,
        organizationId: program.organization_id,
        participantId: input.participantId,
        optionKind: option.kind,
        unitKind: input.unit.kind,
        unitId: input.unit.id,
        ...(input.offerId !== undefined ? { offerId: input.offerId } : {}),
        totalFils,
        currency: 'AED' as const,
        priceKind,
        taxTreatment: 'notConfigured' as const,
        lines: [{ lineNo: 1, kind: 'base' as const, labelEn, amountFils: totalFils }],
        expiresAt: inserted.rows[0]!.expires_at.toISOString(),
      },
    };
  });
}
