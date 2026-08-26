/**
 * W2-13 — provider fulfillment-configuration administration (docs/35 §3;
 * owner W2-13 items 2–6, 22–23, 26). The bounded backend companion S6-1
 * recorded W2-13 as owning: the FIRST provider mutation surface for
 * `price_option_fulfillment_revision`.
 *
 * AUTHORIZATION: fulfillment configuration is PRODUCT configuration — it
 * rides the exact certified capability that already owns the parent price
 * option (`listings.manage`: owner · org_manager · listings_editor;
 * branch_manager within listing branch scope, re-enforced service-side via
 * `programInBranchScope`). `attendance.manage` grants NOTHING here — front
 * desk and coach cannot edit products.
 *
 * IMMUTABLE REVISION MODEL (S6-1, unchanged): an "edit" NEVER mutates a
 * row — it supersedes the current ACTIVE revision (locked, CAS) and
 * inserts the next immutable `revision_no` with its schedule-term VALUE
 * snapshot. Previously sold quotes/entitlements stay bound to their
 * historical revision; a new revision affects FUTURE purchases only.
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import {
  findOrgProgram,
  programInBranchScope,
  type CatalogueActor,
  type CatalogueServiceDeps,
} from '../../catalogue/services/catalogue-shared';
import { branchInScope, type OrgScope } from '../../provider/services/provider-principal';

export interface FulfillmentScheduleTermInput {
  /** 0 = Sunday … 6 = Saturday (the certified weekday convention). */
  weekday: number;
  startTime: string; // HH:MM
  endTime: string; // HH:MM
}

export interface FulfillmentTermsInput {
  usageKind: 'finite' | 'unlimited';
  /** Finite MEMBERSHIP total; a package's total IS its sessions_count. */
  usesTotal?: number;
  validityKind: 'daysFromConfirmation' | 'fixedEndDate' | 'none';
  validityDays?: number;
  validityEndDate?: string; // YYYY-MM-DD
  reservationRequired: boolean;
  walkInAllowed: boolean;
  branchId?: string;
  /** Membership promised-pattern snapshot (immutable VALUES). */
  scheduleTerms?: FulfillmentScheduleTermInput[];
}

export interface FulfillmentRevisionView {
  revisionId: string;
  revisionNo: number;
  state: 'active' | 'superseded';
  usageKind: 'finite' | 'unlimited';
  usesTotal?: number;
  validityKind: 'daysFromConfirmation' | 'fixedEndDate' | 'none';
  validityDays?: number;
  validityEndDate?: string;
  reservationRequired: boolean;
  walkInAllowed: boolean;
  branchId?: string;
  scheduleTerms: FulfillmentScheduleTermInput[];
  createdAt: string; // ISO
}

export type GetFulfillmentConfigResult =
  | {
      kind: 'fulfillmentConfig';
      optionKind: string;
      /** FALSE for capacity kinds — they carry no fulfillment config. */
      supported: boolean;
      active: FulfillmentRevisionView | null;
    }
  | { kind: 'programNotFound' }
  | { kind: 'optionNotFound' }
  | { kind: 'forbidden' };

export type SetFulfillmentConfigResult =
  | { kind: 'revisionCreated'; revision: FulfillmentRevisionView }
  | { kind: 'programNotFound' }
  | { kind: 'optionNotFound' }
  | { kind: 'forbidden' }
  /** Capacity kinds carry no fulfillment configuration. */
  | { kind: 'optionNotEntitlement' }
  | { kind: 'invalidFulfillmentConfig' }
  | { kind: 'invalidBranch' }
  | { kind: 'lifecycleConflict' };

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function termsValid(optionKind: string, terms: FulfillmentTermsInput): boolean {
  if (optionKind === 'package') {
    // A package's total derives from the certified sessions_count.
    if (terms.usageKind !== 'finite' || terms.usesTotal !== undefined) return false;
  } else if (terms.usageKind === 'finite') {
    if (
      terms.usesTotal === undefined ||
      !Number.isInteger(terms.usesTotal) ||
      terms.usesTotal <= 0
    ) {
      return false;
    }
  } else if (terms.usesTotal !== undefined) {
    return false;
  }
  if (terms.validityKind === 'daysFromConfirmation') {
    if (
      terms.validityDays === undefined ||
      !Number.isInteger(terms.validityDays) ||
      terms.validityDays <= 0 ||
      terms.validityEndDate !== undefined
    ) {
      return false;
    }
  } else if (terms.validityKind === 'fixedEndDate') {
    if (terms.validityEndDate === undefined || terms.validityDays !== undefined) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(terms.validityEndDate)) return false;
  } else {
    // 'none' — finite-only (an unlimited pass with no expiry is not a V1
    // product) and carries neither validity value.
    if (terms.usageKind !== 'finite') return false;
    if (terms.validityDays !== undefined || terms.validityEndDate !== undefined) return false;
  }
  if (!terms.reservationRequired && !terms.walkInAllowed) return false;
  if (terms.scheduleTerms !== undefined) {
    // The promised-pattern snapshot exists for schedule-bound MEMBERSHIP
    // products only (docs/35 §12).
    if (optionKind !== 'membership' || terms.scheduleTerms.length === 0) return false;
    for (const term of terms.scheduleTerms) {
      if (!Number.isInteger(term.weekday) || term.weekday < 0 || term.weekday > 6) return false;
      if (!TIME_PATTERN.test(term.startTime) || !TIME_PATTERN.test(term.endTime)) return false;
      if (term.startTime >= term.endTime) return false;
    }
  }
  return true;
}

interface RevisionRow {
  id: string;
  revision_no: number;
  state: string;
  usage_kind: string;
  uses_total: number | null;
  validity_kind: string;
  validity_days: number | null;
  validity_end_date: Date | null;
  reservation_required: boolean;
  walk_in_allowed: boolean;
  branch_id: string | null;
  created_at: Date;
}

const REVISION_COLUMNS = [
  'id',
  'revision_no',
  'state',
  'usage_kind',
  'uses_total',
  'validity_kind',
  'validity_days',
  'validity_end_date',
  'reservation_required',
  'walk_in_allowed',
  'branch_id',
  'created_at',
] as const;

function toRevisionView(
  row: RevisionRow,
  scheduleTerms: FulfillmentScheduleTermInput[],
): FulfillmentRevisionView {
  return {
    revisionId: row.id,
    revisionNo: row.revision_no,
    state: row.state as 'active' | 'superseded',
    usageKind: row.usage_kind as 'finite' | 'unlimited',
    ...(row.uses_total !== null ? { usesTotal: Number(row.uses_total) } : {}),
    validityKind: row.validity_kind as FulfillmentRevisionView['validityKind'],
    ...(row.validity_days !== null ? { validityDays: row.validity_days } : {}),
    ...(row.validity_end_date !== null
      ? { validityEndDate: row.validity_end_date.toISOString().slice(0, 10) }
      : {}),
    reservationRequired: row.reservation_required,
    walkInAllowed: row.walk_in_allowed,
    ...(row.branch_id !== null ? { branchId: row.branch_id } : {}),
    scheduleTerms,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadScheduleTerms(
  trx: Parameters<Parameters<typeof withTransaction>[1]>[0],
  revisionId: string,
): Promise<FulfillmentScheduleTermInput[]> {
  const rows = await sql<{ weekday: number; start_time: string; end_time: string }>`
    SELECT weekday, to_char(start_time, 'HH24:MI') AS start_time,
           to_char(end_time, 'HH24:MI') AS end_time
    FROM price_option_fulfillment_schedule_term
    WHERE revision_id = ${revisionId}
    ORDER BY weekday, start_time`.execute(trx);
  return rows.rows.map((row) => ({
    weekday: row.weekday,
    startTime: row.start_time,
    endTime: row.end_time,
  }));
}

export async function getFulfillmentConfig(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  input: { programId: string; optionId: string },
): Promise<GetFulfillmentConfigResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (!(await programInBranchScope(trx, scope, input.programId))) {
      return { kind: 'forbidden' as const };
    }
    const option = await trx
      .selectFrom('program_price_option')
      .select(['id', 'kind'])
      .where('id', '=', input.optionId)
      .where('program_id', '=', input.programId)
      .executeTakeFirst();
    if (option === undefined) return { kind: 'optionNotFound' as const };
    const supported = option.kind === 'package' || option.kind === 'membership';
    if (!supported) {
      return {
        kind: 'fulfillmentConfig' as const,
        optionKind: option.kind,
        supported,
        active: null,
      };
    }
    const active = await trx
      .selectFrom('price_option_fulfillment_revision')
      .select(REVISION_COLUMNS)
      .where('price_option_id', '=', input.optionId)
      .where('state', '=', 'active')
      .executeTakeFirst();
    return {
      kind: 'fulfillmentConfig' as const,
      optionKind: option.kind,
      supported,
      active:
        active === undefined
          ? null
          : toRevisionView(active as RevisionRow, await loadScheduleTerms(trx, active.id)),
    };
  });
}

export async function setFulfillmentConfig(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; optionId: string; terms: FulfillmentTermsInput },
): Promise<SetFulfillmentConfigResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (!(await programInBranchScope(trx, scope, input.programId))) {
      return { kind: 'forbidden' as const };
    }
    const option = await trx
      .selectFrom('program_price_option')
      .select(['id', 'kind', 'state'])
      .where('id', '=', input.optionId)
      .where('program_id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (option === undefined) return { kind: 'optionNotFound' as const };
    if (option.kind !== 'package' && option.kind !== 'membership') {
      return { kind: 'optionNotEntitlement' as const };
    }
    // An archived option is retired commercial history — its config is too.
    if (option.state === 'archived') return { kind: 'lifecycleConflict' as const };
    if (!termsValid(option.kind, input.terms)) {
      return { kind: 'invalidFulfillmentConfig' as const };
    }
    // Branch limitation: only a branch the provider owns AND the acting
    // scope can manage.
    if (input.terms.branchId !== undefined) {
      const branch = await trx
        .selectFrom('branch')
        .select(['id', 'active'])
        .where('id', '=', input.terms.branchId)
        .where('organization_id', '=', scope.organizationId)
        .executeTakeFirst();
      if (branch === undefined || !branch.active) return { kind: 'invalidBranch' as const };
      if (!branchInScope(scope, input.terms.branchId)) return { kind: 'forbidden' as const };
    }

    // Supersede-and-insert (the immutable revision model): lock the current
    // ACTIVE revision, retire it, insert the next revision_no.
    const current = await sql<{ id: string; revision_no: number }>`
      SELECT id, revision_no FROM price_option_fulfillment_revision
      WHERE price_option_id = ${input.optionId} AND state = 'active'
      FOR UPDATE`.execute(trx);
    let nextRevisionNo = 1;
    for (const previous of current.rows) {
      const moved = await trx
        .updateTable('price_option_fulfillment_revision')
        .set({ state: 'superseded' })
        .where('id', '=', previous.id)
        .where('state', '=', 'active')
        .executeTakeFirst();
      if ((moved.numUpdatedRows ?? 0n) !== 1n) {
        throw new Error(`fulfillment revision ${previous.id} supersede CAS lost under lock`);
      }
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: actor.userId,
        principalContext: 'provider',
        action: 'fulfillment.revision.superseded',
        entityType: 'price_option_fulfillment_revision',
        entityId: previous.id,
      });
    }
    const maxNo = await sql<{ max: number | null }>`
      SELECT max(revision_no) AS max FROM price_option_fulfillment_revision
      WHERE price_option_id = ${input.optionId}`.execute(trx);
    nextRevisionNo = (maxNo.rows[0]!.max ?? 0) + 1;

    const revisionId = newId();
    await sql`
      INSERT INTO price_option_fulfillment_revision
        (id, price_option_id, program_id, organization_id, revision_no, usage_kind,
         uses_total, validity_kind, validity_days, validity_end_date,
         reservation_required, walk_in_allowed, branch_id)
      VALUES (${revisionId}, ${input.optionId}, ${input.programId}, ${scope.organizationId},
              ${nextRevisionNo}, ${input.terms.usageKind}, ${input.terms.usesTotal ?? null},
              ${input.terms.validityKind}, ${input.terms.validityDays ?? null},
              ${input.terms.validityEndDate ?? null}, ${input.terms.reservationRequired},
              ${input.terms.walkInAllowed}, ${input.terms.branchId ?? null})`.execute(trx);
    for (const term of input.terms.scheduleTerms ?? []) {
      await sql`
        INSERT INTO price_option_fulfillment_schedule_term
          (id, revision_id, weekday, start_time, end_time)
        VALUES (${newId()}, ${revisionId}, ${term.weekday}, ${term.startTime},
                ${term.endTime})`.execute(trx);
    }
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      principalContext: 'provider',
      action: 'fulfillment.revision.created',
      entityType: 'price_option_fulfillment_revision',
      entityId: revisionId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'price_option_fulfillment_revision',
      aggregateId: revisionId,
      eventType: 'fulfillment.revision.created',
      payload: {
        revisionId,
        priceOptionId: input.optionId,
        programId: input.programId,
        organizationId: scope.organizationId,
        revisionNo: nextRevisionNo,
      },
    });

    const created = await trx
      .selectFrom('price_option_fulfillment_revision')
      .select(REVISION_COLUMNS)
      .where('id', '=', revisionId)
      .executeTakeFirstOrThrow();
    return {
      kind: 'revisionCreated' as const,
      revision: toRevisionView(created as RevisionRow, await loadScheduleTerms(trx, revisionId)),
    };
  });
}
