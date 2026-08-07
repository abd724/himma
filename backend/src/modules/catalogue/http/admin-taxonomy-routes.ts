/**
 * Internal taxonomy administration routes (docs/28 §16.3 `/admin/taxonomy/…`).
 *
 * Existing `admin` policy; the services require the `operations` role fresh
 * per transaction. Deliberate named services per entity — no generic table
 * CRUD abstraction, no raw models. Slug immutability is structural: no
 * PATCH schema carries a slug (undeclared fields are stripped app-wide),
 * and the 0007 trigger stays the final authority. Retirement is the
 * `active` flag / collection `state` — no delete route exists and the app
 * role holds no DELETE grant. English required, Arabic optional (D-S4-3).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import {
  createActivityType,
  createArea,
  createCategory,
  createCollection,
  getTaxonomyAdminView,
  updateActivityType,
  updateArea,
  updateCategory,
  updateCollection,
} from '../services/taxonomy-admin';

const TAXONOMY_BODY_LIMIT = 16_384;
const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const TAXONOMY_ERRORS = {
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

const Slug = Type.String({ pattern: '^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$' });
const LabelEn = Type.String({ minLength: 1, maxLength: 120 });
const NullableLabel = Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()]);
const NullableText = (maxLength: number) =>
  Type.Union([Type.String({ maxLength }), Type.Null()]);
const SortHint = Type.Integer({ minimum: 0, maximum: 100_000 });
const ExpectedVersion = Type.Integer({ minimum: 1 });
const Synonyms = Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20 });
const Audience = Type.Union([
  Type.Literal('all'),
  Type.Literal('adults'),
  Type.Literal('children'),
]);
const CollectionState = Type.Union([
  Type.Literal('draft'),
  Type.Literal('published'),
  Type.Literal('archived'),
]);

const AreaView = Type.Object({
  id: Uuid,
  slug: Type.String(),
  labelEn: Type.String(),
  labelAr: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  sortHint: Type.Integer(),
  active: Type.Boolean(),
  version: Type.Integer(),
});

const CategoryView = Type.Object({
  id: Uuid,
  slug: Type.String(),
  labelEn: Type.String(),
  labelAr: Type.Union([Type.String(), Type.Null()]),
  imageRef: Type.Union([Uuid, Type.Null()]),
  sortHint: Type.Integer(),
  active: Type.Boolean(),
  version: Type.Integer(),
});

const ActivityTypeView = Type.Object({
  id: Uuid,
  slug: Type.String(),
  categoryId: Uuid,
  labelEn: Type.String(),
  labelAr: Type.Union([Type.String(), Type.Null()]),
  synonymsEn: Type.Array(Type.String()),
  synonymsAr: Type.Array(Type.String()),
  active: Type.Boolean(),
  version: Type.Integer(),
});

const CollectionView = Type.Object({
  id: Uuid,
  titleEn: Type.String(),
  titleAr: Type.Union([Type.String(), Type.Null()]),
  subtitleEn: Type.Union([Type.String(), Type.Null()]),
  subtitleAr: Type.Union([Type.String(), Type.Null()]),
  imageRef: Type.Union([Uuid, Type.Null()]),
  presetLadiesOnly: Type.Boolean(),
  presetChildRelevant: Type.Boolean(),
  presetCamps: Type.Boolean(),
  presetOffers: Type.Boolean(),
  presetAvailableToday: Type.Boolean(),
  presetAfterSchool: Type.Boolean(),
  presetIndoor: Type.Boolean(),
  audience: Type.String(),
  childFocused: Type.Boolean(),
  featured: Type.Boolean(),
  seasonalLabel: Type.Union([Type.String(), Type.Null()]),
  state: Type.String(),
  version: Type.Integer(),
});

const CollectionBodyFields = {
  titleAr: Type.Optional(NullableLabel),
  subtitleEn: Type.Optional(NullableText(200)),
  subtitleAr: Type.Optional(NullableText(200)),
  imageRef: Type.Optional(Type.Union([Uuid, Type.Null()])),
  presetLadiesOnly: Type.Optional(Type.Boolean()),
  presetChildRelevant: Type.Optional(Type.Boolean()),
  presetCamps: Type.Optional(Type.Boolean()),
  presetOffers: Type.Optional(Type.Boolean()),
  presetAvailableToday: Type.Optional(Type.Boolean()),
  presetAfterSchool: Type.Optional(Type.Boolean()),
  presetIndoor: Type.Optional(Type.Boolean()),
  audience: Type.Optional(Audience),
  childFocused: Type.Optional(Type.Boolean()),
  featured: Type.Optional(Type.Boolean()),
  seasonalLabel: Type.Optional(NullableText(60)),
  state: Type.Optional(CollectionState),
};

function failure(reply: FastifyReply, kind: string): FastifyReply {
  const name: HttpOutcomeName =
    kind === 'areaNotFound' ||
    kind === 'categoryNotFound' ||
    kind === 'activityTypeNotFound' ||
    kind === 'collectionNotFound'
      ? 'notFound'
      : kind === 'forbidden'
        ? 'forbidden'
        : kind === 'staleVersion'
          ? 'staleVersion'
          : kind === 'slugConflict'
            ? 'slugConflict'
            : kind === 'invalidTaxonomy'
              ? 'invalidTaxonomy'
              : 'internalError';
  return sendOutcome(reply, name);
}

export interface TaxonomyRouteDeps {
  db: Db;
}

export function registerAdminTaxonomyRoutes(
  instance: FastifyInstance,
  deps: TaxonomyRouteDeps,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };

  // ---------------------------------------------------------------------
  // GET /admin/taxonomy — the full administration view (inactive included;
  // administration operates on the actual database rows, seed included).
  // ---------------------------------------------------------------------
  app.get(
    '/admin/taxonomy',
    {
      config: { authPolicy: 'admin' },
      schema: {
        response: {
          200: Type.Object({
            areas: Type.Array(AreaView),
            categories: Type.Array(CategoryView),
            activityTypes: Type.Array(ActivityTypeView),
            collections: Type.Array(CollectionView),
          }),
          ...TAXONOMY_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await getTaxonomyAdminView(serviceDeps, { userId: principal.userId });
      if (result.kind === 'view') return reply.status(200).send(result.view);
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Areas.
  // ---------------------------------------------------------------------
  app.post(
    '/admin/taxonomy/areas',
    {
      config: { authPolicy: 'admin' },
      bodyLimit: TAXONOMY_BODY_LIMIT,
      schema: {
        body: Type.Object(
          {
            slug: Slug,
            labelEn: LabelEn,
            labelAr: Type.Optional(NullableLabel),
            city: Type.Optional(NullableText(80)),
            sortHint: Type.Optional(SortHint),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ status: Type.Literal('areaCreated'), area: AreaView }),
          ...TAXONOMY_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await createArea(serviceDeps, { userId: principal.userId }, request.body);
      if (result.kind === 'areaCreated') {
        return reply.status(200).send({ status: 'areaCreated', area: result.area });
      }
      return failure(reply, result.kind);
    },
  );

  app.patch(
    '/admin/taxonomy/areas/:areaId',
    {
      config: { authPolicy: 'admin' },
      bodyLimit: TAXONOMY_BODY_LIMIT,
      schema: {
        params: Type.Object({ areaId: Uuid }),
        body: Type.Object(
          {
            expectedVersion: ExpectedVersion,
            labelEn: Type.Optional(LabelEn),
            labelAr: Type.Optional(NullableLabel),
            city: Type.Optional(NullableText(80)),
            sortHint: Type.Optional(SortHint),
            active: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ status: Type.Literal('areaUpdated'), area: AreaView }),
          ...TAXONOMY_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updateArea(serviceDeps, { userId: principal.userId }, {
        areaId: request.params.areaId,
        expectedVersion,
        patch,
      });
      if (result.kind === 'areaUpdated') {
        return reply.status(200).send({ status: 'areaUpdated', area: result.area });
      }
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Categories.
  // ---------------------------------------------------------------------
  app.post(
    '/admin/taxonomy/categories',
    {
      config: { authPolicy: 'admin' },
      bodyLimit: TAXONOMY_BODY_LIMIT,
      schema: {
        body: Type.Object(
          {
            slug: Slug,
            labelEn: LabelEn,
            labelAr: Type.Optional(NullableLabel),
            imageRef: Type.Optional(Type.Union([Uuid, Type.Null()])),
            sortHint: Type.Optional(SortHint),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ status: Type.Literal('categoryCreated'), category: CategoryView }),
          ...TAXONOMY_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await createCategory(serviceDeps, { userId: principal.userId }, request.body);
      if (result.kind === 'categoryCreated') {
        return reply.status(200).send({ status: 'categoryCreated', category: result.category });
      }
      return failure(reply, result.kind);
    },
  );

  app.patch(
    '/admin/taxonomy/categories/:categoryId',
    {
      config: { authPolicy: 'admin' },
      bodyLimit: TAXONOMY_BODY_LIMIT,
      schema: {
        params: Type.Object({ categoryId: Uuid }),
        body: Type.Object(
          {
            expectedVersion: ExpectedVersion,
            labelEn: Type.Optional(LabelEn),
            labelAr: Type.Optional(NullableLabel),
            imageRef: Type.Optional(Type.Union([Uuid, Type.Null()])),
            sortHint: Type.Optional(SortHint),
            active: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ status: Type.Literal('categoryUpdated'), category: CategoryView }),
          ...TAXONOMY_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updateCategory(serviceDeps, { userId: principal.userId }, {
        categoryId: request.params.categoryId,
        expectedVersion,
        patch,
      });
      if (result.kind === 'categoryUpdated') {
        return reply.status(200).send({ status: 'categoryUpdated', category: result.category });
      }
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Activity types (two levels only; re-parenting is not an operation).
  // ---------------------------------------------------------------------
  app.post(
    '/admin/taxonomy/activity-types',
    {
      config: { authPolicy: 'admin' },
      bodyLimit: TAXONOMY_BODY_LIMIT,
      schema: {
        body: Type.Object(
          {
            slug: Slug,
            categoryId: Uuid,
            labelEn: LabelEn,
            labelAr: Type.Optional(NullableLabel),
            synonymsEn: Type.Optional(Synonyms),
            synonymsAr: Type.Optional(Synonyms),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            status: Type.Literal('activityTypeCreated'),
            activityType: ActivityTypeView,
          }),
          ...TAXONOMY_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await createActivityType(
        serviceDeps,
        { userId: principal.userId },
        request.body,
      );
      if (result.kind === 'activityTypeCreated') {
        return reply
          .status(200)
          .send({ status: 'activityTypeCreated', activityType: result.activityType });
      }
      return failure(reply, result.kind);
    },
  );

  app.patch(
    '/admin/taxonomy/activity-types/:activityTypeId',
    {
      config: { authPolicy: 'admin' },
      bodyLimit: TAXONOMY_BODY_LIMIT,
      schema: {
        params: Type.Object({ activityTypeId: Uuid }),
        body: Type.Object(
          {
            expectedVersion: ExpectedVersion,
            labelEn: Type.Optional(LabelEn),
            labelAr: Type.Optional(NullableLabel),
            synonymsEn: Type.Optional(Synonyms),
            synonymsAr: Type.Optional(Synonyms),
            active: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            status: Type.Literal('activityTypeUpdated'),
            activityType: ActivityTypeView,
          }),
          ...TAXONOMY_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updateActivityType(serviceDeps, { userId: principal.userId }, {
        activityTypeId: request.params.activityTypeId,
        expectedVersion,
        patch,
      });
      if (result.kind === 'activityTypeUpdated') {
        return reply
          .status(200)
          .send({ status: 'activityTypeUpdated', activityType: result.activityType });
      }
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Collections (admin-curated editorial data; state per the 0007 CHECK).
  // ---------------------------------------------------------------------
  app.post(
    '/admin/taxonomy/collections',
    {
      config: { authPolicy: 'admin' },
      bodyLimit: TAXONOMY_BODY_LIMIT,
      schema: {
        body: Type.Object(
          { titleEn: LabelEn, ...CollectionBodyFields },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            status: Type.Literal('collectionCreated'),
            collection: CollectionView,
          }),
          ...TAXONOMY_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await createCollection(
        serviceDeps,
        { userId: principal.userId },
        request.body,
      );
      if (result.kind === 'collectionCreated') {
        return reply
          .status(200)
          .send({ status: 'collectionCreated', collection: result.collection });
      }
      return failure(reply, result.kind);
    },
  );

  app.patch(
    '/admin/taxonomy/collections/:collectionId',
    {
      config: { authPolicy: 'admin' },
      bodyLimit: TAXONOMY_BODY_LIMIT,
      schema: {
        params: Type.Object({ collectionId: Uuid }),
        body: Type.Object(
          {
            expectedVersion: ExpectedVersion,
            titleEn: Type.Optional(LabelEn),
            ...CollectionBodyFields,
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            status: Type.Literal('collectionUpdated'),
            collection: CollectionView,
          }),
          ...TAXONOMY_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updateCollection(serviceDeps, { userId: principal.userId }, {
        collectionId: request.params.collectionId,
        expectedVersion,
        patch,
      });
      if (result.kind === 'collectionUpdated') {
        return reply
          .status(200)
          .send({ status: 'collectionUpdated', collection: result.collection });
      }
      return failure(reply, result.kind);
    },
  );
}
