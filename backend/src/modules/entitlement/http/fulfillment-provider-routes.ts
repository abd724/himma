/**
 * Provider fulfillment-configuration HTTP surface — W2-13 (docs/35 §3;
 * owner W2-13 items 2–6, 22).
 *
 * Exactly TWO provider-private operations over the S6-1 immutable revision
 * model: read the current ACTIVE fulfillment terms of an owned price
 * option, and SET terms — which supersedes the prior active revision and
 * creates the next immutable one (historical/sold terms are never
 * rewritten; new revisions affect FUTURE purchases only). Authorization is
 * the certified PRODUCT capability that already owns the parent option:
 * reads on `catalogue.read`, mutation on `listings.manage` (branch scope
 * re-enforced service-side). `attendance.manage` grants nothing here —
 * front desk and coach cannot edit products. Bodies are
 * additionalProperties:false; cross-org ids are not-found-shaped.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requireOrgScope, requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import {
  getFulfillmentConfig,
  setFulfillmentConfig,
} from '../services/fulfillment-admin';

const ORG = '/provider/organizations/:organizationId';
const BODY_LIMIT = 16_384;
const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const ERRORS = {
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
const TimeHHMM = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
const DateISO = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

const ScheduleTermSchema = Type.Object({
  weekday: Type.Integer({ minimum: 0, maximum: 6 }),
  startTime: TimeHHMM,
  endTime: TimeHHMM,
});

const FulfillmentTermsBody = Type.Object(
  {
    usageKind: Type.Union([Type.Literal('finite'), Type.Literal('unlimited')]),
    usesTotal: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    validityKind: Type.Union([
      Type.Literal('daysFromConfirmation'),
      Type.Literal('fixedEndDate'),
      Type.Literal('none'),
    ]),
    validityDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
    validityEndDate: Type.Optional(DateISO),
    reservationRequired: Type.Boolean(),
    walkInAllowed: Type.Boolean(),
    branchId: Type.Optional(Uuid),
    scheduleTerms: Type.Optional(Type.Array(ScheduleTermSchema, { maxItems: 21 })),
  },
  { additionalProperties: false },
);

const FulfillmentRevisionSchema = Type.Object({
  revisionId: Uuid,
  revisionNo: Type.Integer(),
  state: Type.Union([Type.Literal('active'), Type.Literal('superseded')]),
  usageKind: Type.Union([Type.Literal('finite'), Type.Literal('unlimited')]),
  usesTotal: Type.Optional(Type.Integer()),
  validityKind: Type.Union([
    Type.Literal('daysFromConfirmation'),
    Type.Literal('fixedEndDate'),
    Type.Literal('none'),
  ]),
  validityDays: Type.Optional(Type.Integer()),
  validityEndDate: Type.Optional(Type.String()),
  reservationRequired: Type.Boolean(),
  walkInAllowed: Type.Boolean(),
  branchId: Type.Optional(Uuid),
  scheduleTerms: Type.Array(ScheduleTermSchema),
  createdAt: Type.String(),
});

export interface FulfillmentProviderRouteDeps {
  db: Db;
}

export function registerFulfillmentProviderRoutes(
  rawApp: FastifyInstance,
  deps: FulfillmentProviderRouteDeps,
): void {
  const app = rawApp.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };

  function failure(reply: FastifyReply, kind: string): FastifyReply {
    const name: HttpOutcomeName =
      kind === 'programNotFound' || kind === 'optionNotFound'
        ? 'notFound'
        : kind === 'forbidden'
          ? 'forbidden'
          : kind === 'optionNotEntitlement' || kind === 'invalidFulfillmentConfig'
            ? 'invalidFulfillmentConfig'
            : kind === 'invalidBranch'
              ? 'invalidBranchScope'
              : kind === 'lifecycleConflict'
                ? 'lifecycleConflict'
                : 'internalError';
    return sendOutcome(reply, name);
  }

  app.get(
    `${ORG}/programs/:programId/price-options/:optionId/fulfillment`,
    {
      config: { authPolicy: 'provider', providerCapability: 'catalogue.read' },
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid, optionId: Uuid }),
        response: {
          200: Type.Object({
            fulfillment: Type.Object({
              optionKind: Type.String(),
              supported: Type.Boolean(),
              active: Type.Union([FulfillmentRevisionSchema, Type.Null()]),
            }),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const result = await getFulfillmentConfig(serviceDeps, scope, {
        programId: request.params.programId,
        optionId: request.params.optionId,
      });
      if (result.kind !== 'fulfillmentConfig') return failure(reply, result.kind);
      return reply.status(200).send({
        fulfillment: {
          optionKind: result.optionKind,
          supported: result.supported,
          active: result.active,
        },
      });
    },
  );

  app.put(
    `${ORG}/programs/:programId/price-options/:optionId/fulfillment`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid, optionId: Uuid }),
        body: FulfillmentTermsBody,
        response: {
          200: Type.Object({ revision: FulfillmentRevisionSchema }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await setFulfillmentConfig(
        serviceDeps,
        scope,
        { userId: principal.userId },
        {
          programId: request.params.programId,
          optionId: request.params.optionId,
          terms: request.body,
        },
      );
      if (result.kind !== 'revisionCreated') return failure(reply, result.kind);
      return reply.status(200).send({ revision: result.revision });
    },
  );
}
