/**
 * RI-4 — the shared check-in ISSUANCE entry (owner RI-4 §15/§18).
 *
 * One helper every check-in surface uses: issue (or find already-live)
 * through the real S6 credential API with a STABLE per-target idempotency
 * key, stash the one-time secret in memory, and hand back where to
 * navigate. The S6-2 initial-issuance semantics are honored exactly: an
 * `alreadyLive` response carries NO secret and is never retried in a loop —
 * the credential screen offers explicit regeneration instead.
 */
import { newIdempotencyKey } from '@/features/booking/commerce-session';
import { stashCredential } from '@/features/checkin/credential-store';
import type {
  EntitlementsApi,
  IssueCredentialOutcome,
  OccurrenceSelection,
} from '@/services/contracts/entitlements';

export type CheckInTarget =
  | { kind: 'booking'; bookingId: string; occurrence?: OccurrenceSelection }
  | { kind: 'entitlement'; entitlementId: string };

/**
 * PENDING issuance keys per material intent (target + occurrence): a double
 * tap or a lost-response retry replays the SAME issuance — never a second
 * credential. Once an outcome is OBSERVED the intent is complete and the
 * key retires: the customer's NEXT check-in on the same target (e.g. after
 * the previous credential was redeemed) is a new material intent, not a
 * replay of the old one.
 */
const issueKeys = new Map<string, string>();

function issueSignature(target: CheckInTarget): string {
  return target.kind === 'booking'
    ? `booking|${target.bookingId}|${target.occurrence?.date ?? ''}|${target.occurrence?.startTime ?? ''}`
    : `entitlement|${target.entitlementId}`;
}

export function issueKeyFor(target: CheckInTarget): string {
  const signature = issueSignature(target);
  let key = issueKeys.get(signature);
  if (key === undefined) {
    key = newIdempotencyKey();
    issueKeys.set(signature, key);
  }
  return key;
}

/** The observed outcome retires the pending key (exported for tests). */
export function retireIssueKey(target: CheckInTarget): void {
  issueKeys.delete(issueSignature(target));
}

/** The credential-screen href for an outcome — target identifiers ride the
 *  route (ids are not secrets); the display code NEVER does. */
export function credentialHref(credentialId: string, target: CheckInTarget): string {
  const params = new URLSearchParams();
  if (target.kind === 'booking') {
    params.set('booking', target.bookingId);
    if (target.occurrence !== undefined) {
      params.set('date', target.occurrence.date);
      params.set('time', target.occurrence.startTime);
    }
  } else {
    params.set('entitlement', target.entitlementId);
  }
  return `/checkin/${credentialId}?${params.toString()}`;
}

export interface IssueForTargetResult {
  outcome: IssueCredentialOutcome;
  href: string;
}

/**
 * Issue (initial) for a target. On `issued` the secret is stashed in
 * memory before navigation; on `alreadyLive` there is no secret — the
 * screen renders metadata + explicit regeneration. Typed ApiErrors are the
 * caller's to map (error-copy).
 */
export async function issueForTarget(
  api: EntitlementsApi,
  target: CheckInTarget,
  regenerateCredentialId?: string,
): Promise<IssueForTargetResult> {
  const request = {
    idempotencyKey:
      regenerateCredentialId === undefined
        ? issueKeyFor(target)
        : // Regeneration is a NEW material intent each time the customer
          // explicitly asks — never a replay of the initial issuance key.
          newIdempotencyKey(),
    ...(regenerateCredentialId !== undefined ? { regenerateCredentialId } : {}),
  };
  const outcome =
    target.kind === 'booking'
      ? await api.issueBookingCredential(target.bookingId, {
          ...request,
          ...(target.occurrence !== undefined ? { occurrence: target.occurrence } : {}),
        })
      : await api.issueEntitlementCredential(target.entitlementId, request);
  // Outcome observed → the pending initial-issuance key retires (a later
  // check-in on this target is a NEW intent; a failed call keeps the key
  // so the retry replays).
  if (regenerateCredentialId === undefined) retireIssueKey(target);
  if (outcome.kind === 'issued' && outcome.credential.displayCode !== undefined) {
    stashCredential({
      credentialId: outcome.credential.credentialId,
      displayCode: outcome.credential.displayCode,
      expiresAt: outcome.credential.expiresAt,
    });
  }
  return { outcome, href: credentialHref(outcome.credential.credentialId, target) };
}
