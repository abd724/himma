/**
 * S6-3 customer HTTP surface — entitlement reservations, "My Passes &
 * Memberships", attendance history, reservable occurrences, and the unified
 * calendar (docs/35 §7, §8, §12, §13).
 *
 * Every route is `authenticatedCustomer`; cross-account ids stay
 * not-found-shaped by the services. The customer authors NOTHING
 * commercial: no price, credit count, fulfillment terms, provider
 * identity, beneficiary, or capacity field exists on any wire — the
 * reservation wire carries exactly (entitlementId, sessionId) and then
 * (holdId, idempotencyKey); everything else is server truth.
 *
 * Deliberately ABSENT: cancellation (no certified customer Booking
 * cancellation path exists — none is invented), no-show penalties, camp/
 * cohort reservation (Session occurrences only in V1 — the recorded
 * occurrence gate), and any mutation on the calendar read (item 37).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import {
  getCustomerCalendar,
  getCustomerEntitlement,
  listCustomerEntitlements,
  listEntitlementAttendance,
  listReservableSessions,
} from '../services/entitlement-read';
import {
  confirmEntitlementReservation,
  requestEntitlementReservationQuote,
} from '../services/entitlement-reservation';

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
const IdempotencyKey = Type.String({ minLength: 8, maxLength: 128 });
const NullableString = Type.Union([Type.String(), Type.Null()]);
const IsoDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

const FiniteSchema = Type.Object({
  usesTotal: Type.Integer(),
  used: Type.Integer(),
  remaining: Type.Integer(),
  reservedUpcoming: Type.Integer(),
  availableToReserve: Type.Integer(),
});

const DisplayRef = Type.Object({ id: Uuid, displayName: Type.String() });
const ProgramRef = Type.Object({ id: Uuid, titleEn: Type.String() });
const ParticipantRef = Type.Object({ id: Uuid, firstName: Type.String() });
const BranchRef = Type.Union([Type.Object({ id: Uuid, label: Type.String() }), Type.Null()]);

const EntitlementSchema = Type.Object({
  entitlementId: Uuid,
  participant: ParticipantRef,
  program: ProgramRef,
  provider: DisplayRef,
  branch: BranchRef,
  productLabel: Type.String(),
  optionKind: Type.String(),
  usageKind: Type.Union([Type.Literal('finite'), Type.Literal('unlimited')]),
  status: Type.Union([
    Type.Literal('active'),
    Type.Literal('exhausted'),
    Type.Literal('expired'),
  ]),
  validFrom: Type.String(),
  validUntil: NullableString,
  walkInAllowed: Type.Boolean(),
  reservationRequired: Type.Boolean(),
  finite: Type.Optional(FiniteSchema),
  scheduleTerms: Type.Array(
    Type.Object({
      weekday: Type.Integer({ minimum: 0, maximum: 6 }),
      startTime: Type.String(),
      endTime: Type.String(),
    }),
  ),
  nextReservedSessionAt: NullableString,
});

const ReservationQuoteSchema = Type.Object({
  quoteId: Uuid,
  entitlementId: Uuid,
  programId: Uuid,
  organizationId: Uuid,
  participantId: Uuid,
  sessionId: Uuid,
  totalFils: Type.Literal(0),
  currency: Type.Literal('AED'),
  expiresAt: Type.String(),
  finite: Type.Optional(FiniteSchema),
});

const ReservationSchema = Type.Object({
  bookingId: Uuid,
  referenceCode: Type.String(),
  state: Type.Literal('confirmed'),
  entitlementId: Uuid,
  sessionId: Uuid,
  participantId: Uuid,
  confirmedAt: Type.String(),
  finite: Type.Optional(FiniteSchema),
});

const ReservableSessionSchema = Type.Object({
  sessionId: Uuid,
  branchId: Uuid,
  startAt: Type.String(),
  endAt: Type.String(),
  /** RI-6 — venue timezone for truthful civil presentation. */
  timezone: Type.String(),
  registrationCutoffAt: Type.String(),
  availability: Type.Union([
    Type.Literal('available'),
    Type.Literal('fewLeft'),
    Type.Literal('full'),
    Type.Literal('closed'),
  ]),
  spotsLeft: Type.Optional(Type.Integer()),
});

const AttendanceSchema = Type.Object({
  attendanceId: Uuid,
  occurredAt: Type.String(),
  program: ProgramRef,
  provider: DisplayRef,
  branch: BranchRef,
  sessionStartAt: NullableString,
  targetKind: Type.Union([
    Type.Literal('session'),
    Type.Literal('reservedEntitlementUse'),
    Type.Literal('walkIn'),
  ]),
});

const CalendarEventSchema = Type.Object({
  eventKey: Type.String(),
  sourceType: Type.Union([
    Type.Literal('sessionBooking'),
    Type.Literal('campWeekOccurrence'),
    Type.Literal('cohortOccurrence'),
    Type.Literal('membershipOccurrence'),
  ]),
  context: Type.Union([
    Type.Literal('booked'),
    Type.Literal('reservedWithPass'),
    Type.Literal('includedSchedule'),
  ]),
  participant: ParticipantRef,
  program: ProgramRef,
  provider: DisplayRef,
  branch: BranchRef,
  startAt: Type.String(),
  endAt: Type.String(),
  /** RI-6 — venue timezone (IANA) for truthful civil presentation on any
   *  device timezone. */
  timezone: Type.String(),
  span: Type.Optional(
    Type.Object({
      startDate: IsoDate,
      endDate: IsoDate,
      dailyStartTime: Type.String(),
      dailyEndTime: Type.String(),
    }),
  ),
  /** RI-4 correction: the EXPLICIT canonical occurrence pair for
   *  camp/cohort Booking occurrences — passed verbatim to credential
   *  issuance; the event key stays opaque identity. */
  occurrence: Type.Optional(
    Type.Object({
      date: IsoDate,
      startTime: Type.String({ pattern: '^\\d{2}:\\d{2}$' }),
    }),
  ),
  bookingId: Type.Optional(Uuid),
  entitlementId: Type.Optional(Uuid),
});

export function registerReservationCustomerRoutes(
  fastify: FastifyInstance,
  deps: { db: Db },
): void {
  const app = fastify.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };

  function accountOf(request: { principal: unknown }): string | undefined {
    const principal = requirePrincipal(
      (request as { principal: Parameters<typeof requirePrincipal>[0] }).principal,
    );
    return principal.accountId;
  }

  function failure(reply: FastifyReply, kind: string): FastifyReply {
    const name: HttpOutcomeName =
      kind === 'entitlementNotFound' || kind === 'holdNotFound'
        ? 'notFound'
        : kind === 'entitlementNotActive'
          ? 'entitlementNotActive'
          : kind === 'entitlementExhausted'
            ? 'entitlementExhausted'
            : kind === 'entitlementFullyCommitted'
              ? 'entitlementFullyCommitted'
                : kind === 'reservationNotPermitted'
                  ? 'reservationNotPermitted'
                : kind === 'occurrenceNotEligible'
                  ? 'occurrenceNotEligible'
                  : kind === 'participantIneligible'
                    ? 'participantIneligible'
                    : kind === 'notReservationQuote'
                      ? 'invalidQuote'
                      : kind === 'alreadyBooked' || kind === 'alreadyConfirmed'
                        ? 'alreadyConfirmed'
                        : kind === 'holdNotActive' || kind === 'holdExpired'
                          ? 'holdExpired'
                          : kind === 'invalidBookingState'
                            ? 'lifecycleConflict'
                            : kind === 'reciprocalMismatch'
                              ? 'invalidQuote'
                              : kind === 'policyUnavailable'
                              ? 'policyUnavailable'
                              : kind === 'idempotencyConflict'
                                ? 'idempotencyConflict'
                                : kind === 'invalidRange'
                                  ? 'invalidRange'
                                  : 'internalError';
    return sendOutcome(reply, name);
  }

  // -------------------------------------------------------------------------
  // My Passes & Memberships
  // -------------------------------------------------------------------------

  app.get(
    '/customer/entitlements',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          cursor: Type.Optional(Uuid),
        }),
        response: {
          200: Type.Object({
            entitlements: Type.Array(EntitlementSchema),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await listCustomerEntitlements(serviceDeps, { accountId }, request.query);
      return reply
        .status(200)
        .send({ entitlements: result.entitlements, nextCursor: result.nextCursor });
    },
  );

  app.get(
    '/customer/entitlements/:entitlementId',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        params: Type.Object({ entitlementId: Uuid }),
        response: { 200: Type.Object({ entitlement: EntitlementSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await getCustomerEntitlement(serviceDeps, { accountId }, request.params);
      if (result.kind !== 'entitlement') return failure(reply, result.kind);
      return reply.status(200).send({ entitlement: result.entitlement });
    },
  );

  app.get(
    '/customer/entitlements/:entitlementId/attendance',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        params: Type.Object({ entitlementId: Uuid }),
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          cursor: Type.Optional(Uuid),
        }),
        response: {
          200: Type.Object({
            attendance: Type.Array(AttendanceSchema),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await listEntitlementAttendance(serviceDeps, { accountId }, {
        entitlementId: request.params.entitlementId,
        ...request.query,
      });
      if (result.kind !== 'attendance') return failure(reply, result.kind);
      return reply
        .status(200)
        .send({ attendance: result.attendance, nextCursor: result.nextCursor });
    },
  );

  // -------------------------------------------------------------------------
  // Reservable occurrences (authenticated entitlement-specific projection)
  // -------------------------------------------------------------------------

  app.get(
    '/customer/entitlements/:entitlementId/reservable-sessions',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        params: Type.Object({ entitlementId: Uuid }),
        querystring: Type.Object({
          from: Type.Optional(IsoDate),
          to: Type.Optional(IsoDate),
        }),
        response: {
          200: Type.Object({
            sessions: Type.Array(ReservableSessionSchema),
            finite: Type.Optional(FiniteSchema),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await listReservableSessions(serviceDeps, { accountId }, {
        entitlementId: request.params.entitlementId,
        ...request.query,
      });
      if (result.kind !== 'reservableSessions') return failure(reply, result.kind);
      return reply.status(200).send({
        sessions: result.sessions,
        ...(result.finite !== undefined ? { finite: result.finite } : {}),
      });
    },
  );

  // -------------------------------------------------------------------------
  // Reservation quote + confirmation (the §7 authority)
  // -------------------------------------------------------------------------

  app.post(
    '/customer/entitlements/:entitlementId/reservation-quote',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ entitlementId: Uuid }),
        body: Type.Object({ sessionId: Uuid }, { additionalProperties: false }),
        response: { 201: Type.Object({ quote: ReservationQuoteSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await requestEntitlementReservationQuote(serviceDeps, { accountId }, {
        entitlementId: request.params.entitlementId,
        sessionId: request.body.sessionId,
      });
      if (result.kind !== 'quoteIssued') return failure(reply, result.kind);
      return reply.status(201).send({ quote: result.quote });
    },
  );

  app.post(
    '/customer/entitlement-reservations/confirm',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          { holdId: Uuid, idempotencyKey: IdempotencyKey },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ reservation: ReservationSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const run = await confirmEntitlementReservation(serviceDeps, { accountId }, {
        holdId: request.body.holdId,
        idempotencyKey: request.body.idempotencyKey,
      });
      if (run.outcome.kind !== 'reservationConfirmed') return failure(reply, run.outcome.kind);
      return reply.status(201).send({ reservation: run.outcome.reservation });
    },
  );

  // -------------------------------------------------------------------------
  // Calendar (derived READ; performs no mutation — item 37)
  // -------------------------------------------------------------------------

  app.get(
    '/customer/calendar',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        querystring: Type.Object({ from: IsoDate, to: IsoDate }),
        response: {
          200: Type.Object({ events: Type.Array(CalendarEventSchema) }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await getCustomerCalendar(serviceDeps, { accountId }, request.query);
      if (result.kind !== 'calendar') return failure(reply, result.kind);
      return reply.status(200).send({ events: result.events });
    },
  );
}
