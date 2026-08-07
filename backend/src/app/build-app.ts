/**
 * Fastify 5 application foundation (owner ruling 2; docs/25 §2).
 *
 * Structural deny-by-default (docs/26 §6): the route-policy guard is
 * installed on EVERY app instance before any route registers — a route
 * without an explicit `config.authPolicy` declaration aborts startup, and
 * public status (including the health route) is always a deliberate
 * declaration. The identity HTTP layer (B2-4) is registered when its
 * dependencies are supplied; the app builds without them for foundation
 * tests and tooling.
 */
import { Type } from '@sinclair/typebox';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import { isDbError } from '../db/errors';
import type { Db } from '../db/kysely';
import type { NodeEnv } from '../config/env';
import type { MailSender } from '../modules/identity/mail/mail-sender';
import type { AuthProviderAdapter } from '../modules/identity/providers/adapter';
import type { AccessTokenVerifier } from '../modules/identity/providers/access-token';
import type { ProviderSessionRevoker } from '../modules/identity/providers/revocation';
import type { MfaProviderPort } from '../modules/identity/providers/mfa';
import type { MfaConfig } from '../modules/identity/services/mfa-config';
import type { StaffInvitationConfig } from '../modules/provider/staff-invitation-config';
import { registerAdminModerationRoutes } from '../modules/catalogue/http/admin-moderation-routes';
import { registerCatalogueRoutes } from '../modules/catalogue/http/catalogue-routes';
import { installAuthPipeline } from '../modules/identity/http/auth-plugin';
import { registerAdminRoutes } from '../modules/identity/http/admin-routes';
import { registerIdentityRoutes } from '../modules/identity/http/identity-routes';
import { registerMfaRoutes } from '../modules/identity/http/mfa-routes';
import { registerOrganizationAdminRoutes } from '../modules/provider/http/organization-admin-routes';
import { registerProviderRoutes } from '../modules/provider/http/provider-routes';
import { registerStorefrontRoutes } from '../modules/provider/http/storefront-routes';
import { installRoutePolicyGuard } from '../modules/identity/http/policies';
import {
  createRateLimiterStore,
  DEFAULT_RATE_LIMITS,
  type RateLimiterStore,
  type RateLimitRules,
} from '../modules/identity/http/rate-limiter';

/** Configurable security values (docs/26 §14.C) with safe defaults. */
const DEFAULT_STEP_UP_MAX_AGE_SECONDS = 300;
const DEFAULT_ENUMERATION_FLOOR_MS = 30;

/**
 * Production admin-activation capability report (B2-6C, docs/23 §7).
 * Every flag must be EXPLICITLY true for the production admin surface to
 * register; there is no default-true, no environment shortcut, and no test
 * bypass — dev/test exercise the full behavior through deterministic
 * adapters instead. As of B2-6C the real-pool SOFTWARE_TOKEN_MFA smoke
 * (docs/26 §14.E′) has NOT run, so no truthful production configuration
 * can report ready yet: Slice 2 implementation is complete; production
 * Cognito/admin-MFA activation is pending operational validation.
 */
export interface AdminProductionReadiness {
  /** Real Cognito pool configured for authentication (docs/26 §14.E′). */
  cognitoConfigured: boolean;
  /** MFA provider capability validated against that pool. */
  mfaProviderValidated: boolean;
  /** Successful real-pool smoke of the SOFTWARE_TOKEN_MFA challenge flow. */
  realPoolSmokeVerified: boolean;
  /** Owner-approved production configuration in place. */
  productionConfigApproved: boolean;
}

export interface IdentityHttpOptions {
  db: Db;
  accessTokenVerifier: AccessTokenVerifier;
  idTokenAdapter: AuthProviderAdapter;
  mailSender: MailSender;
  providerRevoker?: ProviderSessionRevoker;
  /** MFA routes register when both provider port and config are supplied. */
  mfaProvider?: MfaProviderPort;
  mfaConfig?: MfaConfig;
  /** Provider-private management surface (S3-3) registers when supplied. */
  staffInvitationConfig?: StaffInvitationConfig;
  /**
   * D-S3-3 verification-evidence capability (S3-4). Defaults FALSE with no
   * environment shortcut. Slice 3 contains NO VerificationCase/document-
   * review implementation, so no production build can truthfully report
   * ready — a production start that claims it refuses loudly, and while it
   * is false every production `verify`/`go-live` transition fail-closes
   * with a typed, audited refusal. Development/test exercise the complete
   * lifecycle deterministically.
   */
  verificationEvidenceCapabilityReady?: boolean;
  /** Defaults via createRateLimiterStore — which FAILS CLOSED in production. */
  rateLimiterStore?: RateLimiterStore;
  nodeEnv?: NodeEnv;
  stepUpMaxAgeSeconds?: number;
  enumerationFloorMs?: number;
  rateLimits?: Partial<RateLimitRules>;
  now?: () => number;
  /**
   * Final B2-6C capability gate: in production the admin surface registers
   * ONLY when adminReadiness reports every capability ready — otherwise it
   * is absent (fail-closed 404). Missing readiness never throws unless the
   * caller explicitly forces enableAdminRoutes in an unready production
   * build, which refuses startup loudly instead of lying.
   */
  adminReadiness?: AdminProductionReadiness;
  /** Set false to omit admin routes in dev/test; forcing true in an
   *  UNREADY production build refuses startup. */
  enableAdminRoutes?: boolean;
  /** Set false to omit provider routes in dev/test; forcing true in an
   *  UNREADY production build refuses startup (D-S3-5 shares the identity
   *  MFA-activation gate — no bypass). */
  enableProviderRoutes?: boolean;
}

function adminProductionReady(readiness: AdminProductionReadiness | undefined): boolean {
  return (
    readiness !== undefined &&
    readiness.cognitoConfigured &&
    readiness.mfaProviderValidated &&
    readiness.realPoolSmokeVerified &&
    readiness.productionConfigApproved
  );
}

export interface BuildAppOptions {
  logger?: boolean;
  identity?: IdentityHttpOptions;
}

/** Typed error envelope per docs/24 §11.2. */
const ErrorBody = Type.Object({
  code: Type.String(),
  message: Type.String(),
});

const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
});

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  installRoutePolicyGuard(app);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Database errors are translated at the db boundary (docs/25 §7); here
    // they map to the docs/24 §11 typed vocabulary without leaking SQL
    // detail — expected conflicts were already typed by the services, so
    // anything arriving here is an internal failure, never a user conflict.
    if (isDbError(error)) {
      request.log.error({ err: error }, 'database error');
      return reply.status(500).send({ code: 'internalError', message: 'Internal error' });
    }
    if (error.validation !== undefined) {
      return reply
        .status(422)
        .send({ code: 'validationError', message: error.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    const statusCode = error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500;
    return reply.status(statusCode).send({
      code: statusCode >= 500 ? 'internalError' : 'requestError',
      message: statusCode >= 500 ? 'Internal error' : error.message,
    });
  });

  app.get(
    '/internal/health',
    {
      config: { authPolicy: 'public' },
      schema: { response: { 200: HealthResponse, 500: ErrorBody } },
    },
    async () => ({ status: 'ok' as const }),
  );

  if (options.identity !== undefined) {
    const identity = options.identity;
    const rules: RateLimitRules = { ...DEFAULT_RATE_LIMITS, ...identity.rateLimits };
    const rateLimiter =
      identity.rateLimiterStore ?? createRateLimiterStore(identity.nodeEnv ?? 'development');
    installAuthPipeline(app, {
      db: identity.db,
      verifier: identity.accessTokenVerifier,
      rateLimiter,
      rules,
      stepUpMaxAgeSeconds: identity.stepUpMaxAgeSeconds ?? DEFAULT_STEP_UP_MAX_AGE_SECONDS,
      now: identity.now ?? (() => Date.now()),
    });
    registerIdentityRoutes(app, {
      db: identity.db,
      accessTokenVerifier: identity.accessTokenVerifier,
      idTokenAdapter: identity.idTokenAdapter,
      mailSender: identity.mailSender,
      ...(identity.providerRevoker !== undefined
        ? { providerRevoker: identity.providerRevoker }
        : {}),
      rateLimiter,
      rules,
      enumerationFloorMs: identity.enumerationFloorMs ?? DEFAULT_ENUMERATION_FLOOR_MS,
    });

    // MFA/step-up surface (B2-6C): registers when the provider port and
    // config are wired; dev/test use the deterministic fake provider.
    if (identity.mfaProvider !== undefined && identity.mfaConfig !== undefined) {
      registerMfaRoutes(app, {
        db: identity.db,
        mfaProvider: identity.mfaProvider,
        mfaConfig: identity.mfaConfig,
        rateLimiter,
        rules,
      });
    }

    // Admin surface — final B2-6C capability gate (replaces the temporary
    // B2-5 placeholder): production registers admin routes ONLY when every
    // AdminProductionReadiness capability reports ready; otherwise the
    // surface is absent (fail-closed 404). Explicitly forcing it on in an
    // unready production build refuses startup loudly. Dev/test register
    // the full surface behind the same admin MFA enforcement, exercised
    // through deterministic adapters.
    const nodeEnv = identity.nodeEnv ?? 'development';

    // D-S3-3 (binding): Slice 3 ships NO VerificationCase/document-review
    // capability, so a production build claiming evidence readiness is
    // lying by construction — refuse startup instead of weakening the
    // verify/go-live fail-close. The flag becomes honestly settable only
    // when the admin workstream lands the real capability.
    if (nodeEnv === 'production' && identity.verificationEvidenceCapabilityReady === true) {
      throw new Error(
        'verificationEvidenceCapabilityReady cannot be true: this build contains no VerificationCase/document-review capability, and production verified/live transitions stay fail-closed until it exists (docs/27 D-S3-3).',
      );
    }
    const organizationAdminDeps =
      identity.staffInvitationConfig !== undefined
        ? {
            db: identity.db,
            mailSender: identity.mailSender,
            invitationConfig: identity.staffInvitationConfig,
            lifecycle: {
              nodeEnv,
              verificationEvidenceCapabilityReady:
                identity.verificationEvidenceCapabilityReady ?? false,
            },
          }
        : undefined;

    if (nodeEnv === 'production') {
      const ready = adminProductionReady(identity.adminReadiness);
      if (identity.enableAdminRoutes === true && !ready) {
        throw new Error(
          'Production admin activation is fail-closed: required capabilities (Cognito integration, MFA provider validation, real-pool SOFTWARE_TOKEN_MFA smoke, approved production configuration) have not all reported ready (docs/23 §7; docs/26 §14.E′).',
        );
      }
      if (ready && identity.enableAdminRoutes !== false) {
        registerAdminRoutes(app, { db: identity.db });
        // Internal catalogue moderation (Slice 4) shares the admin surface's
        // production capability gate — same MFA enforcement, no bypass.
        registerAdminModerationRoutes(app, { db: identity.db });
        if (organizationAdminDeps !== undefined) {
          registerOrganizationAdminRoutes(app, organizationAdminDeps);
        }
      }
    } else if (identity.enableAdminRoutes !== false) {
      registerAdminRoutes(app, { db: identity.db });
      registerAdminModerationRoutes(app, { db: identity.db });
      if (organizationAdminDeps !== undefined) {
        registerOrganizationAdminRoutes(app, organizationAdminDeps);
      }
    }

    // Customer-public storefront read (S3-4, docs/27 §13.1): explicitly
    // public, served from the structurally separate public projection; no
    // MFA/activation dependency, so it registers with the identity surface.
    registerStorefrontRoutes(app, { db: identity.db });

    // Provider-private management surface (S3-3). D-S3-5 makes the MFA
    // baseline mandatory on every provider route, and production TOTP
    // activation is still pending the docs/26 §14.E′ real-pool smoke — so
    // the provider surface shares the SAME production capability gate as
    // the admin surface: absent (fail-closed 404) until every identity
    // MFA-activation capability reports ready, refusing startup loudly if
    // explicitly forced on while unready. There is no bypass and no
    // provider-specific weakening. Dev/test register the full surface and
    // exercise the complete behavior through deterministic adapters.
    if (identity.staffInvitationConfig !== undefined) {
      const providerDeps = {
        db: identity.db,
        mailSender: identity.mailSender,
        invitationConfig: identity.staffInvitationConfig,
        rateLimiter,
        rules,
      };
      if (nodeEnv === 'production') {
        const ready = adminProductionReady(identity.adminReadiness);
        if (identity.enableProviderRoutes === true && !ready) {
          throw new Error(
            'Production provider-surface activation is fail-closed: the D-S3-5 MFA baseline depends on the identity MFA capabilities (Cognito integration, MFA provider validation, real-pool SOFTWARE_TOKEN_MFA smoke, approved production configuration), which have not all reported ready (docs/27 §7.9; docs/26 §14.E′).',
          );
        }
        if (ready && identity.enableProviderRoutes !== false) {
          registerProviderRoutes(app, providerDeps);
          // Provider catalogue management (S4-2, docs/28 §16.2) shares the
          // provider surface's production capability gate: same MFA
          // baseline, same fail-closed activation, no bypass.
          registerCatalogueRoutes(app, { db: identity.db });
        }
      } else if (identity.enableProviderRoutes !== false) {
        registerProviderRoutes(app, providerDeps);
        registerCatalogueRoutes(app, { db: identity.db });
      }
    }
  }

  return app;
}
