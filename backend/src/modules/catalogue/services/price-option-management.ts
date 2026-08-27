/**
 * ProgramPriceOption provider services (S4-2; D-S4-1; docs/28 §7, §16.2).
 *
 * Options are catalogue/commercial metadata ONLY — nothing here touches
 * capacity, entitlements, redemption, or payments. Stable opaque ids are
 * the selection handle; ownership is immutable; retirement is archive-only
 * (the archived row is DB-frozen — no reactivation path exists anywhere).
 * Price options are ADMIN-DESIGNATED SENSITIVE FIELDS: on a review-gated
 * listing (approved/published/paused) every add/edit/archive routes through
 * the §7 revision flow instead of touching the live option set; on a
 * draft/changes_requested listing they edit directly.
 */
import { withTransaction } from '../../../db/transaction';
import { newId } from '../../../db/ids';
import type { OrgScope } from '../../provider/services/provider-principal';
import {
  editModeOf,
  findOrgProgram,
  programInBranchScope,
  toOptionView,
  OPTION_COLUMNS,
  type CatalogueActor,
  type CatalogueServiceDeps,
  type PriceOptionView,
} from './catalogue-shared';
import { createSensitiveRevision, emitListingEvent } from './program-management';

// W2-13 (owning-slice amendment; docs/24 Amendment A4, D-S6-3): `membership`
// joined the COMMERCIAL vocabulary with migration 0017 — commercial only;
// fulfillment semantics live on the immutable fulfillment revision, never
// in this enum.
export const PRICE_OPTION_KINDS = [
  'dropIn',
  'monthly',
  'term',
  'camp',
  'package',
  'free',
  'membership',
] as const;
export type PriceOptionKind = (typeof PRICE_OPTION_KINDS)[number];

/** Entitlement-producing kinds (docs/35 §3): the only kinds that carry a
 *  fulfillment configuration, and the only kinds a genuine ZERO price is
 *  legal for (a free introductory product's real price — 0017). */
export const ENTITLEMENT_OPTION_KINDS = ['package', 'membership'] as const;

export interface PriceOptionInput {
  kind: PriceOptionKind;
  amountFils?: number | null;
  sessionsCount?: number | null;
  labelEn?: string | null;
  labelAr?: string | null;
  sortHint?: number;
}

/** The S4-1/0017 CHECK ties, prechecked for typed outcomes: free ⇔ NULL
 *  amount; capacity paid kinds ⇒ positive integer fils; entitlement kinds
 *  (package/membership) ⇒ integer fils ≥ 0 (a genuine zero price is legal
 *  — 0017); package ⇔ positive sessions_count. */
export function optionShapeValid(input: {
  kind: PriceOptionKind;
  amountFils?: number | null;
  sessionsCount?: number | null;
}): boolean {
  const amount = input.amountFils ?? null;
  const sessions = input.sessionsCount ?? null;
  const entitlementKind = (ENTITLEMENT_OPTION_KINDS as readonly string[]).includes(input.kind);
  if (input.kind === 'free') {
    if (amount !== null) return false;
  } else if (
    amount === null ||
    !Number.isInteger(amount) ||
    (entitlementKind ? amount < 0 : amount <= 0)
  ) {
    return false;
  }
  if (input.kind === 'package') {
    if (sessions === null || !Number.isInteger(sessions) || sessions <= 0) return false;
  } else if (sessions !== null) {
    return false;
  }
  return true;
}

export type AddPriceOptionResult =
  | { kind: 'optionAdded'; option: PriceOptionView }
  | { kind: 'revisionSubmitted'; revisionId: string }
  | { kind: 'revisionPending' }
  | { kind: 'invalidPriceOption' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' };

export async function addPriceOption(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; option: PriceOptionInput },
): Promise<AddPriceOptionResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (!(await programInBranchScope(trx, scope, input.programId))) {
      return { kind: 'forbidden' as const };
    }
    const mode = editModeOf(program.listing_state);
    if (mode === 'locked') return { kind: 'lifecycleConflict' as const };
    if (!optionShapeValid(input.option)) return { kind: 'invalidPriceOption' as const };
    // Membership traverses the ordinary revision path since 0019 widened
    // ck_program_revision_option_kind (the W2-13 typed refusal that stood
    // in for the pre-0019 CHECK is gone) — no kind is special-cased here.

    if (mode === 'reviewGated') {
      const revision = await createSensitiveRevision(trx, scope, actor, input.programId, {
        option: {
          optionId: null, // add-intent
          kind: input.option.kind,
          ...(input.option.amountFils !== undefined ? { amountFils: input.option.amountFils } : {}),
          ...(input.option.sessionsCount !== undefined
            ? { sessionsCount: input.option.sessionsCount }
            : {}),
          ...(input.option.labelEn !== undefined ? { labelEn: input.option.labelEn } : {}),
          ...(input.option.labelAr !== undefined ? { labelAr: input.option.labelAr } : {}),
          ...(input.option.sortHint !== undefined ? { sortHint: input.option.sortHint } : {}),
          state: 'active',
        },
      });
      if (revision.kind === 'revisionPending') return { kind: 'revisionPending' as const };
      return { kind: 'revisionSubmitted' as const, revisionId: revision.revisionId };
    }

    const id = newId();
    await trx
      .insertInto('program_price_option')
      .values({
        id,
        program_id: input.programId,
        organization_id: scope.organizationId,
        kind: input.option.kind,
        amount_fils: input.option.amountFils ?? null,
        sessions_count: input.option.sessionsCount ?? null,
        label_en: input.option.labelEn ?? null,
        label_ar: input.option.labelAr ?? null,
        sort_hint: input.option.sortHint ?? 0,
      })
      .execute();
    await emitListingEvent(
      trx,
      actor,
      scope,
      input.programId,
      'listing.price_option_changed',
      'listing.price_option_changed',
      { optionId: id },
    );
    const created = await trx
      .selectFrom('program_price_option')
      .select(OPTION_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { kind: 'optionAdded' as const, option: toOptionView(created) };
  });
}

export interface PriceOptionPatch {
  kind?: PriceOptionKind;
  amountFils?: number | null;
  sessionsCount?: number | null;
  labelEn?: string | null;
  labelAr?: string | null;
  sortHint?: number;
}

export type UpdatePriceOptionResult =
  | { kind: 'optionUpdated'; option: PriceOptionView }
  | { kind: 'revisionSubmitted'; revisionId: string }
  | { kind: 'revisionPending' }
  | { kind: 'invalidPriceOption' }
  | { kind: 'optionNotFound' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function updatePriceOption(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; optionId: string; expectedVersion: number; patch: PriceOptionPatch },
): Promise<UpdatePriceOptionResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (!(await programInBranchScope(trx, scope, input.programId))) {
      return { kind: 'forbidden' as const };
    }
    const mode = editModeOf(program.listing_state);
    if (mode === 'locked') return { kind: 'lifecycleConflict' as const };

    const option = await trx
      .selectFrom('program_price_option')
      .select(OPTION_COLUMNS)
      .where('id', '=', input.optionId)
      .where('program_id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (option === undefined) return { kind: 'optionNotFound' as const };
    // Archive-only retirement: an archived option is immutable history.
    if (option.state === 'archived') return { kind: 'lifecycleConflict' as const };
    if (option.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    const merged = {
      kind: input.patch.kind ?? (option.kind as PriceOptionKind),
      amountFils:
        input.patch.amountFils !== undefined
          ? input.patch.amountFils
          : option.amount_fils === null
            ? null
            : Number(option.amount_fils),
      sessionsCount:
        input.patch.sessionsCount !== undefined ? input.patch.sessionsCount : option.sessions_count,
    };
    if (!optionShapeValid(merged)) return { kind: 'invalidPriceOption' as const };

    if (mode === 'reviewGated') {
      const revision = await createSensitiveRevision(trx, scope, actor, input.programId, {
        option: {
          optionId: input.optionId,
          ...(input.patch.kind !== undefined ? { kind: input.patch.kind } : {}),
          ...(input.patch.amountFils !== undefined ? { amountFils: input.patch.amountFils } : {}),
          ...(input.patch.sessionsCount !== undefined
            ? { sessionsCount: input.patch.sessionsCount }
            : {}),
          ...(input.patch.labelEn !== undefined ? { labelEn: input.patch.labelEn } : {}),
          ...(input.patch.labelAr !== undefined ? { labelAr: input.patch.labelAr } : {}),
          ...(input.patch.sortHint !== undefined ? { sortHint: input.patch.sortHint } : {}),
        },
      });
      if (revision.kind === 'revisionPending') return { kind: 'revisionPending' as const };
      return { kind: 'revisionSubmitted' as const, revisionId: revision.revisionId };
    }

    const updated = await trx
      .updateTable('program_price_option')
      .set({
        ...(input.patch.kind !== undefined ? { kind: input.patch.kind } : {}),
        ...(input.patch.amountFils !== undefined ? { amount_fils: input.patch.amountFils } : {}),
        ...(input.patch.sessionsCount !== undefined
          ? { sessions_count: input.patch.sessionsCount }
          : {}),
        ...(input.patch.labelEn !== undefined ? { label_en: input.patch.labelEn } : {}),
        ...(input.patch.labelAr !== undefined ? { label_ar: input.patch.labelAr } : {}),
        ...(input.patch.sortHint !== undefined ? { sort_hint: input.patch.sortHint } : {}),
      })
      .where('id', '=', input.optionId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitListingEvent(
      trx,
      actor,
      scope,
      input.programId,
      'listing.price_option_changed',
      'listing.price_option_changed',
      { optionId: input.optionId },
    );
    const row = await trx
      .selectFrom('program_price_option')
      .select(OPTION_COLUMNS)
      .where('id', '=', input.optionId)
      .executeTakeFirstOrThrow();
    return { kind: 'optionUpdated' as const, option: toOptionView(row) };
  });
}

export type ArchivePriceOptionResult =
  | { kind: 'optionArchived' }
  | { kind: 'revisionSubmitted'; revisionId: string }
  | { kind: 'revisionPending' }
  | { kind: 'optionNotFound' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function archivePriceOption(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; optionId: string; expectedVersion: number },
): Promise<ArchivePriceOptionResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (!(await programInBranchScope(trx, scope, input.programId))) {
      return { kind: 'forbidden' as const };
    }
    const mode = editModeOf(program.listing_state);
    if (mode === 'locked') return { kind: 'lifecycleConflict' as const };

    const option = await trx
      .selectFrom('program_price_option')
      .select(['id', 'state', 'version'])
      .where('id', '=', input.optionId)
      .where('program_id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (option === undefined) return { kind: 'optionNotFound' as const };
    if (option.state === 'archived') return { kind: 'optionArchived' as const }; // idempotent
    if (option.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    if (mode === 'reviewGated') {
      const revision = await createSensitiveRevision(trx, scope, actor, input.programId, {
        option: { optionId: input.optionId, state: 'archived' },
      });
      if (revision.kind === 'revisionPending') return { kind: 'revisionPending' as const };
      return { kind: 'revisionSubmitted' as const, revisionId: revision.revisionId };
    }

    const updated = await trx
      .updateTable('program_price_option')
      .set({ state: 'archived' })
      .where('id', '=', input.optionId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitListingEvent(
      trx,
      actor,
      scope,
      input.programId,
      'listing.price_option_archived',
      'listing.price_option_archived',
      { optionId: input.optionId },
    );
    return { kind: 'optionArchived' as const };
  });
}
