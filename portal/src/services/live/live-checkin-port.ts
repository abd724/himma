import type { ApiJsonResponse } from '../../api/client';
import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import type {
  CheckInAttendance,
  CheckInPort,
  CheckInPreview,
  CheckInRefusalKind,
  PreviewCheckInOutcome,
  RedeemCheckInOutcome,
} from '../../checkin/contract';

/**
 * LIVE provider check-in (W2-13) — the production implementation of the
 * `CheckInPort` over the authenticated transport, against the REAL S6-2
 * routes. Semantics come entirely from the backend — this port maps, it
 * never decides: preview is a pure read (grants nothing), redeem is the
 * single atomic authority (the backend revalidates everything; preview
 * output is never a local redeem proof), refusal codes map 1:1 into the
 * typed vocabulary (generic `notFound` stays generic — the S6-2 privacy
 * shaping is preserved, never "improved"), and any response outside the
 * approved DTO shape FAILS CLOSED to `unavailable`. Raw codes travel to
 * the backend only; nothing here stores, logs, or invents credential
 * authority, and no QR/scanner path exists.
 */

const codeOf = (response: ApiJsonResponse): string => response.code ?? '';

function refusalOf(code: string): CheckInRefusalKind {
  switch (code) {
    case 'notFound':
      return 'codeNotFound';
    case 'credentialExpired':
      return 'codeExpired';
    case 'credentialAlreadyUsed':
      return 'codeAlreadyUsed';
    case 'forbidden':
    case 'mfaRequired':
      return 'notAuthorized';
    case 'entitlementNotActive':
      return 'entitlementNotActive';
    case 'entitlementExhausted':
      return 'entitlementExhausted';
    case 'rateLimited':
      return 'tooManyAttempts';
    default:
      return 'unavailable';
  }
}

function stringOr(value: unknown, fallback: null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const TARGET_KINDS = ['session', 'reservedEntitlementUse', 'walkIn'] as const;

function previewFrom(raw: unknown): CheckInPreview | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const credentialId = stringOr(record.credentialId, null);
  const expiresAt = stringOr(record.expiresAt, null);
  const participantFirstName = stringOr(record.participantFirstName, null);
  const programTitle = stringOr(record.programTitle, null);
  const targetKind = record.targetKind;
  if (
    credentialId === null ||
    expiresAt === null ||
    participantFirstName === null ||
    programTitle === null ||
    !(TARGET_KINDS as readonly unknown[]).includes(targetKind)
  ) {
    return null;
  }
  const usageRaw = record.usage;
  let usage: CheckInPreview['usage'];
  if (typeof usageRaw === 'object' && usageRaw !== null) {
    const usageRecord = usageRaw as Record<string, unknown>;
    if (usageRecord.usageKind === 'finite' || usageRecord.usageKind === 'unlimited') {
      const usesTotal = optionalNumber(usageRecord.usesTotal);
      const used = optionalNumber(usageRecord.used);
      const remaining = optionalNumber(usageRecord.remaining);
      usage = {
        usageKind: usageRecord.usageKind,
        ...(usesTotal !== undefined ? { usesTotal } : {}),
        ...(used !== undefined ? { used } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
      };
    }
  }
  const validityRaw = record.validity;
  let validity: CheckInPreview['validity'];
  if (typeof validityRaw === 'object' && validityRaw !== null) {
    const validityRecord = validityRaw as Record<string, unknown>;
    const validFrom = stringOr(validityRecord.validFrom, null);
    if (validFrom !== null) {
      const validUntil = optionalString(validityRecord.validUntil);
      validity = {
        validFrom,
        ...(validUntil !== undefined ? { validUntil } : {}),
      };
    }
  }
  const sessionStartAt = optionalString(record.sessionStartAt);
  const branchLabel = optionalString(record.branchLabel);
  return {
    credentialId,
    expiresAt,
    participantFirstName,
    programTitle,
    targetKind: targetKind as CheckInPreview['targetKind'],
    ...(sessionStartAt !== undefined ? { sessionStartAt } : {}),
    ...(branchLabel !== undefined ? { branchLabel } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(validity !== undefined ? { validity } : {}),
  };
}

function attendanceFrom(raw: unknown): CheckInAttendance | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const attendanceId = stringOr(record.attendanceId, null);
  const credentialId = stringOr(record.credentialId, null);
  const participantFirstName = stringOr(record.participantFirstName, null);
  const programTitle = stringOr(record.programTitle, null);
  const occurredAt = stringOr(record.occurredAt, null);
  const targetKind = record.targetKind;
  if (
    attendanceId === null ||
    credentialId === null ||
    participantFirstName === null ||
    programTitle === null ||
    occurredAt === null ||
    !(TARGET_KINDS as readonly unknown[]).includes(targetKind)
  ) {
    return null;
  }
  const remaining = optionalNumber(record.remaining);
  return {
    attendanceId,
    credentialId,
    participantFirstName,
    programTitle,
    targetKind: targetKind as CheckInAttendance['targetKind'],
    occurredAt,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(record.entitlementExhausted === true ? { entitlementExhausted: true } : {}),
  };
}

const checkInPath = (organizationId: string, suffix: string): string =>
  `/provider/organizations/${encodeURIComponent(organizationId)}/check-in${suffix}`;

export function createLiveCheckInPort(transport: LiveTransport): CheckInPort {
  return {
    async previewCheckIn(organizationId, code): Promise<PreviewCheckInOutcome> {
      const response = await transport.authorizedRequest(
        checkInPath(organizationId, '/preview'),
        { method: 'POST', body: { code } },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const preview = previewFrom((response.body as { preview?: unknown }).preview);
        return preview === null ? { kind: 'unavailable' } : { kind: 'preview', preview };
      }
      return { kind: refusalOf(codeOf(response)) };
    },

    async redeemCheckIn(organizationId, input): Promise<RedeemCheckInOutcome> {
      const response = await transport.authorizedRequest(
        checkInPath(organizationId, '/redeem'),
        {
          method: 'POST',
          body: {
            code: input.code,
            credentialId: input.credentialId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      // The atomic redeem answers 201 Created — never 200.
      if (response.status === 201) {
        const attendance = attendanceFrom(
          (response.body as { attendance?: unknown }).attendance,
        );
        return attendance === null
          ? { kind: 'unavailable' }
          : { kind: 'attendanceRecorded', attendance };
      }
      return { kind: refusalOf(codeOf(response)) };
    },
  };
}
