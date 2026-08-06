/**
 * Deterministic fake MfaProviderPort (docs/26 §11.4) — B2-6B.
 *
 * No network, no cloud resource, no randomness: the accepted OTP for a given
 * provider access token is a pure function of the token, and enrollment
 * material is minted sequentially. Tests exercise the application core
 * through the same port the Cognito adapter implements.
 */
import type {
  MfaProviderPort,
  TotpEnrollmentStartResult,
  TotpVerificationResult,
} from '../mfa';

export class FakeMfaProvider implements MfaProviderPort {
  private unavailable = false;
  private forcedVerification: TotpVerificationResult['kind'] | undefined;
  private counter = 0;

  /** The one OTP this fake accepts for the given provider access token. */
  validCodeFor(providerAccessToken: string): string {
    return `fake-otp-${providerAccessToken}`;
  }

  /** Simulates provider outage for every call until restored. */
  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  /** Forces the NEXT verification call to return the given outcome. */
  forceVerificationOutcome(kind: TotpVerificationResult['kind']): void {
    this.forcedVerification = kind;
  }

  async beginTotpEnrollment(input: {
    providerAccessToken: string;
  }): Promise<TotpEnrollmentStartResult> {
    if (this.unavailable) return { kind: 'providerUnavailable' };
    this.counter += 1;
    return {
      kind: 'enrollmentStarted',
      material: {
        sharedSecret: `fake-shared-secret-${this.counter}-${input.providerAccessToken}`,
      },
    };
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

  private verify(input: {
    providerAccessToken: string;
    code: string;
  }): TotpVerificationResult {
    if (this.unavailable) return { kind: 'providerUnavailable' };
    if (this.forcedVerification !== undefined) {
      const kind = this.forcedVerification;
      this.forcedVerification = undefined;
      return { kind };
    }
    return input.code === this.validCodeFor(input.providerAccessToken)
      ? { kind: 'verificationSucceeded' }
      : { kind: 'invalidCode' };
  }
}
