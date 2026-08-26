/**
 * S6-1 — the entitlement-acquisition quote (docs/35 §4; D-S6-1/D-S6-3).
 *
 * The UNIT-LESS branch of the certified quote authority: a package/
 * membership product has no Session/CampWeek/Cohort at quote time and gets
 * none — the quote binds Program + price option + participant + provider
 * organization + the IMMUTABLE fulfillment revision in force when the
 * customer was quoted (`commercial_shape = 'entitlementAcquisition'`,
 * `ck_price_quote_shape`). A provider edit between quote and confirmation
 * supersedes the revision but never changes what THIS quote sells.
 *
 * Same certified conventions as the capacity path: server-authored money
 * only (the option's catalogue amount — integer fils, AED; a genuine zero
 * is the free-acquisition path), D-6 quote TTL, append-only immutability,
 * participant ownership + age eligibility (program-level — there is no
 * unit to override it; evaluated at quote time), audit-only emission.
 * Offers are NOT applied to entitlement products in V1 (D-10 freeTrial
 * stays a session-trial rule — docs/35 §5.5; discount semantics deferred).
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import { withTransaction } from '../../../db/transaction';
import { DEFAULT_QUOTE_TTL_SECONDS } from '../../booking/services/booking-shared';
import type { CustomerActor } from '../../booking/services/booking-shared';
import {
  loadFulfillmentContext,
  fulfillmentTermsView,
  type EntitlementServiceDeps,
  type FulfillmentTermsView,
} from './entitlement-shared';

export interface RequestEntitlementQuoteInput {
  programId: string;
  priceOptionId: string;
  participantId: string;
}

export interface EntitlementQuoteView {
  quoteId: string;
  programId: string;
  organizationId: string;
  participantId: string;
  optionKind: string;
  totalFils: number;
  currency: 'AED';
  priceKind: 'oneOff';
  taxTreatment: 'notConfigured';
  lines: Array<{ lineNo: number; kind: 'base'; labelEn: string; amountFils: number }>;
  expiresAt: string; // ISO
  /** Customer-safe display of the immutable terms this quote sells — values
   *  only, never revision identifiers. */
  fulfillment: FulfillmentTermsView;
}

export type RequestEntitlementQuoteResult =
  | { kind: 'quoteIssued'; quote: EntitlementQuoteView }
  | { kind: 'programNotFound' }
  | { kind: 'programNotBookable' }
  | { kind: 'priceOptionNotFound' }
  /** The option is a capacity kind — the certified capacity quote owns it. */
  | { kind: 'optionNotEntitlement' }
  | { kind: 'participantNotFound' }
  | { kind: 'participantIneligible' }
  /** No ACTIVE fulfillment revision (or the product's fixed end date has
   *  passed) — fail-closed: nothing sellable exists (docs/35 §4). */
  | { kind: 'fulfillmentUnavailable' };

/** Full years between date of birth and `at` (UTC civil). */
function ageAtDate(dateOfBirth: Date, at: Date): number {
  let age = at.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = at.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

export async function requestEntitlementQuote(
  deps: EntitlementServiceDeps,
  actor: CustomerActor,
  input: RequestEntitlementQuoteInput,
): Promise<RequestEntitlementQuoteResult> {
  const ttlSeconds = deps.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
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
      .select(['id', 'kind', 'amount_fils', 'sessions_count', 'label_en', 'state'])
      .where('id', '=', input.priceOptionId)
      .where('program_id', '=', input.programId)
      .executeTakeFirst();
    if (option === undefined || option.state !== 'active') {
      return { kind: 'priceOptionNotFound' as const };
    }
    if (option.kind !== 'package' && option.kind !== 'membership') {
      return { kind: 'optionNotEntitlement' as const };
    }

    // docs/24 §2.5: child suitability is purely age-based; with no unit the
    // gate evaluates at quote time against the program's range.
    if (participant.kind === 'child' && !program.all_ages) {
      const minAge = program.min_age;
      const maxAge = program.max_age;
      if (minAge !== null || maxAge !== null) {
        if (participant.date_of_birth === null) {
          return { kind: 'participantIneligible' as const }; // fail closed
        }
        const now = new Date();
        const age = ageAtDate(participant.date_of_birth, now);
        if ((minAge !== null && age < minAge) || (maxAge !== null && age > maxAge)) {
          return { kind: 'participantIneligible' as const };
        }
      }
    }

    // The immutable terms in force NOW — fail-closed when absent or lapsed.
    const context = await loadFulfillmentContext(trx, option.id);
    if (context === undefined) return { kind: 'fulfillmentUnavailable' as const };

    // Entitlement kinds always carry a catalogue amount (0 is a genuine
    // free product — the §5.5 non-payment acquisition path).
    const totalFils = Number(option.amount_fils);
    if (!Number.isInteger(totalFils) || totalFils < 0) {
      return { kind: 'priceOptionNotFound' as const };
    }
    const labelEn = option.label_en ?? option.kind;

    const quoteId = newId();
    const inserted = await sql<{ expires_at: Date }>`
      INSERT INTO price_quote (id, organization_id, program_id, account_id, participant_id,
                               option_kind, price_option_id, commercial_shape,
                               fulfillment_revision_id, total_fils, price_kind, expires_at)
      VALUES (${quoteId}, ${program.organization_id}, ${input.programId}, ${actor.accountId},
              ${input.participantId}, ${option.kind}, ${option.id}, 'entitlementAcquisition',
              ${context.revision.id}, ${totalFils}, 'oneOff',
              now() + make_interval(secs => ${ttlSeconds}))
      RETURNING expires_at`.execute(trx);
    await sql`
      INSERT INTO price_quote_line (id, quote_id, line_no, kind, label_en, amount_fils)
      VALUES (${newId()}, ${quoteId}, 1, 'base', ${labelEn}, ${totalFils})`.execute(trx);

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
        totalFils,
        currency: 'AED' as const,
        priceKind: 'oneOff' as const,
        taxTreatment: 'notConfigured' as const,
        lines: [{ lineNo: 1, kind: 'base' as const, labelEn, amountFils: totalFils }],
        expiresAt: inserted.rows[0]!.expires_at.toISOString(),
        fulfillment: fulfillmentTermsView(context),
      },
    };
  });
}
