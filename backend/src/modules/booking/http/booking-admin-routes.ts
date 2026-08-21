/**
 * Internal Admin booking-oversight routes — S5-6 (docs/32 §13). READS ONLY:
 * the two bounded oversight reads on the `admin` BASELINE policy (the
 * final D-W3-5 read rule), role-gated to `operations` inside the service.
 * NO admin booking mutation exists in Slice 5 — the exhaustive D-W3-5
 * mutation-policy lock is untouched because there is nothing to classify;
 * any future admin booking mutation (e.g. AD-08 cancel/refund oversight)
 * must arrive as its own explicitly classified, owner-reviewed action.
 * Reading emits no events.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome } from '../../identity/http/http-outcomes';
import { UNIT_KINDS } from '../services/booking-shared';
import {
  ADMIN_BOOKING_STATES,
  getAdminBooking,
  listAdminBookings,
} from '../services/admin-booking-read';

const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const ADMIN_ERRORS = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  429: ErrorBody,
  500: ErrorBody,
  503: ErrorBody,
};
const NullableString = Type.Union([Type.String(), Type.Null()]);
const BookingStateLiteral = Type.Union(
  ADMIN_BOOKING_STATES.map((state) => Type.Literal(state)),
);

const AdminBookingRowSchema = Type.Object({
  bookingId: Uuid,
  referenceCode: NullableString,
  state: Type.String(),
  organization: Type.Object({ id: Uuid, displayName: Type.String() }),
  program: Type.Object({ id: Uuid, titleEn: Type.String() }),
  unit: Type.Object({
    kind: Type.Union(UNIT_KINDS.map((kind) => Type.Literal(kind))),
    unitId: Uuid,
    startAt: NullableString,
  }),
  participant: Type.Object({ id: Uuid, firstName: Type.String() }),
  accountId: Uuid,
  price: Type.Object({ totalFils: Type.Integer(), currency: Type.Literal('AED') }),
  createdAt: Type.String(),
  confirmedAt: NullableString,
});

const AdminBookingDetailSchema = Type.Composite([
  AdminBookingRowSchema,
  Type.Object({
    cancelledAt: NullableString,
    hold: Type.Object({
      holdId: Uuid,
      /** PHYSICAL persisted state (S5-2 transactional truth). */
      physicalState: Type.String(),
      /** Physically active but past TTL — unusable, awaiting settlement. */
      effectivelyExpired: Type.Boolean(),
      expiresAt: Type.String(),
    }),
    occupancy: Type.Object({
      capacity: Type.Integer(),
      /** PHYSICAL committed-booking counter. */
      bookedCount: Type.Integer(),
      /** PHYSICAL held counter — includes lapsed-but-unswept holds. */
      physicalHeldCount: Type.Integer(),
      /** EFFECTIVE held count — active AND unexpired holds only. */
      effectiveHeldCount: Type.Integer(),
    }),
  }),
]);

export interface BookingAdminRouteDeps {
  db: Db;
}

export function registerBookingAdminRoutes(
  rawApp: FastifyInstance,
  deps: BookingAdminRouteDeps,
): void {
  const app = rawApp.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };

  app.get(
    '/admin/bookings',
    {
      config: { authPolicy: 'admin' },
      schema: {
        querystring: Type.Object({
          reference: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
          organizationId: Type.Optional(Uuid),
          programId: Type.Optional(Uuid),
          accountId: Type.Optional(Uuid),
          state: Type.Optional(BookingStateLiteral),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          cursor: Type.Optional(Uuid),
        }),
        response: {
          200: Type.Object({
            bookings: Type.Array(AdminBookingRowSchema),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          ...ADMIN_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await listAdminBookings(
        serviceDeps,
        { userId: principal.userId },
        request.query,
      );
      if (result.kind !== 'bookings') return sendOutcome(reply, 'forbidden');
      return reply.status(200).send({ bookings: result.bookings, nextCursor: result.nextCursor });
    },
  );

  app.get(
    '/admin/bookings/:bookingId',
    {
      config: { authPolicy: 'admin' },
      schema: {
        params: Type.Object({ bookingId: Uuid }),
        response: { 200: Type.Object({ booking: AdminBookingDetailSchema }), ...ADMIN_ERRORS },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await getAdminBooking(serviceDeps, { userId: principal.userId }, {
        bookingId: request.params.bookingId,
      });
      if (result.kind === 'forbidden') return sendOutcome(reply, 'forbidden');
      if (result.kind !== 'booking') return sendOutcome(reply, 'notFound');
      return reply.status(200).send({ booking: result.booking });
    },
  );
}
