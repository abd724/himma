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
import { sql as kyselySql } from 'kysely';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import { isDbError } from '../db/errors';
import type { Db } from '../db/kysely';
import {
  enterRequestContext,
  newCorrelationId,
  validClientRequestIdHint,
} from '../observability/request-context';
import type { NodeEnv } from '../config/env';
import type { MailSender } from '../modules/identity/mail/mail-sender';
import type { AuthProviderAdapter } from '../modules/identity/providers/adapter';
import type { AccessTokenVerifier } from '../modules/identity/providers/access-token';
import type { ProviderTokenRefresher } from '../modules/identity/providers/refresh';
import type { ProviderSessionRevoker } from '../modules/identity/providers/revocation';
import type { AuthCookieConfig } from '../modules/identity/http/auth-session-cookies';
import type { MfaProviderPort } from '../modules/identity/providers/mfa';
import type { MfaConfig } from '../modules/identity/services/mfa-config';
import type { StaffInvitationConfig } from '../modules/provider/staff-invitation-config';
import { registerAdminModerationRoutes } from '../modules/catalogue/http/admin-moderation-routes';
import { registerAdminTaxonomyRoutes } from '../modules/catalogue/http/admin-taxonomy-routes';
import { registerBookingAdminRoutes } from '../modules/booking/http/booking-admin-routes';
import { registerBookingCustomerRoutes } from '../modules/booking/http/booking-customer-routes';
import { registerAttendanceProviderRoutes } from '../modules/entitlement/http/attendance-provider-routes';
import { registerFulfillmentProviderRoutes } from '../modules/entitlement/http/fulfillment-provider-routes';
import { registerEntitlementCustomerRoutes } from '../modules/entitlement/http/entitlement-customer-routes';
import { registerReservationCustomerRoutes } from '../modules/entitlement/http/reservation-customer-routes';
import { registerBookingPublicRoutes } from '../modules/booking/http/booking-public-routes';
import { registerBookingProviderRoutes } from '../modules/booking/http/booking-provider-routes';
import { registerPaymentWebhookRoutes } from '../modules/payment/http/payment-webhook-routes';
import type { PaymentProviderPort } from '../modules/payment/provider-port';
import { registerCatalogueRoutes } from '../modules/catalogue/http/catalogue-routes';
import { registerPublicCatalogueRoutes } from '../modules/catalogue/http/public-catalogue-routes';
import { registerSearchRoutes } from '../modules/catalogue/http/search-routes';
import { PostgresSearchReadPort } from '../modules/catalogue/services/search-read-port';
import { installAuthPipeline } from '../modules/identity/http/auth-plugin';
import { registerAdminRoutes } from '../modules/identity/http/admin-routes';
import { registerDevIdentityRoutes } from '../modules/identity/http/dev-identity-routes';
import { registerIdentityRoutes } from '../modules/identity/http/identity-routes';
import { registerMfaRoutes } from '../modules/identity/http/mfa-routes';
import { registerParticipantRoutes } from '../modules/identity/http/participant-routes';
import type { DevPasswordIdentityProvider } from '../modules/identity/providers/dev/dev-password-identity';
import { registerOrganizationAdminRoutes } from '../modules/provider/http/organization-admin-routes';
import { registerOrganizationAdminReadRoutes } from '../modules/provider/http/organization-admin-read-routes';
import { registerProviderRoutes } from '../modules/provider/http/provider-routes';
import {
  installEvidenceContentParsers,
  registerAdminEvidenceRoutes,
  registerProviderEvidenceRoutes,
} from '../modules/provider/http/verification-evidence-routes';
import {
  DEFAULT_EVIDENCE_UPLOAD_CONFIG,
  type VerificationEvidenceObjectStore,
  type VerificationEvidenceUploadConfig,
} from '../modules/provider/storage/evidence-store';
import type { EvidenceStorageDeps } from '../modules/provider/services/evidence-storage';
import { registerVerificationReviewRoutes } from '../modules/provider/http/verification-review-routes';
import type { VerificationRequirementPolicyProvider } from '../modules/provider/services/verification-case';
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
  /**
   * docs/26 §4.7(9)/§14.E browser session-continuity channel (W2-12A
   * correction): the HttpOnly auth-path refresh cookie, double-submit
   * CSRF, and the server-mediated `POST /auth/refresh`. Absent → the
   * channel does not exist (fail-closed 404) and behavior is unchanged.
   */
  sessionContinuity?: {
    cookieConfig: AuthCookieConfig;
    tokenRefresher: ProviderTokenRefresher;
  };
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
  /**
   * W3-4 private verification-evidence storage (D-W3-1). ABSENT (the
   * default) = the entire evidence upload/download surface does not exist
   * (fail-closed 404) — an unconfigured deployment can never accept or
   * serve documents, and nothing can ever mark evidence `stored`.
   * Production must supply the real private S3-compatible driver; the
   * deterministic in-memory store is a dev/test double only.
   */
  verificationEvidenceStorage?: {
    store: VerificationEvidenceObjectStore;
    upload?: Partial<VerificationEvidenceUploadConfig>;
    /**
     * Evidence content-safety capability report (W3-4 owner correction).
     * Defaults FALSE: internal/admin retrieval of provider-uploaded bytes
     * FAILS CLOSED (typed `verificationEvidenceSafetyUnavailable`) until a
     * trusted content-safety/scanning boundary exists and reports ready —
     * a HARD prerequisite for live Admin evidence review. This build
     * contains NO scanning capability, so a production start claiming
     * readiness refuses loudly (the D-S3-3 pattern) — there is no operator
     * bypass. Dev/test set it true to exercise retrieval deterministically.
     */
    contentSafetyReady?: boolean;
  };
  /**
   * W3-5: the injected evidence-requirement policy (W3-3 seam). ABSENT
   * (the default — D-W3-3 is an unresolved owner decision) = opening a
   * verification round refuses with the typed policy-unavailable outcome;
   * the real production review path stays fail-closed until the owner
   * approves the launch checklist and configuration supplies it.
   */
  verificationPolicyProvider?: VerificationRequirementPolicyProvider;
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
  /**
   * `true`/`false` keep the historical behavior; a pino options object
   * (W6-1, docs/37 §24 — `buildLoggerOptions`) configures structured
   * production logging. Passed straight to Fastify.
   */
  logger?: FastifyServerOptions['logger'];
  /**
   * W6-1 production runtime wiring (docs/37 §7/§23). Absent = historical
   * behavior (no readiness route, correlation still active). When present:
   * `/internal/ready` registers with DB/identity/migration-head checks and
   * honors the shutdown drain signal.
   */
  runtime?: {
    readiness: {
      db: Db;
      /** The migration head this build requires (expectedMigrationHead()). */
      expectedMigrationHead?: string;
      /** The DB login this runtime role must be connected as (docs/37 §28). */
      expectedDbIdentity?: string;
      /** Flipped by graceful shutdown — readiness fails while draining. */
      drainSignal?: { draining: boolean };
    };
  };
  identity?: IdentityHttpOptions;
  /**
   * W5-3 payment webhook ingress + W5-5 customer paid checkout: both exist
   * ONLY when a genuinely composed payment provider exists (docs/33 §13
   * fail-closed composition — in production `resolvePaymentProvider` cannot
   * produce one in W5, so the webhook route is structurally absent there
   * and the customer paid boundary keeps its certified fail-closed refusal;
   * no flag can conjure either). The webhook route is Stripe-authenticated
   * (signature over the raw body), never Himma-authenticated. `checkoutUrls`
   * are the SERVER-AUTHORED hosted-Checkout success/cancel navigation
   * targets (W5-5): pure navigation, never customer input, never financial
   * truth — absent, paid checkout stays fail-closed even with a provider.
   */
  payment?: {
    provider: PaymentProviderPort;
    checkoutUrls?: { successUrl: string; cancelUrl: string };
  };
  /**
   * RI-1 (D-RI-3): DEVELOPMENT-ONLY token-acquisition stand-in for the real
   * Cognito client flows. Registering it composes the /dev/identity routes;
   * PRODUCTION REFUSES this composition outright (startup error) — the dev
   * identity provider can never exist there, exactly like the deterministic
   * payment provider. Real Apple/Google/email sign-in arrives as Cognito
   * configuration, never through this seam.
   */
  devIdentity?: { provider: DevPasswordIdentityProvider };
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
    // W6-1 correlation (docs/37 §23): the canonical request id is ALWAYS
    // server-generated; a client `x-request-id` is never adopted as the id
    // (requestIdHeader:false) — a validated hint may ride in log bindings.
    genReqId: () => newCorrelationId(),
    requestIdHeader: false,
    // W6-1 graceful shutdown (docs/37 §8): close() lets ACTIVE requests
    // finish while idle keep-alive sockets are released — a drained
    // shutdown never hangs on an idle connection.
    forceCloseConnections: 'idle',
  }).withTypeProvider<TypeBoxTypeProvider>();

  installRoutePolicyGuard(app);

  app.addHook('onRequest', (request, reply, done) => {
    const requestId = request.id as string;
    void reply.header('x-request-id', requestId);
    const clientHint = validClientRequestIdHint(request.headers['x-request-id']);
    if (clientHint !== undefined) {
      request.log = request.log.child({ clientRequestId: clientHint });
    }
    // als.run(store, done) carries the id through the remaining hooks,
    // handler, and every await beneath them — the audit seam reads it.
    enterRequestContext(
      clientHint !== undefined ? { requestId, clientRequestId: clientHint } : { requestId },
      done,
    );
  });

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

  // W6-1 liveness (docs/37 §7): process/event-loop aliveness ONLY — no
  // dependency probes, so a third-party outage can never restart-loop the
  // platform. `/internal/health` remains as the historical alias.
  app.get(
    '/internal/live',
    {
      config: { authPolicy: 'public' },
      schema: { response: { 200: HealthResponse, 500: ErrorBody } },
    },
    async () => ({ status: 'ok' as const }),
  );

  // W6-1 readiness (docs/37 §7/§23): registers ONLY when the runtime
  // wiring supplies its dependencies (the production bootstrap does; dev/
  // test builds keep the historical surface). Checks are strictly
  // platform-internal — database reachability, connected DB identity, and
  // the migration head — never Stripe/Cognito/object-storage availability.
  // Responses carry bounded machine codes only; no configuration leaks.
  if (options.runtime !== undefined) {
    const readiness = options.runtime.readiness;
    const ReadyResponse = Type.Object({ status: Type.Literal('ready') });
    const UnreadyResponse = Type.Object({
      status: Type.Literal('unready'),
      reasons: Type.Array(Type.String()),
    });
    let cache: { at: number; identity?: string; head?: string; dbOk: boolean } | undefined;
    const PROBE_CACHE_MS = 2_000;
    app.get(
      '/internal/ready',
      {
        config: { authPolicy: 'public' },
        schema: { response: { 200: ReadyResponse, 503: UnreadyResponse, 500: ErrorBody } },
      },
      async (_request, reply) => {
        const reasons: string[] = [];
        if (readiness.drainSignal?.draining === true) reasons.push('draining');
        const now = Date.now();
        if (cache === undefined || now - cache.at > PROBE_CACHE_MS) {
          try {
            const probe = await kyselySql<{ identity: string; head: string | null }>`
              SELECT current_user AS identity,
                     (SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1) AS head
            `.execute(readiness.db);
            const row = probe.rows[0];
            cache = {
              at: now,
              dbOk: true,
              ...(row?.identity !== undefined ? { identity: row.identity } : {}),
              ...(row?.head != null ? { head: row.head } : {}),
            };
          } catch {
            cache = { at: now, dbOk: false };
          }
        }
        if (!cache.dbOk) reasons.push('databaseUnavailable');
        if (
          cache.dbOk &&
          readiness.expectedDbIdentity !== undefined &&
          cache.identity !== readiness.expectedDbIdentity
        ) {
          reasons.push('wrongDatabaseIdentity');
        }
        if (
          cache.dbOk &&
          readiness.expectedMigrationHead !== undefined &&
          cache.head !== readiness.expectedMigrationHead
        ) {
          reasons.push('migrationHeadMismatch');
        }
        if (reasons.length > 0) {
          return reply.status(503).send({ status: 'unready' as const, reasons });
        }
        return { status: 'ready' as const };
      },
    );
  }

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
    // Browser CORS for the configured portal origins (credentialed auth
    // channel + future domain calls; docs/23 §18 deployment topology stays
    // open — origins are pure configuration, nothing hardcoded).
    if (
      identity.sessionContinuity !== undefined &&
      identity.sessionContinuity.cookieConfig.allowedOrigins.length > 0
    ) {
      const allowed = identity.sessionContinuity.cookieConfig.allowedOrigins;
      app.addHook('onRequest', async (request, reply) => {
        const origin = request.headers.origin;
        if (typeof origin !== 'string' || !allowed.includes(origin)) return;
        void reply.header('access-control-allow-origin', origin);
        void reply.header('access-control-allow-credentials', 'true');
        void reply.header('vary', 'origin');
        if (request.method === 'OPTIONS') {
          void reply.header(
            'access-control-allow-methods',
            'GET,POST,PATCH,DELETE,OPTIONS',
          );
          void reply.header(
            'access-control-allow-headers',
            'authorization,content-type,x-csrf-token',
          );
          void reply.header('access-control-max-age', '600');
          return reply.status(204).send();
        }
        return;
      });
    }
    registerIdentityRoutes(app, {
      db: identity.db,
      accessTokenVerifier: identity.accessTokenVerifier,
      idTokenAdapter: identity.idTokenAdapter,
      mailSender: identity.mailSender,
      ...(identity.providerRevoker !== undefined
        ? { providerRevoker: identity.providerRevoker }
        : {}),
      ...(identity.sessionContinuity !== undefined
        ? { sessionContinuity: identity.sessionContinuity }
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
    // W3-4 private evidence storage: configured → the trusted server-
    // proxied surface exists; absent → fail-closed 404 everywhere.
    // Content safety mirrors D-S3-3: no scanning capability exists in this
    // build, so a production claim of readiness is a lie by construction
    // and refuses startup — internal retrieval stays fail-closed instead.
    if (
      nodeEnv === 'production' &&
      identity.verificationEvidenceStorage?.contentSafetyReady === true
    ) {
      throw new Error(
        'verificationEvidenceStorage.contentSafetyReady cannot be true: this build contains no evidence content-safety/scanning capability, and internal admin retrieval of uploaded documents stays fail-closed until it exists (W3-4 owner correction; docs/31).',
      );
    }
    const evidenceStorageDeps: EvidenceStorageDeps | undefined =
      identity.verificationEvidenceStorage !== undefined
        ? {
            db: identity.db,
            store: identity.verificationEvidenceStorage.store,
            upload: {
              ...DEFAULT_EVIDENCE_UPLOAD_CONFIG,
              ...identity.verificationEvidenceStorage.upload,
            } satisfies VerificationEvidenceUploadConfig,
            contentSafetyReady: identity.verificationEvidenceStorage.contentSafetyReady ?? false,
          }
        : undefined;
    if (evidenceStorageDeps !== undefined) {
      installEvidenceContentParsers(app, evidenceStorageDeps.upload.allowedContentTypes);
    }

    // W3-5 review composition: the canonical lifecycle config + the W3-4
    // content-safety capability + the injected (D-W3-3) policy seam.
    const verificationReviewDeps = {
      db: identity.db,
      lifecycle: {
        nodeEnv,
        verificationEvidenceCapabilityReady:
          identity.verificationEvidenceCapabilityReady ?? false,
      },
      contentSafetyReady: identity.verificationEvidenceStorage?.contentSafetyReady ?? false,
      ...(identity.verificationPolicyProvider !== undefined
        ? { policyProvider: identity.verificationPolicyProvider }
        : {}),
    };

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
        registerAdminTaxonomyRoutes(app, { db: identity.db });
        // W3-2 internal organization reads — same gate, db-only deps.
        registerOrganizationAdminReadRoutes(app, { db: identity.db });
        // S5-6 booking-oversight READS (docs/32 §13) — same gate; the
        // service role-gates `operations`; no admin booking mutation exists.
        registerBookingAdminRoutes(app, { db: identity.db });
        if (organizationAdminDeps !== undefined) {
          registerOrganizationAdminRoutes(app, organizationAdminDeps);
        }
        if (evidenceStorageDeps !== undefined) {
          registerAdminEvidenceRoutes(app, evidenceStorageDeps);
        }
        registerVerificationReviewRoutes(app, verificationReviewDeps);
      }
    } else if (identity.enableAdminRoutes !== false) {
      registerAdminRoutes(app, { db: identity.db });
      registerAdminModerationRoutes(app, { db: identity.db });
      registerAdminTaxonomyRoutes(app, { db: identity.db });
      registerOrganizationAdminReadRoutes(app, { db: identity.db });
      registerBookingAdminRoutes(app, { db: identity.db });
      if (organizationAdminDeps !== undefined) {
        registerOrganizationAdminRoutes(app, organizationAdminDeps);
      }
      if (evidenceStorageDeps !== undefined) {
        registerAdminEvidenceRoutes(app, evidenceStorageDeps);
      }
      registerVerificationReviewRoutes(app, verificationReviewDeps);
    }

    // Customer-public storefront read (S3-4, docs/27 §13.1): explicitly
    // public, served from the structurally separate public projection; no
    // MFA/activation dependency, so it registers with the identity surface.
    registerStorefrontRoutes(app, { db: identity.db });

    // Customer-public catalogue reads (Slice 4, docs/28 §16.1/§19): same
    // posture as the storefront read — explicitly public projections over
    // live authoritative state, registered unconditionally with the
    // identity surface. Reads only; no search surface exists yet.
    registerPublicCatalogueRoutes(app, { db: identity.db });

    // Customer-public search (Slice 4, docs/28 §16.1): the HTTP layer
    // depends on the SearchReadPort boundary only; PostgreSQL is the
    // launch engine behind it (docs/28 §12). Public read, registered
    // unconditionally like the other public projections.
    registerSearchRoutes(app, {
      searchPort: new PostgresSearchReadPort({ db: identity.db }),
    });

    // Customer-public availability read (RI-2, docs/34 §12.1 D-RI-4): the
    // certified S5-5 availability projection served without login — same
    // posture as the other public projections, one shared effective-truth
    // calculation, never counters.
    registerBookingPublicRoutes(app, { db: identity.db });

    // Customer booking surface (S5-5, docs/32 §12; W5-5, docs/33 §15):
    // authenticatedCustomer routes over the certified S5-2/S5-3 domain —
    // availability, quotes, holds, atomic free confirmation (D-10 authority
    // inside), paid-checkout initiation (the real W5-2 orchestration only
    // when a composed provider AND server-authored checkout URLs exist —
    // otherwise the certified fail-closed refusal), the converged
    // payment-status read, and own-booking reads. Registers with the
    // identity surface (the customer session policy is its whole gate);
    // the trusted paid-confirmation seam remains route-less by design.
    registerBookingCustomerRoutes(app, {
      db: identity.db,
      ...(options.payment !== undefined
        ? {
            payment: {
              resolution: { kind: 'configured' as const, provider: options.payment.provider },
              ...(options.payment.checkoutUrls !== undefined
                ? { checkoutUrls: options.payment.checkoutUrls }
                : {}),
            },
          }
        : {}),
    });

    // Customer participant management (RI-1, docs/34 §4.1): the bounded
    // companion closing the recorded gap — list/create-child/update/archive
    // over the certified participant schema. Registers with the identity
    // surface (the customer session policy is its whole gate).
    registerParticipantRoutes(app, { db: identity.db });

    // Customer entitlement acquisition (S6-1, docs/35 §13): the unit-less
    // acquisition quote, the zero-price non-payment boundary, the paid
    // initiation over the SAME generalized W5 orchestration (fail-closed
    // without a composed provider + server-authored URLs), the converged
    // purchase payment-status read, and the own-purchase read. Reservation,
    // credential, attendance, and entitlement-list surfaces do NOT exist
    // until their owning slices (S6-2/S6-3).
    registerEntitlementCustomerRoutes(app, {
      db: identity.db,
      ...(options.payment !== undefined
        ? {
            payment: {
              resolution: { kind: 'configured' as const, provider: options.payment.provider },
              ...(options.payment.checkoutUrls !== undefined
                ? { checkoutUrls: options.payment.checkoutUrls }
                : {}),
            },
          }
        : {}),
    });

    // S6-3: entitlement reservations + Passes/attendance/reservable reads +
    // the derived customer calendar (docs/35 §7/§8/§12/§13).
    registerReservationCustomerRoutes(app, { db: identity.db });

    // DEV-ONLY identity token acquisition (RI-1, D-RI-3): a Cognito client
    // stand-in, structurally impossible in production.
    if (options.devIdentity !== undefined) {
      if (nodeEnv === 'production') {
        throw new Error(
          'The dev identity provider is never available in production (D-RI-3): real customer authentication arrives as Cognito configuration, and no dev token-acquisition surface may exist there.',
        );
      }
      registerDevIdentityRoutes(app, { provider: options.devIdentity.provider });
    }

    // W5-3 gateway webhook ingress: machine-to-machine, signature-trusted
    // only, raw-body scope, durable §7.8 receipt before any processing.
    // Absent entirely (404) unless a composed provider was supplied.
    if (options.payment !== undefined) {
      registerPaymentWebhookRoutes(app, {
        db: identity.db,
        provider: options.payment.provider,
      });
    }

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
          // Provider scheduling/capacity surface (S5-4, docs/32 §11) shares
          // the same production capability gate: same MFA baseline, same
          // fail-closed activation, no bypass.
          registerBookingProviderRoutes(app, { db: identity.db });
          // Provider check-in surface (S6-2, docs/35 §14) shares the same
          // production capability gate: same MFA baseline, same fail-closed
          // activation, no bypass.
          registerAttendanceProviderRoutes(app, { db: identity.db });
          // Provider fulfillment-configuration surface (W2-13, docs/35 §3):
          // the immutable-revision editor companion — same gate.
          registerFulfillmentProviderRoutes(app, { db: identity.db });
          if (evidenceStorageDeps !== undefined) {
            registerProviderEvidenceRoutes(app, evidenceStorageDeps);
          }
        }
      } else if (identity.enableProviderRoutes !== false) {
        registerProviderRoutes(app, providerDeps);
        registerCatalogueRoutes(app, { db: identity.db });
        registerBookingProviderRoutes(app, { db: identity.db });
        registerAttendanceProviderRoutes(app, { db: identity.db });
        registerFulfillmentProviderRoutes(app, { db: identity.db });
        if (evidenceStorageDeps !== undefined) {
          registerProviderEvidenceRoutes(app, evidenceStorageDeps);
        }
      }
    }
  }

  return app;
}
