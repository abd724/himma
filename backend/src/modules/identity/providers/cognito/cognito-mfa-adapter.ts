/**
 * Cognito MfaProviderPort implementation (docs/26 §2, §5.8, A1.1) — B2-6B,
 * TOTP-semantics correction.
 *
 * Two DISTINCT Cognito flows, never conflated:
 * - ENROLLMENT: AssociateSoftwareToken (secret issuance) +
 *   VerifySoftwareToken (registration confirmation). These are the only
 *   operations `beginTotpEnrollment`/`verifyTotpEnrollment` touch.
 * - STEP-UP: an already-enrolled user's ordinary TOTP verification is the
 *   SOFTWARE_TOKEN_MFA challenge flow — a fresh reauthentication yields
 *   ChallengeName SOFTWARE_TOKEN_MFA plus a provider `Session`, answered
 *   via RespondToAuthChallenge (SOFTWARE_TOKEN_MFA_CODE). Cognito has no
 *   operation that verifies a bare TOTP code against an access token, and
 *   the enrollment-verification operation is NOT used as one.
 *
 * Everything is mediated behind an INJECTED client interface: nothing here
 * provisions, names, or contacts a real user pool — the concrete
 * AWS-SDK-backed client (and the pool's choice of reauthentication flow
 * that produces the challenge) belongs to the §14.E′ real-pool task, and
 * the real-pool smoke remains pending until that owner-approved pool
 * exists.
 *
 * Provider exception objects NEVER escape: every outcome is collapsed into
 * the normalized single-field results of the port. The ephemeral secret
 * from AssociateSoftwareToken and the challenge `Session` pass through in
 * memory only.
 */
import type {
  MfaProviderPort,
  TotpChallengeSession,
  TotpChallengeStartResult,
  TotpEnrollmentStartResult,
  TotpVerificationResult,
} from '../mfa';

/**
 * Injectable subset of the Cognito IdP surface used by B2-6B. Shapes mirror
 * the provider operations without importing any AWS SDK type:
 * - associateSoftwareToken / verifySoftwareToken — the enrollment APIs;
 * - initiateSoftwareTokenMfaChallenge — the reauthentication call that
 *   yields `{ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session }` (which
 *   Cognito auth flow produces it is pool configuration, §14.E′);
 * - respondToSoftwareTokenMfaChallenge — RespondToAuthChallenge with
 *   SOFTWARE_TOKEN_MFA_CODE; `verified` abstracts "challenge cleared".
 */
export interface CognitoMfaClient {
  associateSoftwareToken(input: { accessToken: string }): Promise<{ secretCode?: string }>;
  verifySoftwareToken(input: {
    accessToken: string;
    userCode: string;
  }): Promise<{ status?: string }>;
  initiateSoftwareTokenMfaChallenge(input: {
    providerUserRef: string;
  }): Promise<{ challengeName?: string; session?: string }>;
  respondToSoftwareTokenMfaChallenge(input: {
    providerUserRef: string;
    session: string;
    code: string;
  }): Promise<{ verified?: boolean }>;
}

const SOFTWARE_TOKEN_MFA = 'SOFTWARE_TOKEN_MFA';

const INVALID_CODE_ERRORS = ['CodeMismatchException', 'EnableSoftwareTokenMFAException'];
const EXPIRED_ERRORS = ['ExpiredCodeException'];
const INVALID_STATE_ERRORS = [
  'NotAuthorizedException',
  'InvalidParameterException',
  'SoftwareTokenMFANotFoundException',
  'ResourceNotFoundException',
  'UserNotFoundException',
];

function errorName(error: unknown): string | undefined {
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function normalizeError(error: unknown): TotpVerificationResult {
  const name = errorName(error);
  if (name !== undefined) {
    if (INVALID_CODE_ERRORS.includes(name)) return { kind: 'invalidCode' };
    if (EXPIRED_ERRORS.includes(name)) return { kind: 'challengeExpired' };
    if (INVALID_STATE_ERRORS.includes(name)) return { kind: 'invalidProviderState' };
  }
  // Anything else (network, throttling, unknown provider failure) is an
  // availability problem — never rethrown, never detailed.
  return { kind: 'providerUnavailable' };
}

export class CognitoMfaAdapter implements MfaProviderPort {
  constructor(private readonly client: CognitoMfaClient) {}

  async beginTotpEnrollment(input: {
    providerAccessToken: string;
  }): Promise<TotpEnrollmentStartResult> {
    let secretCode: string | undefined;
    try {
      ({ secretCode } = await this.client.associateSoftwareToken({
        accessToken: input.providerAccessToken,
      }));
    } catch (error) {
      // Enrollment start has no code to mismatch: everything except an
      // availability problem is an invalid provider state.
      return normalizeError(error).kind === 'providerUnavailable'
        ? { kind: 'providerUnavailable' }
        : { kind: 'invalidProviderState' };
    }
    if (secretCode === undefined || secretCode.length === 0) {
      return { kind: 'invalidProviderState' };
    }
    return { kind: 'enrollmentStarted', material: { sharedSecret: secretCode } };
  }

  async verifyTotpEnrollment(input: {
    providerAccessToken: string;
    code: string;
  }): Promise<TotpVerificationResult> {
    let status: string | undefined;
    try {
      ({ status } = await this.client.verifySoftwareToken({
        accessToken: input.providerAccessToken,
        userCode: input.code,
      }));
    } catch (error) {
      return normalizeError(error);
    }
    return status === 'SUCCESS' ? { kind: 'verificationSucceeded' } : { kind: 'invalidCode' };
  }

  async beginTotpStepUpChallenge(input: {
    providerUserRef: string;
  }): Promise<TotpChallengeStartResult> {
    let challengeName: string | undefined;
    let session: string | undefined;
    try {
      ({ challengeName, session } = await this.client.initiateSoftwareTokenMfaChallenge({
        providerUserRef: input.providerUserRef,
      }));
    } catch (error) {
      return normalizeError(error).kind === 'providerUnavailable'
        ? { kind: 'providerUnavailable' }
        : { kind: 'invalidProviderState' };
    }
    // Only a genuine SOFTWARE_TOKEN_MFA challenge with a session counts —
    // any other provider response is an invalid state, never improvised.
    if (challengeName !== SOFTWARE_TOKEN_MFA || session === undefined || session.length === 0) {
      return { kind: 'invalidProviderState' };
    }
    return { kind: 'challengeIssued', challenge: { providerChallengeSession: session } };
  }

  async respondToTotpStepUpChallenge(input: {
    providerUserRef: string;
    challenge: TotpChallengeSession;
    code: string;
  }): Promise<TotpVerificationResult> {
    let verified: boolean | undefined;
    try {
      ({ verified } = await this.client.respondToSoftwareTokenMfaChallenge({
        providerUserRef: input.providerUserRef,
        session: input.challenge.providerChallengeSession,
        code: input.code,
      }));
    } catch (error) {
      // In the RespondToAuthChallenge context an invalid, expired, or
      // replayed Session surfaces as NotAuthorizedException — that is the
      // challenge dying, not a broader provider-state problem. (Mapping
      // confirmed against the real pool in the §14.E′ smoke.)
      if (errorName(error) === 'NotAuthorizedException') return { kind: 'challengeExpired' };
      return normalizeError(error);
    }
    return verified === true ? { kind: 'verificationSucceeded' } : { kind: 'invalidCode' };
  }
}
