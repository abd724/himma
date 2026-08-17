import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import type { SessionInterrupt } from '../src/auth/adapter';

/**
 * Live auth runtime — unit coverage over a fully stubbed transport: the
 * Cognito boundary AND the Himma API are simulated here, so these tests
 * pin OUTCOME MAPPING and token hygiene deterministically. The real Himma
 * backend contract is exercised separately by the node-environment
 * contract suite (test-contract/) against buildApp on real PostgreSQL.
 */

const API_BASE = 'https://api.himma.test';
const ISSUER = 'https://cognito-idp.test/pool-1';
const COGNITO_ORIGIN = 'https://cognito-idp.test/';
const CLIENT_ID = 'portal-client-1';

const b64url = (value: object) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ID_TOKEN = `e30.${b64url({ email: 'rana@bluewave.test', name: 'Rana Haddad' })}.sig`;
const ACCESS_TOKEN = 'cognito-access-token-1';
const REFRESH_TOKEN = 'cognito-refresh-token-1';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  target: string | null;
}

type Responder = (call: RecordedCall) => { status: number; body: unknown } | 'network';

function makeTransport(respond: Responder) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const call: RecordedCall = {
      url: input,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : null,
      target: headers['x-amz-target'] ?? null,
    };
    calls.push(call);
    const result = respond(call);
    if (result === 'network') {
      throw new TypeError('network failure');
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const cognitoTokens = (overrides: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    AuthenticationResult: {
      AccessToken: ACCESS_TOKEN,
      IdToken: ID_TOKEN,
      RefreshToken: REFRESH_TOKEN,
      ...overrides,
    },
  },
});

const CSRF_1 = 'csrf-value-0001';
const CSRF_2 = 'csrf-value-0002';
const REFRESHED_ACCESS = 'cognito-access-token-2';

const himmaSessionOk = {
  status: 200,
  body: {
    status: 'authenticated',
    userId: '018f0000-0000-7000-8000-000000000001',
    session: { id: '018f0000-0000-7000-8000-000000000002', expiresAt: '2026-08-17T12:00:00Z' },
    csrfToken: CSRF_1,
  },
};

/** Legacy-shaped /auth/session response (backend WITHOUT the §14.E
 *  channel) — the pre-correction pass-through behavior must survive. */
const himmaSessionLegacy = {
  status: 200,
  body: {
    status: 'authenticated',
    userId: '018f0000-0000-7000-8000-000000000001',
    session: { id: '018f0000-0000-7000-8000-000000000002', expiresAt: '2026-08-17T12:00:00Z' },
  },
};

function runtimeWith(respond: Responder) {
  const transport = makeTransport(respond);
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: API_BASE,
    cognitoIssuer: ISSUER,
    cognitoClientId: CLIENT_ID,
    fetchImpl: transport.fetchImpl,
  });
  return { ...runtime, calls: transport.calls };
}

/** The happy default transport: password auth succeeds, Himma session
 *  establishes (cookie channel engaged), the §14.E bootstrap works, and
 *  /provider/me returns one owner membership. */
function defaultResponder(call: RecordedCall): { status: number; body: unknown } | 'network' {
  if (call.target === 'AWSCognitoIdentityProviderService.InitiateAuth') {
    return cognitoTokens();
  }
  if (call.url.startsWith(API_BASE) && call.url.endsWith('/auth/session')) {
    return himmaSessionOk;
  }
  if (call.url.startsWith(API_BASE) && call.url.endsWith('/auth/csrf')) {
    return { status: 200, body: { status: 'ok', csrfToken: CSRF_1 } };
  }
  if (call.url.startsWith(API_BASE) && call.url.endsWith('/auth/refresh')) {
    if (call.headers['x-csrf-token'] !== CSRF_1) {
      return { status: 403, body: { code: 'csrfRejected', message: 'refused' } };
    }
    return {
      status: 200,
      body: {
        status: 'authenticated',
        accessToken: REFRESHED_ACCESS,
        idToken: ID_TOKEN,
        assurance: 'mfa',
        expiresAt: '2026-08-17T13:00:00Z',
        csrfToken: CSRF_2,
      },
    };
  }
  if (call.url.startsWith(API_BASE) && call.url.endsWith('/provider/me')) {
    return {
      status: 200,
      body: {
        memberships: [
          {
            organizationId: '018f0000-0000-7000-8000-0000000000aa',
            displayName: 'Blue Wave Swimming',
            role: 'owner',
            branchScope: 'all',
            organizationState: 'live',
          },
        ],
      },
    };
  }
  return { status: 404, body: { code: 'notFound', message: 'not found' } };
}

describe('live auth runtime — semantic outcome mapping', () => {
  test('hard-reload bootstrap: GET /auth/csrf → POST /auth/refresh re-establishes a usable in-memory session', async () => {
    const { adapter, accessPort, calls } = runtimeWith(defaultResponder);
    await expect(adapter.bootstrap()).resolves.toEqual({
      kind: 'session',
      assurance: 'mfa',
      identity: { email: 'rana@bluewave.test', displayName: 'Rana Haddad' },
    });
    // The refresh ran over the cookie channel with the double-submit header.
    const refresh = calls.find((call) => call.url.endsWith('/auth/refresh'));
    expect(refresh?.headers['x-csrf-token']).toBe(CSRF_1);
    // The refreshed ACCESS token is the working bearer afterwards.
    await accessPort.resolveAccess();
    const me = calls.find((call) => call.url.endsWith('/provider/me'));
    expect(me?.headers.authorization).toBe(`Bearer ${REFRESHED_ACCESS}`);
  });

  test('with no continuity cookie the bootstrap is a SINGLE attempt landing signed out — no refresh loop', async () => {
    const { adapter, calls } = runtimeWith((call) => {
      if (call.url.endsWith('/auth/csrf')) {
        return { status: 401, body: { code: 'sessionExpired', message: 'signed out' } };
      }
      return defaultResponder(call);
    });
    await expect(adapter.bootstrap()).resolves.toEqual({ kind: 'noSession' });
    expect(calls).toHaveLength(1); // exactly the one csrf probe, nothing else
  });

  test('a refused refresh (revoked Himma session) is a SINGLE attempt landing signed out', async () => {
    const { adapter, calls } = runtimeWith((call) => {
      if (call.url.endsWith('/auth/refresh')) {
        return { status: 401, body: { code: 'sessionExpired', message: 'revoked' } };
      }
      return defaultResponder(call);
    });
    await expect(adapter.bootstrap()).resolves.toEqual({ kind: 'noSession' });
    expect(calls.filter((call) => call.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  test('sign-in without an MFA challenge: Cognito tokens → Himma session → signedIn single_factor with claim-derived display identity', async () => {
    const { adapter, calls } = runtimeWith(defaultResponder);
    const outcome = await adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' });
    expect(outcome).toEqual({
      kind: 'signedIn',
      assurance: 'single_factor',
      identity: { email: 'rana@bluewave.test', displayName: 'Rana Haddad' },
    });
    // The session leg presented BOTH tokens to the real route shape.
    const sessionCall = calls.find((call) => call.url.endsWith('/auth/session'));
    expect(sessionCall?.method).toBe('POST');
    expect(JSON.parse(sessionCall?.body ?? '{}')).toMatchObject({
      accessToken: ACCESS_TOKEN,
      idToken: ID_TOKEN,
    });
  });

  test('SOFTWARE_TOKEN_MFA challenge flow: challenge → wrong code → correct code → signedIn mfa', async () => {
    const { adapter } = runtimeWith((call) => {
      if (call.target === 'AWSCognitoIdentityProviderService.InitiateAuth') {
        return { status: 200, body: { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'sess-1' } };
      }
      if (call.target === 'AWSCognitoIdentityProviderService.RespondToAuthChallenge') {
        const body = JSON.parse(call.body ?? '{}') as {
          ChallengeResponses?: { SOFTWARE_TOKEN_MFA_CODE?: string };
        };
        if (body.ChallengeResponses?.SOFTWARE_TOKEN_MFA_CODE !== '246810') {
          return { status: 400, body: { __type: 'CodeMismatchException', message: 'bad code' } };
        }
        return cognitoTokens();
      }
      return defaultResponder(call);
    });

    await expect(adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' })).resolves.toEqual(
      { kind: 'mfaChallenge' },
    );
    await expect(adapter.completeMfaChallenge('000000')).resolves.toEqual({ kind: 'invalidCode' });
    const outcome = await adapter.completeMfaChallenge('246810');
    expect(outcome).toMatchObject({ kind: 'signedIn', assurance: 'mfa' });
  });

  test('challenge-context NotAuthorizedException maps to challengeExpired (restart from credentials), and a missing challenge is already expired', async () => {
    const { adapter } = runtimeWith((call) => {
      if (call.target === 'AWSCognitoIdentityProviderService.InitiateAuth') {
        return { status: 200, body: { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'sess-1' } };
      }
      if (call.target === 'AWSCognitoIdentityProviderService.RespondToAuthChallenge') {
        return {
          status: 400,
          body: { __type: 'NotAuthorizedException', message: 'Invalid session for the user.' },
        };
      }
      return defaultResponder(call);
    });
    await adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' });
    await expect(adapter.completeMfaChallenge('246810')).resolves.toEqual({
      kind: 'challengeExpired',
    });
    // The lapsed challenge was dropped — answering again cannot resume it.
    await expect(adapter.completeMfaChallenge('246810')).resolves.toEqual({
      kind: 'challengeExpired',
    });
  });

  test.each([
    ['NotAuthorizedException', 'invalidCredentials'],
    ['UserNotFoundException', 'invalidCredentials'],
    ['UserNotConfirmedException', 'invalidCredentials'],
    ['PasswordResetRequiredException', 'invalidCredentials'],
    ['TooManyRequestsException', 'rateLimited'],
    ['LimitExceededException', 'rateLimited'],
  ])('Cognito %s at sign-in maps to the safe %s outcome', async (type, expected) => {
    const { adapter } = runtimeWith((call) =>
      call.target === 'AWSCognitoIdentityProviderService.InitiateAuth'
        ? { status: 400, body: { __type: type, message: 'refused' } }
        : defaultResponder(call),
    );
    await expect(adapter.signIn({ email: 'a@b.test', password: 'x' })).resolves.toEqual({
      kind: expected,
    });
  });

  test('a Cognito outage (network / 5xx) is providerUnavailable; an unsupported challenge type is a safe failure', async () => {
    const down = runtimeWith((call) =>
      call.target !== null ? 'network' : defaultResponder(call),
    );
    await expect(down.adapter.signIn({ email: 'a@b.test', password: 'x' })).resolves.toEqual({
      kind: 'providerUnavailable',
    });

    const unexpected = runtimeWith((call) =>
      call.target === 'AWSCognitoIdentityProviderService.InitiateAuth'
        ? { status: 200, body: { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' } }
        : defaultResponder(call),
    );
    await expect(unexpected.adapter.signIn({ email: 'a@b.test', password: 'x' })).resolves.toEqual({
      kind: 'failure',
    });
  });

  test('a Himma /auth/session refusal maps by outcome code (accountSuspended shown here)', async () => {
    const { adapter } = runtimeWith((call) => {
      if (call.url.endsWith('/auth/session')) {
        return { status: 403, body: { code: 'accountSuspended', message: 'suspended' } };
      }
      return defaultResponder(call);
    });
    await expect(adapter.signIn({ email: 'a@b.test', password: 'x' })).resolves.toEqual({
      kind: 'accountSuspended',
    });
  });
});

describe('live provider-access bootstrap (GET /provider/me)', () => {
  test('memberships map field-for-field from the real DTO', async () => {
    const { adapter, accessPort } = runtimeWith(defaultResponder);
    await adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' });
    await expect(accessPort.resolveAccess()).resolves.toEqual({
      kind: 'resolved',
      memberships: [
        {
          organizationId: '018f0000-0000-7000-8000-0000000000aa',
          displayName: 'Blue Wave Swimming',
          role: 'owner',
          branchScope: 'all',
          organizationState: 'live',
        },
      ],
    });
  });

  test('without a session, access resolution is unavailable — never a fabricated result', async () => {
    const { accessPort } = runtimeWith(defaultResponder);
    await expect(accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
  });

  test('a contract-violating membership row fails CLOSED (no partial access truth)', async () => {
    const { adapter, accessPort } = runtimeWith((call) => {
      if (call.url.endsWith('/provider/me')) {
        return {
          status: 200,
          body: { memberships: [{ organizationId: 'org', role: 'super_admin' }] },
        };
      }
      return defaultResponder(call);
    });
    await adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' });
    await expect(accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
  });

  test('a revoked/expired Himma session (401 sessionExpired) drops tokens and pushes the ONE canonical interrupt', async () => {
    let sessionDead = false;
    const { adapter, accessPort, calls } = runtimeWith((call) => {
      if (call.url.endsWith('/provider/me') && sessionDead) {
        return { status: 401, body: { code: 'sessionExpired', message: 'expired' } };
      }
      return defaultResponder(call);
    });
    const interrupts: SessionInterrupt[] = [];
    adapter.subscribe((interrupt) => interrupts.push(interrupt));

    await adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' });
    sessionDead = true;
    await expect(accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
    expect(interrupts).toEqual([{ kind: 'sessionExpired' }]);

    // Tokens are GONE: the next resolution never even reaches the API.
    const callCount = calls.length;
    await expect(accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
    expect(calls.length).toBe(callCount);
  });
});

describe('live logout and step-up', () => {
  test('with the cookie channel engaged, sign-in hands the refresh token to /auth/session ONCE and drops it from JS memory — logout carries no token material', async () => {
    const { adapter, accessPort, calls } = runtimeWith((call) => {
      if (call.url.endsWith('/auth/logout')) {
        return { status: 200, body: { status: 'loggedOut' } };
      }
      return defaultResponder(call);
    });
    await adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' });
    // Exactly one presentation of the refresh token: the session leg.
    const session = calls.find((call) => call.url.endsWith('/auth/session'));
    expect(JSON.parse(session?.body ?? '{}')).toMatchObject({ refreshToken: REFRESH_TOKEN });

    await adapter.signOut();
    const logout = calls.find((call) => call.url.endsWith('/auth/logout'));
    expect(logout?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    // The refresh token is server-owned now — logout sends NO token body
    // and needs no direct provider revocation from the browser.
    expect(JSON.parse(logout?.body ?? '{}')).toEqual({});
    expect(
      calls.find((call) => call.target === 'AWSCognitoIdentityProviderService.RevokeToken'),
    ).toBeUndefined();
    await expect(accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
  });

  test('legacy backend WITHOUT the cookie channel: the documented ephemeral pass-through and outage fallback still work', async () => {
    const legacyResponder = (call: RecordedCall) => {
      if (call.url.endsWith('/auth/session')) {
        return himmaSessionLegacy;
      }
      if (call.url.endsWith('/auth/logout')) {
        return 'network' as const;
      }
      return defaultResponder(call);
    };
    const { adapter, accessPort, calls } = runtimeWith(legacyResponder);
    await adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' });
    await adapter.signOut();
    const revoke = calls.find(
      (call) => call.target === 'AWSCognitoIdentityProviderService.RevokeToken',
    );
    expect(JSON.parse(revoke?.body ?? '{}')).toMatchObject({ Token: REFRESH_TOKEN });
    await expect(accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
  });

  test('TOTP step-up runs the real two-legged begin/complete contract behind the one-call seam', async () => {
    const { adapter, calls } = runtimeWith((call) => {
      if (call.url.endsWith('/auth/step-up/totp/begin')) {
        return {
          status: 200,
          body: {
            status: 'challengeStarted',
            challengeId: '018f0000-0000-7000-8000-00000000c001',
            expiresAt: '2026-08-17T12:05:00Z',
            providerChallenge: 'provider-session-1',
          },
        };
      }
      if (call.url.endsWith('/auth/step-up/totp/complete')) {
        return {
          status: 200,
          body: { status: 'stepUpCompleted', expiresAt: '2026-08-17T12:15:00Z' },
        };
      }
      return defaultResponder(call);
    });
    await adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' });
    await expect(adapter.completeStepUpTotp('246810')).resolves.toEqual({
      kind: 'completed',
      expiresAt: '2026-08-17T12:15:00Z',
    });
    const complete = calls.find((call) => call.url.endsWith('/auth/step-up/totp/complete'));
    expect(JSON.parse(complete?.body ?? '{}')).toEqual({
      challengeId: '018f0000-0000-7000-8000-00000000c001',
      providerChallenge: 'provider-session-1',
      code: '246810',
    });
  });

  test('step-up refusals map safely: the sanitized challengeInvalid class → invalidCode; rate limits pass through', async () => {
    const { adapter } = runtimeWith((call) => {
      if (call.url.endsWith('/auth/step-up/recovery-code')) {
        return { status: 400, body: { code: 'challengeInvalid', message: 'refused' } };
      }
      return defaultResponder(call);
    });
    await adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' });
    await expect(adapter.completeStepUpRecoveryCode('AAAA-BBBB-CCCC')).resolves.toEqual({
      kind: 'invalidCode',
    });
  });
});

describe('token hygiene (task §6/§19)', () => {
  test('no token, password, or code EVER appears in a request URL, and bearer material rides headers only', async () => {
    const { adapter, accessPort, calls } = runtimeWith(defaultResponder);
    await adapter.signIn({ email: 'rana@bluewave.test', password: 'super-secret-pw' });
    await accessPort.resolveAccess();
    await adapter.signOut();

    for (const call of calls) {
      expect(call.url).not.toMatch(/[?#]/); // no query strings at all
      for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, ID_TOKEN, 'super-secret-pw']) {
        expect(call.url).not.toContain(secret);
      }
    }
    // Credentials go ONLY to the Cognito boundary, never to the Himma API.
    for (const call of calls.filter((entry) => entry.url.startsWith(API_BASE))) {
      expect(call.body ?? '').not.toContain('super-secret-pw');
    }
    // Cognito calls carry no Himma bearer; Himma calls carry it as a header.
    for (const call of calls.filter((entry) => entry.url.startsWith(COGNITO_ORIGIN))) {
      expect(call.headers.authorization).toBeUndefined();
    }
  });

  test('the live flows never touch localStorage or sessionStorage', async () => {
    const localSet = jest.spyOn(Storage.prototype, 'setItem');
    const localGet = jest.spyOn(Storage.prototype, 'getItem');
    try {
      const { adapter, accessPort } = runtimeWith(defaultResponder);
      await adapter.bootstrap();
      await adapter.signIn({ email: 'rana@bluewave.test', password: 'pw-1' });
      await accessPort.resolveAccess();
      await adapter.signOut();
      expect(localSet).not.toHaveBeenCalled();
      expect(localGet).not.toHaveBeenCalled();
    } finally {
      localSet.mockRestore();
      localGet.mockRestore();
    }
  });

  test('the live-auth source keeps token material out of browser storage by construction (source sweep)', () => {
    // Deliberate static guard: the adapter boundary owns tokens in memory
    // only. If someone adds web storage to these modules, this fails.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as { readFileSync: (p: string, e: string) => string };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as { join: (...parts: string[]) => string };
    const files = [
      'src/auth/live/live-auth-runtime.ts',
      'src/auth/live/cognito-api.ts',
      'src/api/client.ts',
    ];
    for (const file of files) {
      const source = fs
        .readFileSync(path.join(__dirname, '..', file), 'utf8')
        // Comments may DOCUMENT the prohibition; only code counts.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    }
  });
});
