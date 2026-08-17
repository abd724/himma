import type { ApiJsonResponse } from '../../api/client';
import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import type {
  AddBranchAssociationOutcome,
  AddMediaOutcome,
  AddOfferOutcome,
  AddPriceOptionOutcome,
  ArchiveMediaOutcome,
  ArchivePriceOptionOutcome,
  CreateProgramOutcome,
  EndOfferOutcome,
  ListingEditorPort,
  MediaInput,
  MediaPatch,
  OfferInput,
  OfferPatch,
  PriceOptionInput,
  PriceOptionPatch,
  ProgramCreateInput,
  ProgramPatch,
  RemoveBranchAssociationOutcome,
  UpdateMediaOutcome,
  UpdateOfferOutcome,
  UpdatePriceOptionOutcome,
  UpdateProgramOutcome,
} from '../../catalogue/editor-contract';
import { offerFrom, priceOptionFrom, programMediaFrom } from './live-catalogue-ports';

/**
 * LIVE listing editor mutations (W2-12C2) — the production implementation
 * of the approved W2-8 `ListingEditorPort` over the authenticated W2-12A
 * transport, operation for operation against the REAL Slice-4 catalogue
 * management routes (see editor-contract.ts for the 13-route table).
 *
 * Semantics come entirely from the backend — this port maps, it never
 * decides:
 * - the edit-state matrix (draft/changes_requested direct ·
 *   approved/published/paused review-gated · submitted/in_review/archived
 *   locked) is server truth: `lifecycleConflict` maps 1:1;
 * - PROTECTED edits on review-gated listings ride the backend's automatic
 *   ProgramRevision routing — a program PATCH or price-option mutation
 *   whose change is sensitive answers `revisionSubmitted` (live values
 *   untouched until Himma approves), and a second competing sensitive
 *   change answers `revisionPending`. No decision/withdrawal operation
 *   exists anywhere, and this port never bypasses the revision model;
 * - CAS: every `expectedVersion` is passed through untouched, and
 *   `staleVersion` maps 1:1 — no retry, no last-write-wins, the caller
 *   refetches canonical truth and reconciles through the existing UX;
 * - Offer windows pass through as the exact ISO date-time strings the
 *   wire contract defines (the timestamptz invariant) — no timezone
 *   policy is invented here;
 * - a response outside the approved DTO shape FAILS CLOSED to
 *   `unavailable` — no partial truth, no fixture fallback (fixture code
 *   is not reachable from this module), and canonical success only ever
 *   comes from the backend response.
 */

const codeOf = (response: ApiJsonResponse): string => response.code ?? '';

/** Shared policy-layer refusals every operation can map. */
function policyRefusal(
  code: string,
): { kind: 'forbidden' } | { kind: 'notFound' } | { kind: 'organizationSuspended' } | null {
  switch (code) {
    case 'forbidden':
    case 'mfaRequired': // cannot occur behind the guard chain; stays safe
      return { kind: 'forbidden' };
    case 'notFound':
      return { kind: 'notFound' };
    case 'organizationSuspended':
      return { kind: 'organizationSuspended' };
    default:
      return null;
  }
}

function statusOf(response: ApiJsonResponse): string | null {
  const body = response.body as { status?: unknown } | null;
  return body !== null && typeof body.status === 'string' ? body.status : null;
}

function revisionIdOf(response: ApiJsonResponse): string | null {
  const body = response.body as { revisionId?: unknown } | null;
  return body !== null && typeof body.revisionId === 'string' ? body.revisionId : null;
}

export function createLiveListingEditorPort(transport: LiveTransport): ListingEditorPort {
  const listingPath = (organizationId: string, suffix = '') =>
    `/provider/organizations/${encodeURIComponent(organizationId)}/listings${suffix}`;
  const programPath = (organizationId: string, programId: string, suffix = '') =>
    listingPath(organizationId, `/${encodeURIComponent(programId)}${suffix}`);

  const request = async (
    path: string,
    method: 'POST' | 'PATCH',
    body: unknown,
  ): Promise<ApiJsonResponse | null> => transport.authorizedRequest(path, { method, body });

  return {
    async createProgram(organizationId, input: ProgramCreateInput): Promise<CreateProgramOutcome> {
      const response = await request(listingPath(organizationId), 'POST', input);
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'programCreated') {
        const program = (response.body as { program?: unknown }).program as
          | Record<string, unknown>
          | undefined;
        if (
          typeof program !== 'object' ||
          program === null ||
          typeof program.id !== 'string' ||
          typeof program.listingState !== 'string' ||
          typeof program.version !== 'number'
        ) {
          return { kind: 'unavailable' };
        }
        // The canonical id/version come from the backend — never invented.
        return {
          kind: 'programCreated',
          program: {
            id: program.id,
            listingState: program.listingState,
            version: program.version,
          },
        };
      }
      switch (codeOf(response)) {
        case 'invalidTaxonomy':
          return { kind: 'invalidTaxonomy' };
        case 'invalidEligibility':
          return { kind: 'invalidEligibility' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async updateProgram(
      organizationId,
      programId,
      expectedVersion,
      patch: ProgramPatch,
    ): Promise<UpdateProgramOutcome> {
      const response = await request(programPath(organizationId, programId), 'PATCH', {
        expectedVersion,
        ...patch,
      });
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const body = response.body as {
          status?: unknown;
          version?: unknown;
          revisionId?: unknown;
          appliedFields?: unknown;
          deferredFields?: unknown;
        } | null;
        if (body?.status === 'programUpdated' && typeof body.version === 'number') {
          return { kind: 'programUpdated', version: body.version };
        }
        if (
          body?.status === 'revisionSubmitted' &&
          typeof body.revisionId === 'string' &&
          Array.isArray(body.appliedFields) &&
          body.appliedFields.every((field) => typeof field === 'string') &&
          Array.isArray(body.deferredFields) &&
          body.deferredFields.every((field) => typeof field === 'string')
        ) {
          // The backend routed the protected part of this change into an
          // open ProgramRevision — live values stay untouched until Himma
          // approves; nothing here pretends otherwise.
          return {
            kind: 'revisionSubmitted',
            revisionId: body.revisionId,
            appliedFields: body.appliedFields,
            deferredFields: body.deferredFields,
          };
        }
        return { kind: 'unavailable' };
      }
      switch (codeOf(response)) {
        case 'revisionPending':
          return { kind: 'revisionPending' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'invalidTaxonomy':
          return { kind: 'invalidTaxonomy' };
        case 'invalidEligibility':
          return { kind: 'invalidEligibility' };
        case 'staleVersion':
          return { kind: 'staleVersion' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async addPriceOption(
      organizationId,
      programId,
      input: PriceOptionInput,
    ): Promise<AddPriceOptionOutcome> {
      const response = await request(
        programPath(organizationId, programId, '/price-options'),
        'POST',
        input,
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        if (statusOf(response) === 'optionAdded') {
          const option = priceOptionFrom((response.body as { option?: unknown }).option);
          return option === null ? { kind: 'unavailable' } : { kind: 'optionAdded', option };
        }
        const revisionId = revisionIdOf(response);
        if (statusOf(response) === 'revisionSubmitted' && revisionId !== null) {
          return { kind: 'revisionSubmitted', revisionId };
        }
        return { kind: 'unavailable' };
      }
      switch (codeOf(response)) {
        case 'revisionPending':
          return { kind: 'revisionPending' };
        case 'invalidPriceOption':
          return { kind: 'invalidPriceOption' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async updatePriceOption(
      organizationId,
      programId,
      optionId,
      expectedVersion,
      patch: PriceOptionPatch,
    ): Promise<UpdatePriceOptionOutcome> {
      const response = await request(
        programPath(organizationId, programId, `/price-options/${encodeURIComponent(optionId)}`),
        'PATCH',
        { expectedVersion, ...patch },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        if (statusOf(response) === 'optionUpdated') {
          const option = priceOptionFrom((response.body as { option?: unknown }).option);
          return option === null ? { kind: 'unavailable' } : { kind: 'optionUpdated', option };
        }
        const revisionId = revisionIdOf(response);
        if (statusOf(response) === 'revisionSubmitted' && revisionId !== null) {
          return { kind: 'revisionSubmitted', revisionId };
        }
        return { kind: 'unavailable' };
      }
      switch (codeOf(response)) {
        case 'revisionPending':
          return { kind: 'revisionPending' };
        case 'invalidPriceOption':
          return { kind: 'invalidPriceOption' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'staleVersion':
          return { kind: 'staleVersion' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async archivePriceOption(
      organizationId,
      programId,
      optionId,
      expectedVersion,
    ): Promise<ArchivePriceOptionOutcome> {
      const response = await request(
        programPath(
          organizationId,
          programId,
          `/price-options/${encodeURIComponent(optionId)}/archive`,
        ),
        'POST',
        { expectedVersion },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        if (statusOf(response) === 'optionArchived') return { kind: 'optionArchived' };
        const revisionId = revisionIdOf(response);
        if (statusOf(response) === 'revisionSubmitted' && revisionId !== null) {
          return { kind: 'revisionSubmitted', revisionId };
        }
        return { kind: 'unavailable' };
      }
      switch (codeOf(response)) {
        case 'revisionPending':
          return { kind: 'revisionPending' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'staleVersion':
          return { kind: 'staleVersion' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async addBranchAssociation(
      organizationId,
      programId,
      branchId,
    ): Promise<AddBranchAssociationOutcome> {
      const response = await request(programPath(organizationId, programId, '/branches'), 'POST', {
        branchId,
      });
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'branchAssociated') {
        return { kind: 'branchAssociated' };
      }
      switch (codeOf(response)) {
        case 'invalidBranchScope': // the wire code for the service's invalidBranch
          return { kind: 'invalidBranch' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async removeBranchAssociation(
      organizationId,
      programId,
      branchId,
    ): Promise<RemoveBranchAssociationOutcome> {
      const response = await request(
        programPath(organizationId, programId, `/branches/${encodeURIComponent(branchId)}/remove`),
        'POST',
        {},
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'branchAssociationRemoved') {
        return { kind: 'branchAssociationRemoved' };
      }
      switch (codeOf(response)) {
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async addMedia(organizationId, programId, input: MediaInput): Promise<AddMediaOutcome> {
      const response = await request(programPath(organizationId, programId, '/media'), 'POST', input);
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'mediaAdded') {
        const media = programMediaFrom((response.body as { media?: unknown }).media);
        return media === null ? { kind: 'unavailable' } : { kind: 'mediaAdded', media };
      }
      switch (codeOf(response)) {
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async updateMedia(
      organizationId,
      programId,
      mediaId,
      expectedVersion,
      patch: MediaPatch,
    ): Promise<UpdateMediaOutcome> {
      const response = await request(
        programPath(organizationId, programId, `/media/${encodeURIComponent(mediaId)}`),
        'PATCH',
        { expectedVersion, ...patch },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'mediaUpdated') {
        const media = programMediaFrom((response.body as { media?: unknown }).media);
        return media === null ? { kind: 'unavailable' } : { kind: 'mediaUpdated', media };
      }
      switch (codeOf(response)) {
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'staleVersion':
          return { kind: 'staleVersion' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async archiveMedia(
      organizationId,
      programId,
      mediaId,
      expectedVersion,
    ): Promise<ArchiveMediaOutcome> {
      const response = await request(
        programPath(organizationId, programId, `/media/${encodeURIComponent(mediaId)}/archive`),
        'POST',
        { expectedVersion },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'mediaArchived') {
        return { kind: 'mediaArchived' };
      }
      switch (codeOf(response)) {
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'staleVersion':
          return { kind: 'staleVersion' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async addOffer(organizationId, programId, input: OfferInput): Promise<AddOfferOutcome> {
      const response = await request(programPath(organizationId, programId, '/offers'), 'POST', input);
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'offerAdded') {
        const offer = offerFrom((response.body as { offer?: unknown }).offer);
        return offer === null ? { kind: 'unavailable' } : { kind: 'offerAdded', offer };
      }
      switch (codeOf(response)) {
        case 'invalidOffer':
          return { kind: 'invalidOffer' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async updateOffer(
      organizationId,
      programId,
      offerId,
      expectedVersion,
      patch: OfferPatch,
    ): Promise<UpdateOfferOutcome> {
      const response = await request(
        programPath(organizationId, programId, `/offers/${encodeURIComponent(offerId)}`),
        'PATCH',
        { expectedVersion, ...patch },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'offerUpdated') {
        const offer = offerFrom((response.body as { offer?: unknown }).offer);
        return offer === null ? { kind: 'unavailable' } : { kind: 'offerUpdated', offer };
      }
      switch (codeOf(response)) {
        case 'invalidOffer':
          return { kind: 'invalidOffer' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'staleVersion':
          return { kind: 'staleVersion' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async endOffer(organizationId, programId, offerId, expectedVersion): Promise<EndOfferOutcome> {
      const response = await request(
        programPath(organizationId, programId, `/offers/${encodeURIComponent(offerId)}/end`),
        'POST',
        { expectedVersion },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'offerEnded') {
        return { kind: 'offerEnded' };
      }
      switch (codeOf(response)) {
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'staleVersion':
          return { kind: 'staleVersion' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },
  };
}
