/**
 * Deterministic fake MfaProviderPort (docs/26 §11.4) — B2-6B.
 *
 * No network, no cloud resource, no randomness: the accepted OTP for a given
 * provider user/token is a pure function of that reference, enrollment
 * material and challenge sessions are minted sequentially, and challenge
 * sessions are SINGLE-USE and user-bound (mirroring Cognito's Session
 * semantics). `callLog` records the port operations invoked so tests can
 * prove enrollment and step-up use distinct provider operations.
 */
import type {
  MfaProviderPort,
  TotpChallengeSession,
  TotpChallengeStartResult,
  TotpEnrollmentStartResult,
  TotpVerificationResult,
} from '../mfa';

export class FakeMfaProvider implements MfaProviderPort {
  readonly callLog: string[] = [];
  private unavailable = false;
  private forcedVerification: TotpVerificationResult['kind'] | undefined;
  private counter = 0;
  private readonly sessions = new Map<string, { userRef: string; used: boolean }>();

  /** The one OTP this fake accepts for the given provider user/token ref. */
  validCodeFor(providerRef: string): string {
    return `fake-otp-${providerRef}`;
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
    this.callLog.push('beginTotpEnrollment');
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
    this.callLog.push('verifyTotpEnrollment');
    if (this.unavailable) return { kind: 'providerUnavailable' };
    const forced = this.takeForced();
    if (forced !== undefined) return { kind: forced };
    return input.code === this.validCodeFor(input.providerAccessToken)
      ? { kind: 'verificationSucceeded' }
      : { kind: 'invalidCode' };
  }

  async beginTotpStepUpChallenge(input: {
    providerUserRef: string;
  }): Promise<TotpChallengeStartResult> {
    this.callLog.push('beginTotpStepUpChallenge');
    if (this.unavailable) return { kind: 'providerUnavailable' };
    this.counter += 1;
    const session = `fake-challenge-session-${this.counter}`;
    this.sessions.set(session, { userRef: input.providerUserRef, used: false });
    return { kind: 'challengeIssued', challenge: { providerChallengeSession: session } };
  }

  async respondToTotpStepUpChallenge(input: {
    providerUserRef: string;
    challenge: TotpChallengeSession;
    code: string;
  }): Promise<TotpVerificationResult> {
    this.callLog.push('respondToTotpStepUpChallenge');
    if (this.unavailable) return { kind: 'providerUnavailable' };
    const forced = this.takeForced();
    if (forced !== undefined) return { kind: forced };
    const session = this.sessions.get(input.challenge.providerChallengeSession);
    if (session === undefined || session.userRef !== input.providerUserRef) {
      return { kind: 'invalidProviderState' };
    }
    if (session.used) return { kind: 'challengeExpired' };
    if (input.code !== this.validCodeFor(input.providerUserRef)) {
      return { kind: 'invalidCode' };
    }
    session.used = true;
    return { kind: 'verificationSucceeded' };
  }

  private takeForced(): TotpVerificationResult['kind'] | undefined {
    const kind = this.forcedVerification;
    this.forcedVerification = undefined;
    return kind;
  }
}
