/**
 * S6-1 shared entitlement-domain foundation (docs/35 §5–§6).
 *
 * Owns the pieces both acquisition boundaries (free §5.5 and the trusted
 * paid seam §5.4) compose: the immutable fulfillment-context read, the
 * D-S6-4 validity computation (validity starts at successful acquisition
 * CONFIRMATION; first-use activation does not exist in V1), the atomic
 * grant (exactly one Entitlement per confirmed Purchase — `uq_entitlement_
 * purchase` + the 7-column grant-identity composite FK make anything else
 * structurally impossible), and the customer-safe view shapes.
 */
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';

export interface EntitlementServiceDeps {
  db: Db;
  /** D-6 quote TTL (shared service configuration; default 900 s). */
  quoteTtlSeconds?: number;
  /** Purchase checkout-ABANDONMENT window (docs/35 §5.1) — commercial
   *  metadata only, never inventory ownership. Default 1800 s. */
  purchaseWindowSeconds?: number;
  /** TEST-ONLY failure injection at named acquisition points. */
  onAcquirePhase?: (phase: AcquirePhase) => void;
}

export type AcquirePhase = 'purchaseInserted' | 'entitlementInserted' | 'beforeCommit';

export const DEFAULT_PURCHASE_WINDOW_SECONDS = 1800;

/** Purchase reference code — the Booking convention with a distinct
 *  entitlement-purchase prefix (customer-facing, non-enumerable). */
export function generatePurchaseReferenceCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `HMP-${code}`;
}

export interface FulfillmentRevisionRow {
  id: string;
  price_option_id: string;
  usage_kind: 'finite' | 'unlimited';
  uses_total: number | null;
  validity_kind: 'daysFromConfirmation' | 'fixedEndDate' | 'none';
  validity_days: number | null;
  validity_end_date: Date | null;
  reservation_required: boolean;
  walk_in_allowed: boolean;
  branch_id: string | null;
}

export interface FulfillmentContext {
  revision: FulfillmentRevisionRow;
  optionKind: 'package' | 'membership';
  /** The certified package total (docs/35 §3: sessions_count IS the finite
   *  total for `package`; membership finite totals live on the revision). */
  sessionsCount: number | null;
}

/** The finite allowance for a context, or null for unlimited. */
export function usesTotalOf(context: FulfillmentContext): number | null {
  if (context.revision.usage_kind === 'unlimited') return null;
  return context.optionKind === 'package'
    ? context.sessionsCount
    : context.revision.uses_total;
}

export interface FulfillmentTermsView {
  usageKind: 'finite' | 'unlimited';
  usesTotal?: number;
  validityKind: 'daysFromConfirmation' | 'fixedEndDate' | 'none';
  validityDays?: number;
  validityEndDate?: string; // ISO date
  reservationRequired: boolean;
  walkInAllowed: boolean;
}

export function fulfillmentTermsView(context: FulfillmentContext): FulfillmentTermsView {
  const total = usesTotalOf(context);
  const revision = context.revision;
  return {
    usageKind: revision.usage_kind,
    ...(total !== null ? { usesTotal: total } : {}),
    validityKind: revision.validity_kind,
    ...(revision.validity_days !== null ? { validityDays: revision.validity_days } : {}),
    ...(revision.validity_end_date !== null
      ? { validityEndDate: revision.validity_end_date.toISOString().slice(0, 10) }
      : {}),
    reservationRequired: revision.reservation_required,
    walkInAllowed: revision.walk_in_allowed,
  };
}

/** Loads the ACTIVE immutable revision + option facts for an option, or a
 *  specific frozen revision (quote/purchase-bound reads). */
export async function loadFulfillmentContext(
  trx: Trx | Db,
  priceOptionId: string,
  revisionId?: string,
): Promise<FulfillmentContext | undefined> {
  let query = trx
    .selectFrom('price_option_fulfillment_revision as r')
    .innerJoin('program_price_option as o', 'o.id', 'r.price_option_id')
    .select([
      'r.id',
      'r.price_option_id',
      'r.usage_kind',
      'r.uses_total',
      'r.validity_kind',
      'r.validity_days',
      'r.validity_end_date',
      'r.reservation_required',
      'r.walk_in_allowed',
      'r.branch_id',
      'o.kind as option_kind',
      'o.sessions_count',
    ])
    .where('r.price_option_id', '=', priceOptionId);
  query =
    revisionId === undefined
      ? query.where('r.state', '=', 'active')
      : query.where('r.id', '=', revisionId);
  const row = await query.executeTakeFirst();
  if (row === undefined) return undefined;
  const { option_kind, sessions_count, ...revision } = row;
  return {
    revision: revision as FulfillmentRevisionRow,
    optionKind: option_kind as 'package' | 'membership',
    sessionsCount: sessions_count === null ? null : Number(sessions_count),
  };
}

/** A fixed-end-date product whose date has passed can no longer produce a
 *  valid entitlement (its `valid_until` would not exceed `valid_from`). */
export async function fulfillmentLapsed(
  trx: Trx | Db,
  revision: FulfillmentRevisionRow,
): Promise<boolean> {
  if (revision.validity_kind !== 'fixedEndDate') return false;
  const row = await sql<{ lapsed: boolean }>`
    SELECT ((${revision.validity_end_date}::date + 1)::timestamp
             AT TIME ZONE 'Asia/Dubai') <= now() AS lapsed`.execute(trx);
  return row.rows[0]!.lapsed;
}

export interface EntitlementView {
  entitlementId: string;
  usageKind: 'finite' | 'unlimited';
  usesTotal?: number;
  validFrom: string; // ISO
  validUntil?: string; // ISO
  reservationRequired: boolean;
  walkInAllowed: boolean;
}

export interface EntitlementPurchaseView {
  purchaseId: string;
  referenceCode: string | null;
  state: string;
  programId: string;
  organizationId: string;
  participantId: string;
  totalFils: number;
  currency: 'AED';
  createdAt: string; // ISO
  confirmedAt: string | null; // ISO
  entitlement?: EntitlementView;
}

interface PurchaseRowForGrant {
  id: string;
  account_id: string;
  participant_id: string;
  organization_id: string;
  program_id: string;
  price_option_id: string;
  fulfillment_revision_id: string;
  confirmed_at: Date;
}

/**
 * The atomic grant (docs/35 §6): exactly one append-only Entitlement,
 * created COMPLETE inside the caller's confirming transaction. Validity is
 * computed from the acquisition confirmation instant (D-S6-4):
 * `daysFromConfirmation` → confirmed_at + days; `fixedEndDate` → the end of
 * the configured date (Asia/Dubai); `none` → no expiry (finite-only).
 * Emits `entitlement.created` (audit + outbox) exactly once — replays
 * never reach here twice (the idempotency snapshot returns first).
 */
export async function grantEntitlement(
  trx: Trx,
  purchase: PurchaseRowForGrant,
  context: FulfillmentContext,
  eventActor: { type: 'user'; accountId: string } | { type: 'system' },
): Promise<EntitlementView> {
  const revision = context.revision;
  const usesTotal = usesTotalOf(context);
  const entitlementId = newId();
  const inserted = await sql<{ valid_from: Date; valid_until: Date | null }>`
    INSERT INTO entitlement (id, purchase_id, account_id, participant_id, organization_id,
                             program_id, price_option_id, fulfillment_revision_id,
                             usage_kind, uses_total, valid_from, valid_until,
                             reservation_required, walk_in_allowed, branch_id)
    VALUES (${entitlementId}, ${purchase.id}, ${purchase.account_id},
            ${purchase.participant_id}, ${purchase.organization_id}, ${purchase.program_id},
            ${purchase.price_option_id}, ${purchase.fulfillment_revision_id},
            ${revision.usage_kind}, ${usesTotal},
            ${purchase.confirmed_at},
            CASE
              WHEN ${revision.validity_kind} = 'daysFromConfirmation'
                THEN ${purchase.confirmed_at}::timestamptz
                     + make_interval(days => ${revision.validity_days ?? 0})
              WHEN ${revision.validity_kind} = 'fixedEndDate'
                THEN (${revision.validity_end_date}::date + 1)::timestamp
                     AT TIME ZONE 'Asia/Dubai'
              ELSE NULL
            END,
            ${revision.reservation_required}, ${revision.walk_in_allowed},
            ${revision.branch_id})
    RETURNING valid_from, valid_until`.execute(trx);
  const validity = inserted.rows[0]!;

  await appendAuditEvent(trx, {
    actorType: eventActor.type === 'user' ? 'user' : 'system',
    ...(eventActor.type === 'user' ? { actorId: eventActor.accountId } : {}),
    principalContext: eventActor.type === 'user' ? 'customer' : 'system',
    action: 'entitlement.created',
    entityType: 'entitlement',
    entityId: entitlementId,
  });
  await appendOutboxEvent(trx, {
    aggregateType: 'entitlement',
    aggregateId: entitlementId,
    eventType: 'entitlement.created',
    payload: {
      entitlementId,
      purchaseId: purchase.id,
      organizationId: purchase.organization_id,
      usageKind: revision.usage_kind,
      ...(usesTotal !== null ? { usesTotal } : {}),
    },
  });

  return {
    entitlementId,
    usageKind: revision.usage_kind,
    ...(usesTotal !== null ? { usesTotal } : {}),
    validFrom: validity.valid_from.toISOString(),
    ...(validity.valid_until !== null
      ? { validUntil: validity.valid_until.toISOString() }
      : {}),
    reservationRequired: revision.reservation_required,
    walkInAllowed: revision.walk_in_allowed,
  };
}
