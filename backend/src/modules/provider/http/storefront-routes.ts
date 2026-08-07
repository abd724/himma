/**
 * Customer-public provider storefront read (docs/27 §13.1) — S3-4.
 *
 * Explicitly `public`: no provider membership, no customer login, no
 * authentication of any kind. The response is the dedicated §13.1
 * projection (storefront-read.ts) with an explicit TypeBox schema — never
 * a serialized Organization. Ineligible and nonexistent providers are the
 * same not-found; nothing reveals which visibility condition failed.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { sendOutcome } from '../../identity/http/http-outcomes';
import { readPublicStorefront } from '../services/storefront-read';

const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });

const PublicBranchSchema = Type.Object({
  id: Uuid,
  label: Type.String(),
  addressLine: Type.Union([Type.String(), Type.Null()]),
  areaLabel: Type.String(),
  geoPoint: Type.Union([
    Type.Object({
      longitude: Type.Number(),
      latitude: Type.Number(),
    }),
    Type.Null(),
  ]),
  openingHours: Type.Any(),
  facilities: Type.Array(Type.String()),
});

/** The complete public storefront contract — Slice 4 composes listings
 *  WITH this shape; absent fields stay absent (no fake placeholders). */
const PublicStorefrontSchema = Type.Object({
  provider: Type.Object({
    id: Uuid,
    displayName: Type.String(),
    descriptionEn: Type.Union([Type.String(), Type.Null()]),
    descriptionAr: Type.Union([Type.String(), Type.Null()]),
    verified: Type.Boolean(),
    logoMediaRef: Type.Union([Uuid, Type.Null()]),
    coverMediaRef: Type.Union([Uuid, Type.Null()]),
    galleryMediaRefs: Type.Array(Uuid),
    publicPhone: Type.Union([Type.String(), Type.Null()]),
    publicEmail: Type.Union([Type.String(), Type.Null()]),
    publicWebsite: Type.Union([Type.String(), Type.Null()]),
    publicInstagram: Type.Union([Type.String(), Type.Null()]),
    branches: Type.Array(PublicBranchSchema),
  }),
});

export function registerStorefrontRoutes(
  instance: FastifyInstance,
  deps: { db: Db },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/providers/:organizationId',
    {
      config: { authPolicy: 'public' },
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        response: {
          200: PublicStorefrontSchema,
          404: ErrorBody,
          422: ErrorBody,
          500: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const result = await readPublicStorefront(deps, request.params.organizationId);
      if (result.kind !== 'storefront') return sendOutcome(reply, 'notFound');
      return reply.status(200).send({ provider: result.storefront });
    },
  );
}
