/**
 * Cognito MfaProviderPort implementation (docs/26 §2, §5.8, A1.1) — B2-6B.
 *
 * Mediates AssociateSoftwareToken / VerifySoftwareToken behind an INJECTED
 * client interface: nothing here (or anywhere in this slice) provisions,
 * names, or contacts a real user pool — the concrete AWS-SDK-backed client
 * is instantiated only by the future §14.E′ real-pool smoke task, and the
 * real-pool smoke remains pending until that owner-approved pool exists.
 *
 * Provider exception objects NEVER escape: every outcome (including thrown
 * client errors, whose names/messages may carry provider state) is collapsed
 * into the normalized single-field results of the port. The ephemeral
 * secret from AssociateSoftwareToken passes through in memory only.
 */
import type {
  MfaProviderPort,
  TotpEnrollmentStartResult,
  TotpVerificationResult,
} from '../mfa';

/**
 * Injectable subset of the Cognito IdP API used by B2-6B. Shapes mirror the
 * provider operations without importing any AWS SDK type.
 */
export interface CognitoMfaClient {
  associateSoftwareToken(input: { accessToken: string }): Promise<{ secretCode?: string }>;
  verifySoftwareToken(input: {
    accessToken: string;
    userCode: string;
  }): Promise<{ status?: string }>;
}

const INVALID_CODE_ERRORS = ['CodeMismatchException', 'EnableSoftwareTokenMFAException'];
const EXPIRED_ERRORS = ['ExpiredCodeException'];
const INVALID_STATE_ERRORS = [
  'NotAuthorizedException',
  'InvalidParameterException',
  'SoftwareTokenMFANotFoundException',
  'ResourceNotFoundException',
  'UserNotFoundException',
];

function normalizeError(error: unknown): TotpVerificationResult {
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string') {
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
    return this.verify(input);
  }

  async verifyTotpChallenge(input: {
    providerAccessToken: string;
    code: string;
  }): Promise<TotpVerificationResult> {
    return this.verify(input);
  }

  private async verify(input: {
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
}
