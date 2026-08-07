/**
 * Customer-public search (docs/28 §16.1) — `GET /search`, the one search
 * route, depending exclusively on the SearchReadPort boundary (no SQL
 * here). Explicitly `public`; a privileged bearer changes nothing. The
 * typed query object mirrors the mock FilterSelection/SortId contracts for
 * exactly the dimensions the real domain supports today (docs/28 §11);
 * every other mock dimension (when/afterSchool/nearMe/offers/topRated/
 * rating/popularity sorts…) is REFUSED by the closed schema rather than
 * silently pretended — those filters stay reserved with their owning
 * slices. Results are listing-level: one row per Program, each carrying
 * its provider storefront identity.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import { sendOutcome } from '../../identity/http/http-outcomes';
import type {
  SearchFormat,
  SearchReadPort,
} from '../services/search-read-port';

const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const NullableStr = Type.Union([Type.String(), Type.Null()]);

const PublicTaxonomyRefSchema = Type.Object({
  id: Uuid,
  slug: Type.String(),
  labelEn: Type.String(),
  labelAr: NullableStr,
});

const PublicMediaSchema = Type.Object({
  mediaRef: Uuid,
  altTextEn: NullableStr,
  altTextAr: NullableStr,
});

const FromPriceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('free') }),
  Type.Object({
    kind: Type.Literal('from'),
    amountFils: Type.Integer(),
    currency: Type.Literal('AED'),
  }),
  Type.Null(),
]);

/** The public listing summary (identical to the storefront-listings row)
 *  plus the provider storefront identity every result navigates back to. */
const SearchResultSchema = Type.Object({
  id: Uuid,
  titleEn: Type.String(),
  titleAr: NullableStr,
  setting: Type.String(),
  minAge: Type.Union([Type.Integer(), Type.Null()]),
  maxAge: Type.Union([Type.Integer(), Type.Null()]),
  allAges: Type.Boolean(),
  genderEligibility: Type.String(),
  skillLevel: NullableStr,
  category: PublicTaxonomyRefSchema,
  activityType: PublicTaxonomyRefSchema,
  media: Type.Array(PublicMediaSchema),
  fromPrice: FromPriceSchema,
  offerBadges: Type.Array(Type.String()),
  provider: Type.Object({ id: Uuid, displayName: Type.String() }),
});

const FORMATS_PATTERN = '^(dropIn|monthly|term|package|camp)(,(dropIn|monthly|term|package|camp)){0,4}$';

/** Closed query contract — unknown/unsupported dimensions are 422s. */
const SearchQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 200 })),
    sort: Type.Optional(
      Type.Union([Type.Literal('recommended'), Type.Literal('price'), Type.Literal('newest')]),
    ),
    ladiesOnly: Type.Optional(Type.Boolean()),
    audience: Type.Optional(Type.Union([Type.Literal('adults'), Type.Literal('children')])),
    ageMin: Type.Optional(Type.Integer({ minimum: 0, maximum: 120 })),
    ageMax: Type.Optional(Type.Integer({ minimum: 0, maximum: 120 })),
    areaId: Type.Optional(Uuid),
    categoryId: Type.Optional(Uuid),
    activityTypeId: Type.Optional(Uuid),
    formats: Type.Optional(Type.String({ pattern: FORMATS_PATTERN })),
    setting: Type.Optional(Type.Union([Type.Literal('indoor'), Type.Literal('outdoor')])),
    priceBand: Type.Optional(
      Type.Union([
        Type.Literal('under-100'),
        Type.Literal('100-500'),
        Type.Literal('over-500'),
      ]),
    ),
    free: Type.Optional(Type.Boolean()),
    trial: Type.Optional(Type.Boolean()),
    skillLevel: Type.Optional(
      Type.Union([
        Type.Literal('beginner'),
        Type.Literal('intermediate'),
        Type.Literal('advanced'),
      ]),
    ),
    collectionId: Type.Optional(Uuid),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
  },
  { additionalProperties: false },
);

/** The closed query vocabulary. Fastify's Ajv strips unknown params rather
 *  than failing, so unsupported/future dimensions (when, offers, topRated,
 *  rating, nearMe, …) are refused EXPLICITLY — silently ignoring a filter
 *  would pretend support the domain does not have. */
const ALLOWED_PARAMS = new Set(Object.keys(SearchQuerySchema.properties));

export function registerSearchRoutes(
  instance: FastifyInstance,
  deps: { searchPort: SearchReadPort },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/search',
    {
      config: { authPolicy: 'public' },
      schema: {
        querystring: SearchQuerySchema,
        response: {
          200: Type.Object({
            results: Type.Array(SearchResultSchema),
            nextCursor: NullableStr,
          }),
          404: ErrorBody,
          422: ErrorBody,
          500: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const rawQuery = (request.raw.url ?? '').split('?')[1];
      if (rawQuery !== undefined && rawQuery.length > 0) {
        for (const pair of rawQuery.split('&')) {
          const key = decodeURIComponent(pair.split('=')[0] ?? '');
          if (key.length > 0 && !ALLOWED_PARAMS.has(key)) {
            return reply.status(422).send({
              code: 'validationError',
              message: `querystring parameter "${key}" is not supported`,
            });
          }
        }
      }
      const query = request.query;
      const outcome = await deps.searchPort.search({
        ...(query.q !== undefined ? { q: query.q } : {}),
        ...(query.sort !== undefined ? { sort: query.sort } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        filters: {
          ...(query.ladiesOnly !== undefined ? { ladiesOnly: query.ladiesOnly } : {}),
          ...(query.audience !== undefined ? { audience: query.audience } : {}),
          ...(query.ageMin !== undefined ? { ageMin: query.ageMin } : {}),
          ...(query.ageMax !== undefined ? { ageMax: query.ageMax } : {}),
          ...(query.areaId !== undefined ? { areaId: query.areaId } : {}),
          ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
          ...(query.activityTypeId !== undefined
            ? { activityTypeId: query.activityTypeId }
            : {}),
          ...(query.formats !== undefined
            ? { formats: query.formats.split(',') as SearchFormat[] }
            : {}),
          ...(query.setting !== undefined ? { setting: query.setting } : {}),
          ...(query.priceBand !== undefined ? { priceBand: query.priceBand } : {}),
          ...(query.free !== undefined ? { free: query.free } : {}),
          ...(query.trial !== undefined ? { trial: query.trial } : {}),
          ...(query.skillLevel !== undefined ? { skillLevel: query.skillLevel } : {}),
          ...(query.collectionId !== undefined ? { collectionId: query.collectionId } : {}),
        },
      });
      if (outcome.kind === 'invalidCursor') return sendOutcome(reply, 'invalidCursor');
      if (outcome.kind === 'collectionNotFound') return sendOutcome(reply, 'notFound');
      return reply
        .status(200)
        .send({ results: outcome.results, nextCursor: outcome.nextCursor });
    },
  );
}
