import type { ApiJsonResponse } from '../../api/client';
import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import {
  COMPLETENESS_GAPS,
  type ArchiveProgramOutcome,
  type CompletenessGap,
  type ListingLifecyclePort,
  type PauseProgramOutcome,
  type PublishProgramOutcome,
  type SubmitProgramOutcome,
} from '../../catalogue/lifecycle-contract';

/**
 * LIVE listing lifecycle actions (W2-12C3) — the production implementation
 * of the approved W2-9 `ListingLifecyclePort` over the authenticated
 * W2-12A transport, against the four REAL named lifecycle routes:
 *
 * - `POST .../listings/:programId/submit`  (`listings.manage`)  — draft
 *   and changes_requested submit/resubmit (the same action);
 * - `POST .../listings/:programId/publish` (`listings.publish`) — first
 *   publication from `approved` AND resume from `paused` (no separate
 *   resume route exists);
 * - `POST .../listings/:programId/pause`   (`listings.publish`);
 * - `POST .../listings/:programId/archive` (`listings.publish`) —
 *   terminal; the real response carries no version.
 *
 * Everything is server truth, mapped 1:1, never decided here:
 * - completeness/readiness is CANONICAL on the backend — an incomplete
 *   submit/publish answers the structured `programIncomplete` with the
 *   exact service `missing[]` vocabulary (anything outside it fails the
 *   mapping closed rather than inventing a gap);
 * - publication requires the organization to be operationally live
 *   (`organizationNotLive`) — never bypassed or simulated client-side;
 * - approval ≠ publication: nothing here runs after moderation approval
 *   on its own, and no moderation/revision decision is expressible;
 * - CAS: `expectedVersion` passes through untouched; `staleVersion` is
 *   terminal (no retry, no version substitution) — the panel refetches
 *   canonical truth and the provider reconciles;
 * - a response outside the approved DTO shape FAILS CLOSED to
 *   `unavailable`; a network failure never reports success; fixture code
 *   is not reachable from this module.
 */

const codeOf = (response: ApiJsonResponse): string => response.code ?? '';

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

/** The 409 `programIncomplete` body carries the exact service gap
 *  vocabulary; unknown entries fail the mapping closed (never invented). */
function missingGapsFrom(response: ApiJsonResponse): readonly CompletenessGap[] | null {
  const missing = (response.body as { missing?: unknown } | null)?.missing;
  if (!Array.isArray(missing)) return null;
  const gaps: CompletenessGap[] = [];
  for (const entry of missing) {
    if (!(COMPLETENESS_GAPS as readonly string[]).includes(entry as string)) return null;
    gaps.push(entry as CompletenessGap);
  }
  return gaps;
}

export function createLiveLifecyclePort(transport: LiveTransport): ListingLifecyclePort {
  const actionPath = (organizationId: string, programId: string, action: string) =>
    `/provider/organizations/${encodeURIComponent(organizationId)}/listings/${encodeURIComponent(programId)}/${action}`;

  const act = async (
    organizationId: string,
    programId: string,
    action: 'submit' | 'publish' | 'pause' | 'archive',
    expectedVersion: number,
  ): Promise<ApiJsonResponse | null> =>
    transport.authorizedRequest(actionPath(organizationId, programId, action), {
      method: 'POST',
      body: { expectedVersion },
    });

  const versionOf = (response: ApiJsonResponse): number | null => {
    const version = (response.body as { version?: unknown } | null)?.version;
    return typeof version === 'number' ? version : null;
  };

  const statusOf = (response: ApiJsonResponse): string | null => {
    const status = (response.body as { status?: unknown } | null)?.status;
    return typeof status === 'string' ? status : null;
  };

  return {
    async submitProgram(organizationId, programId, expectedVersion): Promise<SubmitProgramOutcome> {
      const response = await act(organizationId, programId, 'submit', expectedVersion);
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'programSubmitted') {
        const version = versionOf(response);
        // Submission ends at the server's word — `submitted`, never an
        // optimistic in_review/approved claim.
        return version === null ? { kind: 'unavailable' } : { kind: 'programSubmitted', version };
      }
      if (codeOf(response) === 'programIncomplete') {
        const missing = missingGapsFrom(response);
        return missing === null ? { kind: 'unavailable' } : { kind: 'programIncomplete', missing };
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

    async publishProgram(
      organizationId,
      programId,
      expectedVersion,
    ): Promise<PublishProgramOutcome> {
      const response = await act(organizationId, programId, 'publish', expectedVersion);
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'programPublished') {
        const version = versionOf(response);
        return version === null ? { kind: 'unavailable' } : { kind: 'programPublished', version };
      }
      if (codeOf(response) === 'programIncomplete') {
        const missing = missingGapsFrom(response);
        return missing === null ? { kind: 'unavailable' } : { kind: 'programIncomplete', missing };
      }
      switch (codeOf(response)) {
        case 'organizationNotLive':
          return { kind: 'organizationNotLive' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'staleVersion':
          return { kind: 'staleVersion' };
        default:
          return policyRefusal(codeOf(response)) ?? { kind: 'unavailable' };
      }
    },

    async pauseProgram(organizationId, programId, expectedVersion): Promise<PauseProgramOutcome> {
      const response = await act(organizationId, programId, 'pause', expectedVersion);
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'programPaused') {
        const version = versionOf(response);
        return version === null ? { kind: 'unavailable' } : { kind: 'programPaused', version };
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

    async archiveProgram(
      organizationId,
      programId,
      expectedVersion,
    ): Promise<ArchiveProgramOutcome> {
      const response = await act(organizationId, programId, 'archive', expectedVersion);
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && statusOf(response) === 'programArchived') {
        // Terminal — the real response carries no version (frozen row).
        return { kind: 'programArchived' };
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
