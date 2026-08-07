/**
 * Customer-public catalogue reads (docs/28 §16.1/§19) — Slice 4 public
 * surface. Explicitly `public`: no customer login, no provider membership,
 * no authentication of any kind, and a privileged bearer changes NOTHING —
 * every response is the same customer-safe projection served from
 * public-catalogue-read.ts with explicit TypeBox schemas (never a
 * serialized database row). Ineligible and nonexistent listings and
 * storefronts are the same not-found; nothing reveals which visibility
 * condition failed.
 *
 * This surface is reads only. Search (`/search`, the search document,
 * ranking, suggestions) is deliberately ABSENT — it is the next owner-
 * approved commit, and no route here accepts free-text query input.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { sendOutcome } from '../../identity/http/http-outcomes';
import {
  listPublicActivityTypes,
  listPublicAreas,
  listPublicCategories,
  listPublicCollections,
  listStorefrontListings,
  readPublicListing,
} from '../services/public-catalogue-read';

const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const NullableStr = Type.Union([Type.String(), Type.Null()]);

const PublicTaxonomyRefSchema = Type.Object({
  id: Uuid,
  slug: Type.String(),
  labelEn: Type.String(),
  labelAr: NullableStr,
});

const PublicListingBranchSchema = Type.Object({
  id: Uuid,
  label: Type.String(),
  addressLine: NullableStr,
  areaLabel: Type.String(),
  geoPoint: Type.Union([
    Type.Object({ longitude: Type.Number(), latitude: Type.Number() }),
    Type.Null(),
  ]),
  openingHours: Type.Any(),
  facilities: Type.Array(Type.String()),
});

const PublicMediaSchema = Type.Object({
  mediaRef: Uuid,
  altTextEn: NullableStr,
  altTextAr: NullableStr,
});

/** §14(c): stable-id option summaries under ONE listing — the future
 *  booking draft selects an option by id, never by position. */
const PublicPriceOptionSchema = Type.Object({
  id: Uuid,
  kind: Type.String(),
  amountFils: Type.Union([Type.Integer(), Type.Null()]),
  currency: Type.String(),
  sessionsCount: Type.Union([Type.Integer(), Type.Null()]),
  labelEn: NullableStr,
  labelAr: NullableStr,
});

const PublicOfferSchema = Type.Object({
  id: Uuid,
  kind: Type.String(),
  labelEn: Type.String(),
  labelAr: NullableStr,
  trialAmountFils: Type.Union([Type.Integer(), Type.Null()]),
  currency: Type.String(),
});

/** §14(a): derived at read time, never stored — `Free` when a free option
 *  exists, otherwise the minimum over the ACTIVE options. */
const FromPriceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('free') }),
  Type.Object({
    kind: Type.Literal('from'),
    amountFils: Type.Integer(),
    currency: Type.Literal('AED'),
  }),
  Type.Null(),
]);

const EligibilityFields = {
  minAge: Type.Union([Type.Integer(), Type.Null()]),
  maxAge: Type.Union([Type.Integer(), Type.Null()]),
  allAges: Type.Boolean(),
  genderEligibility: Type.String(),
  skillLevel: NullableStr,
};

const PublicListingDetailSchema = Type.Object({
  id: Uuid,
  titleEn: Type.String(),
  titleAr: NullableStr,
  descriptionEn: NullableStr,
  descriptionAr: NullableStr,
  setting: Type.String(),
  ...EligibilityFields,
  eligibilityNotes: NullableStr,
  category: PublicTaxonomyRefSchema,
  activityType: PublicTaxonomyRefSchema,
  provider: Type.Object({ id: Uuid, displayName: Type.String() }),
  branches: Type.Array(PublicListingBranchSchema),
  media: Type.Array(PublicMediaSchema),
  priceOptions: Type.Array(PublicPriceOptionSchema),
  offers: Type.Array(PublicOfferSchema),
  fromPrice: FromPriceSchema,
});

const PublicListingSummarySchema = Type.Object({
  id: Uuid,
  titleEn: Type.String(),
  titleAr: NullableStr,
  setting: Type.String(),
  ...EligibilityFields,
  category: PublicTaxonomyRefSchema,
  activityType: PublicTaxonomyRefSchema,
  media: Type.Array(PublicMediaSchema),
  fromPrice: FromPriceSchema,
  offerBadges: Type.Array(Type.String()),
});

const StorefrontListingsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  /** Opaque cursor from a previous page — never a raw row id. */
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

const PUBLIC_ERRORS = { 404: ErrorBody, 422: ErrorBody, 500: ErrorBody };

export function registerPublicCatalogueRoutes(
  instance: FastifyInstance,
  deps: { db: Db },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  // Public listing detail (docs/28 §16.1): published-and-eligible
  // projection; everything else is not-found-shaped, byte-identical.
  app.get(
    '/listings/:programId',
    {
      config: { authPolicy: 'public' },
      schema: {
        params: Type.Object({ programId: Uuid }),
        response: { 200: Type.Object({ listing: PublicListingDetailSchema }), ...PUBLIC_ERRORS },
      },
    },
    async (request, reply) => {
      const result = await readPublicListing(deps, request.params.programId);
      if (result.kind !== 'listing') return sendOutcome(reply, 'notFound');
      return reply.status(200).send({ listing: result.listing });
    },
  );

  // Published listings of one public storefront (docs/28 §19): a dedicated
  // paginated endpoint — the approved S3-4 storefront payload is untouched.
  app.get(
    '/providers/:organizationId/listings',
    {
      config: { authPolicy: 'public' },
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        querystring: StorefrontListingsQuery,
        response: {
          200: Type.Object({
            provider: Type.Object({ id: Uuid, displayName: Type.String() }),
            listings: Type.Array(PublicListingSummarySchema),
            nextCursor: NullableStr,
          }),
          ...PUBLIC_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const result = await listStorefrontListings(deps, {
        organizationId: request.params.organizationId,
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
        ...(request.query.cursor !== undefined ? { cursor: request.query.cursor } : {}),
      });
      if (result.kind === 'invalidCursor') return sendOutcome(reply, 'invalidCursor');
      if (result.kind !== 'listings') return sendOutcome(reply, 'notFound');
      return reply.status(200).send({
        provider: result.provider,
        listings: result.listings,
        nextCursor: result.nextCursor,
      });
    },
  );

  // Public taxonomy reads (docs/28 §16.1; D-S4-3): active canonical rows in
  // deterministic order; Arabic optional; no admin/version metadata.
  app.get(
    '/catalogue/categories',
    {
      config: { authPolicy: 'public' },
      schema: {
        response: {
          200: Type.Object({
            categories: Type.Array(
              Type.Object({
                id: Uuid,
                slug: Type.String(),
                labelEn: Type.String(),
                labelAr: NullableStr,
                imageRef: Type.Union([Uuid, Type.Null()]),
              }),
            ),
          }),
          ...PUBLIC_ERRORS,
        },
      },
    },
    async (_request, reply) =>
      reply.status(200).send({ categories: await listPublicCategories(deps) }),
  );

  app.get(
    '/catalogue/activity-types',
    {
      config: { authPolicy: 'public' },
      schema: {
        response: {
          200: Type.Object({
            activityTypes: Type.Array(
              Type.Object({
                id: Uuid,
                slug: Type.String(),
                labelEn: Type.String(),
                labelAr: NullableStr,
                categoryId: Uuid,
              }),
            ),
          }),
          ...PUBLIC_ERRORS,
        },
      },
    },
    async (_request, reply) =>
      reply.status(200).send({ activityTypes: await listPublicActivityTypes(deps) }),
  );

  app.get(
    '/catalogue/collections',
    {
      config: { authPolicy: 'public' },
      schema: {
        response: {
          200: Type.Object({
            collections: Type.Array(
              Type.Object({
                id: Uuid,
                titleEn: Type.String(),
                titleAr: NullableStr,
                subtitleEn: NullableStr,
                subtitleAr: NullableStr,
                imageRef: Type.Union([Uuid, Type.Null()]),
                audience: Type.String(),
                childFocused: Type.Boolean(),
                featured: Type.Boolean(),
                seasonalLabel: NullableStr,
              }),
            ),
          }),
          ...PUBLIC_ERRORS,
        },
      },
    },
    async (_request, reply) =>
      reply.status(200).send({ collections: await listPublicCollections(deps) }),
  );

  app.get(
    '/catalogue/areas',
    {
      config: { authPolicy: 'public' },
      schema: {
        response: {
          200: Type.Object({
            areas: Type.Array(
              Type.Object({
                id: Uuid,
                slug: Type.String(),
                labelEn: Type.String(),
                labelAr: NullableStr,
                city: NullableStr,
              }),
            ),
          }),
          ...PUBLIC_ERRORS,
        },
      },
    },
    async (_request, reply) => reply.status(200).send({ areas: await listPublicAreas(deps) }),
  );
}
