/**
 * Contract-test harness (W2-12A §18): the REAL backend + a deterministic
 * fake Cognito endpoint.
 *
 * REAL: `buildApp` (every route/policy/outcome), a freshly migrated real
 * PostgreSQL database, Himma `login_session` rows, staff memberships, rate
 * limiting, and the exact response DTOs.
 *
 * SIMULATED (the external provider boundary ONLY): the Cognito user-pool
 * HTTP endpoint. The fake accepts USER_PASSWORD_AUTH + SOFTWARE_TOKEN_MFA
 * exactly like the portal's Cognito client expects, and mints tokens
 * through the backend's own FakeAccessTokenVerifier /
 * FakeAuthProviderAdapter instances — so a token issued "by Cognito" here
 * is verified by the same fake the backend app trusts, and the whole
 * Himma leg (token presentation → session establishment → liveness →
 * /provider/me) is contract-real.
 */
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

import { buildApp } from '../../../backend/src/app/build-app';
import { newId } from '../../../backend/src/db/ids';
import { parseAuthCookieConfig } from '../../../backend/src/modules/identity/http/auth-session-cookies';
import { InMemoryRateLimiterStore } from '../../../backend/src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../../../backend/src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../../../backend/src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../../../backend/src/modules/identity/providers/fake/fake-adapter';
import { FakeMfaProvider } from '../../../backend/src/modules/identity/providers/fake/fake-mfa-provider';
import { FakeTokenRefresher } from '../../../backend/src/modules/identity/providers/fake/fake-token-refresher';
import { parseMfaConfig } from '../../../backend/src/modules/identity/services/mfa-config';
import { parseStaffInvitationConfig } from '../../../backend/src/modules/provider/staff-invitation-config';
import {
  createMigratedTestDb,
  type TestDb,
} from '../../../backend/test/helpers/test-db';
import type { FetchLike } from '../../src/api/client';

export const CONTRACT_ISSUER = 'https://cognito.test/portal-contract-pool';
export const CONTRACT_CLIENT_ID = 'portal-contract-client';
export const VALID_TOTP = '246810';
export const PORTAL_ORIGIN = 'https://portal.himma.test';

export interface FakeCognitoUser {
  readonly password: string;
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  readonly mfaConfigured: boolean;
}

export interface ContractHarness {
  readonly testDb: TestDb;
  readonly app: FastifyInstance;
  readonly apiBaseUrl: string;
  readonly verifier: FakeAccessTokenVerifier;
  readonly idAdapter: FakeAuthProviderAdapter;
  readonly mfaProvider: FakeMfaProvider;
  readonly refresher: FakeTokenRefresher;
  /** The simulated browser cookie jar (auth-path cookies only). */
  readonly cookieJar: Map<string, string>;
  readonly fetchImpl: FetchLike;
  registerUser(username: string, user: FakeCognitoUser): void;
  /** Mints a bearer directly (bypassing the sign-in flow) for negative
   *  probes such as claims-cannot-grant-authority. */
  mintAccessToken(input: {
    subject: string;
    assurance?: 'single_factor' | 'mfa';
    scopes?: string[];
  }): string;
  close(): Promise<void>;
}

interface PendingChallenge {
  readonly username: string;
}

export async function createContractHarness(): Promise<ContractHarness> {
  const testDb = await createMigratedTestDb();
  const verifier = new FakeAccessTokenVerifier();
  const idAdapter = new FakeAuthProviderAdapter();
  const mfaProvider = new FakeMfaProvider();
  const refresher = new FakeTokenRefresher();
  const app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: idAdapter,
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      mfaProvider,
      mfaConfig: parseMfaConfig('test', {}),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
      // Contract runs establish/refresh many sessions from one IP; the
      // rule stays ACTIVE but roomy (production default stays 10/min).
      rateLimits: { sessionEstablishment: { limit: 1000, windowMs: 60_000 } },
      sessionContinuity: {
        cookieConfig: parseAuthCookieConfig('test', {
          PORTAL_ALLOWED_ORIGINS: PORTAL_ORIGIN,
        }),
        tokenRefresher: refresher,
      },
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;

  const users = new Map<string, FakeCognitoUser>();
  const challenges = new Map<string, PendingChallenge>();
  let challengeCounter = 0;

  const mintAccessToken = (input: {
    subject: string;
    assurance?: 'single_factor' | 'mfa';
    scopes?: string[];
  }): string =>
    verifier.issueToken({
      issuer: CONTRACT_ISSUER,
      subject: input.subject,
      originJti: `origin-${newId()}`,
      scopes: input.scopes ?? [],
      assurance: input.assurance ?? 'mfa',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      authTime: new Date(),
    });

  /** One SIGN-IN mints one provider session: the access token, ID token,
   *  and refresh token share ONE origin_jti (Cognito keeps `origin_jti`
   *  stable across refreshes of the same session — the Himma liveness
   *  key), and the refresh token is registered with the fake refresher to
   *  mint future same-session access tokens. */
  const mintTokenPair = (user: FakeCognitoUser, assurance: 'single_factor' | 'mfa') => {
    const originJti = `origin-${newId()}`;
    const evidence = () => ({
      issuer: CONTRACT_ISSUER,
      subject: user.subject,
      originJti,
      scopes: [],
      assurance,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      authTime: new Date(),
    });
    const mintIdToken = () =>
      idAdapter.issueToken({
        provider: 'email',
        issuer: CONTRACT_ISSUER,
        subject: user.subject,
        email: user.email,
        emailVerified: true,
        isPrivateRelay: false,
        assurance,
        displayName: user.displayName,
      });
    const refreshToken = `fake-refresh-${newId()}`;
    refresher.register(refreshToken, () => ({
      accessToken: verifier.issueToken(evidence()),
      idToken: mintIdToken(),
    }));
    return {
      AccessToken: verifier.issueToken(evidence()),
      IdToken: mintIdToken(),
      RefreshToken: refreshToken,
    };
  };

  const cognitoError = (type: string) =>
    jsonResponse(400, { __type: type, message: type });

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  /** The deterministic fake Cognito endpoint. */
  const fakeCognitoFetch = async (init: RequestInit): Promise<Response> => {
    const target = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    )['x-amz-target'];
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    if (body.ClientId !== CONTRACT_CLIENT_ID) {
      return cognitoError('ResourceNotFoundException');
    }
    if (target === 'AWSCognitoIdentityProviderService.InitiateAuth') {
      const params = body.AuthParameters as Record<string, string> | undefined;
      const user = users.get(params?.USERNAME ?? '');
      if (user === undefined || user.password !== params?.PASSWORD) {
        return cognitoError('NotAuthorizedException');
      }
      if (user.mfaConfigured) {
        challengeCounter += 1;
        const session = `challenge-session-${challengeCounter}`;
        challenges.set(session, { username: params?.USERNAME ?? '' });
        return jsonResponse(200, { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: session });
      }
      return jsonResponse(200, { AuthenticationResult: mintTokenPair(user, 'single_factor') });
    }
    if (target === 'AWSCognitoIdentityProviderService.RespondToAuthChallenge') {
      const session = typeof body.Session === 'string' ? body.Session : '';
      const pending = challenges.get(session);
      if (pending === undefined) {
        return cognitoError('NotAuthorizedException'); // consumed/expired session
      }
      const responses = body.ChallengeResponses as Record<string, string> | undefined;
      const user = users.get(pending.username);
      if (user === undefined || responses?.USERNAME !== pending.username) {
        return cognitoError('NotAuthorizedException');
      }
      if (responses?.SOFTWARE_TOKEN_MFA_CODE !== VALID_TOTP) {
        return cognitoError('CodeMismatchException');
      }
      challenges.delete(session); // single-use, like the real Session
      return jsonResponse(200, { AuthenticationResult: mintTokenPair(user, 'mfa') });
    }
    if (target === 'AWSCognitoIdentityProviderService.RevokeToken') {
      return jsonResponse(200, {});
    }
    return cognitoError('UnknownOperationException');
  };

  /** Browser-style transport: requests to the fake Cognito origin hit the
   *  fake pool; credentialed API requests carry the simulated cookie jar +
   *  portal Origin (like a real browser), and Set-Cookie responses are
   *  absorbed into the jar — HttpOnly enforcement is a browser guarantee,
   *  proven here through the exact Set-Cookie attributes (backend suite)
   *  while the portal code path never attempts to read the jar. */
  const cookieJar = new Map<string, string>();
  const absorbSetCookies = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
      const separator = (pair ?? '').indexOf('=');
      if (pair === undefined || separator <= 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const maxAge = attributes.find((attribute) =>
        attribute.toLowerCase().startsWith('max-age='),
      );
      if (maxAge !== undefined && Number(maxAge.split('=')[1]) <= 0) {
        cookieJar.delete(name);
      } else if (value !== '') {
        cookieJar.set(name, value);
      }
    }
  };
  const fetchImpl: FetchLike = async (input, init) => {
    if (input.startsWith(new URL(CONTRACT_ISSUER).origin)) {
      return fakeCognitoFetch(init);
    }
    if (init.credentials === 'include') {
      const headers = {
        ...(init.headers as Record<string, string> | undefined),
        origin: PORTAL_ORIGIN,
        ...(cookieJar.size > 0
          ? {
              cookie: [...cookieJar.entries()]
                .map(([name, value]) => `${name}=${value}`)
                .join('; '),
            }
          : {}),
      };
      const response = await globalThis.fetch(input, { ...init, headers });
      absorbSetCookies(response);
      return response;
    }
    return globalThis.fetch(input, init);
  };

  return {
    testDb,
    app,
    apiBaseUrl,
    verifier,
    idAdapter,
    mfaProvider,
    refresher,
    cookieJar,
    fetchImpl,
    registerUser(username, user) {
      users.set(username, user);
    },
    mintAccessToken,
    close: async () => {
      await app.close();
      await testDb.drop();
    },
  };
}
