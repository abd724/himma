/**
 * Program media-reference and Offer provider services (S4-2; docs/28 §14,
 * §16.2; docs/24 §2.2).
 *
 * Media rows are metadata/reference ownership ONLY — no upload, storage,
 * transformation, CDN, or signed-URL behavior exists anywhere here, and no
 * credential-shaped value is accepted (media_ref is an opaque uuid).
 * Offers are structured catalogue metadata (Offer ≠ ProgramPriceOption):
 * never a coupon engine, promo-code system, booking inventory, discount
 * ledger, or entitlement. Neither media nor offers are in the docs/28 §7
 * admin-designated sensitive set (the revision schema cannot even represent
 * them), so they edit directly in every provider-editable state and hot-
 * apply on published listings with their own audit/outbox events.
 */
import { newId } from '../../../db/ids';
import { withTransaction } from '../../../db/transaction';
import type { OrgScope } from '../../provider/services/provider-principal';
import {
  editModeOf,
  findOrgProgram,
  programInBranchScope,
  type CatalogueActor,
  type CatalogueServiceDeps,
  type OfferView,
  type ProgramMediaView,
} from './catalogue-shared';
import { emitListingEvent } from './program-management';

type ProgramGate =
  | { kind: 'ok' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' };

async function gateProgram(
  trx: Parameters<typeof findOrgProgram>[0],
  scope: OrgScope,
  programId: string,
): Promise<ProgramGate> {
  const program = await findOrgProgram(trx, scope, programId);
  if (program === undefined) return { kind: 'programNotFound' };
  if (editModeOf(program.listing_state) === 'locked') return { kind: 'lifecycleConflict' };
  if (!(await programInBranchScope(trx, scope, programId))) return { kind: 'forbidden' };
  return { kind: 'ok' };
}

// -- media references ---------------------------------------------------------

const MEDIA_COLUMNS = [
  'id',
  'media_ref',
  'sort_hint',
  'alt_text_en',
  'alt_text_ar',
  'active',
  'version',
] as const;

function toMediaView(row: {
  id: string;
  media_ref: string;
  sort_hint: number;
  alt_text_en: string | null;
  alt_text_ar: string | null;
  active: boolean;
  version: number;
}): ProgramMediaView {
  return {
    id: row.id,
    mediaRef: row.media_ref,
    sortHint: row.sort_hint,
    altTextEn: row.alt_text_en,
    altTextAr: row.alt_text_ar,
    active: row.active,
    version: row.version,
  };
}

export type AddProgramMediaResult =
  | { kind: 'mediaAdded'; media: ProgramMediaView }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' };

export async function addProgramMedia(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: {
    programId: string;
    mediaRef: string;
    sortHint?: number;
    altTextEn?: string | null;
    altTextAr?: string | null;
  },
): Promise<AddProgramMediaResult> {
  return withTransaction(deps.db, async (trx) => {
    const gate = await gateProgram(trx, scope, input.programId);
    if (gate.kind !== 'ok') return gate;
    const id = newId();
    await trx
      .insertInto('program_media')
      .values({
        id,
        program_id: input.programId,
        organization_id: scope.organizationId,
        media_ref: input.mediaRef,
        sort_hint: input.sortHint ?? 0,
        alt_text_en: input.altTextEn ?? null,
        alt_text_ar: input.altTextAr ?? null,
      })
      .execute();
    await emitListingEvent(
      trx,
      actor,
      scope,
      input.programId,
      'listing.media_changed',
      'listing.media_changed',
      { mediaId: id },
    );
    const created = await trx
      .selectFrom('program_media')
      .select(MEDIA_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { kind: 'mediaAdded' as const, media: toMediaView(created) };
  });
}

export type UpdateProgramMediaResult =
  | { kind: 'mediaUpdated'; media: ProgramMediaView }
  | { kind: 'mediaNotFound' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function updateProgramMedia(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: {
    programId: string;
    mediaId: string;
    expectedVersion: number;
    patch: { sortHint?: number; altTextEn?: string | null; altTextAr?: string | null };
  },
): Promise<UpdateProgramMediaResult> {
  return withTransaction(deps.db, async (trx) => {
    const gate = await gateProgram(trx, scope, input.programId);
    if (gate.kind !== 'ok') return gate;
    const media = await trx
      .selectFrom('program_media')
      .select(['id', 'active', 'version'])
      .where('id', '=', input.mediaId)
      .where('program_id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (media === undefined) return { kind: 'mediaNotFound' as const };
    if (media.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('program_media')
      .set({
        ...(input.patch.sortHint !== undefined ? { sort_hint: input.patch.sortHint } : {}),
        ...(input.patch.altTextEn !== undefined ? { alt_text_en: input.patch.altTextEn } : {}),
        ...(input.patch.altTextAr !== undefined ? { alt_text_ar: input.patch.altTextAr } : {}),
      })
      .where('id', '=', input.mediaId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitListingEvent(
      trx,
      actor,
      scope,
      input.programId,
      'listing.media_changed',
      'listing.media_changed',
      { mediaId: input.mediaId },
    );
    const row = await trx
      .selectFrom('program_media')
      .select(MEDIA_COLUMNS)
      .where('id', '=', input.mediaId)
      .executeTakeFirstOrThrow();
    return { kind: 'mediaUpdated' as const, media: toMediaView(row) };
  });
}

export type ArchiveProgramMediaResult =
  | { kind: 'mediaArchived' }
  | { kind: 'mediaNotFound' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function archiveProgramMedia(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; mediaId: string; expectedVersion: number },
): Promise<ArchiveProgramMediaResult> {
  return withTransaction(deps.db, async (trx) => {
    const gate = await gateProgram(trx, scope, input.programId);
    if (gate.kind !== 'ok') return gate;
    const media = await trx
      .selectFrom('program_media')
      .select(['id', 'active', 'version'])
      .where('id', '=', input.mediaId)
      .where('program_id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (media === undefined) return { kind: 'mediaNotFound' as const };
    if (!media.active) return { kind: 'mediaArchived' as const }; // idempotent
    if (media.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('program_media')
      .set({ active: false })
      .where('id', '=', input.mediaId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitListingEvent(
      trx,
      actor,
      scope,
      input.programId,
      'listing.media_changed',
      'listing.media_changed',
      { mediaId: input.mediaId },
    );
    return { kind: 'mediaArchived' as const };
  });
}

// -- offers -------------------------------------------------------------------

export const OFFER_KINDS = ['freeTrial', 'paidTrial', 'discount', 'promo'] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

const OFFER_COLUMNS = [
  'id',
  'kind',
  'label_en',
  'label_ar',
  'trial_amount_fils',
  'effective_start',
  'effective_end',
  'state',
  'version',
] as const;

function toOfferView(row: {
  id: string;
  kind: string;
  label_en: string;
  label_ar: string | null;
  trial_amount_fils: string | bigint | number | null;
  effective_start: Date | null;
  effective_end: Date | null;
  state: string;
  version: number;
}): OfferView {
  return {
    id: row.id,
    kind: row.kind,
    labelEn: row.label_en,
    labelAr: row.label_ar,
    trialAmountFils: row.trial_amount_fils === null ? null : Number(row.trial_amount_fils),
    effectiveStart: row.effective_start?.toISOString() ?? null,
    effectiveEnd: row.effective_end?.toISOString() ?? null,
    state: row.state,
    version: row.version,
  };
}

/** The S4-1 CHECK ties, prechecked: paidTrial ⇔ positive trial amount;
 *  effective_end strictly after effective_start when both are present. */
function offerShapeValid(input: {
  kind: OfferKind;
  trialAmountFils?: number | null;
  effectiveStart?: Date | null;
  effectiveEnd?: Date | null;
}): boolean {
  const amount = input.trialAmountFils ?? null;
  if (input.kind === 'paidTrial') {
    if (amount === null || !Number.isInteger(amount) || amount <= 0) return false;
  } else if (amount !== null) {
    return false;
  }
  const start = input.effectiveStart ?? null;
  const end = input.effectiveEnd ?? null;
  if (start !== null && end !== null && end.getTime() <= start.getTime()) return false;
  return true;
}

export interface OfferInput {
  kind: OfferKind;
  labelEn: string;
  labelAr?: string | null;
  trialAmountFils?: number | null;
  effectiveStart?: Date | null;
  effectiveEnd?: Date | null;
}

export type AddOfferResult =
  | { kind: 'offerAdded'; offer: OfferView }
  | { kind: 'invalidOffer' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' };

export async function addOffer(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; offer: OfferInput },
): Promise<AddOfferResult> {
  return withTransaction(deps.db, async (trx) => {
    const gate = await gateProgram(trx, scope, input.programId);
    if (gate.kind !== 'ok') return gate;
    if (!offerShapeValid(input.offer)) return { kind: 'invalidOffer' as const };
    const id = newId();
    await trx
      .insertInto('offer')
      .values({
        id,
        program_id: input.programId,
        organization_id: scope.organizationId,
        kind: input.offer.kind,
        label_en: input.offer.labelEn,
        label_ar: input.offer.labelAr ?? null,
        trial_amount_fils: input.offer.trialAmountFils ?? null,
        effective_start: input.offer.effectiveStart ?? null,
        effective_end: input.offer.effectiveEnd ?? null,
      })
      .execute();
    await emitListingEvent(trx, actor, scope, input.programId, 'offer.created', 'offer.created', {
      offerId: id,
    });
    const created = await trx
      .selectFrom('offer')
      .select(OFFER_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { kind: 'offerAdded' as const, offer: toOfferView(created) };
  });
}

export interface OfferPatch {
  labelEn?: string;
  labelAr?: string | null;
  trialAmountFils?: number | null;
  effectiveStart?: Date | null;
  effectiveEnd?: Date | null;
}

export type UpdateOfferResult =
  | { kind: 'offerUpdated'; offer: OfferView }
  | { kind: 'invalidOffer' }
  | { kind: 'offerNotFound' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function updateOffer(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; offerId: string; expectedVersion: number; patch: OfferPatch },
): Promise<UpdateOfferResult> {
  return withTransaction(deps.db, async (trx) => {
    const gate = await gateProgram(trx, scope, input.programId);
    if (gate.kind !== 'ok') return gate;
    const offer = await trx
      .selectFrom('offer')
      .select(OFFER_COLUMNS)
      .where('id', '=', input.offerId)
      .where('program_id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (offer === undefined) return { kind: 'offerNotFound' as const };
    if (offer.state === 'ended') return { kind: 'lifecycleConflict' as const };
    if (offer.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    const merged = {
      kind: offer.kind as OfferKind,
      trialAmountFils:
        input.patch.trialAmountFils !== undefined
          ? input.patch.trialAmountFils
          : offer.trial_amount_fils === null
            ? null
            : Number(offer.trial_amount_fils),
      effectiveStart:
        input.patch.effectiveStart !== undefined ? input.patch.effectiveStart : offer.effective_start,
      effectiveEnd:
        input.patch.effectiveEnd !== undefined ? input.patch.effectiveEnd : offer.effective_end,
    };
    if (!offerShapeValid(merged)) return { kind: 'invalidOffer' as const };

    const updated = await trx
      .updateTable('offer')
      .set({
        ...(input.patch.labelEn !== undefined ? { label_en: input.patch.labelEn } : {}),
        ...(input.patch.labelAr !== undefined ? { label_ar: input.patch.labelAr } : {}),
        ...(input.patch.trialAmountFils !== undefined
          ? { trial_amount_fils: input.patch.trialAmountFils }
          : {}),
        ...(input.patch.effectiveStart !== undefined
          ? { effective_start: input.patch.effectiveStart }
          : {}),
        ...(input.patch.effectiveEnd !== undefined
          ? { effective_end: input.patch.effectiveEnd }
          : {}),
      })
      .where('id', '=', input.offerId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitListingEvent(trx, actor, scope, input.programId, 'offer.updated', 'offer.updated', {
      offerId: input.offerId,
    });
    const row = await trx
      .selectFrom('offer')
      .select(OFFER_COLUMNS)
      .where('id', '=', input.offerId)
      .executeTakeFirstOrThrow();
    return { kind: 'offerUpdated' as const, offer: toOfferView(row) };
  });
}

export type EndOfferResult =
  | { kind: 'offerEnded' }
  | { kind: 'offerNotFound' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function endOffer(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; offerId: string; expectedVersion: number },
): Promise<EndOfferResult> {
  return withTransaction(deps.db, async (trx) => {
    const gate = await gateProgram(trx, scope, input.programId);
    if (gate.kind !== 'ok') return gate;
    const offer = await trx
      .selectFrom('offer')
      .select(['id', 'state', 'version'])
      .where('id', '=', input.offerId)
      .where('program_id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (offer === undefined) return { kind: 'offerNotFound' as const };
    if (offer.state === 'ended') return { kind: 'offerEnded' as const }; // idempotent
    if (offer.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('offer')
      .set({ state: 'ended' })
      .where('id', '=', input.offerId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitListingEvent(trx, actor, scope, input.programId, 'offer.ended', 'offer.ended', {
      offerId: input.offerId,
    });
    return { kind: 'offerEnded' as const };
  });
}
