/**
 * Admin verification review/decision routes (W3-5; docs/31).
 *
 * Reads ride the `admin` BASELINE (W3-1: ordinary internal reads never
 * demand step-up). Every MUTATION rides `adminStepUp` — the safer existing
 * boundary — because D-W3-5 (the final high-risk step-up set) remains an
 * owner decision; nothing here decides it. The services additionally
 * require the `operations` role fresh per transaction, refuse while
 * content safety is unavailable (the W3-4 invariant — all of production
 * today), and compose decisions with the canonical organization lifecycle
 * in ONE transaction. Typed refusals stay distinct: policy absence,
 * unready evidence (with the structured missing list), safety
 * unavailability, case-state conflicts, organization lifecycle conflicts,
 * and stale versions are never collapsed.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import { openVerificationCase } from '../services/verification-case';
import {
  beginVerificationReview,
  decideVerification,
  getOrganizationVerificationView,
  type VerificationReviewDeps,
} from '../services/verification-review';
import type { VerificationRequirementPolicyProvider } from '../services/verification-case';
import { requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome } from '../../identity/http/http-outcomes';

const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const REVIEW_ERRORS = {
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  500: ErrorBody,
  503: ErrorBody,
};
const REVIEW_BODY_LIMIT = 16_384;

/** Machine reason slug — the schema mirror of the decision layer. */
const ReasonCode = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });

const ReadinessView = Type.Union([
  Type.Object({ kind: Type.Literal('ready') }),
  Type.Object({
    kind: Type.Literal('missingRequirements'),
    missing: Type.Array(Type.Object({ requirementKey: Type.String(), labelEn: Type.String() })),
  }),
  Type.Object({ kind: Type.Literal('policyUnavailable') }),
]);

const CaseViewSchema = Type.Object({
  caseId: Uuid,
  organizationId: Uuid,
  round: Type.Integer(),
  state: Type.String(),
  policyVersion: Type.String(),
  readiness: ReadinessView,
  requirements: Type.Array(
    Type.Object({
      requirementId: Uuid,
      requirementKey: Type.String(),
      labelEn: Type.String(),
      descriptionEn: Type.Union([Type.String(), Type.Null()]),
      required: Type.Boolean(),
      currentEvidence: Type.Union([
        Type.Object({
          evidenceId: Uuid,
          state: Type.String(),
          originalFilename: Type.String(),
          declaredContentType: Type.String(),
          byteSize: Type.Union([Type.Integer(), Type.Null()]),
          storedAt: Type.Union([Type.String(), Type.Null()]),
          version: Type.Integer(),
        }),
        Type.Null(),
      ]),
    }),
  ),
  decision: Type.Union([
    Type.Object({
      outcome: Type.String(),
      reasonCode: Type.Union([Type.String(), Type.Null()]),
      providerSafeMessage: Type.Union([Type.String(), Type.Null()]),
      internalNote: Type.Union([Type.String(), Type.Null()]),
      decidedBy: Uuid,
      decidedAt: Type.String(),
    }),
    Type.Null(),
  ]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  version: Type.Integer(),
});

function caseNotReady(
  reply: FastifyReply,
  missing: Array<{ requirementKey: string; labelEn: string }>,
): FastifyReply {
  // The programIncomplete pattern: a typed conflict carrying the exact
  // structured gaps (snapshot vocabulary — safe internal labels only).
  return reply.status(409).send({
    code: 'verificationCaseNotReady',
    message: 'The case is not ready for approval: required evidence is missing.',
    missing,
  });
}

export interface VerificationReviewRouteDeps extends VerificationReviewDeps {
  policyProvider?: VerificationRequirementPolicyProvider;
}

export function registerVerificationReviewRoutes(
  instance: FastifyInstance,
  deps: VerificationReviewRouteDeps,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  // ---------------------------------------------------------------------
  // The reviewer workspace read — internal truth for one organization:
  // canonical org state, round history, and the latest case's full
  // internal view incl. readiness. Baseline admin read (W3-1).
  // ---------------------------------------------------------------------
  app.get(
    '/admin/organizations/:organizationId/verification',
    {
      config: { authPolicy: 'admin' },
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        response: {
          200: Type.Object({
            organizationId: Uuid,
            organizationState: Type.String(),
            organizationVersion: Type.Integer(),
            contentSafetyReady: Type.Boolean(),
            policyConfigured: Type.Boolean(),
            rounds: Type.Array(
              Type.Object({
                caseId: Uuid,
                round: Type.Integer(),
                state: Type.String(),
                decidedAt: Type.Union([Type.String(), Type.Null()]),
                outcome: Type.Union([Type.String(), Type.Null()]),
              }),
            ),
            latestCase: Type.Union([CaseViewSchema, Type.Null()]),
          }),
          ...REVIEW_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await getOrganizationVerificationView(
        { ...deps, policyConfigured: deps.policyProvider !== undefined },
        { userId: principal.userId },
        request.params.organizationId,
      );
      if (result.kind === 'verificationView') return reply.status(200).send(result.view);
      return sendOutcome(reply, result.kind === 'forbidden' ? 'forbidden' : 'notFound');
    },
  );

  // ---------------------------------------------------------------------
  // Open a review round (W3-3 service; policy injected, fail-closed).
  // ---------------------------------------------------------------------
  app.post(
    '/admin/organizations/:organizationId/verification/cases',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: REVIEW_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        response: {
          200: Type.Object({
            status: Type.Literal('caseOpened'),
            caseId: Uuid,
            round: Type.Integer(),
            version: Type.Integer(),
          }),
          ...REVIEW_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await openVerificationCase(
        {
          db: deps.db,
          ...(deps.policyProvider !== undefined ? { policyProvider: deps.policyProvider } : {}),
        },
        { userId: principal.userId },
        { organizationId: request.params.organizationId },
      );
      switch (result.kind) {
        case 'caseOpened':
          return reply.status(200).send({
            status: 'caseOpened',
            caseId: result.caseId,
            round: result.round,
            version: result.version,
          });
        case 'organizationNotFound':
          return sendOutcome(reply, 'notFound');
        case 'organizationStateConflict':
          return sendOutcome(reply, 'lifecycleConflict');
        case 'activeCaseExists':
          return sendOutcome(reply, 'verificationCaseConflict');
        case 'policyUnavailable':
          return sendOutcome(reply, 'verificationPolicyUnavailable');
        case 'forbidden':
          return sendOutcome(reply, 'forbidden');
      }
    },
  );

  // ---------------------------------------------------------------------
  // Begin review — case in_review + canonical org start_review (one tx).
  // ---------------------------------------------------------------------
  app.post(
    '/admin/organizations/:organizationId/verification/cases/:caseId/review',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: REVIEW_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, caseId: Uuid }),
        body: Type.Object({ expectedCaseVersion: Type.Integer({ minimum: 1 }) }),
        response: {
          200: Type.Object({
            status: Type.Literal('reviewStarted'),
            caseVersion: Type.Integer(),
            organizationState: Type.String(),
          }),
          ...REVIEW_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await beginVerificationReview(deps, { userId: principal.userId }, {
        organizationId: request.params.organizationId,
        caseId: request.params.caseId,
        expectedCaseVersion: request.body.expectedCaseVersion,
      });
      switch (result.kind) {
        case 'reviewStarted':
          return reply.status(200).send({
            status: 'reviewStarted',
            caseVersion: result.caseVersion,
            organizationState: result.organizationState,
          });
        case 'caseNotFound':
          return sendOutcome(reply, 'notFound');
        case 'caseStateConflict':
          return sendOutcome(reply, 'verificationCaseConflict');
        case 'organizationStateConflict':
          return sendOutcome(reply, 'lifecycleConflict');
        case 'staleVersion':
          return sendOutcome(reply, 'staleVersion');
        case 'evidenceSafetyUnavailable':
          return sendOutcome(reply, 'verificationEvidenceSafetyUnavailable');
        case 'forbidden':
          return sendOutcome(reply, 'forbidden');
      }
    },
  );

  // ---------------------------------------------------------------------
  // Decide — the ONE authoritative allow-path to verified/rejected: the
  // three-layer decision + the canonical organization transition, atomic.
  // ---------------------------------------------------------------------
  app.post(
    '/admin/organizations/:organizationId/verification/cases/:caseId/decision',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: REVIEW_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, caseId: Uuid }),
        body: Type.Object({
          expectedCaseVersion: Type.Integer({ minimum: 1 }),
          outcome: Type.Union([Type.Literal('approved'), Type.Literal('rejected')]),
          reasonCode: Type.Optional(ReasonCode),
          providerSafeMessage: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
          internalNote: Type.Optional(Type.String({ maxLength: 4000 })),
        }),
        response: {
          200: Type.Object({
            status: Type.Literal('verificationDecided'),
            decisionId: Uuid,
            caseVersion: Type.Integer(),
            organizationState: Type.String(),
            organizationVersion: Type.Integer(),
          }),
          ...REVIEW_ERRORS,
          // The structured not-ready refusal rides the 409 leg (the
          // programIncomplete pattern) — `missing` must survive
          // serialization alongside plain {code, message} conflicts.
          409: Type.Object({
            code: Type.String(),
            message: Type.String(),
            missing: Type.Optional(
              Type.Array(
                Type.Object({ requirementKey: Type.String(), labelEn: Type.String() }),
              ),
            ),
          }),
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await decideVerification(deps, { userId: principal.userId }, {
        organizationId: request.params.organizationId,
        caseId: request.params.caseId,
        expectedCaseVersion: request.body.expectedCaseVersion,
        outcome: request.body.outcome,
        ...(request.body.reasonCode !== undefined ? { reasonCode: request.body.reasonCode } : {}),
        ...(request.body.providerSafeMessage !== undefined
          ? { providerSafeMessage: request.body.providerSafeMessage }
          : {}),
        ...(request.body.internalNote !== undefined
          ? { internalNote: request.body.internalNote }
          : {}),
      });
      switch (result.kind) {
        case 'verificationDecided':
          return reply.status(200).send({
            status: 'verificationDecided',
            decisionId: result.decisionId,
            caseVersion: result.caseVersion,
            organizationState: result.organizationState,
            organizationVersion: result.organizationVersion,
          });
        case 'caseNotFound':
          return sendOutcome(reply, 'notFound');
        case 'caseStateConflict':
          return sendOutcome(reply, 'verificationCaseConflict');
        case 'organizationStateConflict':
          return sendOutcome(reply, 'lifecycleConflict');
        case 'staleVersion':
          return sendOutcome(reply, 'staleVersion');
        case 'invalidDecision':
          return sendOutcome(reply, 'invalidVerificationDecision');
        case 'evidenceSafetyUnavailable':
          return sendOutcome(reply, 'verificationEvidenceSafetyUnavailable');
        case 'policyUnavailable':
          return sendOutcome(reply, 'verificationPolicyUnavailable');
        case 'caseNotReady':
          return caseNotReady(reply, result.missing);
      }
    },
  );
}
