/**
 * Bearer authentication pipeline (docs/26 §4.1, §4.7, §6) — B2-4.
 *
 * For every route whose policy requires authentication: extract the bearer
 * token safely → verify through the ACCESS-token verifier (a provider ID
 * token can never authenticate — verifiers enforce token-usage semantics)
 * → resolve Himma session liveness (B2-3) → attach the minimum principal.
 * Provider verification happens outside any PostgreSQL transaction; the
 * principal carries NO business roles (empty typed future slots only) —
 * authorization stays Himma-database-backed in later slices.
 *
 * Repeated invalid bearer presentations are rate-limited per IP digest;
 * tokens are never logged or echoed.
 */
import type { FastifyInstance } from 'fastify';

import type { Db } from '../../../db/kysely';
import {
  checkSessionLiveness,
  type AuthenticatedSessionPrincipal,
} from '../services/session-liveness';
import { resolveAdminRoles, type AdminRole } from '../services/admin-roles';
import type { AccessTokenVerifier } from '../providers/access-token';
import { livenessOutcomeName, sendOutcome } from './http-outcomes';
import { policyOf } from './policies';
import {
  rateLimitDigest,
  type RateLimiterStore,
  type RateLimitRules,
} from './rate-limiter';

/** Minimum approved request principal: B2-3 session principal + provider
 *  reference + Himma-database-resolved admin roles (empty for customers and
 *  on non-admin routes) + typed empty future org scope. Roles come ONLY
 *  from `admin_role_assignment` — never from provider claims. */
export interface RequestPrincipal extends AuthenticatedSessionPrincipal {
  issuer: string;
  subject: string;
  adminRoles: AdminRole[];
  orgScope: null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: RequestPrincipal | null;
  }
}

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;
const MAX_TOKEN_LENGTH = 4096;

export interface AuthPipelineDeps {
  db: Db;
  verifier: AccessTokenVerifier;
  rateLimiter: RateLimiterStore;
  rules: RateLimitRules;
  stepUpMaxAgeSeconds: number;
  now: () => number;
}

export function installAuthPipeline(app: FastifyInstance, deps: AuthPipelineDeps): void {
  app.decorateRequest('principal', null);

  // Auth-relevant responses are never cacheable; all responses are nosniff.
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-content-type-options', 'nosniff');
    if (policyOf(request.routeOptions.config) !== 'public') {
      void reply.header('cache-control', 'no-store');
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    const policy = policyOf(request.routeOptions.config);
    if (policy === undefined || policy === 'public' || policy === 'unauthenticatedAuthFlow') {
      return;
    }

    const failureKey = `bearer-fail:${rateLimitDigest(request.ip)}`;
    const blocked = await deps.rateLimiter.consume(failureKey, deps.rules.invalidBearer, 0);
    if (!blocked.allowed) {
      return sendOutcome(reply, 'rateLimited', {
        'retry-after': String(blocked.retryAfterSeconds),
      });
    }

    const rejectToken = async (): Promise<unknown> => {
      await deps.rateLimiter.consume(failureKey, deps.rules.invalidBearer, 1);
      return sendOutcome(reply, 'invalidAccessToken');
    };

    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 16) {
      return rejectToken();
    }
    const match = BEARER_PATTERN.exec(header);
    if (match === null || match[1] === undefined || match[1].length > MAX_TOKEN_LENGTH) {
      return rejectToken();
    }

    // Provider verification — network I/O, strictly outside DB transactions.
    const verified = await deps.verifier.verifyAccessToken(match[1]);
    if (!verified.ok) {
      if (verified.reason === 'providerUnavailable') {
        return sendOutcome(reply, 'providerUnavailable');
      }
      return rejectToken();
    }

    const liveness = await checkSessionLiveness({ db: deps.db }, { evidence: verified.evidence });
    if (liveness.kind !== 'authenticated') {
      return sendOutcome(reply, livenessOutcomeName(liveness.kind));
    }

    if (policy === 'stepUpRequired') {
      const stepUpAt = liveness.principal.stepUpAt;
      const fresh =
        stepUpAt !== undefined &&
        deps.now() - stepUpAt.getTime() <= deps.stepUpMaxAgeSeconds * 1000;
      if (!fresh) return sendOutcome(reply, 'stepUpRequired');
    }

    let adminRoles: AdminRole[] = [];
    if (policy === 'admin') {
      // Admin surfaces require MFA assurance (docs/23 §7) and at least one
      // ACTIVE Himma database role, resolved fresh on every request — no
      // caching, no role material from tokens; changes apply immediately.
      if (liveness.principal.assurance !== 'mfa') {
        return sendOutcome(reply, 'mfaRequired');
      }
      adminRoles = await resolveAdminRoles({ db: deps.db }, liveness.principal.userId);
      if (adminRoles.length === 0) return sendOutcome(reply, 'forbidden');
    }

    request.principal = {
      ...liveness.principal,
      issuer: verified.evidence.issuer,
      subject: verified.evidence.subject,
      adminRoles,
      orgScope: null,
    };
  });
}

/** The principal is always present behind authenticated policies. */
export function requirePrincipal(principal: RequestPrincipal | null): RequestPrincipal {
  if (principal === null) {
    throw new Error('principal missing behind an authenticated route policy');
  }
  return principal;
}
