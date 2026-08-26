/**
 * Provider check-in seam — mirrors the two REAL S6-2 provider check-in
 * routes (backend/src/modules/entitlement/http/attendance-provider-routes.ts)
 * field for field. W2-13 implements this port over the live API; the
 * semantic fixture stands behind the same contract for fixture mode.
 *
 * - `previewCheckIn` ⇄ `POST /provider/organizations/:orgId/check-in/preview`
 *   (capability `attendance.manage`). A PURE READ: it grants nothing,
 *   consumes nothing, and creates no attendance — the backend resolves the
 *   8-digit code ONLY within the authenticated organization among
 *   effectively-live credentials and re-checks branch/coach scope.
 *   Foreign-org, random, superseded, and unknown codes are ONE generic
 *   not-found (deliberate S6-2 privacy shaping — the UI must not invent
 *   distinctions the backend refuses to make).
 * - `redeemCheckIn` ⇄ `POST …/check-in/redeem` (same capability; HTTP
 *   **201** on success). The ATOMIC check-in: the backend revalidates
 *   EVERYTHING (live credential, expiry, org, staff scope, target, finite
 *   balance, attendance uniqueness) — preview output is never authority,
 *   and the portal never decrements anything optimistically.
 *
 * Deliberately absent (docs/35; owner W2-13 items 19–20, 33): QR scanning
 * (later presentation over the same opaque credential authority), manual
 * attendance/balance mutation, customer search/consume shortcuts,
 * provider-generated customer codes, reservation creation (S6-3).
 */

export const CHECK_IN_OPERATIONS = ['previewCheckIn', 'redeemCheckIn'] as const;

export type CheckInTargetKind = 'session' | 'reservedEntitlementUse' | 'walkIn';

export interface CheckInUsage {
  readonly usageKind: 'finite' | 'unlimited';
  readonly usesTotal?: number;
  readonly used?: number;
  readonly remaining?: number;
}

export interface CheckInValidity {
  readonly validFrom: string; // ISO
  readonly validUntil?: string; // ISO
}

export interface CheckInPreview {
  readonly credentialId: string;
  readonly expiresAt: string; // ISO — the credential's ~10-minute window
  readonly participantFirstName: string;
  readonly programTitle: string;
  readonly targetKind: CheckInTargetKind;
  readonly sessionStartAt?: string; // ISO
  readonly branchLabel?: string;
  readonly usage?: CheckInUsage;
  readonly validity?: CheckInValidity;
}

export interface CheckInAttendance {
  readonly attendanceId: string;
  readonly credentialId: string;
  readonly participantFirstName: string;
  readonly programTitle: string;
  readonly targetKind: CheckInTargetKind;
  readonly occurredAt: string; // ISO
  readonly remaining?: number;
  readonly entitlementExhausted?: boolean;
}

/** The exact backend refusal vocabulary, typed — the UI maps kinds to
 *  provider-facing copy and NEVER renders server prose or codes. */
export type CheckInRefusalKind =
  | 'codeNotFound' // notFound — unknown/foreign/superseded (generic by design)
  | 'codeExpired' // credentialExpired
  | 'codeAlreadyUsed' // credentialAlreadyUsed
  | 'notAuthorized' // forbidden — branch/coach scope
  | 'entitlementNotActive'
  | 'entitlementExhausted'
  | 'tooManyAttempts' // rateLimited — the DURABLE backend limiter
  | 'unavailable';

export type PreviewCheckInOutcome =
  | { readonly kind: 'preview'; readonly preview: CheckInPreview }
  | { readonly kind: CheckInRefusalKind };

export type RedeemCheckInOutcome =
  | { readonly kind: 'attendanceRecorded'; readonly attendance: CheckInAttendance }
  | { readonly kind: CheckInRefusalKind };

export interface CheckInPort {
  previewCheckIn(organizationId: string, code: string): Promise<PreviewCheckInOutcome>;
  redeemCheckIn(
    organizationId: string,
    input: { code: string; credentialId: string; idempotencyKey: string },
  ): Promise<RedeemCheckInOutcome>;
}
