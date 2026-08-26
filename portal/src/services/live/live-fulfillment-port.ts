import type { ApiJsonResponse } from '../../api/client';
import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import type {
  FulfillmentConfigPort,
  FulfillmentRevision,
  FulfillmentScheduleTerm,
  LoadFulfillmentOutcome,
  SetFulfillmentOutcome,
} from '../../catalogue/fulfillment-contract';

/**
 * LIVE fulfillment-configuration port (W2-13) — the production
 * implementation over the authenticated transport against the REAL W2-13
 * provider routes. Semantics are backend truth: saving supersedes the
 * active revision and inserts the next IMMUTABLE one (historical/sold
 * terms never change — the caller communicates "future purchases only"),
 * validation refusals map 1:1, and any response outside the approved DTO
 * shape FAILS CLOSED to `unavailable`. No fixture code is reachable here.
 */

const codeOf = (response: ApiJsonResponse): string => response.code ?? '';

const VALIDITY_KINDS = ['daysFromConfirmation', 'fixedEndDate', 'none'] as const;

function scheduleTermsFrom(raw: unknown): FulfillmentScheduleTerm[] | null {
  if (!Array.isArray(raw)) return null;
  const terms: FulfillmentScheduleTerm[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.weekday !== 'number' ||
      typeof record.startTime !== 'string' ||
      typeof record.endTime !== 'string'
    ) {
      return null;
    }
    terms.push({
      weekday: record.weekday,
      startTime: record.startTime,
      endTime: record.endTime,
    });
  }
  return terms;
}

function revisionFrom(raw: unknown): FulfillmentRevision | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const scheduleTerms = scheduleTermsFrom(record.scheduleTerms);
  if (
    typeof record.revisionId !== 'string' ||
    typeof record.revisionNo !== 'number' ||
    (record.state !== 'active' && record.state !== 'superseded') ||
    (record.usageKind !== 'finite' && record.usageKind !== 'unlimited') ||
    !(VALIDITY_KINDS as readonly unknown[]).includes(record.validityKind) ||
    typeof record.reservationRequired !== 'boolean' ||
    typeof record.walkInAllowed !== 'boolean' ||
    typeof record.createdAt !== 'string' ||
    scheduleTerms === null
  ) {
    return null;
  }
  return {
    revisionId: record.revisionId,
    revisionNo: record.revisionNo,
    state: record.state,
    usageKind: record.usageKind,
    ...(typeof record.usesTotal === 'number' ? { usesTotal: record.usesTotal } : {}),
    validityKind: record.validityKind as FulfillmentRevision['validityKind'],
    ...(typeof record.validityDays === 'number' ? { validityDays: record.validityDays } : {}),
    ...(typeof record.validityEndDate === 'string'
      ? { validityEndDate: record.validityEndDate }
      : {}),
    reservationRequired: record.reservationRequired,
    walkInAllowed: record.walkInAllowed,
    ...(typeof record.branchId === 'string' ? { branchId: record.branchId } : {}),
    scheduleTerms,
    createdAt: record.createdAt,
  };
}

const fulfillmentPath = (organizationId: string, programId: string, optionId: string): string =>
  `/provider/organizations/${encodeURIComponent(organizationId)}/programs/${encodeURIComponent(
    programId,
  )}/price-options/${encodeURIComponent(optionId)}/fulfillment`;

export function createLiveFulfillmentPort(transport: LiveTransport): FulfillmentConfigPort {
  return {
    async loadFulfillment(organizationId, programId, optionId): Promise<LoadFulfillmentOutcome> {
      const response = await transport.authorizedRequest(
        fulfillmentPath(organizationId, programId, optionId),
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const body = (response.body as { fulfillment?: unknown }).fulfillment;
        if (typeof body !== 'object' || body === null) return { kind: 'unavailable' };
        const record = body as Record<string, unknown>;
        if (typeof record.optionKind !== 'string' || typeof record.supported !== 'boolean') {
          return { kind: 'unavailable' };
        }
        if (record.active === null) {
          return {
            kind: 'fulfillment',
            optionKind: record.optionKind,
            supported: record.supported,
            active: null,
          };
        }
        const active = revisionFrom(record.active);
        if (active === null) return { kind: 'unavailable' };
        return {
          kind: 'fulfillment',
          optionKind: record.optionKind,
          supported: record.supported,
          active,
        };
      }
      switch (codeOf(response)) {
        case 'notFound':
          return { kind: 'notFound' };
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        default:
          return { kind: 'unavailable' };
      }
    },

    async setFulfillment(
      organizationId,
      programId,
      optionId,
      terms,
    ): Promise<SetFulfillmentOutcome> {
      const response = await transport.authorizedRequest(
        fulfillmentPath(organizationId, programId, optionId),
        { method: 'PUT', body: terms },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const revision = revisionFrom((response.body as { revision?: unknown }).revision);
        return revision === null
          ? { kind: 'unavailable' }
          : { kind: 'revisionCreated', revision };
      }
      switch (codeOf(response)) {
        case 'invalidFulfillmentConfig':
          return { kind: 'invalidFulfillmentConfig' };
        case 'invalidBranchScope':
          return { kind: 'invalidBranch' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'notFound':
          return { kind: 'notFound' };
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        default:
          return { kind: 'unavailable' };
      }
    },
  };
}
