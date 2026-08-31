/**
 * Customer-PUBLIC availability read — the bounded D-RI-4 companion
 * (docs/34 §12.1): guests choosing an activity may see upcoming occurrence
 * date/time, branch identity, and the customer-safe availability band
 * before signing in, because browse-without-login is the binding default.
 *
 * Explicitly `public`: no authentication of any kind, and a privileged
 * bearer changes nothing. The response is EXACTLY the certified S5-5
 * availability projection (customer-booking-read.ts) — one effective-truth
 * calculation for both surfaces, never a second inconsistent one: derived
 * `available | fewLeft(spotsLeft) | full | closed` from capacity − booked −
 * ACTIVE UNEXPIRED holds (a lapsed-but-unswept hold can never present a
 * seat as taken), and no `held_count` / `booked_count` / capacity /
 * version / lock internals on the wire. Unpublished, moderation-private,
 * and nonexistent programs are the same not-found — knowing an ID reveals
 * nothing. Reads project effective truth only; capacity settlement stays
 * with the authoritative S5-2 boundaries.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { sendOutcome } from '../../identity/http/http-outcomes';
import { UNIT_KINDS } from '../services/booking-shared';
import { listAvailability } from '../services/customer-booking-read';

const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const NullableString = Type.Union([Type.String(), Type.Null()]);
const UnitKindLiteral = Type.Union(UNIT_KINDS.map((kind) => Type.Literal(kind)));

/** Byte-identical to the authenticated projection's row schema — the
 *  shared shape is the proof there is no privileged extra field. */
const PublicAvailabilityViewSchema = Type.Object({
  unitId: Uuid,
  kind: UnitKindLiteral,
  branchId: Uuid,
  startAt: NullableString,
  endAt: NullableString,
  startDate: NullableString,
  endDate: NullableString,
  effectiveStart: NullableString,
  effectiveEnd: NullableString,
  /** RI-6 — venue timezone (IANA) for truthful civil presentation. */
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

export function registerBookingPublicRoutes(
  instance: FastifyInstance,
  deps: { db: Db },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/listings/:programId/availability',
    {
      config: { authPolicy: 'public' },
      schema: {
        params: Type.Object({ programId: Uuid }),
        querystring: Type.Object({ kind: UnitKindLiteral }),
        response: {
          200: Type.Object({ units: Type.Array(PublicAvailabilityViewSchema) }),
          404: ErrorBody,
          422: ErrorBody,
          500: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const result = await listAvailability(
        { db: deps.db },
        { programId: request.params.programId, unitKind: request.query.kind },
      );
      if (result.kind !== 'availability') return sendOutcome(reply, 'notFound');
      return reply.status(200).send({ units: result.units });
    },
  );
}
