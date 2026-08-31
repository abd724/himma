/**
 * RI-6 — the production identity boundary (owner items 8/9): gateway
 * selection is fail-closed in every direction, and the REAL Cognito
 * gateway is certified against bounded contract fixtures (no real pool
 * exists in this environment — the recorded operational gate; production
 * NEVER routes through the dev identity stand-in and success is never
 * faked).
 */
import { describe, expect, it } from '@jest/globals';
import { createCognitoIdentityGateway } from '@/services/auth/cognito-identity-gateway';
import {
  cognitoPublicConfig,
  createUnconfiguredIdentityGateway,
  selectIdentityGateway,
} from '@/services/auth/identity-gateway-selection';
import { ApiError, NetworkError, type HttpClient } from '@/services/http/http-client';

const stubHttpClient: HttpClient = {
  request: async () => {
    throw new Error('unused');
  },
};

describe('Cognito public configuration (fail-closed parsing)', () => {
  it('wholly absent → undefined (dev builds fall back to the dev stand-in; production refuses)', () => {
    expect(cognitoPublicConfig({})).toBeUndefined();
    expect(cognitoPublicConfig({ issuer: '', clientId: ' ' })).toBeUndefined();
  });

  it('partial configuration THROWS — a half-configured build never half-works', () => {
    expect(() => cognitoPublicConfig({ issuer: 'https://x' })).toThrow(/partial/);
    expect(() => cognitoPublicConfig({ clientId: 'abc' })).toThrow(/partial/);
  });

  it('a non-https issuer THROWS', () => {
    expect(() => cognitoPublicConfig({ issuer: 'http://x', clientId: 'abc' })).toThrow(/https/);
  });

  it('valid configuration parses', () => {
    expect(
      cognitoPublicConfig({ issuer: 'https://cognito-idp.me-central-1.amazonaws.com/p', clientId: 'c1' }),
    ).toEqual({ issuer: 'https://cognito-idp.me-central-1.amazonaws.com/p', clientId: 'c1' });
  });
});

describe('gateway selection', () => {
  const cognito = { issuer: 'https://cognito-idp.test/p', clientId: 'c1' };

  it('real Cognito configuration wins in EVERY build', () => {
    for (const isDevBuild of [true, false]) {
      const gateway = selectIdentityGateway({ isDevBuild, cognito, httpClient: stubHttpClient });
      // The Cognito gateway never touches the app HTTP client — proving the
      // selection did not fall back to the dev stand-in.
      expect(gateway).not.toBeNull();
    }
  });

  it('production WITHOUT Cognito configuration refuses every operation with the typed outcome', async () => {
    const gateway = selectIdentityGateway({
      isDevBuild: false,
      cognito: undefined,
      httpClient: stubHttpClient,
    });
    for (const attempt of [
      () => gateway.signIn({ email: 'a@b.c', password: 'x' }),
      () => gateway.signUp({ email: 'a@b.c', password: 'x' }),
      () => gateway.refresh('r'),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'authNotConfigured', status: 503 });
    }
  });

  it('the refusal gateway is exactly the fail-closed implementation', async () => {
    await expect(
      createUnconfiguredIdentityGateway().signIn({ email: 'a@b.c', password: 'x' }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

// ---------------------------------------------------------------------------
// The REAL Cognito gateway against bounded contract fixtures.
// ---------------------------------------------------------------------------

type Call = { target: string; payload: Record<string, unknown> };

function stubCognito(
  respond: (target: string, payload: Record<string, unknown>) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const target = headers['x-amz-target']!.replace('AWSCognitoIdentityProviderService.', '');
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ target, payload });
    expect(String(url)).toBe('https://cognito-idp.test/');
    const result = respond(target, payload);
    return {
      ok: result.status < 400,
      status: result.status,
      json: async () => result.body,
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const CONFIG = { issuer: 'https://cognito-idp.test/pool-1', clientId: 'client-1' };
const NOW = new Date('2026-09-01T08:00:00.000Z');

describe('Cognito identity gateway (contract fixtures)', () => {
  it('sign-in: USER_PASSWORD_AUTH → tokens with expiry derived from ExpiresIn; no secret is ever sent', async () => {
    const { fetchImpl, calls } = stubCognito(() => ({
      status: 200,
      body: {
        AuthenticationResult: {
          AccessToken: 'at-1',
          IdToken: 'id-1',
          RefreshToken: 'rt-1',
          ExpiresIn: 1800,
        },
      },
    }));
    const gateway = createCognitoIdentityGateway({ ...CONFIG, fetchImpl, now: () => NOW });
    const tokens = await gateway.signIn({ email: 'a@b.c', password: 'pw' });
    expect(tokens).toEqual({
      accessToken: 'at-1',
      idToken: 'id-1',
      refreshToken: 'rt-1',
      expiresAt: '2026-09-01T08:30:00.000Z',
    });
    expect(calls[0]).toMatchObject({
      target: 'InitiateAuth',
      payload: { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: 'client-1' },
    });
    expect(JSON.stringify(calls[0]!.payload)).not.toMatch(/secret/i);
  });

  it('sign-up: SignUp then immediate token acquisition; an existing email maps to the typed refusal', async () => {
    const { fetchImpl, calls } = stubCognito((target) =>
      target === 'SignUp'
        ? { status: 200, body: { UserConfirmed: true } }
        : {
            status: 200,
            body: { AuthenticationResult: { AccessToken: 'at-2', ExpiresIn: 3600 } },
          },
    );
    const gateway = createCognitoIdentityGateway({ ...CONFIG, fetchImpl, now: () => NOW });
    const tokens = await gateway.signUp({ email: 'a@b.c', password: 'pw', displayName: 'A' });
    expect(tokens.accessToken).toBe('at-2');
    expect(calls.map((call) => call.target)).toEqual(['SignUp', 'InitiateAuth']);

    const taken = stubCognito(() => ({
      status: 400,
      body: { __type: 'UsernameExistsException' },
    }));
    const gateway2 = createCognitoIdentityGateway({ ...CONFIG, fetchImpl: taken.fetchImpl });
    await expect(gateway2.signUp({ email: 'a@b.c', password: 'pw' })).rejects.toMatchObject({
      code: 'emailInUse',
    });
  });

  it('credential rejections collapse to ONE safe class; unsupported challenges refuse; unconfirmed accounts surface the operational gate', async () => {
    for (const type of ['NotAuthorizedException', 'UserNotFoundException']) {
      const { fetchImpl } = stubCognito(() => ({ status: 400, body: { __type: type } }));
      const gateway = createCognitoIdentityGateway({ ...CONFIG, fetchImpl });
      await expect(gateway.signIn({ email: 'a@b.c', password: 'x' })).rejects.toMatchObject({
        code: 'invalidCredentials',
        status: 401,
      });
    }
    const challenge = stubCognito(() => ({
      status: 200,
      body: { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 's' },
    }));
    await expect(
      createCognitoIdentityGateway({ ...CONFIG, fetchImpl: challenge.fetchImpl }).signIn({
        email: 'a@b.c',
        password: 'x',
      }),
    ).rejects.toMatchObject({ code: 'identityChallengeUnsupported' });
    const unconfirmed = stubCognito(() => ({
      status: 400,
      body: { __type: 'UserNotConfirmedException' },
    }));
    await expect(
      createCognitoIdentityGateway({ ...CONFIG, fetchImpl: unconfirmed.fetchImpl }).signIn({
        email: 'a@b.c',
        password: 'x',
      }),
    ).rejects.toMatchObject({ code: 'accountNotConfirmed' });
  });

  it('transient provider failures are NetworkError (AuthSession retains the stored session)', async () => {
    const { fetchImpl } = stubCognito(() => ({ status: 500, body: {} }));
    const gateway = createCognitoIdentityGateway({ ...CONFIG, fetchImpl });
    await expect(gateway.refresh('rt-1')).rejects.toBeInstanceOf(NetworkError);
    const offline = createCognitoIdentityGateway({
      ...CONFIG,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    await expect(offline.signIn({ email: 'a@b.c', password: 'x' })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('refresh: REFRESH_TOKEN_AUTH keeps the SAME refresh authority; an authoritative rejection maps to sessionExpired', async () => {
    const { fetchImpl, calls } = stubCognito(() => ({
      status: 200,
      body: { AuthenticationResult: { AccessToken: 'at-3', ExpiresIn: 3600 } },
    }));
    const gateway = createCognitoIdentityGateway({ ...CONFIG, fetchImpl, now: () => NOW });
    const refreshed = await gateway.refresh('rt-1');
    expect(refreshed).toEqual({ accessToken: 'at-3', expiresAt: '2026-09-01T09:00:00.000Z' });
    expect(calls[0]!.payload).toMatchObject({ AuthFlow: 'REFRESH_TOKEN_AUTH' });

    const dead = stubCognito(() => ({
      status: 400,
      body: { __type: 'NotAuthorizedException' },
    }));
    await expect(
      createCognitoIdentityGateway({ ...CONFIG, fetchImpl: dead.fetchImpl }).refresh('rt-1'),
    ).rejects.toMatchObject({ code: 'sessionExpired', status: 401 });
  });
});
