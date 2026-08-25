/**
 * RI-1 — customer participant management HTTP surface (docs/34 §4.1;
 * docs/24 §1.2). The bounded backend companion: list own active
 * participants, create a child profile, update the V1-editable fields
 * (name, DOB), archive a child (history-safe — never destructive).
 *
 * Every route is `authenticatedCustomer`; the acting account is the
 * session's resolved `customer_account` and foreign participant ids are
 * not-found-shaped by the service. Only the certified identity fields
 * exist on the wire — no medical/allergy/gender/sensitive fields (docs/24
 * §14.B1 pending counsel). Reads emit nothing; mutations are audit-evented
 * in their service transaction.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requirePrincipal } from './auth-plugin';
import { sendOutcome, type HttpOutcomeName } from './http-outcomes';
import {
  archiveParticipant,
  createChildParticipant,
  listParticipants,
  updateParticipant,
} from '../services/participants';

const BODY_LIMIT = 16_384;
const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const ERRORS = {
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  500: ErrorBody,
};
const NameString = Type.String({ minLength: 1, maxLength: 80 });
/** ISO calendar date; full validation (real date, past, ≥1900) is service-side. */
const DateString = Type.String({ minLength: 10, maxLength: 10 });

const ParticipantSchema = Type.Object({
  id: Uuid,
  kind: Type.Union([Type.Literal('self'), Type.Literal('child')]),
  firstName: Type.String(),
  dateOfBirth: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
  version: Type.Integer(),
});

export interface ParticipantRouteDeps {
  db: Db;
}

export function registerParticipantRoutes(
  rawApp: FastifyInstance,
  deps: ParticipantRouteDeps,
): void {
  const app = rawApp.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };

  function principalOf(request: {
    principal: unknown;
  }): { userId: string; accountId: string } | undefined {
    const principal = requirePrincipal(
      (request as { principal: Parameters<typeof requirePrincipal>[0] }).principal,
    );
    if (principal.accountId === undefined) return undefined;
    return { userId: principal.userId, accountId: principal.accountId };
  }

  function failure(reply: FastifyReply, kind: string): FastifyReply {
    const name: HttpOutcomeName =
      kind === 'participantNotFound'
        ? 'notFound'
        : kind === 'invalidParticipant'
          ? 'invalidParticipant'
          : kind === 'participantArchived'
            ? 'participantArchived'
            : kind === 'cannotArchiveSelf'
              ? 'cannotArchiveSelf'
              : kind === 'staleVersion'
                ? 'staleVersion'
                : 'internalError';
    return sendOutcome(reply, name);
  }

  app.get(
    '/customer/participants',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        response: { 200: Type.Object({ participants: Type.Array(ParticipantSchema) }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const actor = principalOf(request);
      if (actor === undefined) return sendOutcome(reply, 'notFound');
      const result = await listParticipants(serviceDeps, actor);
      return reply.status(200).send({ participants: result.participants });
    },
  );

  app.post(
    '/customer/participants',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          { firstName: NameString, dateOfBirth: DateString },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ participant: ParticipantSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const actor = principalOf(request);
      if (actor === undefined) return sendOutcome(reply, 'notFound');
      const result = await createChildParticipant(serviceDeps, actor, request.body);
      if (result.kind !== 'participantCreated') return failure(reply, result.kind);
      return reply.status(201).send({ participant: result.participant });
    },
  );

  app.patch(
    '/customer/participants/:participantId',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ participantId: Uuid }),
        body: Type.Object(
          {
            version: Type.Integer({ minimum: 1 }),
            firstName: Type.Optional(NameString),
            dateOfBirth: Type.Optional(DateString),
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ participant: ParticipantSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const actor = principalOf(request);
      if (actor === undefined) return sendOutcome(reply, 'notFound');
      const result = await updateParticipant(serviceDeps, actor, {
        participantId: request.params.participantId,
        version: request.body.version,
        ...(request.body.firstName !== undefined ? { firstName: request.body.firstName } : {}),
        ...(request.body.dateOfBirth !== undefined
          ? { dateOfBirth: request.body.dateOfBirth }
          : {}),
      });
      if (result.kind !== 'participantUpdated') return failure(reply, result.kind);
      return reply.status(200).send({ participant: result.participant });
    },
  );

  app.post(
    '/customer/participants/:participantId/archive',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ participantId: Uuid }),
        body: Type.Object(
          { version: Type.Integer({ minimum: 1 }) },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ participant: ParticipantSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const actor = principalOf(request);
      if (actor === undefined) return sendOutcome(reply, 'notFound');
      const result = await archiveParticipant(serviceDeps, actor, {
        participantId: request.params.participantId,
        version: request.body.version,
      });
      if (result.kind !== 'participantArchived') return failure(reply, result.kind);
      return reply.status(200).send({ participant: result.participant });
    },
  );
}
