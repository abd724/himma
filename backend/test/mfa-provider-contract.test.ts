/**
 * B2-6B — MFA provider port contract (docs/26 §2, A1.1). The fake provider
 * (every automated test) and the Cognito adapter (injectable client; no pool
 * is provisioned — real-pool smoke stays pending under docs/26 §14.E′)
 * satisfy one normalized contract, and no provider exception object or
 * secret-bearing message ever escapes the adapter.
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

  it('simulates outage and forced outcomes for every operation', async () => {
    const fake = new FakeMfaProvider();
    fake.setUnavailable(true);
    expect(
      (await fake.beginTotpEnrollment({ providerAccessToken: 't' })).kind,
    ).toBe('providerUnavailable');
    expect(
      (await fake.verifyTotpChallenge({ providerAccessToken: 't', code: 'x' })).kind,
    ).toBe('providerUnavailable');
    fake.setUnavailable(false);
    fake.forceVerificationOutcome('challengeExpired');
    expect(
      (await fake.verifyTotpChallenge({ providerAccessToken: 't', code: 'x' })).kind,
    ).toBe('challengeExpired');
  });
});

describe('CognitoMfaAdapter (injected client; SDK types stay inside providers/cognito)', () => {
  function clientOf(overrides: Partial<CognitoMfaClient>): CognitoMfaClient {
    return {
      associateSoftwareToken: async () => ({ secretCode: 'provider-secret' }),
      verifySoftwareToken: async () => ({ status: 'SUCCESS' }),
      ...overrides,
    };
  }

  it('normalizes a successful enrollment start and verification', async () => {
    const adapter = new CognitoMfaAdapter(clientOf({}));
    const started = await adapter.beginTotpEnrollment({ providerAccessToken: 'at' });
    expect(started).toEqual({
      kind: 'enrollmentStarted',
      material: { sharedSecret: 'provider-secret' },
    });
    const verified = await adapter.verifyTotpEnrollment({ providerAccessToken: 'at', code: '1' });
    expect(verified).toEqual({ kind: 'verificationSucceeded' });
  });

  it('normalizes provider refusals without exposing exception objects', async () => {
    const err = (name: string) =>
      Object.assign(new Error(`${name}: secret-bearing provider message SECRET-XYZ`), { name });
    const cases: Array<[Partial<CognitoMfaClient>, string]> = [
      [{ verifySoftwareToken: async () => ({ status: 'ERROR' }) }, 'invalidCode'],
      [
        {
          verifySoftwareToken: async () => {
            throw err('CodeMismatchException');
          },
        },
        'invalidCode',
      ],
      [
        {
          verifySoftwareToken: async () => {
            throw err('EnableSoftwareTokenMFAException');
          },
        },
        'invalidCode',
      ],
      [
        {
          verifySoftwareToken: async () => {
            throw err('ExpiredCodeException');
          },
        },
        'challengeExpired',
      ],
      [
        {
          verifySoftwareToken: async () => {
            throw err('NotAuthorizedException');
          },
        },
        'invalidProviderState',
      ],
      [
        {
          verifySoftwareToken: async () => {
            throw err('SoftwareTokenMFANotFoundException');
          },
        },
        'invalidProviderState',
      ],
      [
        {
          verifySoftwareToken: async () => {
            throw Object.assign(new Error('socket hang up SECRET-XYZ'), { name: 'Error' });
          },
        },
        'providerUnavailable',
      ],
    ];
    for (const [overrides, expected] of cases) {
      const adapter = new CognitoMfaAdapter(clientOf(overrides));
      const result = await adapter.verifyTotpChallenge({ providerAccessToken: 'at', code: '1' });
      expect(result.kind).toBe(expected);
      // The normalized result carries NOTHING from the provider error.
      expect(JSON.stringify(result)).not.toContain('SECRET-XYZ');
      expect(Object.keys(result)).toEqual(['kind']);
    }
  });

  it('treats enrollment-start failures the same way and never throws', async () => {
    const noSecret = new CognitoMfaAdapter(
      clientOf({ associateSoftwareToken: async () => ({}) }),
    );
    expect((await noSecret.beginTotpEnrollment({ providerAccessToken: 'at' })).kind).toBe(
      'invalidProviderState',
    );
    const down = new CognitoMfaAdapter(
      clientOf({
        associateSoftwareToken: async () => {
          throw new Error('network unreachable');
        },
      }),
    );
    expect((await down.beginTotpEnrollment({ providerAccessToken: 'at' })).kind).toBe(
      'providerUnavailable',
    );
    const refused = new CognitoMfaAdapter(
      clientOf({
        associateSoftwareToken: async () => {
          throw Object.assign(new Error('nope'), { name: 'NotAuthorizedException' });
        },
      }),
    );
    expect((await refused.beginTotpEnrollment({ providerAccessToken: 'at' })).kind).toBe(
      'invalidProviderState',
    );
  });
});
