/**
 * Provider scheduling/capacity HTTP surface — S5-4 (docs/32 §11).
 *
 * Exactly the approved provider operations over the certified S5-1/S5-2
 * domain — no generic database editing: schedules (create/list/update/end),
 * deterministic idempotent session generation, one-off unit creation,
 * capacity/cutoff/time edits under the capacity floor, the two
 * provider-drivable §5.4 status edges (open/close), and the PII-lean
 * roster/occupancy read. Every route declares the `provider` policy plus
 * its ACTIVE capability (`schedules.manage` · `capacity.manage` ·
 * `bookings.view` · reads on `catalogue.read`); org binding is the
 * pipeline's per-request scope resolution; branch/program scope is
 * re-enforced service-side. All bodies are additionalProperties:false —
 * the app-wide Ajv strips undeclared properties before any handler, so a
 * smuggled `heldCount`/`bookedCount`/`state` is inexpressible and never
 * applied: counters and lifecycle are DOMAIN authority, not provider input
 * (no contract field for them exists anywhere on this surface). No route exists for `cancelled_by_provider` (controlled
 * disruption — future slice), `completed` (system), payments, or the
 * trusted confirmation seam.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requireOrgScope, requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import { UNIT_KINDS } from '../services/booking-shared';
import {
  createUnit,
  closeUnit,
  listUnits,
  openUnit,
  unitRoster,
  updateUnitConfig,
} from '../services/provider-capacity';
import {
  createSchedule,
  endSchedule,
  generateSessions,
  listSchedules,
  updateSchedule,
  CUTOFF_KINDS,
} from '../services/provider-scheduling';

const BODY_LIMIT = 32_768;
const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
/** 409 may carry the structured capacity-floor impact (docs/32 §3). */
const ConflictBody = Type.Object({
  code: Type.String(),
  message: Type.String(),
  capacity: Type.Optional(Type.Integer()),
  bookedCount: Type.Optional(Type.Integer()),
  heldCount: Type.Optional(Type.Integer()),
  floor: Type.Optional(Type.Integer()),
});
const ERRORS = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ConflictBody,
  422: ErrorBody,
  429: ErrorBody,
  500: ErrorBody,
  503: ErrorBody,
};

const TimeHHMM = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
const DateISO = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Timestamp = Type.String({ format: 'date-time' });
const ExpectedVersion = Type.Integer({ minimum: 1 });
const Capacity = Type.Integer({ minimum: 0, maximum: 100_000 });
const CutoffKindLiteral = Type.Union(CUTOFF_KINDS.map((kind) => Type.Literal(kind)));
const UnitKindLiteral = Type.Union(UNIT_KINDS.map((kind) => Type.Literal(kind)));
const IdempotencyKey = Type.String({ minLength: 8, maxLength: 128 });

const ScheduleView = Type.Object({
  id: Uuid,
  programId: Uuid,
  weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 6 })),
  startTime: Type.String(),
  endTime: Type.String(),
  timezone: Type.String(),
  effectiveStart: Type.String(),
  effectiveEnd: Type.Union([Type.String(), Type.Null()]),
  exceptionDates: Type.Array(Type.String()),
  registrationCutoffKind: Type.String(),
  registrationCutoffMinutes: Type.Union([Type.Integer(), Type.Null()]),
  instructorStaffId: Type.Union([Uuid, Type.Null()]),
  state: Type.String(),
  version: Type.Integer(),
});

const UnitView = Type.Object({
  id: Uuid,
  kind: UnitKindLiteral,
  programId: Uuid,
  branchId: Uuid,
  capacity: Type.Integer(),
  bookedCount: Type.Integer(),
  heldCount: Type.Integer(),
  state: Type.String(),
  registrationCutoffAt: Type.String(),
  startAt: Type.Union([Type.String(), Type.Null()]),
  endAt: Type.Union([Type.String(), Type.Null()]),
  startDate: Type.Union([Type.String(), Type.Null()]),
  endDate: Type.Union([Type.String(), Type.Null()]),
  effectiveStart: Type.Union([Type.String(), Type.Null()]),
  effectiveEnd: Type.Union([Type.String(), Type.Null()]),
  scheduleId: Type.Union([Uuid, Type.Null()]),
  version: Type.Integer(),
});

const RosterEntryView = Type.Object({
  referenceCode: Type.Union([Type.String(), Type.Null()]),
  state: Type.String(),
  participant: Type.Object({ firstName: Type.String(), kind: Type.String() }),
  confirmedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

export interface BookingProviderRouteDeps {
  db: Db;
}

export function registerBookingProviderRoutes(
  rawApp: FastifyInstance,
  deps: BookingProviderRouteDeps,
): void {
  const app = rawApp.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };
  const ORG = '/provider/organizations/:organizationId';

  function failure(reply: FastifyReply, kind: string): FastifyReply {
    const name: HttpOutcomeName =
      kind === 'programNotFound' || kind === 'scheduleNotFound' || kind === 'unitNotFound'
        ? 'notFound'
        : kind === 'forbidden'
          ? 'forbidden'
          : kind === 'lifecycleConflict'
            ? 'lifecycleConflict'
            : kind === 'staleVersion'
              ? 'staleVersion'
              : kind === 'invalidSchedule' || kind === 'invalidGeneration'
                ? 'invalidSchedule'
                : kind === 'invalidUnit'
                  ? 'invalidUnit'
                  : kind === 'invalidBranch'
                    ? 'invalidBranchScope'
                    : kind === 'idempotencyConflict'
                      ? 'idempotencyConflict'
                      : 'internalError';
    return sendOutcome(reply, name);
  }

  // -------------------------------------------------------------------------
  // Recurring schedules
  // -------------------------------------------------------------------------

  app.get(
    `${ORG}/programs/:programId/schedules`,
    {
      config: { authPolicy: 'provider', providerCapability: 'catalogue.read' },
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        response: { 200: Type.Object({ schedules: Type.Array(ScheduleView) }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const result = await listSchedules(serviceDeps, scope, {
        programId: request.params.programId,
      });
      if (result.kind !== 'schedules') return failure(reply, result.kind);
      return reply.status(200).send({ schedules: result.schedules });
    },
  );

  app.post(
    `${ORG}/programs/:programId/schedules`,
    {
      config: { authPolicy: 'provider', providerCapability: 'schedules.manage' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        body: Type.Object(
          {
            weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
              minItems: 1,
              maxItems: 7,
            }),
            startTime: TimeHHMM,
            endTime: TimeHHMM,
            effectiveStart: DateISO,
            effectiveEnd: Type.Optional(DateISO),
            exceptionDates: Type.Optional(Type.Array(DateISO, { maxItems: 100 })),
            registrationCutoffKind: Type.Optional(CutoffKindLiteral),
            registrationCutoffMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_160 })),
            instructorStaffId: Type.Optional(Uuid),
            idempotencyKey: Type.Optional(IdempotencyKey),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ schedule: ScheduleView }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await createSchedule(serviceDeps, scope, { userId: principal.userId }, {
        programId: request.params.programId,
        ...request.body,
      });
      if (result.kind !== 'scheduleCreated') return failure(reply, result.kind);
      return reply.status(201).send({ schedule: result.schedule });
    },
  );

  app.patch(
    `${ORG}/schedules/:scheduleId`,
    {
      config: { authPolicy: 'provider', providerCapability: 'schedules.manage' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, scheduleId: Uuid }),
        body: Type.Object(
          {
            expectedVersion: ExpectedVersion,
            weekdays: Type.Optional(
              Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7 }),
            ),
            startTime: Type.Optional(TimeHHMM),
            endTime: Type.Optional(TimeHHMM),
            effectiveEnd: Type.Optional(Type.Union([DateISO, Type.Null()])),
            exceptionDates: Type.Optional(Type.Array(DateISO, { maxItems: 100 })),
            registrationCutoffKind: Type.Optional(CutoffKindLiteral),
            registrationCutoffMinutes: Type.Optional(
              Type.Union([Type.Integer({ minimum: 1, maximum: 20_160 }), Type.Null()]),
            ),
            instructorStaffId: Type.Optional(Type.Union([Uuid, Type.Null()])),
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ schedule: ScheduleView }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updateSchedule(serviceDeps, scope, { userId: principal.userId }, {
        scheduleId: request.params.scheduleId,
        expectedVersion,
        patch,
      });
      if (result.kind !== 'scheduleUpdated') return failure(reply, result.kind);
      return reply.status(200).send({ schedule: result.schedule });
    },
  );

  app.post(
    `${ORG}/schedules/:scheduleId/end`,
    {
      config: { authPolicy: 'provider', providerCapability: 'schedules.manage' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, scheduleId: Uuid }),
        body: Type.Object(
          { expectedVersion: ExpectedVersion },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ status: Type.Literal('scheduleEnded') }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await endSchedule(serviceDeps, scope, { userId: principal.userId }, {
        scheduleId: request.params.scheduleId,
        expectedVersion: request.body.expectedVersion,
      });
      if (result.kind !== 'scheduleEnded') return failure(reply, result.kind);
      return reply.status(200).send({ status: 'scheduleEnded' });
    },
  );

  app.post(
    `${ORG}/schedules/:scheduleId/generate-sessions`,
    {
      config: { authPolicy: 'provider', providerCapability: 'schedules.manage' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, scheduleId: Uuid }),
        body: Type.Object(
          {
            branchId: Uuid,
            capacity: Capacity,
            fromDate: DateISO,
            toDate: DateISO,
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            created: Type.Integer(),
            alreadyExisted: Type.Integer(),
            sessionIds: Type.Array(Uuid),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await generateSessions(serviceDeps, scope, { userId: principal.userId }, {
        scheduleId: request.params.scheduleId,
        ...request.body,
      });
      if (result.kind !== 'sessionsGenerated') return failure(reply, result.kind);
      return reply.status(200).send({
        created: result.created,
        alreadyExisted: result.alreadyExisted,
        sessionIds: result.sessionIds,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Capacity units
  // -------------------------------------------------------------------------

  app.get(
    `${ORG}/programs/:programId/units`,
    {
      config: { authPolicy: 'provider', providerCapability: 'catalogue.read' },
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        querystring: Type.Object({ kind: UnitKindLiteral }),
        response: { 200: Type.Object({ units: Type.Array(UnitView) }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const result = await listUnits(serviceDeps, scope, {
        kind: request.query.kind,
        programId: request.params.programId,
      });
      if (result.kind !== 'units') return failure(reply, result.kind);
      return reply.status(200).send({ units: result.units });
    },
  );

  app.post(
    `${ORG}/units`,
    {
      config: { authPolicy: 'provider', providerCapability: 'capacity.manage' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        body: Type.Object(
          {
            kind: UnitKindLiteral,
            programId: Uuid,
            branchId: Uuid,
            capacity: Capacity,
            registrationCutoffAt: Type.Optional(Timestamp),
            openRegistration: Type.Optional(Type.Boolean()),
            startAt: Type.Optional(Timestamp),
            endAt: Type.Optional(Timestamp),
            instructorStaffId: Type.Optional(Uuid),
            startDate: Type.Optional(DateISO),
            endDate: Type.Optional(DateISO),
            dailyStartTime: Type.Optional(TimeHHMM),
            dailyEndTime: Type.Optional(TimeHHMM),
            effectiveStart: Type.Optional(DateISO),
            effectiveEnd: Type.Optional(DateISO),
            idempotencyKey: Type.Optional(IdempotencyKey),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ unit: UnitView }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await createUnit(serviceDeps, scope, { userId: principal.userId }, request.body);
      if (result.kind !== 'unitCreated') return failure(reply, result.kind);
      return reply.status(201).send({ unit: result.unit });
    },
  );

  app.patch(
    `${ORG}/units/:unitKind/:unitId`,
    {
      config: { authPolicy: 'provider', providerCapability: 'capacity.manage' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, unitKind: UnitKindLiteral, unitId: Uuid }),
        body: Type.Object(
          {
            expectedVersion: ExpectedVersion,
            capacity: Type.Optional(Capacity),
            registrationCutoffAt: Type.Optional(Timestamp),
            startAt: Type.Optional(Timestamp),
            endAt: Type.Optional(Timestamp),
            instructorStaffId: Type.Optional(Type.Union([Uuid, Type.Null()])),
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ unit: UnitView }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updateUnitConfig(serviceDeps, scope, { userId: principal.userId }, {
        unit: { kind: request.params.unitKind, id: request.params.unitId },
        expectedVersion,
        patch,
      });
      if (result.kind === 'capacityBelowCommitments') {
        // The typed floor refusal with its structured impact (docs/32 §3):
        // reducing committed capacity is the controlled-disruption
        // workflow's job — never a capacity edit.
        return reply.status(409).send({
          code: 'capacityBelowCommitments',
          message:
            'Capacity cannot be reduced below the seats already booked or held. Reducing committed capacity requires the controlled disruption workflow.',
          capacity: result.capacity,
          bookedCount: result.bookedCount,
          heldCount: result.heldCount,
          floor: result.floor,
        });
      }
      if (result.kind !== 'unitUpdated') return failure(reply, result.kind);
      return reply.status(200).send({ unit: result.unit });
    },
  );

  for (const action of ['open', 'close'] as const) {
    app.post(
      `${ORG}/units/:unitKind/:unitId/${action}`,
      {
        config: { authPolicy: 'provider', providerCapability: 'capacity.manage' },
        bodyLimit: BODY_LIMIT,
        schema: {
          params: Type.Object({ organizationId: Uuid, unitKind: UnitKindLiteral, unitId: Uuid }),
          body: Type.Object(
            { expectedVersion: ExpectedVersion },
            { additionalProperties: false },
          ),
          response: { 200: Type.Object({ unit: UnitView }), ...ERRORS },
        },
      },
      async (request, reply) => {
        const scope = requireOrgScope(request.principal);
        const principal = requirePrincipal(request.principal);
        const fn = action === 'open' ? openUnit : closeUnit;
        const result = await fn(serviceDeps, scope, { userId: principal.userId }, {
          unit: { kind: request.params.unitKind, id: request.params.unitId },
          expectedVersion: request.body.expectedVersion,
        });
        if (result.kind !== 'unitOpened' && result.kind !== 'unitClosed') {
          return failure(reply, result.kind);
        }
        return reply.status(200).send({ unit: result.unit });
      },
    );
  }

  app.get(
    `${ORG}/units/:unitKind/:unitId/roster`,
    {
      config: { authPolicy: 'provider', providerCapability: 'bookings.view' },
      schema: {
        params: Type.Object({ organizationId: Uuid, unitKind: UnitKindLiteral, unitId: Uuid }),
        response: {
          200: Type.Object({ unit: UnitView, entries: Type.Array(RosterEntryView) }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const result = await unitRoster(serviceDeps, scope, {
        unit: { kind: request.params.unitKind, id: request.params.unitId },
      });
      if (result.kind !== 'roster') return failure(reply, result.kind);
      return reply.status(200).send({ unit: result.unit, entries: result.entries });
    },
  );
}
