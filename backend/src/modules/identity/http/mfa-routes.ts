/**
 * MFA and step-up HTTP routes (docs/26 §10; B2-6C) — the applicable
 * equivalents of `POST /auth/mfa/totp/enroll` · `/confirm` ·
 * `POST /auth/mfa/recovery-codes/regenerate` (all step-up-gated) and the
 * begin/complete phases of `POST /auth/step-up` (TOTP + recovery code).
 *
 * Secret boundary: the TOTP shared secret, the provider challenge session,
 * and raw recovery codes appear ONLY in `no-store` responses to the
 * authenticated caller (the B2-4 pipeline stamps `Cache-Control: no-store`
 * on every non-public route) — they are never persisted, logged, audited,
 * outboxed, or echoed back on any later read. Recovery codes are presented
 * exactly once (`presentation: 'one-time'` in the schema). Bearer tokens
 * are consumed as the provider access token for the Cognito enrollment
 * operations and never echoed.
 *
 * Live-Cognito status (binding honesty): the SOFTWARE_TOKEN_MFA
 * reauthentication flow behind `beginTotpStepUpChallenge` is validated
 * against a real pool only in the §14.E′ smoke — until then TOTP step-up is
 * NOT production-operational; dev/test exercise the full behavior through
 * the deterministic fake provider.
 */
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../../../db/kysely';
import type { MfaProviderPort } from '../providers/mfa';
import {
  beginTotpEnrollment,
  completeTotpEnrollment,
  type MfaServiceDeps,
} from '../services/mfa-enrollment';
import type { MfaConfig } from '../services/mfa-config';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
} from '../services/mfa-recovery-codes';
import {
  beginStepUpChallenge,
  completeStepUpWithTotp,
} from '../services/mfa-step-up';
import { requirePrincipal } from './auth-plugin';
import { sendOutcome, type HttpOutcomeName } from './http-outcomes';
import {
  rateLimitDigest,
  type RateLimiterStore,
  type RateLimitRule,
  type RateLimitRules,
} from './rate-limiter';

const MFA_BODY_LIMIT = 4096 + 2048;

const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });

const EnrollmentStarted = Type.Object({
  status: Type.Literal('enrollmentStarted'),
  methodId: Type.String({ format: 'uuid' }),
  totp: Type.Object({
    sharedSecret: Type.String({
      description:
        'Ephemeral TOTP enrollment secret — presented exactly once, never retrievable again, never stored by Himma.',
    }),
  }),
});

const ConfirmBody = Type.Object({
  methodId: Type.String({ format: 'uuid' }),
  code: Type.String({ minLength: 1, maxLength: 64 }),
});

const MfaEnrolled = Type.Object({
  status: Type.Literal('mfaEnrolled'),
  methodId: Type.String({ format: 'uuid' }),
  supersededMethodId: Type.Optional(Type.String({ format: 'uuid' })),
});

const RecoveryCodesGenerated = Type.Object({
  status: Type.Literal('recoveryCodesGenerated'),
  batchId: Type.String({ format: 'uuid' }),
  codes: Type.Array(Type.String(), {
    description:
      'Raw recovery codes — presented exactly ONCE at generation; Himma stores only one-way digests and no later read can return them.',
  }),
  presentation: Type.Literal('one-time'),
});

const ChallengeStarted = Type.Object({
  status: Type.Literal('challengeStarted'),
  challengeId: Type.String({ format: 'uuid' }),
  expiresAt: Type.String({ format: 'date-time' }),
  providerChallenge: Type.String({
    description:
      'Ephemeral provider challenge session — round-trip it once to complete this step-up; never stored by Himma.',
  }),
});

const StepUpTotpCompleteBody = Type.Object({
  challengeId: Type.String({ format: 'uuid' }),
  code: Type.String({ minLength: 1, maxLength: 64 }),
  providerChallenge: Type.String({ minLength: 1, maxLength: 4096 }),
});

const StepUpCompleted = Type.Object({
  status: Type.Literal('stepUpCompleted'),
  expiresAt: Type.String({ format: 'date-time' }),
});

const RecoveryCodeBody = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 64 }),
});

export interface MfaRouteDeps {
  db: Db;
  mfaProvider: MfaProviderPort;
  mfaConfig: MfaConfig;
  rateLimiter: RateLimiterStore;
  rules: RateLimitRules;
}

/** The caller's bearer IS the provider access token for the Cognito
 *  enrollment operations (B2-3 tokens are provider-issued). Extracted for
 *  the provider port only — never logged, stored, or echoed. */
function providerAccessTokenOf(request: FastifyRequest): string {
  const header = request.headers.authorization;
  return typeof header === 'string' ? header.replace(/^Bearer /, '') : '';
}

async function consumeRateLimit(
  reply: FastifyReply,
  limiter: RateLimiterStore,
  rule: RateLimitRule,
  key: string,
): Promise<boolean> {
  const decision = await limiter.consume(key, rule, 1);
  if (!decision.allowed) {
    void sendOutcome(reply, 'rateLimited', {
      'retry-after': String(decision.retryAfterSeconds),
    });
    return false;
  }
  return true;
}

export function registerMfaRoutes(instance: FastifyInstance, deps: MfaRouteDeps): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps: MfaServiceDeps = {
    db: deps.db,
    mfaProvider: deps.mfaProvider,
    mfaConfig: deps.mfaConfig,
  };

  const providerFailure = (kind: 'providerUnavailable' | 'invalidProviderState' | 'notEligible') =>
    (kind === 'providerUnavailable'
      ? 'providerUnavailable'
      : kind === 'notEligible'
        ? 'mfaRequired'
        : 'invalidCredentials') satisfies HttpOutcomeName;

  app.post(
    '/auth/mfa/totp/enroll',
    {
      config: { authPolicy: 'stepUpRequired' },
      bodyLimit: MFA_BODY_LIMIT,
      schema: {
        response: { 200: EnrollmentStarted, 401: ErrorBody, 403: ErrorBody, 503: ErrorBody },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      if (
        !(await consumeRateLimit(
          reply,
          deps.rateLimiter,
          deps.rules.mfaEnrollment,
          `mfa-enroll:${rateLimitDigest(principal.userId)}`,
        ))
      ) {
        return reply;
      }
      const result = await beginTotpEnrollment(serviceDeps, {
        userId: principal.userId,
        providerAccessToken: providerAccessTokenOf(request),
      });
      if (result.kind !== 'enrollmentStarted') {
        return sendOutcome(reply, providerFailure(result.kind));
      }
      return reply.status(200).send({
        status: 'enrollmentStarted' as const,
        methodId: result.methodId,
        totp: { sharedSecret: result.material.sharedSecret },
      });
    },
  );

  app.post(
    '/auth/mfa/totp/confirm',
    {
      config: { authPolicy: 'stepUpRequired' },
      bodyLimit: MFA_BODY_LIMIT,
      schema: {
        body: ConfirmBody,
        response: {
          200: MfaEnrolled,
          400: ErrorBody,
          401: ErrorBody,
          403: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      if (
        !(await consumeRateLimit(
          reply,
          deps.rateLimiter,
          deps.rules.mfaEnrollment,
          `mfa-enroll:${rateLimitDigest(principal.userId)}`,
        ))
      ) {
        return reply;
      }
      const result = await completeTotpEnrollment(serviceDeps, {
        userId: principal.userId,
        methodId: request.body.methodId,
        code: request.body.code,
        providerAccessToken: providerAccessTokenOf(request),
      });
      if (result.kind === 'mfaEnrolled') {
        return reply.status(200).send({
          status: 'mfaEnrolled' as const,
          methodId: result.methodId,
          ...(result.supersededMethodId !== undefined
            ? { supersededMethodId: result.supersededMethodId }
            : {}),
        });
      }
      if (result.kind === 'providerUnavailable') {
        return sendOutcome(reply, 'providerUnavailable');
      }
      // enrollmentInvalid / invalidCode / challengeExpired /
      // invalidProviderState collapse into ONE sanitized outcome — the
      // caller learns nothing about other users' enrollment state.
      return sendOutcome(reply, 'challengeInvalid');
    },
  );

  app.post(
    '/auth/mfa/recovery-codes/regenerate',
    {
      config: { authPolicy: 'stepUpRequired' },
      bodyLimit: MFA_BODY_LIMIT,
      schema: {
        response: { 200: RecoveryCodesGenerated, 401: ErrorBody, 403: ErrorBody },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      if (
        !(await consumeRateLimit(
          reply,
          deps.rateLimiter,
          deps.rules.mfaEnrollment,
          `mfa-recovery-gen:${rateLimitDigest(principal.userId)}`,
        ))
      ) {
        return reply;
      }
      const result = await generateRecoveryCodes(serviceDeps, { userId: principal.userId });
      if (result.kind !== 'recoveryCodesGenerated') {
        return sendOutcome(reply, 'mfaRequired');
      }
      return reply.status(200).send({
        status: 'recoveryCodesGenerated' as const,
        batchId: result.batchId,
        codes: result.codes,
        presentation: 'one-time' as const,
      });
    },
  );

  app.post(
    '/auth/step-up/totp/begin',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: MFA_BODY_LIMIT,
      schema: {
        response: { 200: ChallengeStarted, 401: ErrorBody, 403: ErrorBody, 503: ErrorBody },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      if (
        !(await consumeRateLimit(
          reply,
          deps.rateLimiter,
          deps.rules.mfaChallenge,
          `mfa-stepup:${rateLimitDigest(principal.userId)}`,
        ))
      ) {
        return reply;
      }
      const result = await beginStepUpChallenge(serviceDeps, {
        userId: principal.userId,
        sessionId: principal.sessionId,
        providerUserRef: principal.subject,
      });
      if (result.kind !== 'challengeStarted') {
        if (result.kind === 'sessionNotLive') return sendOutcome(reply, 'sessionExpired');
        return sendOutcome(reply, providerFailure(result.kind));
      }
      return reply.status(200).send({
        status: 'challengeStarted' as const,
        challengeId: result.challengeId,
        expiresAt: result.expiresAt.toISOString(),
        providerChallenge: result.providerChallenge.providerChallengeSession,
      });
    },
  );

  app.post(
    '/auth/step-up/totp/complete',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: MFA_BODY_LIMIT,
      schema: {
        body: StepUpTotpCompleteBody,
        response: {
          200: StepUpCompleted,
          400: ErrorBody,
          401: ErrorBody,
          429: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      if (
        !(await consumeRateLimit(
          reply,
          deps.rateLimiter,
          deps.rules.mfaChallenge,
          `mfa-stepup:${rateLimitDigest(principal.userId)}`,
        ))
      ) {
        return reply;
      }
      const result = await completeStepUpWithTotp(serviceDeps, {
        userId: principal.userId,
        sessionId: principal.sessionId,
        challengeId: request.body.challengeId,
        code: request.body.code,
        providerUserRef: principal.subject,
        providerChallenge: { providerChallengeSession: request.body.providerChallenge },
      });
      switch (result.kind) {
        case 'stepUpCompleted':
          return reply.status(200).send({
            status: 'stepUpCompleted' as const,
            expiresAt: result.expiresAt.toISOString(),
          });
        case 'tooManyAttempts':
          return sendOutcome(reply, 'rateLimited');
        case 'sessionNotLive':
          return sendOutcome(reply, 'sessionExpired');
        case 'providerUnavailable':
          return sendOutcome(reply, 'providerUnavailable');
        default:
          // challengeInvalid / challengeExpired / invalidCode /
          // invalidProviderState: one sanitized class — no oracle for
          // which stage refused.
          return sendOutcome(reply, 'challengeInvalid');
      }
    },
  );

  app.post(
    '/auth/step-up/recovery-code',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: MFA_BODY_LIMIT,
      schema: {
        body: RecoveryCodeBody,
        response: { 200: StepUpCompleted, 400: ErrorBody, 401: ErrorBody, 429: ErrorBody },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      if (
        !(await consumeRateLimit(
          reply,
          deps.rateLimiter,
          deps.rules.recoveryCode,
          `mfa-recovery:${rateLimitDigest(principal.userId)}`,
        ))
      ) {
        return reply;
      }
      const result = await consumeRecoveryCode(serviceDeps, {
        userId: principal.userId,
        code: request.body.code,
        session: { sessionId: principal.sessionId },
      });
      if (result.kind === 'recoveryCodeAccepted') {
        return reply.status(200).send({
          status: 'stepUpCompleted' as const,
          expiresAt: (result.stepUpGrantExpiresAt ?? new Date()).toISOString(),
        });
      }
      if (result.kind === 'sessionNotLive') return sendOutcome(reply, 'sessionExpired');
      // Wrong, consumed, superseded, and never-existed codes are one
      // byte-identical outcome (docs/26 §11.2 enumeration posture).
      return sendOutcome(reply, 'challengeInvalid');
    },
  );
}
