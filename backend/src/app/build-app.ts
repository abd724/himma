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
import { installAuthPipeline } from '../modules/identity/http/auth-plugin';
import { registerIdentityRoutes } from '../modules/identity/http/identity-routes';
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

export interface IdentityHttpOptions {
  db: Db;
  accessTokenVerifier: AccessTokenVerifier;
  idTokenAdapter: AuthProviderAdapter;
  mailSender: MailSender;
  providerRevoker?: ProviderSessionRevoker;
  /** Defaults via createRateLimiterStore — which FAILS CLOSED in production. */
  rateLimiterStore?: RateLimiterStore;
  nodeEnv?: NodeEnv;
  stepUpMaxAgeSeconds?: number;
  enumerationFloorMs?: number;
  rateLimits?: Partial<RateLimitRules>;
  now?: () => number;
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
  }

  return app;
}
