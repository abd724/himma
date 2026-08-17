/**
 * Customer identity routes (docs/26 §10 under Amendment A1.1) — B2-4.
 *
 * Under the approved Cognito model, credentials and token rotation are
 * provider-side; every login flow converges on TOKEN PRESENTATION, so the
 * §10 `login`/`oidc/*` routes collapse into `POST /auth/session` (recorded
 * deviation): the client authenticates with Cognito, then presents its ID
 * token (identity evidence, first login/linking only) and access token
 * (the only API bearer credential). When both are present they MUST agree
 * on issuer + subject — mismatched pairs are rejected before any user or
 * session is created.
 *
 * Failure boundary of /auth/session (documented rule): first-login and
 * session establishment are two INDEPENDENT service transactions (docs/26
 * §9.1's session leg was split into B2-3 by the approved commit plan) — a
 * canonical user may exist although establishment later failed; both
 * operations are idempotent/convergent, so a client retry converges on the
 * same user, account, and one live session with no duplicates.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import type { MailSender } from '../mail/mail-sender';
import type { AuthProviderAdapter } from '../providers/adapter';
import type { AccessTokenVerifier } from '../providers/access-token';
import type { ProviderTokenRefresher } from '../providers/refresh';
import type { ProviderSessionRevoker } from '../providers/revocation';
import { checkSessionLiveness } from '../services/session-liveness';
import {
  clearedAuthCookies,
  csrfCookie,
  csrfMatches,
  newCsrfToken,
  originAllowed,
  parseCookies,
  refreshCookie,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_NAME,
  type AuthCookieConfig,
} from './auth-session-cookies';
import { firstLogin } from '../services/first-login';
import { linkIdentity, unlinkIdentity } from '../services/link-identity';
import { readCustomerProfile } from '../services/profile';
import { requestPasswordReset } from '../services/password-reset';
import { establishSession, listSessions } from '../services/sessions';
import { logoutAllSessions, logoutSession } from '../services/session-revocation';
import { requirePrincipal } from './auth-plugin';
import { livenessOutcomeName, sendOutcome, type HttpOutcomeName } from './http-outcomes';
import {
  rateLimitDigest,
  type RateLimiterStore,
  type RateLimitRules,
} from './rate-limiter';

const AUTH_BODY_LIMIT = 16_384;
const TokenString = Type.String({ minLength: 8, maxLength: 4096 });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const Uuid = Type.String({ format: 'uuid' });

export interface IdentityRouteDeps {
  db: Db;
  accessTokenVerifier: AccessTokenVerifier;
  idTokenAdapter: AuthProviderAdapter;
  mailSender: MailSender;
  providerRevoker?: ProviderSessionRevoker;
  rateLimiter: RateLimiterStore;
  rules: RateLimitRules;
  /** Minimum handler duration for enumeration-sensitive routes. */
  enumerationFloorMs: number;
  /**
   * docs/26 §4.7(9)/§14.E browser session-continuity channel (W2-12A
   * correction). When supplied, `POST /auth/session` may set the Secure/
   * HttpOnly refresh cookie, and `GET /auth/csrf` + `POST /auth/refresh`
   * register. Absent → the routes do not exist (fail-closed 404) and the
   * pre-correction behavior is byte-identical.
   */
  sessionContinuity?: {
    cookieConfig: AuthCookieConfig;
    tokenRefresher: ProviderTokenRefresher;
  };
}

/** First-login/link outcome kinds → external envelope names. */
function loginFlowOutcome(kind: string): HttpOutcomeName {
  switch (kind) {
    case 'identityEnded':
    case 'verifiedEmailConflict':
      return 'accountLinkConflict';
    case 'accountLocked':
    case 'accountDeleted':
    case 'accountSuspended':
      return 'accountSuspended';
    case 'sessionRevoked':
      return 'sessionExpired';
    case 'identityLinkedToAnotherUser':
      return 'identityAlreadyLinked';
    case 'lastLoginMethod':
      return 'lastLoginMethod';
    case 'staleVersion':
      return 'staleVersion';
    case 'identityNotFound':
      return 'notFound';
    default:
      return 'invalidCredentials';
  }
}

async function holdUntilFloor(startedAt: number, floorMs: number): Promise<void> {
  const remaining = startedAt + floorMs - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

export function registerIdentityRoutes(
  instance: FastifyInstance,
  deps: IdentityRouteDeps,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };
  const revocationDeps = {
    db: deps.db,
    ...(deps.providerRevoker !== undefined ? { providerRevoker: deps.providerRevoker } : {}),
  };

  // ---------------------------------------------------------------------
  // POST /auth/session — first login + Himma session establishment.
  // ---------------------------------------------------------------------
  app.post(
    '/auth/session',
    {
      config: { authPolicy: 'unauthenticatedAuthFlow' },
      bodyLimit: AUTH_BODY_LIMIT,
      schema: {
        body: Type.Object({
          accessToken: TokenString,
          idToken: Type.Optional(TokenString),
          deviceLabel: Type.Optional(Type.String({ maxLength: 120 })),
          /** Session-continuity opt-in (docs/26 §4.7(9)): presented ONCE so
           *  the server can move it into the HttpOnly auth-path cookie; it
           *  is never stored, logged, or echoed in any response body. */
          refreshToken: Type.Optional(TokenString),
        }),
        response: {
          200: Type.Object({
            status: Type.Literal('authenticated'),
            userId: Uuid,
            accountId: Type.Optional(Uuid),
            session: Type.Object({ id: Uuid, expiresAt: Type.String() }),
            /** Double-submit CSRF value for the cookie channel (random
             *  channel binding — never an authentication credential). */
            csrfToken: Type.Optional(Type.String()),
          }),
          401: ErrorBody,
          403: ErrorBody,
          409: ErrorBody,
          422: ErrorBody,
          429: ErrorBody,
          500: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const limited = await deps.rateLimiter.consume(
        `session:${rateLimitDigest(request.ip)}`,
        deps.rules.sessionEstablishment,
        1,
      );
      if (!limited.allowed) {
        return sendOutcome(reply, 'rateLimited', {
          'retry-after': String(limited.retryAfterSeconds),
        });
      }

      // 1. Provider verification — outside any DB transaction.
      const access = await deps.accessTokenVerifier.verifyAccessToken(request.body.accessToken);
      if (!access.ok) {
        return sendOutcome(
          reply,
          access.reason === 'providerUnavailable' ? 'providerUnavailable' : 'invalidCredentials',
        );
      }

      // 2. Optional ID-token identity evidence (first login / new identity).
      if (request.body.idToken !== undefined) {
        const identity = await deps.idTokenAdapter.validateToken(request.body.idToken);
        if (!identity.ok) {
          return sendOutcome(
            reply,
            identity.reason === 'providerUnavailable'
              ? 'providerUnavailable'
              : 'invalidCredentials',
          );
        }
        // 3. Token-pair binding: both tokens must represent the same
        // provider user. Mismatches create NOTHING.
        if (
          identity.evidence.issuer !== access.evidence.issuer ||
          identity.evidence.subject !== access.evidence.subject
        ) {
          return sendOutcome(reply, 'invalidCredentials');
        }
        const login = await firstLogin(serviceDeps, { evidence: identity.evidence });
        if (login.kind !== 'newCustomerCreated' && login.kind !== 'identityResolved') {
          return sendOutcome(reply, loginFlowOutcome(login.kind));
        }
      }

      // 4. Himma session establishment (its own service transaction).
      const session = await establishSession(serviceDeps, {
        evidence: access.evidence,
        client: {
          ...(request.body.deviceLabel !== undefined
            ? { deviceLabel: request.body.deviceLabel }
            : {}),
          ipAddress: request.ip,
        },
      });
      if (session.kind !== 'sessionEstablished') {
        // Unknown identities collapse into the single invalidCredentials
        // class on the login path (docs/26 §5.5) — never not-found-shaped.
        return sendOutcome(
          reply,
          session.kind === 'identityNotFound'
            ? 'invalidCredentials'
            : loginFlowOutcome(session.kind),
        );
      }
      // Session continuity (docs/26 §4.7(9)): move the presented refresh
      // token into the Secure/HttpOnly auth-path cookie and hand back the
      // double-submit CSRF value. The refresh token itself never appears
      // in any response body.
      let csrfToken: string | undefined;
      if (deps.sessionContinuity !== undefined && request.body.refreshToken !== undefined) {
        if (!originAllowed(deps.sessionContinuity.cookieConfig, request.headers.origin)) {
          return sendOutcome(reply, 'csrfRejected');
        }
        csrfToken = newCsrfToken();
        void reply.header('set-cookie', [
          refreshCookie(deps.sessionContinuity.cookieConfig, request.body.refreshToken),
          csrfCookie(deps.sessionContinuity.cookieConfig, csrfToken),
        ]);
      }
      return reply.status(200).send({
        status: 'authenticated' as const,
        userId: session.userId,
        ...(session.accountId !== undefined ? { accountId: session.accountId } : {}),
        session: {
          id: session.sessionId,
          expiresAt: access.evidence.expiresAt.toISOString(),
        },
        ...(csrfToken !== undefined ? { csrfToken } : {}),
      });
    },
  );

  // ---------------------------------------------------------------------
  // Session-continuity channel (docs/26 §4.7(9)/§14.E — W2-12A correction):
  // GET /auth/csrf re-issues the double-submit value to an allowlisted
  // origin holding the refresh cookie; POST /auth/refresh performs the
  // server-mediated Cognito refresh under the §9.4 Himma liveness
  // transaction. Registered ONLY when the channel is configured.
  // ---------------------------------------------------------------------
  if (deps.sessionContinuity !== undefined) {
    const continuity = deps.sessionContinuity;
    const clearAuthCookies = (reply: Parameters<typeof sendOutcome>[0]) => {
      void reply.header('set-cookie', clearedAuthCookies(continuity.cookieConfig));
    };

    app.get(
      '/auth/csrf',
      {
        config: { authPolicy: 'unauthenticatedAuthFlow' },
        schema: {
          response: {
            200: Type.Object({
              status: Type.Literal('ok'),
              csrfToken: Type.String(),
            }),
            401: ErrorBody,
            403: ErrorBody,
            429: ErrorBody,
            500: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        if (!originAllowed(continuity.cookieConfig, request.headers.origin)) {
          return sendOutcome(reply, 'csrfRejected');
        }
        const cookies = parseCookies(request.headers.cookie);
        if (!cookies.has(REFRESH_COOKIE_NAME)) {
          // No continuity material — semantically signed out.
          return sendOutcome(reply, 'sessionExpired');
        }
        const csrfToken = newCsrfToken();
        void reply.header('set-cookie', [csrfCookie(continuity.cookieConfig, csrfToken)]);
        return reply.status(200).send({ status: 'ok' as const, csrfToken });
      },
    );

    app.post(
      '/auth/refresh',
      {
        config: { authPolicy: 'unauthenticatedAuthFlow' },
        bodyLimit: AUTH_BODY_LIMIT,
        schema: {
          body: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
          response: {
            200: Type.Object({
              status: Type.Literal('authenticated'),
              accessToken: Type.String(),
              idToken: Type.Optional(Type.String()),
              assurance: Type.String(),
              expiresAt: Type.String(),
              csrfToken: Type.String(),
            }),
            401: ErrorBody,
            403: ErrorBody,
            429: ErrorBody,
            500: ErrorBody,
            503: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        const limited = await deps.rateLimiter.consume(
          `refresh:${rateLimitDigest(request.ip)}`,
          deps.rules.sessionEstablishment,
          1,
        );
        if (!limited.allowed) {
          return sendOutcome(reply, 'rateLimited', {
            'retry-after': String(limited.retryAfterSeconds),
          });
        }
        // CSRF defense-in-depth (docs/26 §4.7(9)): origin allowlist, then
        // the SameSite=Strict cookies, then the double-submit header.
        if (!originAllowed(continuity.cookieConfig, request.headers.origin)) {
          return sendOutcome(reply, 'csrfRejected');
        }
        const cookies = parseCookies(request.headers.cookie);
        if (
          !csrfMatches(cookies.get(CSRF_COOKIE_NAME), request.headers[CSRF_HEADER_NAME])
        ) {
          return sendOutcome(reply, 'csrfRejected');
        }
        const refreshToken = cookies.get(REFRESH_COOKIE_NAME);
        if (refreshToken === undefined) {
          return sendOutcome(reply, 'sessionExpired');
        }

        // 1. Provider refresh — outside any DB transaction (§9.4).
        const refreshed = await continuity.tokenRefresher.refreshTokens({ refreshToken });
        if (!refreshed.ok) {
          if (refreshed.reason === 'providerUnavailable') {
            return sendOutcome(reply, 'providerUnavailable');
          }
          // Revoked/expired/reused provider material: clear the channel so
          // the browser cannot loop on a dead credential.
          clearAuthCookies(reply);
          return sendOutcome(reply, 'sessionExpired');
        }

        // 2. Verify the rotated access token through the adapter boundary.
        const access = await deps.accessTokenVerifier.verifyAccessToken(
          refreshed.tokens.accessToken,
        );
        if (!access.ok) {
          if (access.reason === 'providerUnavailable') {
            return sendOutcome(reply, 'providerUnavailable');
          }
          clearAuthCookies(reply);
          return sendOutcome(reply, 'sessionExpired');
        }

        // 3. The §9.4 Himma transaction: session-of-record liveness + CAS
        // last-seen. A still-valid provider refresh token NEVER bypasses
        // Himma revocation — a dead row refuses here and clears the channel.
        const liveness = await checkSessionLiveness(
          { db: deps.db },
          { evidence: access.evidence, touch: true },
        );
        if (liveness.kind !== 'authenticated') {
          clearAuthCookies(reply);
          return sendOutcome(reply, livenessOutcomeName(liveness.kind));
        }

        // 4. Rotate the cookie channel: new CSRF value always; new refresh
        // cookie when the provider rotated the token.
        const csrfToken = newCsrfToken();
        const setCookies = [csrfCookie(continuity.cookieConfig, csrfToken)];
        if (refreshed.tokens.refreshToken !== undefined) {
          setCookies.unshift(
            refreshCookie(continuity.cookieConfig, refreshed.tokens.refreshToken),
          );
        }
        void reply.header('set-cookie', setCookies);
        return reply.status(200).send({
          status: 'authenticated' as const,
          accessToken: refreshed.tokens.accessToken,
          ...(refreshed.tokens.idToken !== undefined
            ? { idToken: refreshed.tokens.idToken }
            : {}),
          assurance: access.evidence.assurance,
          expiresAt: access.evidence.expiresAt.toISOString(),
          csrfToken,
        });
      },
    );
  }

  // ---------------------------------------------------------------------
  // GET /me — principal snapshot (docs/26 §10, §12).
  // ---------------------------------------------------------------------
  app.get(
    '/me',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        response: {
          200: Type.Object({
            user: Type.Object({ id: Uuid }),
            account: Type.Optional(
              Type.Object({
                id: Uuid,
                displayName: Type.String(),
                contactEmail: Type.Union([Type.String(), Type.Null()]),
              }),
            ),
            participants: Type.Array(
              Type.Object({ id: Uuid, kind: Type.Literal('self'), firstName: Type.String() }),
            ),
            roles: Type.Array(Type.Never()),
          }),
          401: ErrorBody,
          403: ErrorBody,
          429: ErrorBody,
          500: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request.principal);
      return readCustomerProfile(serviceDeps, { userId: principal.userId });
    },
  );

  // ---------------------------------------------------------------------
  // GET /auth/sessions — the user's own live session/device inventory.
  // ---------------------------------------------------------------------
  app.get(
    '/auth/sessions',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        response: {
          200: Type.Object({
            sessions: Type.Array(
              Type.Object({
                id: Uuid,
                clientKind: Type.String(),
                deviceLabel: Type.Union([Type.String(), Type.Null()]),
                createdAt: Type.String(),
                lastSeenAt: Type.String(),
                expiresAt: Type.String(),
                version: Type.Integer(),
                current: Type.Boolean(),
              }),
            ),
          }),
          401: ErrorBody,
          403: ErrorBody,
          429: ErrorBody,
          500: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request.principal);
      const sessions = await listSessions(serviceDeps, { userId: principal.userId });
      return {
        sessions: sessions.map((session) => ({
          id: session.sessionId,
          clientKind: session.clientKind,
          deviceLabel: session.deviceLabel,
          createdAt: session.createdAt.toISOString(),
          lastSeenAt: session.lastSeenAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
          version: session.version,
          current: session.sessionId === principal.sessionId,
        })),
      };
    },
  );

  // ---------------------------------------------------------------------
  // DELETE /auth/sessions/:sessionId — selected owned-session logout
  // (step-up per docs/26 §3.10/§10; ownership enforced by the service).
  // ---------------------------------------------------------------------
  app.delete(
    '/auth/sessions/:sessionId',
    {
      config: { authPolicy: 'stepUpRequired' },
      bodyLimit: AUTH_BODY_LIMIT,
      schema: {
        params: Type.Object({ sessionId: Uuid }),
        body: Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }) }),
        response: {
          200: Type.Object({
            status: Type.Union([Type.Literal('loggedOut'), Type.Literal('alreadyRevoked')]),
          }),
          401: ErrorBody,
          403: ErrorBody,
          404: ErrorBody,
          409: ErrorBody,
          422: ErrorBody,
          429: ErrorBody,
          500: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await logoutSession(
        revocationDeps,
        { userId: principal.userId },
        {
          sessionId: request.params.sessionId,
          expectedVersion: request.body.expectedVersion,
        },
      );
      if (result.kind === 'loggedOut' || result.kind === 'alreadyRevoked') {
        return reply.status(200).send({ status: result.kind });
      }
      return sendOutcome(reply, result.kind === 'sessionNotFound' ? 'notFound' : 'staleVersion');
    },
  );

  // ---------------------------------------------------------------------
  // POST /auth/logout — current session; idempotent. The optional
  // refreshToken is EPHEMERAL pass-through for provider revocation only.
  // ---------------------------------------------------------------------
  app.post(
    '/auth/logout',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: AUTH_BODY_LIMIT,
      schema: {
        body: Type.Union([
          Type.Object({ refreshToken: Type.Optional(TokenString) }),
          Type.Null(),
        ]),
        response: {
          200: Type.Object({
            status: Type.Union([Type.Literal('loggedOut'), Type.Literal('alreadyRevoked')]),
          }),
          401: ErrorBody,
          403: ErrorBody,
          429: ErrorBody,
          500: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      // Final §14.E logout architecture: the provider-revocation material
      // comes from the HttpOnly cookie channel when configured (the body
      // pass-through remains for non-cookie clients); the auth cookies are
      // ALWAYS cleared so a stale refresh cookie can never silently
      // re-authenticate this browser.
      const cookieRefreshToken =
        deps.sessionContinuity !== undefined
          ? parseCookies(request.headers.cookie).get(REFRESH_COOKIE_NAME)
          : undefined;
      const ephemeralToken = request.body?.refreshToken ?? cookieRefreshToken;
      const result = await logoutSession(
        revocationDeps,
        { userId: principal.userId },
        {
          sessionId: principal.sessionId,
          ...(ephemeralToken !== undefined ? { ephemeralToken } : {}),
        },
      );
      if (deps.sessionContinuity !== undefined) {
        void reply.header(
          'set-cookie',
          clearedAuthCookies(deps.sessionContinuity.cookieConfig),
        );
      }
      if (result.kind === 'loggedOut' || result.kind === 'alreadyRevoked') {
        return reply.status(200).send({ status: result.kind });
      }
      // The principal's own session cannot be foreign or stale here.
      return sendOutcome(reply, 'internalError');
    },
  );

  // ---------------------------------------------------------------------
  // POST /auth/logout-all — every session of the user; idempotent.
  // ---------------------------------------------------------------------
  app.post(
    '/auth/logout-all',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: AUTH_BODY_LIMIT,
      schema: {
        body: Type.Union([
          Type.Object({ refreshToken: Type.Optional(TokenString) }),
          Type.Null(),
        ]),
        response: {
          200: Type.Object({
            status: Type.Literal('loggedOutAll'),
            revokedCount: Type.Integer(),
          }),
          401: ErrorBody,
          403: ErrorBody,
          429: ErrorBody,
          500: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await logoutAllSessions(revocationDeps, { userId: principal.userId });
      return reply
        .status(200)
        .send({ status: 'loggedOutAll' as const, revokedCount: result.revokedCount });
    },
  );

  // ---------------------------------------------------------------------
  // POST /auth/identities/link — link a SECOND provider identity (fresh ID
  // token proves present control — docs/26 §3.6); step-up gated.
  // ---------------------------------------------------------------------
  app.post(
    '/auth/identities/link',
    {
      config: { authPolicy: 'stepUpRequired' },
      bodyLimit: AUTH_BODY_LIMIT,
      schema: {
        body: Type.Object({ idToken: TokenString }),
        response: {
          200: Type.Object({
            status: Type.Union([Type.Literal('linked'), Type.Literal('alreadyLinked')]),
            identityId: Uuid,
          }),
          401: ErrorBody,
          403: ErrorBody,
          409: ErrorBody,
          422: ErrorBody,
          429: ErrorBody,
          500: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const limited = await deps.rateLimiter.consume(
        `link:${rateLimitDigest(principal.userId)}`,
        deps.rules.identityLinking,
        1,
      );
      if (!limited.allowed) {
        return sendOutcome(reply, 'rateLimited', {
          'retry-after': String(limited.retryAfterSeconds),
        });
      }
      const identity = await deps.idTokenAdapter.validateToken(request.body.idToken);
      if (!identity.ok) {
        return sendOutcome(
          reply,
          identity.reason === 'providerUnavailable' ? 'providerUnavailable' : 'invalidCredentials',
        );
      }
      const result = await linkIdentity(
        serviceDeps,
        { userId: principal.userId },
        { evidence: identity.evidence },
      );
      if (result.kind === 'identityLinked') {
        return reply.status(200).send({ status: 'linked' as const, identityId: result.identityId });
      }
      if (result.kind === 'identityAlreadyLinked') {
        return reply
          .status(200)
          .send({ status: 'alreadyLinked' as const, identityId: result.identityId });
      }
      return sendOutcome(reply, loginFlowOutcome(result.kind));
    },
  );

  // ---------------------------------------------------------------------
  // DELETE /auth/identities/:identityId — unlink (docs/26 §9.3); step-up.
  // ---------------------------------------------------------------------
  app.delete(
    '/auth/identities/:identityId',
    {
      config: { authPolicy: 'stepUpRequired' },
      bodyLimit: AUTH_BODY_LIMIT,
      schema: {
        params: Type.Object({ identityId: Uuid }),
        body: Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }) }),
        response: {
          200: Type.Object({ status: Type.Literal('unlinked') }),
          401: ErrorBody,
          403: ErrorBody,
          404: ErrorBody,
          409: ErrorBody,
          422: ErrorBody,
          429: ErrorBody,
          500: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await unlinkIdentity(
        serviceDeps,
        { userId: principal.userId },
        {
          identityId: request.params.identityId,
          expectedVersion: request.body.expectedVersion,
        },
      );
      if (result.kind === 'identityUnlinked') {
        return reply.status(200).send({ status: 'unlinked' as const });
      }
      return sendOutcome(reply, loginFlowOutcome(result.kind));
    },
  );

  // ---------------------------------------------------------------------
  // POST /auth/password/reset-request — enumeration-safe (docs/26 §5.5,
  // §10): ALWAYS the same accepted response; bookkeeping + captured mail
  // happen only when an identity exists, and nothing observable differs.
  // ---------------------------------------------------------------------
  app.post(
    '/auth/password/reset-request',
    {
      config: { authPolicy: 'unauthenticatedAuthFlow' },
      bodyLimit: AUTH_BODY_LIMIT,
      schema: {
        body: Type.Object({ email: Type.String({ format: 'email', maxLength: 320 }) }),
        response: {
          200: Type.Object({ status: Type.Literal('accepted') }),
          422: ErrorBody,
          429: ErrorBody,
          500: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const startedAt = Date.now();
      const limited = await deps.rateLimiter.consume(
        `reset:${rateLimitDigest(request.body.email)}:${rateLimitDigest(request.ip)}`,
        deps.rules.resetRequest,
        1,
      );
      if (!limited.allowed) {
        return sendOutcome(reply, 'rateLimited', {
          'retry-after': String(limited.retryAfterSeconds),
        });
      }

      const result = await requestPasswordReset(
        { db: deps.db, mailSender: deps.mailSender },
        { email: request.body.email },
      );
      await holdUntilFloor(startedAt, deps.enumerationFloorMs);
      return reply.status(200).send(result);
    },
  );
}
