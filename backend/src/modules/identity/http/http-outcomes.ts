/**
 * Service-outcome → HTTP envelope mapping (docs/24 §11.2, docs/26 §10) —
 * B2-4. One stable envelope `{ code, message }`; nothing here ever exposes
 * PostgreSQL constraint names, provider/JWKS errors, stack traces, raw
 * provider responses, or account-existence information.
 *
 * External vocabulary is the docs/26 §10 set. Deliberate collapses
 * (documented, internally the outcomes stay fully typed):
 * - accountLocked / accountSuspended / accountDeleted → `accountSuspended`
 *   (the §3.8 single non-specific customer message);
 * - sessionNotRegistered / sessionRevoked / sessionExpired / identityEnded
 *   on BEARER requests → `sessionExpired` (revocation state is not leaked);
 * - login-flow evidence failures → `invalidCredentials` (single class,
 *   §5.5); bearer failures → `invalidAccessToken`.
 */
import type { FastifyReply } from 'fastify';

export interface HttpOutcome {
  statusCode: number;
  code: string;
  message: string;
}

export const HTTP_OUTCOMES = {
  invalidAccessToken: {
    statusCode: 401,
    code: 'invalidAccessToken',
    message: 'A valid access token is required.',
  },
  invalidCredentials: {
    statusCode: 401,
    code: 'invalidCredentials',
    message: 'Sign-in could not be completed with the provided credentials.',
  },
  sessionExpired: {
    statusCode: 401,
    code: 'sessionExpired',
    message: 'Your session has ended. Please sign in again.',
  },
  accountSuspended: {
    statusCode: 403,
    code: 'accountSuspended',
    message: 'This account is currently unavailable. Contact support for help.',
  },
  stepUpRequired: {
    statusCode: 403,
    code: 'stepUpRequired',
    message: 'Please re-authenticate to continue.',
  },
  mfaRequired: {
    statusCode: 403,
    code: 'mfaRequired',
    message: 'Multi-factor authentication is required for this action.',
  },
  csrfRejected: {
    statusCode: 403,
    code: 'csrfRejected',
    message: 'The request could not be verified as coming from the Himma portal.',
  },
  dualControlViolation: {
    statusCode: 409,
    code: 'dualControlViolation',
    message: 'A different Access Administrator must approve this request.',
  },
  roleConflict: {
    statusCode: 409,
    code: 'roleConflict',
    message: 'This role conflicts with a role the user already holds.',
  },
  assignmentAlreadyFinalized: {
    statusCode: 409,
    code: 'assignmentAlreadyFinalized',
    message: 'This assignment has already been finalized.',
  },
  forbidden: {
    statusCode: 403,
    code: 'forbidden',
    message: 'You do not have access to this resource.',
  },
  notFound: {
    statusCode: 404,
    code: 'notFound',
    message: 'The requested resource was not found.',
  },
  accountLinkConflict: {
    statusCode: 409,
    code: 'accountLinkConflict',
    message:
      'This sign-in method conflicts with an existing account. Sign in with your existing method, then link it explicitly.',
  },
  identityAlreadyLinked: {
    statusCode: 409,
    code: 'identityAlreadyLinked',
    message: 'This sign-in method is already linked to a different account.',
  },
  lastLoginMethod: {
    statusCode: 409,
    code: 'lastLoginMethod',
    message: 'This is your only sign-in method and cannot be removed.',
  },
  challengeInvalid: {
    statusCode: 400,
    code: 'challengeInvalid',
    message: 'The verification could not be completed. Request a new challenge and try again.',
  },
  staleVersion: {
    statusCode: 409,
    code: 'staleVersion',
    message: 'The resource changed since you loaded it. Refresh and try again.',
  },
  organizationSuspended: {
    statusCode: 403,
    code: 'organizationSuspended',
    message: 'This organization is currently suspended. Changes are unavailable.',
  },
  organizationIncomplete: {
    statusCode: 409,
    code: 'organizationIncomplete',
    message:
      'The organization is not ready for submission. Complete the profile and add at least one branch.',
  },
  lastOwnerProtected: {
    statusCode: 409,
    code: 'lastOwnerProtected',
    message: 'An organization must keep at least one active Owner.',
  },
  invitationInvalid: {
    statusCode: 400,
    code: 'invitationInvalid',
    message: 'This invitation is not valid for this account.',
  },
  invalidBranchScope: {
    statusCode: 422,
    code: 'invalidBranchScope',
    message: 'Branch scope must reference active branches of this organization.',
  },
  lifecycleConflict: {
    statusCode: 409,
    code: 'lifecycleConflict',
    message: "This action is not available in the resource's current state.",
  },
  organizationNotLive: {
    statusCode: 409,
    code: 'organizationNotLive',
    message: 'The organization must be live before listings can be published.',
  },
  revisionPending: {
    statusCode: 409,
    code: 'revisionPending',
    message: 'A pending revision already exists for this listing. Wait for its review to finish.',
  },
  slugConflict: {
    statusCode: 409,
    code: 'slugConflict',
    message: 'This slug is already in use. Slugs are stable identifiers and must be unique.',
  },
  invalidTaxonomy: {
    statusCode: 422,
    code: 'invalidTaxonomy',
    message: 'The selected category or activity type is not available.',
  },
  invalidEligibility: {
    statusCode: 422,
    code: 'invalidEligibility',
    message: 'The eligibility values are contradictory or out of range.',
  },
  invalidPriceOption: {
    statusCode: 422,
    code: 'invalidPriceOption',
    message: 'The price option shape is invalid for its kind.',
  },
  invalidOffer: {
    statusCode: 422,
    code: 'invalidOffer',
    message: 'The offer shape is invalid for its kind or effective period.',
  },
  // -- S5-4 provider scheduling/capacity vocabulary (docs/32 §11) ---------
  invalidSchedule: {
    statusCode: 422,
    code: 'invalidSchedule',
    message: 'The schedule shape is invalid (pattern, times, range, or cutoff rule).',
  },
  invalidUnit: {
    statusCode: 422,
    code: 'invalidUnit',
    message: 'The inventory unit shape is invalid (times, dates, capacity, or cutoff).',
  },
  idempotencyConflict: {
    statusCode: 409,
    code: 'idempotencyConflict',
    message: 'This idempotency key was already used for a different request.',
  },
  capacityBelowCommitments: {
    statusCode: 409,
    code: 'capacityBelowCommitments',
    message:
      'Capacity cannot be reduced below the seats already booked or held. Reducing committed capacity requires the controlled disruption workflow.',
  },
  // -- S5-5 customer booking vocabulary (docs/22 §11 / docs/32 §12; D-10) --
  sessionFull: {
    statusCode: 409,
    code: 'sessionFull',
    message: 'This session is fully booked.',
  },
  registrationClosed: {
    statusCode: 409,
    code: 'registrationClosed',
    message: 'Registration for this session has closed.',
  },
  participantIneligible: {
    statusCode: 422,
    code: 'participantIneligible',
    message: 'This participant is not eligible for the selected session.',
  },
  quoteExpired: {
    statusCode: 409,
    code: 'quoteExpired',
    message: 'The price quote has expired. Please request a new quote.',
  },
  invalidQuote: {
    statusCode: 422,
    code: 'invalidQuote',
    message: 'The quote does not match this booking request.',
  },
  holdAlreadyActive: {
    statusCode: 409,
    code: 'holdAlreadyActive',
    message: 'An active reservation already exists for this participant and session.',
  },
  holdNotActive: {
    statusCode: 409,
    code: 'holdNotActive',
    message: 'This reservation is no longer active.',
  },
  holdExpired: {
    statusCode: 409,
    code: 'holdExpired',
    message: 'This reservation has expired. Please start again if seats remain.',
  },
  alreadyBooked: {
    statusCode: 409,
    code: 'alreadyBooked',
    message: 'This participant already has a live booking for this session.',
  },
  alreadyConfirmed: {
    statusCode: 409,
    code: 'alreadyConfirmed',
    message: 'This booking is already confirmed.',
  },
  paymentNotRequired: {
    statusCode: 409,
    code: 'paymentNotRequired',
    message: 'No payment is required — complete this booking through the free confirmation step.',
  },
  notFreeQuote: {
    statusCode: 409,
    code: 'notFreeQuote',
    message: 'This booking requires payment and cannot be completed as a free booking.',
  },
  paymentUnavailable: {
    statusCode: 503,
    code: 'paymentUnavailable',
    message: 'Paid checkout is not yet available. No booking was created and nothing was charged.',
  },
  trialAlreadyRedeemed: {
    statusCode: 409,
    code: 'trialAlreadyRedeemed',
    message: 'The free trial for this activity has already been used for this participant.',
  },
  // -- W5-5 customer paid-checkout vocabulary (docs/33 §15) ----------------
  checkoutAlreadyActive: {
    statusCode: 409,
    code: 'checkoutAlreadyActive',
    message: 'Another checkout is already in progress for this reservation.',
  },
  checkoutConcluded: {
    statusCode: 409,
    code: 'checkoutConcluded',
    message: 'This checkout has already concluded. Check the booking status.',
  },
  checkoutCreateFailed: {
    statusCode: 503,
    code: 'checkoutCreateFailed',
    message:
      'Starting payment did not succeed. Your reservation is still held — please try again.',
  },
  checkoutPending: {
    statusCode: 503,
    code: 'checkoutPending',
    message:
      'Payment setup did not complete. Please retry to continue this checkout — no duplicate charge can be created.',
  },
  policyUnavailable: {
    statusCode: 503,
    code: 'policyUnavailable',
    message: 'Booking confirmation is temporarily unavailable. Nothing was booked.',
  },
  invalidCursor: {
    statusCode: 422,
    code: 'invalidCursor',
    message: 'The pagination cursor is not valid. Restart from the first page.',
  },
  verificationEvidenceUnavailable: {
    statusCode: 503,
    code: 'verificationEvidenceUnavailable',
    message:
      'Provider verification decisions are unavailable until the verification evidence capability is active.',
  },
  invalidEvidenceMetadata: {
    statusCode: 422,
    code: 'invalidEvidenceMetadata',
    message: 'The evidence document metadata is not acceptable.',
  },
  evidenceStateConflict: {
    statusCode: 409,
    code: 'evidenceStateConflict',
    message: 'The evidence record is not in a state that allows this action.',
  },
  storageUnavailable: {
    statusCode: 503,
    code: 'storageUnavailable',
    message: 'Document storage is temporarily unavailable. Please try again shortly.',
  },
  verificationEvidenceSafetyUnavailable: {
    statusCode: 503,
    code: 'verificationEvidenceSafetyUnavailable',
    message:
      'Internal document review is unavailable until the evidence content-safety capability is active.',
  },
  verificationPolicyUnavailable: {
    statusCode: 503,
    code: 'verificationPolicyUnavailable',
    message:
      'Verification cannot proceed: no evidence requirement policy is configured (D-W3-3 pending).',
  },
  verificationCaseConflict: {
    statusCode: 409,
    code: 'verificationCaseConflict',
    message: 'The verification case is not in a state that allows this action.',
  },
  invalidVerificationDecision: {
    statusCode: 422,
    code: 'invalidVerificationDecision',
    message:
      'A rejection requires a machine reason code and a provider-safe message.',
  },
  rateLimited: {
    statusCode: 429,
    code: 'rateLimited',
    message: 'Too many attempts. Please try again later.',
  },
  providerUnavailable: {
    statusCode: 503,
    code: 'providerUnavailable',
    message: 'Sign-in is temporarily unavailable. Please try again shortly.',
  },
  internalError: {
    statusCode: 500,
    code: 'internalError',
    message: 'Internal error',
  },
} as const satisfies Record<string, HttpOutcome>;

export type HttpOutcomeName = keyof typeof HTTP_OUTCOMES;

export function sendOutcome(
  reply: FastifyReply,
  name: HttpOutcomeName,
  headers: Record<string, string> = {},
): FastifyReply {
  const outcome = HTTP_OUTCOMES[name];
  for (const [header, value] of Object.entries(headers)) {
    void reply.header(header, value);
  }
  return reply
    .status(outcome.statusCode)
    .send({ code: outcome.code, message: outcome.message });
}

/** Bearer-pipeline liveness outcomes → external vocabulary. */
export function livenessOutcomeName(
  kind:
    | 'invalidAccessToken'
    | 'sessionNotRegistered'
    | 'sessionExpired'
    | 'sessionRevoked'
    | 'identityEnded'
    | 'accountLocked'
    | 'accountSuspended'
    | 'accountDeleted',
): HttpOutcomeName {
  switch (kind) {
    case 'invalidAccessToken':
      return 'invalidAccessToken';
    case 'sessionNotRegistered':
    case 'sessionExpired':
    case 'sessionRevoked':
    case 'identityEnded':
      return 'sessionExpired';
    case 'accountLocked':
    case 'accountSuspended':
    case 'accountDeleted':
      return 'accountSuspended';
  }
}
