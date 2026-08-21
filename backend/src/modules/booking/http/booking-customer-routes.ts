/**
 * Customer booking HTTP surface — S5-5 (docs/32 §12; docs/21 §11 / docs/22
 * §11 vocabulary; rulings D-6, D-7, D-8, D-10).
 *
 * Exactly the approved customer boundaries: availability read (derived
 * projection — no counters on the wire), quote issuance, hold claim /
 * status / release, atomic free confirmation, the FAIL-CLOSED paid
 * boundary, and own-booking reads. Every route declares
 * `authPolicy: 'authenticatedCustomer'`; the account is the session's
 * resolved `customer_account` — customers command only their OWN flow, and
 * cross-account ids are not-found-shaped by the services.
 *
 * Deliberately ABSENT (structurally locked by the route-inventory test):
 * any route to the trusted paid-confirmation service (the W5 seam stays
 * route-less), payment success claims, cancellation, waitlists, package
 * redemption. All
 * bodies are additionalProperties:false; smuggled counters/states/prices
 * are inexpressible (the app-wide Ajv strips undeclared properties and no
 * contract field exists for them — money comes ONLY from the server quote).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import { UNIT_KINDS } from '../services/booking-shared';
import {
  confirmFreeBooking,
} from '../services/booking-lifecycle';
import {
  getBooking,
  holdStatus,
  listAvailability,
  listBookings,
  paidCheckoutBoundary,
} from '../services/customer-booking-read';
import { claimHold } from '../services/hold-claim';
import { releaseHold } from '../services/hold-lifecycle';
import { requestQuote } from '../services/quote-service';

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
const UnitKindLiteral = Type.Union(UNIT_KINDS.map((kind) => Type.Literal(kind)));
const IdempotencyKey = Type.String({ minLength: 8, maxLength: 128 });
const NullableString = Type.Union([Type.String(), Type.Null()]);

const AvailabilityViewSchema = Type.Object({
  unitId: Uuid,
  kind: UnitKindLiteral,
  startAt: NullableString,
  endAt: NullableString,
  startDate: NullableString,
  endDate: NullableString,
  effectiveStart: NullableString,
  effectiveEnd: NullableString,
  registrationCutoffAt: Type.String(),
  availability: Type.Union([
    Type.Literal('available'),
    Type.Literal('fewLeft'),
    Type.Literal('full'),
    Type.Literal('closed'),
  ]),
  spotsLeft: Type.Optional(Type.Integer()),
});

const QuoteViewSchema = Type.Object({
  quoteId: Uuid,
  programId: Uuid,
  organizationId: Uuid,
  participantId: Uuid,
  optionKind: Type.String(),
  unitKind: UnitKindLiteral,
  unitId: Uuid,
  offerId: Type.Optional(Uuid),
  totalFils: Type.Integer(),
  currency: Type.Literal('AED'),
  priceKind: Type.String(),
  taxTreatment: Type.Literal('notConfigured'),
  lines: Type.Array(
    Type.Object({
      lineNo: Type.Integer(),
      kind: Type.Literal('base'),
      labelEn: Type.String(),
      amountFils: Type.Integer(),
    }),
  ),
  expiresAt: Type.String(),
});

const HoldViewSchema = Type.Object({
  holdId: Uuid,
  unitKind: UnitKindLiteral,
  unitId: Uuid,
  organizationId: Uuid,
  participantId: Uuid,
  quantity: Type.Integer(),
  state: Type.Literal('active'),
  expiresAt: Type.String(),
});

const ConfirmedBookingSchema = Type.Object({
  bookingId: Uuid,
  state: Type.Literal('confirmed'),
  referenceCode: Type.String(),
  holdId: Uuid,
  unitKind: UnitKindLiteral,
  unitId: Uuid,
  participantId: Uuid,
  policyTemplateId: Uuid,
  confirmedAt: Type.String(),
  enrolmentCreated: Type.Boolean(),
});

const CustomerBookingSchema = Type.Object({
  bookingId: Uuid,
  referenceCode: NullableString,
  state: Type.String(),
  participant: Type.Object({ id: Uuid, firstName: Type.String() }),
  program: Type.Object({ id: Uuid, titleEn: Type.String() }),
  unit: Type.Object({
    kind: UnitKindLiteral,
    unitId: Uuid,
    startAt: NullableString,
    startDate: NullableString,
    effectiveStart: NullableString,
  }),
  price: Type.Object({ totalFils: Type.Integer(), currency: Type.Literal('AED') }),
  createdAt: Type.String(),
  confirmedAt: NullableString,
});

export interface BookingCustomerRouteDeps {
  db: Db;
}

export function registerBookingCustomerRoutes(
  rawApp: FastifyInstance,
  deps: BookingCustomerRouteDeps,
): void {
  const app = rawApp.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };

  /** The session's resolved customer account — the ONLY authority a
   *  customer route acts under. Absent account → not-found-shaped. */
  function accountOf(request: { principal: unknown }): string | undefined {
    const principal = requirePrincipal(
      (request as { principal: Parameters<typeof requirePrincipal>[0] }).principal,
    );
    return principal.accountId;
  }

  function failure(reply: FastifyReply, kind: string): FastifyReply {
    const name: HttpOutcomeName =
      kind === 'programNotFound' ||
      kind === 'unitNotFound' ||
      kind === 'participantNotFound' ||
      kind === 'priceOptionNotFound' ||
      kind === 'offerNotFound' ||
      kind === 'quoteNotFound' ||
      kind === 'holdNotFound' ||
      kind === 'bookingNotFound' ||
      kind === 'programNotBookable'
        ? 'notFound'
        : kind === 'sessionFull'
          ? 'sessionFull'
          : kind === 'registrationClosed'
            ? 'registrationClosed'
            : kind === 'participantIneligible'
              ? 'participantIneligible'
              : kind === 'offerNotApplicable'
                ? 'invalidQuote'
                : kind === 'quoteExpired'
                  ? 'quoteExpired'
                  : kind === 'quoteMismatch'
                    ? 'invalidQuote'
                    : kind === 'holdAlreadyActive'
                      ? 'holdAlreadyActive'
                      : kind === 'holdNotActive'
                        ? 'holdNotActive'
                        : kind === 'holdExpired'
                          ? 'holdExpired'
                          : kind === 'alreadyBooked'
                            ? 'alreadyBooked'
                            : kind === 'alreadyConfirmed'
                              ? 'alreadyConfirmed'
                              : kind === 'invalidBookingState'
                                ? 'lifecycleConflict'
                                : kind === 'staleVersion'
                                  ? 'staleVersion'
                                  : kind === 'notFreeQuote'
                                    ? 'notFreeQuote'
                                    : kind === 'paymentNotRequired'
                                      ? 'paymentNotRequired'
                                      : kind === 'paymentUnavailable'
                                        ? 'paymentUnavailable'
                                        : kind === 'trialAlreadyRedeemed'
                                          ? 'trialAlreadyRedeemed'
                                          : kind === 'policyUnavailable'
                                            ? 'policyUnavailable'
                                            : kind === 'idempotencyConflict'
                                              ? 'idempotencyConflict'
                                              : kind === 'reciprocalMismatch'
                                                ? 'invalidQuote'
                                                : 'internalError';
    return sendOutcome(reply, name);
  }

  // -------------------------------------------------------------------------
  // Availability (derived projection — docs/32 §12)
  // -------------------------------------------------------------------------

  app.get(
    '/customer/programs/:programId/availability',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        params: Type.Object({ programId: Uuid }),
        querystring: Type.Object({ kind: UnitKindLiteral }),
        response: { 200: Type.Object({ units: Type.Array(AvailabilityViewSchema) }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const result = await listAvailability(serviceDeps, {
        programId: request.params.programId,
        unitKind: request.query.kind,
      });
      if (result.kind !== 'availability') return failure(reply, result.kind);
      return reply.status(200).send({ units: result.units });
    },
  );

  // -------------------------------------------------------------------------
  // Quote
  // -------------------------------------------------------------------------

  app.post(
    '/customer/quotes',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          {
            programId: Uuid,
            priceOptionId: Uuid,
            unitKind: UnitKindLiteral,
            unitId: Uuid,
            participantId: Uuid,
            offerId: Type.Optional(Uuid),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ quote: QuoteViewSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const { unitKind, unitId, ...rest } = request.body;
      const result = await requestQuote(serviceDeps, { accountId }, {
        ...rest,
        unit: { kind: unitKind, id: unitId },
      });
      if (result.kind !== 'quoteIssued') return failure(reply, result.kind);
      return reply.status(201).send({ quote: result.quote });
    },
  );

  // -------------------------------------------------------------------------
  // Holds — claim / status / release (S5-2 authority)
  // -------------------------------------------------------------------------

  app.post(
    '/customer/holds',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          {
            unitKind: UnitKindLiteral,
            unitId: Uuid,
            participantId: Uuid,
            quoteId: Uuid,
            idempotencyKey: IdempotencyKey,
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ hold: HoldViewSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const run = await claimHold(serviceDeps, { accountId }, {
        unit: { kind: request.body.unitKind, id: request.body.unitId },
        participantId: request.body.participantId,
        quoteId: request.body.quoteId,
        idempotencyKey: request.body.idempotencyKey,
      });
      if (run.outcome.kind !== 'holdClaimed') return failure(reply, run.outcome.kind);
      return reply.status(201).send({ hold: run.outcome.hold });
    },
  );

  app.get(
    '/customer/holds/:holdId',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        params: Type.Object({ holdId: Uuid }),
        response: {
          200: Type.Object({
            hold: Type.Object({
              holdId: Uuid,
              state: Type.String(),
              unitKind: UnitKindLiteral,
              unitId: Uuid,
              participantId: Uuid,
              expiresAt: Type.String(),
            }),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await holdStatus(serviceDeps, { accountId }, {
        holdId: request.params.holdId,
      });
      if (result.kind !== 'holdStatus') return failure(reply, result.kind);
      return reply.status(200).send({ hold: result.hold });
    },
  );

  app.post(
    '/customer/holds/:holdId/release',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        params: Type.Object({ holdId: Uuid }),
        body: Type.Object(
          { idempotencyKey: IdempotencyKey },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            status: Type.Union([Type.Literal('holdReleased'), Type.Literal('holdExpired')]),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const run = await releaseHold(serviceDeps, { accountId }, {
        holdId: request.params.holdId,
        idempotencyKey: request.body.idempotencyKey,
      });
      if (run.outcome.kind === 'holdReleased' || run.outcome.kind === 'holdExpired') {
        return reply.status(200).send({ status: run.outcome.kind });
      }
      // alreadyReleased is idempotent-friendly at the customer boundary.
      if (run.outcome.kind === 'alreadyReleased') {
        return reply.status(200).send({ status: 'holdReleased' });
      }
      return failure(reply, run.outcome.kind === 'alreadyExpired' ? 'holdExpired' : run.outcome.kind);
    },
  );

  // -------------------------------------------------------------------------
  // Free/trial confirmation — §7.3 atomic create-and-confirm; D-10 inside
  // -------------------------------------------------------------------------

  app.post(
    '/customer/bookings/confirm-free',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          { holdId: Uuid, idempotencyKey: IdempotencyKey },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ booking: ConfirmedBookingSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const run = await confirmFreeBooking(serviceDeps, { accountId }, {
        holdId: request.body.holdId,
        idempotencyKey: request.body.idempotencyKey,
      });
      if (run.outcome.kind !== 'bookingConfirmed') return failure(reply, run.outcome.kind);
      return reply.status(201).send({ booking: run.outcome.booking });
    },
  );

  // -------------------------------------------------------------------------
  // Paid boundary — FAIL-CLOSED while W5 is absent (docs/32 §12 seam)
  // -------------------------------------------------------------------------

  app.post(
    '/customer/bookings/initiate',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          { holdId: Uuid, quoteId: Uuid, idempotencyKey: IdempotencyKey },
          { additionalProperties: false },
        ),
        // No 2xx success shape exists on this route today: the genuine W5
        // orchestration replaces this refusal with the real contract. There
        // is deliberately no flag to flip.
        response: { ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await paidCheckoutBoundary(serviceDeps, { accountId }, {
        holdId: request.body.holdId,
        quoteId: request.body.quoteId,
      });
      return failure(reply, result.kind);
    },
  );

  // -------------------------------------------------------------------------
  // Own-booking reads
  // -------------------------------------------------------------------------

  app.get(
    '/customer/bookings',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          cursor: Type.Optional(Uuid),
        }),
        response: {
          200: Type.Object({
            bookings: Type.Array(CustomerBookingSchema),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await listBookings(serviceDeps, { accountId }, request.query);
      return reply.status(200).send({ bookings: result.bookings, nextCursor: result.nextCursor });
    },
  );

  app.get(
    '/customer/bookings/:bookingId',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        params: Type.Object({ bookingId: Uuid }),
        response: { 200: Type.Object({ booking: CustomerBookingSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await getBooking(serviceDeps, { accountId }, {
        bookingId: request.params.bookingId,
      });
      if (result.kind !== 'booking') return failure(reply, result.kind);
      return reply.status(200).send({ booking: result.booking });
    },
  );
}
