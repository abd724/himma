/**
 * Internal Himma catalogue moderation routes (docs/28 §16.3) — the review
 * transitions for submitted listings and the decision surface for
 * provider-submitted revisions, on the `adminStepUp` policy (live session
 * + MFA assurance + recent MFA factor + ≥1 active database admin role —
 * the pre-split semantics, deliberately retained by the W3-1
 * baseline/step-up separation); the services additionally require the
 * `operations` role fresh per
 * transaction. Provider memberships, customer accounts, and Cognito claims
 * satisfy nothing here. Named action routes only — no writable state field
 * exists; nothing here publishes a listing (D-S4-2), and no customer-public
 * or taxonomy surface is registered.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import { ProgramDetailViewSchema } from './catalogue-routes';
import {
  approveRevision,
  getModerationView,
  listModerationQueue,
  listRevisionQueue,
  rejectRevision,
  reviewProgram,
  startRevisionReview,
  type ProgramReviewAction,
} from '../services/moderation';

const MODERATION_BODY_LIMIT = 16_384;
const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const MODERATION_ERRORS = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  500: ErrorBody,
  503: ErrorBody,
};

/** Safe machine-readable reason slug — never free-text review notes. */
const ReasonCode = Type.Optional(Type.String({ pattern: '^[a-z0-9_]{1,64}$' }));
const ExpectedVersion = Type.Integer({ minimum: 1 });
const QueueQuery = Type.Object({
  state: Type.Optional(Type.Union([Type.Literal('submitted'), Type.Literal('in_review')])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Uuid),
});

const NullableInt = Type.Union([Type.Integer(), Type.Null()]);
const NullableStr = Type.Union([Type.String(), Type.Null()]);

const RevisionChangeSetView = Type.Object({
  id: Uuid,
  programId: Uuid,
  state: Type.String(),
  createdAt: Type.String(),
  version: Type.Integer(),
  minAge: NullableInt,
  maxAge: NullableInt,
  allAges: Type.Union([Type.Boolean(), Type.Null()]),
  genderEligibility: NullableStr,
  skillLevel: NullableStr,
  eligibilityNotes: NullableStr,
  descriptionEn: NullableStr,
  descriptionAr: NullableStr,
  option: Type.Union([
    Type.Object({
      optionId: Type.Union([Uuid, Type.Null()]),
      kind: NullableStr,
      amountFils: NullableInt,
      sessionsCount: NullableInt,
      labelEn: NullableStr,
      labelAr: NullableStr,
      sortHint: NullableInt,
      state: NullableStr,
    }),
    Type.Null(),
  ]),
});

function failure(reply: FastifyReply, kind: string): FastifyReply {
  const name: HttpOutcomeName =
    kind === 'programNotFound' || kind === 'revisionNotFound'
      ? 'notFound'
      : kind === 'forbidden'
        ? 'forbidden'
        : kind === 'lifecycleConflict'
          ? 'lifecycleConflict'
          : kind === 'staleVersion'
            ? 'staleVersion'
            : kind === 'invalidEligibility'
              ? 'invalidEligibility'
              : kind === 'invalidPriceOption'
                ? 'invalidPriceOption'
                : 'internalError';
  return sendOutcome(reply, name);
}

export interface ModerationRouteDeps {
  db: Db;
}

export function registerAdminModerationRoutes(
  instance: FastifyInstance,
  deps: ModerationRouteDeps,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };

  // ---------------------------------------------------------------------
  // Review queue + moderation projection (minimal reads, docs/28 §16.3).
  // ---------------------------------------------------------------------
  app.get(
    '/admin/listings',
    {
      config: { authPolicy: 'adminStepUp' },
      schema: {
        querystring: QueueQuery,
        response: {
          200: Type.Object({
            listings: Type.Array(
              Type.Object({
                id: Uuid,
                organizationId: Uuid,
                organizationDisplayName: Type.String(),
                titleEn: Type.String(),
                listingState: Type.String(),
                version: Type.Integer(),
                createdAt: Type.String(),
                updatedAt: Type.String(),
              }),
            ),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          ...MODERATION_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await listModerationQueue(serviceDeps, { userId: principal.userId }, request.query);
      if (result.kind === 'queue') {
        return reply
          .status(200)
          .send({ listings: result.listings, nextCursor: result.nextCursor });
      }
      return failure(reply, result.kind);
    },
  );

  app.get(
    '/admin/listings/:programId',
    {
      config: { authPolicy: 'adminStepUp' },
      schema: {
        params: Type.Object({ programId: Uuid }),
        response: {
          200: Type.Object({
            program: ProgramDetailViewSchema,
            organization: Type.Object({
              id: Uuid,
              displayName: Type.String(),
              verificationState: Type.String(),
            }),
            revision: Type.Union([RevisionChangeSetView, Type.Null()]),
          }),
          ...MODERATION_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await getModerationView(
        serviceDeps,
        { userId: principal.userId },
        { programId: request.params.programId },
      );
      if (result.kind === 'moderationView') {
        return reply.status(200).send(result.view);
      }
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Program review transitions — named §5.3 admin edges (D-S4-2: approval
  // rests at `approved`; publication remains the provider action).
  // ---------------------------------------------------------------------
  const reviewRoutes: [string, ProgramReviewAction][] = [
    ['/admin/listings/:programId/review/start', 'start_review'],
    ['/admin/listings/:programId/review/approve', 'approve'],
    ['/admin/listings/:programId/review/request-changes', 'request_changes'],
  ];
  for (const [url, action] of reviewRoutes) {
    app.post(
      url,
      {
        config: { authPolicy: 'adminStepUp' },
        bodyLimit: MODERATION_BODY_LIMIT,
        schema: {
          params: Type.Object({ programId: Uuid }),
          body: Type.Object(
            { expectedVersion: ExpectedVersion, reasonCode: ReasonCode },
            { additionalProperties: false },
          ),
          response: {
            200: Type.Object({
              status: Type.Literal('programReviewed'),
              state: Type.String(),
              version: Type.Integer(),
            }),
            ...MODERATION_ERRORS,
          },
        },
      },
      async (request, reply) => {
        const principal = requirePrincipal(request.principal);
        const result = await reviewProgram(serviceDeps, { userId: principal.userId }, {
          programId: request.params.programId,
          action,
          expectedVersion: request.body.expectedVersion,
          ...(request.body.reasonCode !== undefined
            ? { reasonCode: request.body.reasonCode }
            : {}),
        });
        if (result.kind === 'programReviewed') {
          return reply
            .status(200)
            .send({ status: 'programReviewed', state: result.state, version: result.version });
        }
        return failure(reply, result.kind);
      },
    );
  }

  // ---------------------------------------------------------------------
  // Revision queue + decisions (docs/28 §7 machine; atomic application).
  // ---------------------------------------------------------------------
  app.get(
    '/admin/revisions',
    {
      config: { authPolicy: 'adminStepUp' },
      schema: {
        querystring: QueueQuery,
        response: {
          200: Type.Object({
            revisions: Type.Array(
              Type.Object({
                id: Uuid,
                programId: Uuid,
                organizationId: Uuid,
                programTitleEn: Type.String(),
                state: Type.String(),
                version: Type.Integer(),
                createdAt: Type.String(),
              }),
            ),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          ...MODERATION_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await listRevisionQueue(serviceDeps, { userId: principal.userId }, request.query);
      if (result.kind === 'queue') {
        return reply
          .status(200)
          .send({ revisions: result.revisions, nextCursor: result.nextCursor });
      }
      return failure(reply, result.kind);
    },
  );

  app.post(
    '/admin/listings/:programId/revisions/:revisionId/review/start',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: MODERATION_BODY_LIMIT,
      schema: {
        params: Type.Object({ programId: Uuid, revisionId: Uuid }),
        body: Type.Object({ expectedVersion: ExpectedVersion }, { additionalProperties: false }),
        response: {
          200: Type.Object({
            status: Type.Literal('revisionReviewStarted'),
            version: Type.Integer(),
          }),
          ...MODERATION_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await startRevisionReview(serviceDeps, { userId: principal.userId }, {
        programId: request.params.programId,
        revisionId: request.params.revisionId,
        expectedVersion: request.body.expectedVersion,
      });
      if (result.kind === 'revisionReviewStarted') {
        return reply
          .status(200)
          .send({ status: 'revisionReviewStarted', version: result.version });
      }
      return failure(reply, result.kind);
    },
  );

  app.post(
    '/admin/listings/:programId/revisions/:revisionId/approve',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: MODERATION_BODY_LIMIT,
      schema: {
        params: Type.Object({ programId: Uuid, revisionId: Uuid }),
        body: Type.Object({ expectedVersion: ExpectedVersion }, { additionalProperties: false }),
        response: {
          200: Type.Object({
            status: Type.Literal('revisionApproved'),
            programVersion: Type.Integer(),
            newOptionId: Type.Optional(Uuid),
          }),
          ...MODERATION_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await approveRevision(serviceDeps, { userId: principal.userId }, {
        programId: request.params.programId,
        revisionId: request.params.revisionId,
        expectedVersion: request.body.expectedVersion,
      });
      if (result.kind === 'revisionApproved') {
        return reply.status(200).send({
          status: 'revisionApproved',
          programVersion: result.programVersion,
          ...(result.newOptionId !== undefined ? { newOptionId: result.newOptionId } : {}),
        });
      }
      return failure(reply, result.kind);
    },
  );

  app.post(
    '/admin/listings/:programId/revisions/:revisionId/reject',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: MODERATION_BODY_LIMIT,
      schema: {
        params: Type.Object({ programId: Uuid, revisionId: Uuid }),
        body: Type.Object(
          { expectedVersion: ExpectedVersion, reasonCode: ReasonCode },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ status: Type.Literal('revisionRejected') }),
          ...MODERATION_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await rejectRevision(serviceDeps, { userId: principal.userId }, {
        programId: request.params.programId,
        revisionId: request.params.revisionId,
        expectedVersion: request.body.expectedVersion,
        ...(request.body.reasonCode !== undefined
          ? { reasonCode: request.body.reasonCode }
          : {}),
      });
      if (result.kind === 'revisionRejected') {
        return reply.status(200).send({ status: 'revisionRejected' });
      }
      return failure(reply, result.kind);
    },
  );
}
