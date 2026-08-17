/**
 * Provider-private catalogue management routes (S4-2; docs/28 §16.2).
 *
 * Exactly the approved provider catalogue inventory — no customer-public
 * listing/search route, no admin/moderation route, and no revision-decision
 * route exists here. Every route declares the `provider` policy plus its
 * ACTIVE catalogue capability (docs/28 §16.2: ordinary catalogue editing is
 * NOT in the D-S3-5 step-up set, so no route uses `providerStepUp`; the MFA
 * baseline still applies to all of them). Lifecycle-sensitive actions are
 * separate NAMED operations — no endpoint accepts a target listing state
 * (PATCH bodies are additionalProperties:false, so a smuggled
 * `listingState` is rejected outright, never silently ignored).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requireOrgScope, requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import {
  addProgramBranch,
  archiveProgram,
  createProgram,
  getProviderProgram,
  listProviderPrograms,
  pauseProgram,
  publishProgram,
  removeProgramBranch,
  submitProgram,
  updateProgram,
  type CompletenessGap,
} from '../services/program-management';
import {
  addPriceOption,
  archivePriceOption,
  updatePriceOption,
  PRICE_OPTION_KINDS,
} from '../services/price-option-management';
import {
  addOffer,
  addProgramMedia,
  archiveProgramMedia,
  endOffer,
  updateOffer,
  updateProgramMedia,
  OFFER_KINDS,
} from '../services/media-offer-management';

const CATALOGUE_BODY_LIMIT = 32_768;
const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
/** 409 bodies may carry the structured completeness gaps (docs/28 §4). */
const ConflictBody = Type.Object({
  code: Type.String(),
  message: Type.String(),
  missing: Type.Optional(Type.Array(Type.String())),
});
const CATALOGUE_ERRORS = {
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

const NullableString = (maxLength: number) =>
  Type.Union([Type.String({ maxLength }), Type.Null()]);
const NullableInt = Type.Union([Type.Integer({ minimum: 0, maximum: 130 }), Type.Null()]);
const ExpectedVersion = Type.Integer({ minimum: 1 });

const SettingLiteral = Type.Union([Type.Literal('indoor'), Type.Literal('outdoor')]);
const GenderLiteral = Type.Union([
  Type.Literal('women'),
  Type.Literal('men'),
  Type.Literal('girls'),
  Type.Literal('boys'),
  Type.Literal('mixed'),
]);
const SkillLiteral = Type.Union([
  Type.Literal('beginner'),
  Type.Literal('intermediate'),
  Type.Literal('advanced'),
  Type.Literal('all-levels'),
]);
const OptionKindLiteral = Type.Union(PRICE_OPTION_KINDS.map((kind) => Type.Literal(kind)));
const OfferKindLiteral = Type.Union(OFFER_KINDS.map((kind) => Type.Literal(kind)));

const PriceOptionView = Type.Object({
  id: Uuid,
  kind: Type.String(),
  amountFils: Type.Union([Type.Integer(), Type.Null()]),
  currency: Type.String(),
  sessionsCount: Type.Union([Type.Integer(), Type.Null()]),
  labelEn: Type.Union([Type.String(), Type.Null()]),
  labelAr: Type.Union([Type.String(), Type.Null()]),
  sortHint: Type.Integer(),
  state: Type.String(),
  version: Type.Integer(),
});

const MediaView = Type.Object({
  id: Uuid,
  mediaRef: Uuid,
  sortHint: Type.Integer(),
  altTextEn: Type.Union([Type.String(), Type.Null()]),
  altTextAr: Type.Union([Type.String(), Type.Null()]),
  active: Type.Boolean(),
  version: Type.Integer(),
});

const OfferView = Type.Object({
  id: Uuid,
  kind: Type.String(),
  labelEn: Type.String(),
  labelAr: Type.Union([Type.String(), Type.Null()]),
  trialAmountFils: Type.Union([Type.Integer(), Type.Null()]),
  effectiveStart: Type.Union([Type.String(), Type.Null()]),
  effectiveEnd: Type.Union([Type.String(), Type.Null()]),
  state: Type.String(),
  version: Type.Integer(),
});

/** Shared with the internal-admin moderation projection (same explicit
 *  contract — no Type.Any surfaces anywhere on the catalogue). */
export const ProgramDetailViewSchema = Type.Object({
  id: Uuid,
  organizationId: Uuid,
  activityType: Type.Object({
    id: Uuid,
    slug: Type.String(),
    labelEn: Type.String(),
    active: Type.Boolean(),
    categoryId: Uuid,
  }),
  titleEn: Type.String(),
  titleAr: Type.Union([Type.String(), Type.Null()]),
  descriptionEn: Type.Union([Type.String(), Type.Null()]),
  descriptionAr: Type.Union([Type.String(), Type.Null()]),
  setting: Type.String(),
  minAge: Type.Union([Type.Integer(), Type.Null()]),
  maxAge: Type.Union([Type.Integer(), Type.Null()]),
  allAges: Type.Boolean(),
  genderEligibility: Type.String(),
  skillLevel: Type.Union([Type.String(), Type.Null()]),
  eligibilityNotes: Type.Union([Type.String(), Type.Null()]),
  listingState: Type.String(),
  publishedAt: Type.Union([Type.String(), Type.Null()]),
  archivedAt: Type.Union([Type.String(), Type.Null()]),
  sensitiveFieldsVersion: Type.Integer(),
  version: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  priceOptions: Type.Array(PriceOptionView),
  branches: Type.Array(
    Type.Object({
      branchId: Uuid,
      label: Type.String(),
      branchActive: Type.Boolean(),
      associationActive: Type.Boolean(),
      version: Type.Integer(),
    }),
  ),
  media: Type.Array(MediaView),
  offers: Type.Array(OfferView),
  openRevision: Type.Union([
    Type.Object({
      id: Uuid,
      state: Type.String(),
      createdAt: Type.String(),
      version: Type.Integer(),
    }),
    Type.Null(),
  ]),
});

const RevisionSubmittedBody = Type.Object({
  status: Type.Literal('revisionSubmitted'),
  revisionId: Uuid,
  appliedFields: Type.Array(Type.String()),
  deferredFields: Type.Array(Type.String()),
});

const EligibilityBodyFields = {
  minAge: Type.Optional(NullableInt),
  maxAge: Type.Optional(NullableInt),
  allAges: Type.Optional(Type.Boolean()),
  skillLevel: Type.Optional(Type.Union([SkillLiteral, Type.Null()])),
  eligibilityNotes: Type.Optional(NullableString(1_000)),
};

const PriceOptionBodyFields = {
  amountFils: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  sessionsCount: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  labelEn: Type.Optional(NullableString(120)),
  labelAr: Type.Optional(NullableString(120)),
  sortHint: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
};

export interface CatalogueRouteDeps {
  db: Db;
}

export function registerCatalogueRoutes(
  instance: FastifyInstance,
  deps: CatalogueRouteDeps,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };
  const BASE = '/provider/organizations/:organizationId/listings';

  /** Maps shared failure kinds to the typed HTTP vocabulary; success kinds
   *  are handled per route. Constraint/trigger names never leak here. */
  function failure(reply: FastifyReply, kind: string): FastifyReply {
    const name: HttpOutcomeName =
      kind === 'programNotFound' ||
      kind === 'optionNotFound' ||
      kind === 'mediaNotFound' ||
      kind === 'offerNotFound' ||
      kind === 'associationNotFound'
        ? 'notFound'
        : kind === 'forbidden'
          ? 'forbidden'
          : kind === 'lifecycleConflict'
            ? 'lifecycleConflict'
            : kind === 'staleVersion'
              ? 'staleVersion'
              : kind === 'organizationNotLive'
                ? 'organizationNotLive'
                : kind === 'revisionPending'
                  ? 'revisionPending'
                  : kind === 'invalidTaxonomy'
                    ? 'invalidTaxonomy'
                    : kind === 'invalidEligibility'
                      ? 'invalidEligibility'
                      : kind === 'invalidPriceOption'
                        ? 'invalidPriceOption'
                        : kind === 'invalidOffer'
                          ? 'invalidOffer'
                          : kind === 'invalidBranch'
                            ? 'invalidBranchScope'
                            : 'internalError';
    return sendOutcome(reply, name);
  }

  function incomplete(reply: FastifyReply, missing: CompletenessGap[]): FastifyReply {
    return reply.status(409).send({
      code: 'programIncomplete',
      message: 'The listing is not ready: complete the missing catalogue requirements.',
      missing,
    });
  }

  // ---------------------------------------------------------------------
  // Listing collection: list + create.
  // ---------------------------------------------------------------------
  app.get(
    BASE,
    {
      config: { authPolicy: 'provider', providerCapability: 'catalogue.read' },
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          cursor: Type.Optional(Uuid),
        }),
        response: {
          200: Type.Object({
            programs: Type.Array(
              // W2-12C1 list-card projection: one bounded management-row
              // summary (activity display · derived D-S4-1 price summary ·
              // branch summary · thumbnail METADATA — never a fabricated
              // URL) so the provider index needs no per-row detail reads.
              Type.Object({
                id: Uuid,
                titleEn: Type.String(),
                listingState: Type.String(),
                activityType: Type.Object({
                  id: Uuid,
                  labelEn: Type.String(),
                  active: Type.Boolean(),
                }),
                version: Type.Integer(),
                createdAt: Type.String(),
                updatedAt: Type.String(),
                priceSummary: Type.Union([
                  Type.Object({ kind: Type.Literal('free') }),
                  Type.Object({
                    kind: Type.Literal('from'),
                    amountFils: Type.Integer(),
                    currency: Type.Literal('AED'),
                  }),
                  Type.Object({ kind: Type.Literal('none') }),
                ]),
                branchSummary: Type.Object({
                  firstLabel: Type.Union([Type.String(), Type.Null()]),
                  activeCount: Type.Integer(),
                }),
                thumbnail: Type.Union([
                  Type.Object({
                    mediaRef: Uuid,
                    altTextEn: Type.Union([Type.String(), Type.Null()]),
                  }),
                  Type.Null(),
                ]),
              }),
            ),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request) => {
      const scope = requireOrgScope(request.principal);
      return listProviderPrograms(serviceDeps, scope, request.query);
    },
  );

  app.post(
    BASE,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        body: Type.Object(
          {
            titleEn: Type.String({ minLength: 1, maxLength: 160 }),
            titleAr: Type.Optional(NullableString(160)),
            descriptionEn: Type.Optional(NullableString(4_000)),
            descriptionAr: Type.Optional(NullableString(4_000)),
            activityTypeId: Uuid,
            setting: SettingLiteral,
            genderEligibility: GenderLiteral,
            ...EligibilityBodyFields,
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            status: Type.Literal('programCreated'),
            program: Type.Object({
              id: Uuid,
              listingState: Type.String(),
              version: Type.Integer(),
            }),
          }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await createProgram(serviceDeps, scope, { userId: principal.userId }, request.body);
      if (result.kind === 'programCreated') {
        return reply.status(200).send({ status: 'programCreated', program: result.program });
      }
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Listing detail + CAS edit (sensitive fields auto-route to a revision).
  // ---------------------------------------------------------------------
  app.get(
    `${BASE}/:programId`,
    {
      config: { authPolicy: 'provider', providerCapability: 'catalogue.read' },
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        response: {
          200: Type.Object({ program: ProgramDetailViewSchema }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const result = await getProviderProgram(serviceDeps, scope, {
        programId: request.params.programId,
      });
      if (result.kind === 'programView') {
        return reply.status(200).send({ program: result.program });
      }
      return failure(reply, result.kind);
    },
  );

  app.patch(
    `${BASE}/:programId`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        body: Type.Object(
          {
            expectedVersion: ExpectedVersion,
            titleEn: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
            titleAr: Type.Optional(NullableString(160)),
            descriptionEn: Type.Optional(NullableString(4_000)),
            descriptionAr: Type.Optional(NullableString(4_000)),
            activityTypeId: Type.Optional(Uuid),
            setting: Type.Optional(SettingLiteral),
            genderEligibility: Type.Optional(GenderLiteral),
            ...EligibilityBodyFields,
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Union([
            Type.Object({ status: Type.Literal('programUpdated'), version: Type.Integer() }),
            RevisionSubmittedBody,
          ]),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updateProgram(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { programId: request.params.programId, expectedVersion, patch },
      );
      if (result.kind === 'programUpdated') {
        return reply.status(200).send({ status: 'programUpdated', version: result.version });
      }
      if (result.kind === 'revisionSubmitted') {
        return reply.status(200).send({
          status: 'revisionSubmitted',
          revisionId: result.revisionId,
          appliedFields: result.appliedFields,
          deferredFields: result.deferredFields,
        });
      }
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Named lifecycle actions (D-S4-2: publication is never a state patch).
  // ---------------------------------------------------------------------
  app.post(
    `${BASE}/:programId/submit`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        body: Type.Object({ expectedVersion: ExpectedVersion }, { additionalProperties: false }),
        response: {
          200: Type.Object({
            status: Type.Literal('programSubmitted'),
            version: Type.Integer(),
          }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await submitProgram(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { programId: request.params.programId, expectedVersion: request.body.expectedVersion },
      );
      if (result.kind === 'programSubmitted') {
        return reply.status(200).send({ status: 'programSubmitted', version: result.version });
      }
      if (result.kind === 'programIncomplete') return incomplete(reply, result.missing);
      return failure(reply, result.kind);
    },
  );

  app.post(
    `${BASE}/:programId/publish`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.publish' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        body: Type.Object({ expectedVersion: ExpectedVersion }, { additionalProperties: false }),
        response: {
          200: Type.Object({
            status: Type.Literal('programPublished'),
            version: Type.Integer(),
          }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await publishProgram(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { programId: request.params.programId, expectedVersion: request.body.expectedVersion },
      );
      if (result.kind === 'programPublished') {
        return reply.status(200).send({ status: 'programPublished', version: result.version });
      }
      if (result.kind === 'programIncomplete') return incomplete(reply, result.missing);
      return failure(reply, result.kind);
    },
  );

  app.post(
    `${BASE}/:programId/pause`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.publish' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        body: Type.Object({ expectedVersion: ExpectedVersion }, { additionalProperties: false }),
        response: {
          200: Type.Object({ status: Type.Literal('programPaused'), version: Type.Integer() }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await pauseProgram(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { programId: request.params.programId, expectedVersion: request.body.expectedVersion },
      );
      if (result.kind === 'programPaused') {
        return reply.status(200).send({ status: 'programPaused', version: result.version });
      }
      return failure(reply, result.kind);
    },
  );

  app.post(
    `${BASE}/:programId/archive`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.publish' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        body: Type.Object({ expectedVersion: ExpectedVersion }, { additionalProperties: false }),
        response: {
          200: Type.Object({ status: Type.Literal('programArchived') }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await archiveProgram(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { programId: request.params.programId, expectedVersion: request.body.expectedVersion },
      );
      if (result.kind === 'programArchived') {
        return reply.status(200).send({ status: 'programArchived' });
      }
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Branch associations (composite spine; docs/28 §4).
  // ---------------------------------------------------------------------
  app.post(
    `${BASE}/:programId/branches`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        body: Type.Object({ branchId: Uuid }, { additionalProperties: false }),
        response: {
          200: Type.Object({ status: Type.Literal('branchAssociated') }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await addProgramBranch(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { programId: request.params.programId, branchId: request.body.branchId },
      );
      if (result.kind === 'branchAssociated') {
        return reply.status(200).send({ status: 'branchAssociated' });
      }
      return failure(reply, result.kind);
    },
  );

  app.post(
    `${BASE}/:programId/branches/:branchId/remove`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid, branchId: Uuid }),
        response: {
          200: Type.Object({ status: Type.Literal('branchAssociationRemoved') }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await removeProgramBranch(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { programId: request.params.programId, branchId: request.params.branchId },
      );
      if (result.kind === 'branchAssociationRemoved') {
        return reply.status(200).send({ status: 'branchAssociationRemoved' });
      }
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Price options (D-S4-1; sensitive on review-gated listings).
  // ---------------------------------------------------------------------
  app.post(
    `${BASE}/:programId/price-options`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        body: Type.Object(
          { kind: OptionKindLiteral, ...PriceOptionBodyFields },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Union([
            Type.Object({ status: Type.Literal('optionAdded'), option: PriceOptionView }),
            Type.Object({ status: Type.Literal('revisionSubmitted'), revisionId: Uuid }),
          ]),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await addPriceOption(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { programId: request.params.programId, option: request.body },
      );
      if (result.kind === 'optionAdded') {
        return reply.status(200).send({ status: 'optionAdded', option: result.option });
      }
      if (result.kind === 'revisionSubmitted') {
        return reply
          .status(200)
          .send({ status: 'revisionSubmitted', revisionId: result.revisionId });
      }
      return failure(reply, result.kind);
    },
  );

  app.patch(
    `${BASE}/:programId/price-options/:optionId`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid, optionId: Uuid }),
        body: Type.Object(
          {
            expectedVersion: ExpectedVersion,
            kind: Type.Optional(OptionKindLiteral),
            ...PriceOptionBodyFields,
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Union([
            Type.Object({ status: Type.Literal('optionUpdated'), option: PriceOptionView }),
            Type.Object({ status: Type.Literal('revisionSubmitted'), revisionId: Uuid }),
          ]),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updatePriceOption(
        serviceDeps,
        scope,
        { userId: principal.userId },
        {
          programId: request.params.programId,
          optionId: request.params.optionId,
          expectedVersion,
          patch,
        },
      );
      if (result.kind === 'optionUpdated') {
        return reply.status(200).send({ status: 'optionUpdated', option: result.option });
      }
      if (result.kind === 'revisionSubmitted') {
        return reply
          .status(200)
          .send({ status: 'revisionSubmitted', revisionId: result.revisionId });
      }
      return failure(reply, result.kind);
    },
  );

  app.post(
    `${BASE}/:programId/price-options/:optionId/archive`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid, optionId: Uuid }),
        body: Type.Object({ expectedVersion: ExpectedVersion }, { additionalProperties: false }),
        response: {
          200: Type.Union([
            Type.Object({ status: Type.Literal('optionArchived') }),
            Type.Object({ status: Type.Literal('revisionSubmitted'), revisionId: Uuid }),
          ]),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await archivePriceOption(
        serviceDeps,
        scope,
        { userId: principal.userId },
        {
          programId: request.params.programId,
          optionId: request.params.optionId,
          expectedVersion: request.body.expectedVersion,
        },
      );
      if (result.kind === 'optionArchived') {
        return reply.status(200).send({ status: 'optionArchived' });
      }
      if (result.kind === 'revisionSubmitted') {
        return reply
          .status(200)
          .send({ status: 'revisionSubmitted', revisionId: result.revisionId });
      }
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Media references (metadata only; docs/28 §14).
  // ---------------------------------------------------------------------
  app.post(
    `${BASE}/:programId/media`,
    {
      config: { authPolicy: 'provider', providerCapability: 'media.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        body: Type.Object(
          {
            mediaRef: Uuid,
            sortHint: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
            altTextEn: Type.Optional(NullableString(300)),
            altTextAr: Type.Optional(NullableString(300)),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ status: Type.Literal('mediaAdded'), media: MediaView }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await addProgramMedia(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { programId: request.params.programId, ...request.body },
      );
      if (result.kind === 'mediaAdded') {
        return reply.status(200).send({ status: 'mediaAdded', media: result.media });
      }
      return failure(reply, result.kind);
    },
  );

  app.patch(
    `${BASE}/:programId/media/:mediaId`,
    {
      config: { authPolicy: 'provider', providerCapability: 'media.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid, mediaId: Uuid }),
        body: Type.Object(
          {
            expectedVersion: ExpectedVersion,
            sortHint: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
            altTextEn: Type.Optional(NullableString(300)),
            altTextAr: Type.Optional(NullableString(300)),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ status: Type.Literal('mediaUpdated'), media: MediaView }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updateProgramMedia(
        serviceDeps,
        scope,
        { userId: principal.userId },
        {
          programId: request.params.programId,
          mediaId: request.params.mediaId,
          expectedVersion,
          patch,
        },
      );
      if (result.kind === 'mediaUpdated') {
        return reply.status(200).send({ status: 'mediaUpdated', media: result.media });
      }
      return failure(reply, result.kind);
    },
  );

  app.post(
    `${BASE}/:programId/media/:mediaId/archive`,
    {
      config: { authPolicy: 'provider', providerCapability: 'media.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid, mediaId: Uuid }),
        body: Type.Object({ expectedVersion: ExpectedVersion }, { additionalProperties: false }),
        response: {
          200: Type.Object({ status: Type.Literal('mediaArchived') }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await archiveProgramMedia(
        serviceDeps,
        scope,
        { userId: principal.userId },
        {
          programId: request.params.programId,
          mediaId: request.params.mediaId,
          expectedVersion: request.body.expectedVersion,
        },
      );
      if (result.kind === 'mediaArchived') {
        return reply.status(200).send({ status: 'mediaArchived' });
      }
      return failure(reply, result.kind);
    },
  );

  // ---------------------------------------------------------------------
  // Offers (structured, informational; Offer ≠ ProgramPriceOption).
  // ---------------------------------------------------------------------
  app.post(
    `${BASE}/:programId/offers`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid }),
        body: Type.Object(
          {
            kind: OfferKindLiteral,
            labelEn: Type.String({ minLength: 1, maxLength: 160 }),
            labelAr: Type.Optional(NullableString(160)),
            trialAmountFils: Type.Optional(
              Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
            ),
            effectiveStart: Type.Optional(
              Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
            ),
            effectiveEnd: Type.Optional(
              Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
            ),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ status: Type.Literal('offerAdded'), offer: OfferView }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const body = request.body;
      const result = await addOffer(
        serviceDeps,
        scope,
        { userId: principal.userId },
        {
          programId: request.params.programId,
          offer: {
            kind: body.kind,
            labelEn: body.labelEn,
            ...(body.labelAr !== undefined ? { labelAr: body.labelAr } : {}),
            ...(body.trialAmountFils !== undefined
              ? { trialAmountFils: body.trialAmountFils }
              : {}),
            ...(body.effectiveStart !== undefined
              ? {
                  effectiveStart:
                    body.effectiveStart === null ? null : new Date(body.effectiveStart),
                }
              : {}),
            ...(body.effectiveEnd !== undefined
              ? { effectiveEnd: body.effectiveEnd === null ? null : new Date(body.effectiveEnd) }
              : {}),
          },
        },
      );
      if (result.kind === 'offerAdded') {
        return reply.status(200).send({ status: 'offerAdded', offer: result.offer });
      }
      return failure(reply, result.kind);
    },
  );

  app.patch(
    `${BASE}/:programId/offers/:offerId`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid, offerId: Uuid }),
        body: Type.Object(
          {
            expectedVersion: ExpectedVersion,
            labelEn: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
            labelAr: Type.Optional(NullableString(160)),
            trialAmountFils: Type.Optional(
              Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
            ),
            effectiveStart: Type.Optional(
              Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
            ),
            effectiveEnd: Type.Optional(
              Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
            ),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ status: Type.Literal('offerUpdated'), offer: OfferView }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...body } = request.body;
      const result = await updateOffer(
        serviceDeps,
        scope,
        { userId: principal.userId },
        {
          programId: request.params.programId,
          offerId: request.params.offerId,
          expectedVersion,
          patch: {
            ...(body.labelEn !== undefined ? { labelEn: body.labelEn } : {}),
            ...(body.labelAr !== undefined ? { labelAr: body.labelAr } : {}),
            ...(body.trialAmountFils !== undefined
              ? { trialAmountFils: body.trialAmountFils }
              : {}),
            ...(body.effectiveStart !== undefined
              ? {
                  effectiveStart:
                    body.effectiveStart === null ? null : new Date(body.effectiveStart),
                }
              : {}),
            ...(body.effectiveEnd !== undefined
              ? { effectiveEnd: body.effectiveEnd === null ? null : new Date(body.effectiveEnd) }
              : {}),
          },
        },
      );
      if (result.kind === 'offerUpdated') {
        return reply.status(200).send({ status: 'offerUpdated', offer: result.offer });
      }
      return failure(reply, result.kind);
    },
  );

  app.post(
    `${BASE}/:programId/offers/:offerId/end`,
    {
      config: { authPolicy: 'provider', providerCapability: 'listings.manage' },
      bodyLimit: CATALOGUE_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, programId: Uuid, offerId: Uuid }),
        body: Type.Object({ expectedVersion: ExpectedVersion }, { additionalProperties: false }),
        response: {
          200: Type.Object({ status: Type.Literal('offerEnded') }),
          ...CATALOGUE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await endOffer(
        serviceDeps,
        scope,
        { userId: principal.userId },
        {
          programId: request.params.programId,
          offerId: request.params.offerId,
          expectedVersion: request.body.expectedVersion,
        },
      );
      if (result.kind === 'offerEnded') {
        return reply.status(200).send({ status: 'offerEnded' });
      }
      return failure(reply, result.kind);
    },
  );
}
