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
  resolveOrgScope,
  type OrgScope,
} from '../../provider/services/provider-principal';
import {
  checkSessionLiveness,
  type AuthenticatedSessionPrincipal,
} from '../services/session-liveness';
import { resolveAdminRoles, type AdminRole } from '../services/admin-roles';
import {
  resolveSessionMfaAssurance,
  type SessionMfaAssurance,
} from '../services/mfa-step-up';
import type { AccessTokenVerifier } from '../providers/access-token';
import { livenessOutcomeName, sendOutcome } from './http-outcomes';
import { isAdminPolicy, isProviderPolicy, policyOf, providerCapabilityOf } from './policies';
import {
  rateLimitDigest,
  type RateLimiterStore,
  type RateLimitRules,
} from './rate-limiter';

/** Minimum approved request principal: B2-3 session principal + provider
 *  reference + Himma-database-resolved admin roles (empty for customers and
 *  on non-admin routes) + the per-request provider org scope (S3-3; only on
 *  provider policies) + safe derived MFA assurance (B2-6C). Roles and org
 *  scope come ONLY from Himma PostgreSQL (`admin_role_assignment` /
 *  `staff_membership`) — never from provider claims — and assurance comes
 *  from the live session plus Himma `step_up_grant` rows, never from
 *  enrollment state alone. */
export interface RequestPrincipal extends AuthenticatedSessionPrincipal {
  issuer: string;
  subject: string;
  adminRoles: AdminRole[];
  /** Resolved provider context for the ONE addressed organization (docs/27
   *  §8); null outside provider policies. Exactly one org per request. */
  orgScope: OrgScope | null;
  /** app_user.mfa_enrolled mirror — resolved on assurance-gated policies. */
  mfaEnrolled?: boolean;
  /** Most recent valid step-up proof honored for this request. */
  stepUp?: { at: Date; method: string };
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

    // Step-up recency (docs/26 §3.10): a fresh provider authentication OR a
    // live session-bound Himma step_up_grant (B2-6B). Enrollment state alone
    // is never assurance, and grants die with their session (queried only on
    // the live session established above).
    const authTime = liveness.principal.stepUpAt;
    const authTimeFresh =
      authTime !== undefined &&
      deps.now() - authTime.getTime() <= deps.stepUpMaxAgeSeconds * 1000;
    let assuranceState: SessionMfaAssurance | undefined;
    const resolveAssurance = async (): Promise<SessionMfaAssurance> => {
      assuranceState ??= await resolveSessionMfaAssurance(
        { db: deps.db },
        { userId: liveness.principal.userId, sessionId: liveness.principal.sessionId },
      );
      return assuranceState;
    };
    let stepUp: { at: Date; method: string } | undefined;

    if (policy === 'stepUpRequired') {
      const grant = (await resolveAssurance()).grant;
      if (grant !== undefined) {
        stepUp = { at: grant.grantedAt, method: grant.method };
      } else if (authTimeFresh && authTime !== undefined) {
        stepUp = { at: authTime, method: 'provider_auth' };
      } else {
        return sendOutcome(reply, 'stepUpRequired');
      }
    }

    let orgScope: OrgScope | null = null;
    let adminRoles: AdminRole[] = [];
    let mfaEnrolled: boolean | undefined;
    if (policy !== undefined && isProviderPolicy(policy)) {
      // Provider-private management (docs/27 §7–§8; D-S3-5), in the binding
      // order: (1) live session — established above; (2) an ACTIVE staff
      // membership for the ONE addressed organization, resolved fresh from
      // PostgreSQL — no membership, unknown org, and terminal (offboarded)
      // org are all the same not-found shape, so nothing about another
      // provider's existence leaks and Cognito claims grant nothing;
      // (3) the MFA baseline: Himma enrollment + an MFA-verified session
      // factor (MFA login or a live TOTP/recovery-code grant); (4) for the
      // higher-risk set, a sufficiently RECENT step-up; (5) the declared
      // ACTIVE capability; (6) the suspended-organization mutation refusal.
      const organizationId = (request.params as Record<string, unknown> | null)?.organizationId;
      if (typeof organizationId !== 'string') {
        request.log.error('provider route without :organizationId param');
        return sendOutcome(reply, 'notFound');
      }
      const resolved = await resolveOrgScope(
        { db: deps.db },
        { userId: liveness.principal.userId, organizationId },
      );
      if (resolved.kind !== 'resolved') return sendOutcome(reply, 'notFound');

      const assurance = await resolveAssurance();
      mfaEnrolled = assurance.mfaEnrolled;
      if (!assurance.mfaEnrolled) return sendOutcome(reply, 'mfaRequired');
      const mfaGrant =
        assurance.grant !== undefined &&
        (assurance.grant.method === 'totp' || assurance.grant.method === 'recovery_code')
          ? assurance.grant
          : undefined;
      const sessionMfaVerified = liveness.principal.assurance === 'mfa';
      if (mfaGrant === undefined && !sessionMfaVerified) {
        return sendOutcome(reply, 'mfaRequired');
      }
      if (policy === 'providerStepUp') {
        // Slice-2 recency semantics composed on top of the baseline.
        if (mfaGrant !== undefined) {
          stepUp = { at: mfaGrant.grantedAt, method: mfaGrant.method };
        } else if (sessionMfaVerified && authTimeFresh && authTime !== undefined) {
          stepUp = { at: authTime, method: 'provider_mfa' };
        } else {
          return sendOutcome(reply, 'stepUpRequired');
        }
      }

      const capability = providerCapabilityOf(request.routeOptions.config);
      if (capability === undefined || !resolved.orgScope.capabilities.includes(capability)) {
        // Right organization, insufficient role/scope (docs/27 §7.3).
        return sendOutcome(reply, 'forbidden');
      }
      const mutating = request.method !== 'GET' && request.method !== 'HEAD';
      if (mutating && resolved.orgScope.organizationState === 'suspended') {
        // Suspended: provider-private reads still work; every provider
        // mutation is refused (docs/27 §7.5).
        return sendOutcome(reply, 'organizationSuspended');
      }
      orgScope = resolved.orgScope;
    }
    if (isAdminPolicy(policy)) {
      // Admin surfaces, in the binding order (docs/23 §7, docs/26 §5.8;
      // W3-1 final baseline/step-up split): (1) live session — established
      // above; (2) at least one ACTIVE Himma database role, resolved fresh
      // per request (non-admins are simply `forbidden`, learning nothing
      // about MFA requirements); (3) Himma MFA enrollment; (4) an
      // MFA-VERIFIED session factor — an MFA login or a live
      // TOTP/recovery-code grant — with NO recency requirement at the
      // `admin` baseline (owner decision: ordinary bootstrap and permitted
      // surfaces never demand a fresh TOTP merely because the factor
      // aged); (5) `adminStepUp` only: a sufficiently RECENT factor — the
      // pre-split semantics every sensitive admin operation keeps. No role
      // or assurance material ever comes from provider claims, and
      // role/session revocation bites regardless of any grant.
      adminRoles = await resolveAdminRoles({ db: deps.db }, liveness.principal.userId);
      if (adminRoles.length === 0) return sendOutcome(reply, 'forbidden');
      const assurance = await resolveAssurance();
      mfaEnrolled = assurance.mfaEnrolled;
      if (!assurance.mfaEnrolled) return sendOutcome(reply, 'mfaRequired');
      const mfaGrant =
        assurance.grant !== undefined &&
        (assurance.grant.method === 'totp' || assurance.grant.method === 'recovery_code')
          ? assurance.grant
          : undefined;
      const sessionMfaVerified = liveness.principal.assurance === 'mfa';
      if (mfaGrant === undefined && !sessionMfaVerified) {
        return sendOutcome(reply, 'mfaRequired');
      }
      if (mfaGrant !== undefined) {
        stepUp = { at: mfaGrant.grantedAt, method: mfaGrant.method };
      } else if (sessionMfaVerified && authTimeFresh && authTime !== undefined) {
        stepUp = { at: authTime, method: 'provider_mfa' };
      } else if (policy === 'adminStepUp') {
        // MFA-verified but stale: the baseline admits it; step-up refuses.
        return sendOutcome(reply, 'stepUpRequired');
      }
    }

    request.principal = {
      ...liveness.principal,
      issuer: verified.evidence.issuer,
      subject: verified.evidence.subject,
      adminRoles,
      orgScope,
      ...(mfaEnrolled !== undefined ? { mfaEnrolled } : {}),
      ...(stepUp !== undefined ? { stepUp } : {}),
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

/** The org scope is always present behind provider policies. */
export function requireOrgScope(principal: RequestPrincipal | null): OrgScope {
  const scope = requirePrincipal(principal).orgScope;
  if (scope === null) {
    throw new Error('orgScope missing behind a provider route policy');
  }
  return scope;
}
