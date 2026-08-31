/**
 * Provider check-in HTTP surface — S6-2 (docs/35 §14; owner items 13–15,
 * 25, 27).
 *
 * Exactly TWO provider-private operations under the newly ACTIVATED
 * `attendance.manage` capability: the pure-read PREVIEW (the staff member
 * confirms WHO is in front of them — it grants nothing, consumes nothing)
 * and the atomic REDEEM (the real check-in, which revalidates EVERYTHING
 * independently — preview output is never authority). Both resolve codes
 * ONLY within the authenticated organization among effectively-live
 * credentials, both enforce branch/coach-assignment scope, and both are
 * bounded by the durable brute-force windows. Bodies are
 * additionalProperties:false — no remaining/participant/provider truth is
 * expressible on the wire.
 *
 * Deliberately ABSENT: attendance correction/mutation, roster surfaces
 * (`roster.view` stays RESERVED), reservation creation (S6-3), any
 * payment/commission linkage, any Admin surface.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requireOrgScope, requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import {
  previewRedemption,
  redeemCredential,
} from '../services/attendance-redemption';

const ORG = '/provider/organizations/:organizationId';
const BODY_LIMIT = 4_096;
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
const DisplayCode = Type.String({ minLength: 8, maxLength: 8, pattern: '^[0-9]{8}$' });
const IdempotencyKey = Type.String({ minLength: 8, maxLength: 128 });

const UsageSchema = Type.Object({
  usageKind: Type.Union([Type.Literal('finite'), Type.Literal('unlimited')]),
  usesTotal: Type.Optional(Type.Integer()),
  used: Type.Optional(Type.Integer()),
  remaining: Type.Optional(Type.Integer()),
});
const ValiditySchema = Type.Object({
  validFrom: Type.String(),
  validUntil: Type.Optional(Type.String()),
});
const TargetKind = Type.Union([
  Type.Literal('session'),
  Type.Literal('reservedEntitlementUse'),
  Type.Literal('walkIn'),
  Type.Literal('campWeekOccurrence'),
  Type.Literal('cohortOccurrence'),
]);
/** The credential's FROZEN canonical occurrence (camp/cohort): scheduled
 *  identity for the desk — never chooseable or changeable at redeem. */
const OccurrenceDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const OccurrenceStartTime = Type.String({ pattern: '^\\d{2}:\\d{2}$' });

export interface AttendanceProviderRouteDeps {
  db: Db;
}

export function registerAttendanceProviderRoutes(
  rawApp: FastifyInstance,
  deps: AttendanceProviderRouteDeps,
): void {
  const app = rawApp.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };

  function failure(reply: FastifyReply, kind: string): FastifyReply {
    const name: HttpOutcomeName =
      kind === 'credentialNotFound'
        ? 'notFound'
        : kind === 'credentialExpired'
          ? 'credentialExpired'
          : kind === 'credentialAlreadyUsed'
            ? 'credentialAlreadyUsed'
            : kind === 'forbiddenScope'
              ? 'forbidden'
              : kind === 'entitlementNotActive'
                ? 'entitlementNotActive'
                : kind === 'entitlementExhausted'
                  ? 'entitlementExhausted'
                  : kind === 'entitlementFullyCommitted'
                    ? 'entitlementFullyCommitted'
                  : kind === 'tooManyAttempts'
                    ? 'rateLimited'
                    : kind === 'idempotencyConflict'
                      ? 'idempotencyConflict'
                      : 'internalError';
    return sendOutcome(reply, name);
  }

  // -------------------------------------------------------------------------
  // Preview — pure read; grants nothing, consumes nothing.
  // -------------------------------------------------------------------------

  app.post(
    `${ORG}/check-in/preview`,
    {
      config: { authPolicy: 'provider', providerCapability: 'attendance.manage' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        body: Type.Object({ code: DisplayCode }, { additionalProperties: false }),
        response: {
          200: Type.Object({
            preview: Type.Object({
              credentialId: Uuid,
              expiresAt: Type.String(),
              participantFirstName: Type.String(),
              programTitle: Type.String(),
              targetKind: TargetKind,
              sessionStartAt: Type.Optional(Type.String()),
              occurrenceDate: Type.Optional(OccurrenceDate),
              occurrenceStartTime: Type.Optional(OccurrenceStartTime),
              branchLabel: Type.Optional(Type.String()),
              usage: Type.Optional(UsageSchema),
              validity: Type.Optional(ValiditySchema),
            }),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const result = await previewRedemption(serviceDeps, scope, {
        code: request.body.code,
      });
      if (result.kind !== 'redemptionPreview') return failure(reply, result.kind);
      return reply.status(200).send({ preview: result.preview });
    },
  );

  // -------------------------------------------------------------------------
  // Redeem — the atomic check-in.
  // -------------------------------------------------------------------------

  app.post(
    `${ORG}/check-in/redeem`,
    {
      config: { authPolicy: 'provider', providerCapability: 'attendance.manage' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        body: Type.Object(
          { code: DisplayCode, credentialId: Uuid, idempotencyKey: IdempotencyKey },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({
            attendance: Type.Object({
              attendanceId: Uuid,
              credentialId: Uuid,
              participantFirstName: Type.String(),
              programTitle: Type.String(),
              targetKind: TargetKind,
              occurredAt: Type.String(),
              occurrenceDate: Type.Optional(OccurrenceDate),
              occurrenceStartTime: Type.Optional(OccurrenceStartTime),
              remaining: Type.Optional(Type.Integer()),
              entitlementExhausted: Type.Optional(Type.Boolean()),
            }),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const run = await redeemCredential(
        serviceDeps,
        scope,
        { userId: principal.userId },
        {
          code: request.body.code,
          credentialId: request.body.credentialId,
          idempotencyKey: request.body.idempotencyKey,
        },
      );
      if (run.outcome.kind !== 'attendanceRecorded') return failure(reply, run.outcome.kind);
      return reply.status(201).send({ attendance: run.outcome.attendance });
    },
  );
}
