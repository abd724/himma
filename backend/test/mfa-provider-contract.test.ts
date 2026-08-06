/**
 * B2-6B(+semantics correction) — MFA provider port contract (docs/26 §2,
 * A1.1). The fake provider and the Cognito adapter (injected client; no pool
 * is provisioned — real-pool smoke stays pending under docs/26 §14.E′)
 * satisfy one normalized contract, and no provider exception object,
 * secret-bearing message, or challenge session escapes the adapter.
 *
 * Cognito TOTP semantics under test:
 * - enrollment = AssociateSoftwareToken + VerifySoftwareToken ONLY;
 * - ordinary step-up = a fresh reauthentication yielding a
 *   SOFTWARE_TOKEN_MFA challenge Session + RespondToAuthChallenge ONLY —
 *   the enrollment-verification operation is NEVER used for step-up.
 */
import {
  CognitoMfaAdapter,
  type CognitoMfaClient,
} from '../src/modules/identity/providers/cognito/cognito-mfa-adapter';
import { FakeMfaProvider } from '../src/modules/identity/providers/fake/fake-mfa-provider';

describe('FakeMfaProvider (deterministic test double)', () => {
  it('begins enrollment with deterministic ephemeral material and verifies its own codes', async () => {
    const fake = new FakeMfaProvider();
    const started = await fake.beginTotpEnrollment({ providerAccessToken: 'token-1' });
    expect(started.kind).toBe('enrollmentStarted');
    if (started.kind !== 'enrollmentStarted') return;
    expect(started.material.sharedSecret.length).toBeGreaterThan(0);

    const good = await fake.verifyTotpEnrollment({
      providerAccessToken: 'token-1',
      code: fake.validCodeFor('token-1'),
    });
    expect(good.kind).toBe('verificationSucceeded');
    const bad = await fake.verifyTotpEnrollment({
      providerAccessToken: 'token-1',
      code: 'wrong-code',
    });
    expect(bad.kind).toBe('invalidCode');
  });

  it('issues single-use step-up challenge sessions bound to the provider user', async () => {
    const fake = new FakeMfaProvider();
    const issued = await fake.beginTotpStepUpChallenge({ providerUserRef: 'user-a' });
    expect(issued.kind).toBe('challengeIssued');
    if (issued.kind !== 'challengeIssued') return;
    const challenge = issued.challenge;

    // Wrong user cannot answer this session.
    expect(
      (
        await fake.respondToTotpStepUpChallenge({
          providerUserRef: 'user-b',
          challenge,
          code: fake.validCodeFor('user-b'),
        })
      ).kind,
    ).toBe('invalidProviderState');
    // A wrong code fails without consuming the session.
    expect(
      (
        await fake.respondToTotpStepUpChallenge({
          providerUserRef: 'user-a',
          challenge,
          code: 'wrong',
        })
      ).kind,
    ).toBe('invalidCode');
    // The right code succeeds exactly once.
    expect(
      (
        await fake.respondToTotpStepUpChallenge({
          providerUserRef: 'user-a',
          challenge,
          code: fake.validCodeFor('user-a'),
        })
      ).kind,
    ).toBe('verificationSucceeded');
    // Replaying the consumed provider session fails.
    expect(
      (
        await fake.respondToTotpStepUpChallenge({
          providerUserRef: 'user-a',
          challenge,
          code: fake.validCodeFor('user-a'),
        })
      ).kind,
    ).toBe('challengeExpired');
    // An unknown/forged session fails.
    expect(
      (
        await fake.respondToTotpStepUpChallenge({
          providerUserRef: 'user-a',
          challenge: { providerChallengeSession: 'forged-session' },
          code: fake.validCodeFor('user-a'),
        })
      ).kind,
    ).toBe('invalidProviderState');
  });

  it('simulates outage and forced outcomes for every operation', async () => {
    const fake = new FakeMfaProvider();
    fake.setUnavailable(true);
    expect(
      (await fake.beginTotpEnrollment({ providerAccessToken: 't' })).kind,
    ).toBe('providerUnavailable');
    expect(
      (await fake.beginTotpStepUpChallenge({ providerUserRef: 'u' })).kind,
    ).toBe('providerUnavailable');
    expect(
      (
        await fake.respondToTotpStepUpChallenge({
          providerUserRef: 'u',
          challenge: { providerChallengeSession: 's' },
          code: 'x',
        })
      ).kind,
    ).toBe('providerUnavailable');
    fake.setUnavailable(false);
    fake.forceVerificationOutcome('challengeExpired');
    expect(
      (
        await fake.respondToTotpStepUpChallenge({
          providerUserRef: 'u',
          challenge: { providerChallengeSession: 's' },
          code: 'x',
        })
      ).kind,
    ).toBe('challengeExpired');
  });
});

describe('CognitoMfaAdapter (injected client; SDK types stay inside providers/cognito)', () => {
  interface CallCounts {
    associate: number;
    verifySoftware: number;
    initiateChallenge: number;
    respondChallenge: number;
  }

  function clientOf(overrides: Partial<CognitoMfaClient>): {
    client: CognitoMfaClient;
    calls: CallCounts;
  } {
    const calls: CallCounts = {
      associate: 0,
      verifySoftware: 0,
      initiateChallenge: 0,
      respondChallenge: 0,
    };
    const client: CognitoMfaClient = {
      associateSoftwareToken: async () => {
        calls.associate += 1;
        return { secretCode: 'provider-secret' };
      },
      verifySoftwareToken: async () => {
        calls.verifySoftware += 1;
        return { status: 'SUCCESS' };
      },
      initiateSoftwareTokenMfaChallenge: async () => {
        calls.initiateChallenge += 1;
        return { challengeName: 'SOFTWARE_TOKEN_MFA', session: 'provider-session-material' };
      },
      respondToSoftwareTokenMfaChallenge: async () => {
        calls.respondChallenge += 1;
        return { verified: true };
      },
      ...overrides,
    };
    return { client, calls };
  }

  it('enrollment uses ONLY AssociateSoftwareToken + VerifySoftwareToken', async () => {
    const { client, calls } = clientOf({});
    const adapter = new CognitoMfaAdapter(client);
    const started = await adapter.beginTotpEnrollment({ providerAccessToken: 'at' });
    expect(started).toEqual({
      kind: 'enrollmentStarted',
      material: { sharedSecret: 'provider-secret' },
    });
    const verified = await adapter.verifyTotpEnrollment({ providerAccessToken: 'at', code: '1' });
    expect(verified).toEqual({ kind: 'verificationSucceeded' });
    expect(calls).toEqual({
      associate: 1,
      verifySoftware: 1,
      initiateChallenge: 0,
      respondChallenge: 0,
    });
  });

  it('step-up uses ONLY the challenge flow — never the enrollment-verification operation', async () => {
    const { client, calls } = clientOf({});
    const adapter = new CognitoMfaAdapter(client);
    const issued = await adapter.beginTotpStepUpChallenge({ providerUserRef: 'sub-1' });
    expect(issued).toEqual({
      kind: 'challengeIssued',
      challenge: { providerChallengeSession: 'provider-session-material' },
    });
    if (issued.kind !== 'challengeIssued') return;
    const responded = await adapter.respondToTotpStepUpChallenge({
      providerUserRef: 'sub-1',
      challenge: issued.challenge,
      code: '123456',
    });
    expect(responded).toEqual({ kind: 'verificationSucceeded' });
    expect(calls).toEqual({
      associate: 0,
      verifySoftware: 0,
      initiateChallenge: 1,
      respondChallenge: 1,
    });
  });

  it('refuses a challenge start that does not yield a SOFTWARE_TOKEN_MFA session', async () => {
    const wrongChallenge = new CognitoMfaAdapter(
      clientOf({
        initiateSoftwareTokenMfaChallenge: async () => ({
          challengeName: 'SMS_MFA',
          session: 's',
        }),
      }).client,
    );
    expect(
      (await wrongChallenge.beginTotpStepUpChallenge({ providerUserRef: 'u' })).kind,
    ).toBe('invalidProviderState');
    const noSession = new CognitoMfaAdapter(
      clientOf({
        initiateSoftwareTokenMfaChallenge: async () => ({
          challengeName: 'SOFTWARE_TOKEN_MFA',
        }),
      }).client,
    );
    expect(
      (await noSession.beginTotpStepUpChallenge({ providerUserRef: 'u' })).kind,
    ).toBe('invalidProviderState');
  });

  it('normalizes challenge-response refusals without exposing exception objects or session material', async () => {
    const err = (name: string) =>
      Object.assign(new Error(`${name}: provider message SECRET-XYZ session=SESSION-XYZ`), {
        name,
      });
    const cases: Array<[Partial<CognitoMfaClient>, string]> = [
      [{ respondToSoftwareTokenMfaChallenge: async () => ({ verified: false }) }, 'invalidCode'],
      [
        {
          respondToSoftwareTokenMfaChallenge: async () => {
            throw err('CodeMismatchException');
          },
        },
        'invalidCode',
      ],
      [
        {
          respondToSoftwareTokenMfaChallenge: async () => {
            throw err('ExpiredCodeException');
          },
        },
        'challengeExpired',
      ],
      // Session invalid, expired, or replayed: Cognito raises
      // NotAuthorizedException in the RespondToAuthChallenge context.
      [
        {
          respondToSoftwareTokenMfaChallenge: async () => {
            throw err('NotAuthorizedException');
          },
        },
        'challengeExpired',
      ],
      [
        {
          respondToSoftwareTokenMfaChallenge: async () => {
            throw err('SoftwareTokenMFANotFoundException');
          },
        },
        'invalidProviderState',
      ],
      [
        {
          respondToSoftwareTokenMfaChallenge: async () => {
            throw Object.assign(new Error('socket hang up SECRET-XYZ'), { name: 'Error' });
          },
        },
        'providerUnavailable',
      ],
    ];
    for (const [overrides, expected] of cases) {
      const adapter = new CognitoMfaAdapter(clientOf(overrides).client);
      const result = await adapter.respondToTotpStepUpChallenge({
        providerUserRef: 'u',
        challenge: { providerChallengeSession: 's' },
        code: '1',
      });
      expect(result.kind).toBe(expected);
      expect(JSON.stringify(result)).not.toContain('SECRET-XYZ');
      expect(JSON.stringify(result)).not.toContain('SESSION-XYZ');
      expect(Object.keys(result)).toEqual(['kind']);
    }
  });

  it('normalizes enrollment failures the same way and never throws', async () => {
    const noSecret = new CognitoMfaAdapter(
      clientOf({ associateSoftwareToken: async () => ({}) }).client,
    );
    expect((await noSecret.beginTotpEnrollment({ providerAccessToken: 'at' })).kind).toBe(
      'invalidProviderState',
    );
    const down = new CognitoMfaAdapter(
      clientOf({
        associateSoftwareToken: async () => {
          throw new Error('network unreachable');
        },
      }).client,
    );
    expect((await down.beginTotpEnrollment({ providerAccessToken: 'at' })).kind).toBe(
      'providerUnavailable',
    );
    const enrollRefused = new CognitoMfaAdapter(
      clientOf({
        verifySoftwareToken: async () => {
          throw Object.assign(new Error('nope'), { name: 'EnableSoftwareTokenMFAException' });
        },
      }).client,
    );
    expect(
      (await enrollRefused.verifyTotpEnrollment({ providerAccessToken: 'at', code: '1' })).kind,
    ).toBe('invalidCode');
    const challengeDown = new CognitoMfaAdapter(
      clientOf({
        initiateSoftwareTokenMfaChallenge: async () => {
          throw new Error('network unreachable');
        },
      }).client,
    );
    expect(
      (await challengeDown.beginTotpStepUpChallenge({ providerUserRef: 'u' })).kind,
    ).toBe('providerUnavailable');
  });
});
