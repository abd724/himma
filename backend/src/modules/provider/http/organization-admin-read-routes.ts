/**
 * Himma-admin organization READ routes (docs/31 §11 W3-2): the internal
 * provider directory / review queue list and the organization detail.
 *
 * Ordinary internal read surfaces sit on the `admin` BASELINE policy
 * (W3-1 final owner decision: live session + MFA assurance + ≥1 active
 * PostgreSQL admin role — no recent-factor demand merely to browse), and
 * the service additionally requires the `operations` role fresh per
 * transaction, exactly like the lifecycle mutations it prepares for. The
 * lifecycle mutation routes themselves remain untouched on `adminStepUp`.
 *
 * ONE list contract serves both the directory (unfiltered) and the review
 * queue (`needsReview=true` — the documented state predicate); no
 * duplicate queue endpoint exists. The status filter accepts ONLY the
 * canonical ck_organization_state vocabulary (invalid values fail schema
 * validation), and search/filtering always precede pagination.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome } from '../../identity/http/http-outcomes';
import { LISTING_STATES } from '../../catalogue/services/catalogue-shared';
import {
  getAdminOrganizationDetail,
  listAdminOrganizations,
  ORGANIZATION_STATES,
  type OrganizationState,
} from '../services/organization-admin-read';

const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const ADMIN_ORG_READ_ERRORS = {
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  500: ErrorBody,
  503: ErrorBody,
};

const ReviewState = Type.Union([
  Type.Literal('awaiting_review'),
  Type.Literal('in_review'),
  Type.Literal('awaiting_go_live'),
  Type.Literal('none'),
]);

const StorefrontView = Type.Object({
  published: Type.Boolean(),
  publiclyVisible: Type.Boolean(),
});

const OrganizationSummaryView = Type.Object({
  organizationId: Uuid,
  displayName: Type.String(),
  tradeName: Type.String(),
  verificationState: Type.String(),
  reviewState: ReviewState,
  storefront: StorefrontView,
  activeBranchCount: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const OrganizationDetailView = Type.Object({
  organization: Type.Object({
    id: Uuid,
    legalName: Type.String(),
    tradeName: Type.String(),
    orgKind: Type.String(),
    verificationState: Type.String(),
    reviewState: ReviewState,
    suspendedAt: Type.Union([Type.String(), Type.Null()]),
    offboardedAt: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String(),
    version: Type.Integer(),
  }),
  profile: Type.Object({
    displayName: Type.String(),
    descriptionEn: Type.Union([Type.String(), Type.Null()]),
    descriptionAr: Type.Union([Type.String(), Type.Null()]),
    publicPhone: Type.Union([Type.String(), Type.Null()]),
    publicEmail: Type.Union([Type.String(), Type.Null()]),
    publicWebsite: Type.Union([Type.String(), Type.Null()]),
    publicInstagram: Type.Union([Type.String(), Type.Null()]),
    published: Type.Boolean(),
    publiclyVisible: Type.Boolean(),
  }),
  branches: Type.Array(
    Type.Object({
      id: Uuid,
      label: Type.String(),
      addressLine: Type.Union([Type.String(), Type.Null()]),
      city: Type.Union([Type.String(), Type.Null()]),
      areaLabel: Type.String(),
      active: Type.Boolean(),
      createdAt: Type.String(),
    }),
  ),
  team: Type.Array(
    Type.Object({
      membershipId: Uuid,
      displayName: Type.Union([Type.String(), Type.Null()]),
      role: Type.String(),
      branchScopeKind: Type.String(),
      createdAt: Type.String(),
    }),
  ),
  catalogue: Type.Object({
    total: Type.Integer(),
    byState: Type.Object(
      Object.fromEntries(LISTING_STATES.map((state) => [state, Type.Integer()])),
    ),
  }),
});

export function registerOrganizationAdminReadRoutes(
  instance: FastifyInstance,
  deps: { db: Db },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/admin/organizations',
    {
      config: { authPolicy: 'admin' },
      schema: {
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          cursor: Type.Optional(Uuid),
          q: Type.Optional(Type.String({ maxLength: 160 })),
          state: Type.Optional(
            Type.Union(ORGANIZATION_STATES.map((state) => Type.Literal(state))),
          ),
          needsReview: Type.Optional(Type.Boolean()),
        }),
        response: {
          200: Type.Object({
            organizations: Type.Array(OrganizationSummaryView),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          ...ADMIN_ORG_READ_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await listAdminOrganizations(deps, { userId: principal.userId }, {
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
        ...(request.query.cursor !== undefined ? { cursor: request.query.cursor } : {}),
        ...(request.query.q !== undefined ? { q: request.query.q } : {}),
        ...(request.query.state !== undefined
          ? { state: request.query.state as OrganizationState }
          : {}),
        ...(request.query.needsReview !== undefined
          ? { needsReview: request.query.needsReview }
          : {}),
      });
      if (result.kind !== 'organizations') return sendOutcome(reply, 'forbidden');
      return reply
        .status(200)
        .send({ organizations: result.organizations, nextCursor: result.nextCursor });
    },
  );

  app.get(
    '/admin/organizations/:organizationId',
    {
      config: { authPolicy: 'admin' },
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        response: { 200: OrganizationDetailView, ...ADMIN_ORG_READ_ERRORS },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await getAdminOrganizationDetail(
        deps,
        { userId: principal.userId },
        request.params.organizationId,
      );
      if (result.kind === 'organizationDetail') {
        return reply.status(200).send(result.detail);
      }
      return sendOutcome(reply, result.kind === 'forbidden' ? 'forbidden' : 'notFound');
    },
  );
}
