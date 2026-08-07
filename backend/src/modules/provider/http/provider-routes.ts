/**
 * Provider-private management routes (docs/27 §13.2) — S3-3.
 *
 * Exactly the approved route inventory, every route policy-declared:
 * `provider` = live session + fresh PostgreSQL membership for the addressed
 * organization + D-S3-5 MFA baseline + declared ACTIVE capability +
 * suspended-org mutation refusal (all enforced by the pipeline before any
 * handler runs); `providerStepUp` layers the Slice-2 recent-step-up window
 * on the higher-risk staff-management set. `/provider/me` and invitation
 * acceptance are `authenticatedCustomer` per docs/27 §8/§13.2.
 *
 * Responses use explicit TypeBox schemas — the private management view is
 * capability-shaped (no generic all-columns endpoint), and no response or
 * error ever carries another organization's data, Cognito material,
 * PostgreSQL constraint detail, or a raw invitation token.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import type { MailSender } from '../../identity/mail/mail-sender';
import {
  requireOrgScope,
  requirePrincipal,
} from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import {
  rateLimitDigest,
  type RateLimiterStore,
  type RateLimitRule,
  type RateLimitRules,
} from '../../identity/http/rate-limiter';
import {
  createBranch,
  deactivateBranch,
  getProviderOrganizationView,
  listStaff,
  revokeStaffMembership,
  submitOrganization,
  updateBranch,
  updatePublicProfile,
} from '../services/organization-management';
import {
  listProviderMemberships,
} from '../services/provider-principal';
import {
  acceptStaffInvitation,
  issueStaffInvitation,
  revokeStaffInvitation,
} from '../services/staff-invitations';
import { PROVIDER_ROLES } from '../provider-roles';
import type { StaffInvitationConfig } from '../staff-invitation-config';

const PROVIDER_BODY_LIMIT = 32_768;
const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const PROVIDER_ERRORS = {
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

const BranchScopeBody = Type.Union([
  Type.Object({ kind: Type.Literal('all') }),
  Type.Object({
    kind: Type.Literal('branches'),
    branchIds: Type.Array(Uuid, { minItems: 1, maxItems: 50 }),
  }),
]);
const BranchScopeView = Type.Union([Type.Literal('all'), Type.Array(Uuid)]);
const RoleLiteral = Type.Union(PROVIDER_ROLES.map((role) => Type.Literal(role)));

const NullableString = (maxLength: number) =>
  Type.Union([Type.String({ maxLength }), Type.Null()]);
const NullableUuid = Type.Union([Uuid, Type.Null()]);

const GeoPoint = Type.Object({
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
});

const BranchViewSchema = Type.Object({
  id: Uuid,
  label: Type.String(),
  addressLine: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  areaLabel: Type.String(),
  geoPoint: Type.Union([GeoPoint, Type.Null()]),
  openingHours: Type.Any(),
  facilities: Type.Array(Type.String()),
  active: Type.Boolean(),
  version: Type.Integer(),
});

const OrganizationViewSchema = Type.Object({
  organization: Type.Object({
    id: Uuid,
    tradeName: Type.String(),
    legalName: Type.Optional(Type.String()),
    orgKind: Type.String(),
    verificationState: Type.String(),
    commercialTermsRef: Type.Optional(Type.Union([Uuid, Type.Null()])),
    version: Type.Integer(),
  }),
  profile: Type.Object({
    displayName: Type.String(),
    descriptionEn: Type.Union([Type.String(), Type.Null()]),
    descriptionAr: Type.Union([Type.String(), Type.Null()]),
    logoMediaRef: Type.Union([Uuid, Type.Null()]),
    coverMediaRef: Type.Union([Uuid, Type.Null()]),
    galleryMediaRefs: Type.Array(Uuid),
    publicPhone: Type.Union([Type.String(), Type.Null()]),
    publicEmail: Type.Union([Type.String(), Type.Null()]),
    publicWebsite: Type.Union([Type.String(), Type.Null()]),
    publicInstagram: Type.Union([Type.String(), Type.Null()]),
    published: Type.Boolean(),
    version: Type.Integer(),
  }),
  branches: Type.Array(BranchViewSchema),
  membership: Type.Object({
    id: Uuid,
    role: Type.String(),
    branchScope: BranchScopeView,
    capabilities: Type.Array(Type.String()),
  }),
});

const BranchBodyBase = {
  addressLine: Type.Optional(NullableString(240)),
  city: Type.Optional(NullableString(80)),
  geoPoint: Type.Optional(Type.Union([GeoPoint, Type.Null()])),
  openingHours: Type.Optional(Type.Any()),
  facilities: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20 }),
  ),
};

export interface ProviderRouteDeps {
  db: Db;
  mailSender: MailSender;
  invitationConfig: StaffInvitationConfig;
  rateLimiter: RateLimiterStore;
  rules: RateLimitRules;
}

export function registerProviderRoutes(
  instance: FastifyInstance,
  deps: ProviderRouteDeps,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };
  const invitationDeps = {
    db: deps.db,
    mailSender: deps.mailSender,
    invitationConfig: deps.invitationConfig,
  };

  /** Per-user+organization limit on sensitive staff actions; keys are
   *  digests, never raw identifiers. */
  async function limited(
    reply: FastifyReply,
    rule: RateLimitRule,
    dimension: string,
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    const decision = await deps.rateLimiter.consume(
      `${dimension}:${rateLimitDigest(userId)}:${rateLimitDigest(organizationId)}`,
      rule,
      1,
    );
    if (!decision.allowed) {
      void sendOutcome(reply, 'rateLimited', {
        'retry-after': String(decision.retryAfterSeconds),
      });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // GET /provider/me — the caller's own memberships (org-switcher source).
  // ---------------------------------------------------------------------
  app.get(
    '/provider/me',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        response: {
          200: Type.Object({
            memberships: Type.Array(
              Type.Object({
                organizationId: Uuid,
                displayName: Type.String(),
                role: RoleLiteral,
                branchScope: BranchScopeView,
                organizationState: Type.String(),
              }),
            ),
          }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request.principal);
      const memberships = await listProviderMemberships(serviceDeps, {
        userId: principal.userId,
      });
      return { memberships };
    },
  );

  // ---------------------------------------------------------------------
  // GET /provider/organizations/:organizationId — private management view.
  // ---------------------------------------------------------------------
  app.get(
    '/provider/organizations/:organizationId',
    {
      config: { authPolicy: 'provider', providerCapability: 'org.read' },
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        response: { 200: OrganizationViewSchema, ...PROVIDER_ERRORS },
      },
    },
    async (request) => {
      const scope = requireOrgScope(request.principal);
      return getProviderOrganizationView(serviceDeps, scope);
    },
  );

  // ---------------------------------------------------------------------
  // PATCH /provider/organizations/:organizationId/profile — CAS edit.
  // ---------------------------------------------------------------------
  app.patch(
    '/provider/organizations/:organizationId/profile',
    {
      config: { authPolicy: 'provider', providerCapability: 'profile.edit' },
      bodyLimit: PROVIDER_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        body: Type.Object({
          expectedVersion: Type.Integer({ minimum: 1 }),
          displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          descriptionEn: Type.Optional(NullableString(2_000)),
          descriptionAr: Type.Optional(NullableString(2_000)),
          logoMediaRef: Type.Optional(NullableUuid),
          coverMediaRef: Type.Optional(NullableUuid),
          galleryMediaRefs: Type.Optional(Type.Array(Uuid, { maxItems: 20 })),
          publicPhone: Type.Optional(NullableString(32)),
          publicEmail: Type.Optional(
            Type.Union([Type.String({ format: 'email', maxLength: 320 }), Type.Null()]),
          ),
          publicWebsite: Type.Optional(NullableString(300)),
          publicInstagram: Type.Optional(NullableString(64)),
          published: Type.Optional(Type.Boolean()),
        }),
        response: {
          200: Type.Object({ status: Type.Literal('profileUpdated'), version: Type.Integer() }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updatePublicProfile(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { expectedVersion, patch },
      );
      if (result.kind === 'profileUpdated') {
        return reply.status(200).send({ status: 'profileUpdated', version: result.version });
      }
      return sendOutcome(reply, 'staleVersion');
    },
  );

  // ---------------------------------------------------------------------
  // POST /provider/organizations/:organizationId/submit — §5.1 owner edge.
  // ---------------------------------------------------------------------
  app.post(
    '/provider/organizations/:organizationId/submit',
    {
      config: { authPolicy: 'provider', providerCapability: 'org.submit' },
      bodyLimit: PROVIDER_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        body: Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }) }),
        response: {
          200: Type.Object({
            status: Type.Literal('organizationSubmitted'),
            version: Type.Integer(),
          }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await submitOrganization(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { expectedVersion: request.body.expectedVersion },
      );
      if (result.kind === 'organizationSubmitted') {
        return reply
          .status(200)
          .send({ status: 'organizationSubmitted', version: result.version });
      }
      const name: HttpOutcomeName =
        result.kind === 'organizationIncomplete'
          ? 'organizationIncomplete'
          : result.kind === 'lifecycleConflict'
            ? 'lifecycleConflict'
            : 'staleVersion';
      return sendOutcome(reply, name);
    },
  );

  // ---------------------------------------------------------------------
  // Branch management.
  // ---------------------------------------------------------------------
  app.post(
    '/provider/organizations/:organizationId/branches',
    {
      config: { authPolicy: 'provider', providerCapability: 'branch.create' },
      bodyLimit: PROVIDER_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        body: Type.Object({
          label: Type.String({ minLength: 1, maxLength: 120 }),
          areaLabel: Type.String({ minLength: 1, maxLength: 80 }),
          ...BranchBodyBase,
        }),
        response: {
          200: Type.Object({
            status: Type.Literal('branchCreated'),
            branch: BranchViewSchema,
          }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await createBranch(
        serviceDeps,
        scope,
        { userId: principal.userId },
        request.body,
      );
      return reply.status(200).send({ status: 'branchCreated', branch: result.branch });
    },
  );

  app.patch(
    '/provider/organizations/:organizationId/branches/:branchId',
    {
      config: { authPolicy: 'provider', providerCapability: 'branch.edit' },
      bodyLimit: PROVIDER_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, branchId: Uuid }),
        body: Type.Object({
          expectedVersion: Type.Integer({ minimum: 1 }),
          label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          areaLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
          ...BranchBodyBase,
        }),
        response: {
          200: Type.Object({
            status: Type.Literal('branchUpdated'),
            branch: BranchViewSchema,
          }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const { expectedVersion, ...patch } = request.body;
      const result = await updateBranch(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { branchId: request.params.branchId, expectedVersion, patch },
      );
      if (result.kind === 'branchUpdated') {
        return reply.status(200).send({ status: 'branchUpdated', branch: result.branch });
      }
      const name: HttpOutcomeName =
        result.kind === 'branchNotFound'
          ? 'notFound'
          : result.kind === 'forbidden'
            ? 'forbidden'
            : 'staleVersion';
      return sendOutcome(reply, name);
    },
  );

  app.post(
    '/provider/organizations/:organizationId/branches/:branchId/deactivate',
    {
      config: { authPolicy: 'provider', providerCapability: 'branch.deactivate' },
      bodyLimit: PROVIDER_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, branchId: Uuid }),
        body: Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }) }),
        response: {
          200: Type.Object({ status: Type.Literal('branchDeactivated') }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await deactivateBranch(
        serviceDeps,
        scope,
        { userId: principal.userId },
        { branchId: request.params.branchId, expectedVersion: request.body.expectedVersion },
      );
      if (result.kind === 'branchDeactivated') {
        return reply.status(200).send({ status: 'branchDeactivated' });
      }
      return sendOutcome(reply, result.kind === 'branchNotFound' ? 'notFound' : 'staleVersion');
    },
  );

  // ---------------------------------------------------------------------
  // Staff surface (owner; the D-S3-5 higher-risk mutations are step-up).
  // ---------------------------------------------------------------------
  app.get(
    '/provider/organizations/:organizationId/staff',
    {
      config: { authPolicy: 'provider', providerCapability: 'staff.read' },
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        response: {
          200: Type.Object({
            memberships: Type.Array(
              Type.Object({
                id: Uuid,
                userId: Uuid,
                role: Type.String(),
                branchScopeKind: Type.String(),
                branchIds: Type.Array(Uuid),
                state: Type.String(),
                createdAt: Type.String(),
                version: Type.Integer(),
              }),
            ),
            invitations: Type.Array(
              Type.Object({
                id: Uuid,
                email: Type.String(),
                role: Type.String(),
                branchScopeKind: Type.String(),
                branchIds: Type.Array(Uuid),
                state: Type.String(),
                expiresAt: Type.String(),
                version: Type.Integer(),
              }),
            ),
          }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request) => {
      const scope = requireOrgScope(request.principal);
      return listStaff(serviceDeps, scope);
    },
  );

  app.post(
    '/provider/organizations/:organizationId/staff/invitations',
    {
      config: { authPolicy: 'providerStepUp', providerCapability: 'staff.manage' },
      bodyLimit: PROVIDER_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        body: Type.Object({
          email: Type.String({ format: 'email', maxLength: 320 }),
          role: RoleLiteral,
          branchScope: BranchScopeBody,
        }),
        response: {
          200: Type.Object({
            status: Type.Literal('invitationIssued'),
            invitationId: Uuid,
            expiresAt: Type.String(),
            mailDelivery: Type.Union([Type.Literal('delivered'), Type.Literal('failed')]),
          }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      if (
        await limited(
          reply,
          deps.rules.staffInvitation,
          'staff-invite',
          principal.userId,
          scope.organizationId,
        )
      ) {
        return reply;
      }
      const result = await issueStaffInvitation(
        invitationDeps,
        { kind: 'owner', userId: principal.userId },
        {
          organizationId: scope.organizationId,
          email: request.body.email,
          role: request.body.role,
          branchScope:
            request.body.branchScope.kind === 'all'
              ? { kind: 'all' }
              : { kind: 'branches', branchIds: request.body.branchScope.branchIds },
        },
      );
      if (result.kind === 'invitationIssued') {
        return reply.status(200).send({
          status: 'invitationIssued',
          invitationId: result.invitationId,
          expiresAt: result.expiresAt.toISOString(),
          mailDelivery: result.mailDelivery,
        });
      }
      const name: HttpOutcomeName =
        result.kind === 'invalidBranchScope'
          ? 'invalidBranchScope'
          : result.kind === 'organizationSuspended'
            ? 'organizationSuspended'
            : result.kind === 'forbidden'
              ? 'forbidden'
              : 'notFound';
      return sendOutcome(reply, name);
    },
  );

  app.post(
    '/provider/organizations/:organizationId/staff/invitations/:invitationId/revoke',
    {
      config: { authPolicy: 'providerStepUp', providerCapability: 'staff.manage' },
      bodyLimit: PROVIDER_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, invitationId: Uuid }),
        response: {
          200: Type.Object({ status: Type.Literal('invitationRevoked') }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      if (
        await limited(
          reply,
          deps.rules.staffManagement,
          'staff-manage',
          principal.userId,
          scope.organizationId,
        )
      ) {
        return reply;
      }
      const result = await revokeStaffInvitation(
        invitationDeps,
        { kind: 'owner', userId: principal.userId },
        { organizationId: scope.organizationId, invitationId: request.params.invitationId },
      );
      if (result.kind === 'invitationRevoked') {
        return reply.status(200).send({ status: 'invitationRevoked' });
      }
      const name: HttpOutcomeName =
        result.kind === 'invitationAlreadyFinalized'
          ? 'lifecycleConflict'
          : result.kind === 'organizationSuspended'
            ? 'organizationSuspended'
            : result.kind === 'forbidden'
              ? 'forbidden'
              : 'notFound';
      return sendOutcome(reply, name);
    },
  );

  app.post(
    '/provider/organizations/:organizationId/staff/memberships/:membershipId/revoke',
    {
      config: { authPolicy: 'providerStepUp', providerCapability: 'staff.manage' },
      bodyLimit: PROVIDER_BODY_LIMIT,
      schema: {
        params: Type.Object({ organizationId: Uuid, membershipId: Uuid }),
        body: Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }) }),
        response: {
          200: Type.Object({ status: Type.Literal('membershipRevoked') }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      if (
        await limited(
          reply,
          deps.rules.staffManagement,
          'staff-manage',
          principal.userId,
          scope.organizationId,
        )
      ) {
        return reply;
      }
      const result = await revokeStaffMembership(
        serviceDeps,
        scope,
        { userId: principal.userId },
        {
          membershipId: request.params.membershipId,
          expectedVersion: request.body.expectedVersion,
        },
      );
      if (result.kind === 'membershipRevoked') {
        return reply.status(200).send({ status: 'membershipRevoked' });
      }
      const name: HttpOutcomeName =
        result.kind === 'lastOwnerProtected'
          ? 'lastOwnerProtected'
          : result.kind === 'membershipNotFound'
            ? 'notFound'
            : 'staleVersion';
      return sendOutcome(reply, name);
    },
  );

  // ---------------------------------------------------------------------
  // POST /provider/invitations/accept — D-S3-1 acceptance (any
  // authenticated customer; verified-email match enforced by the service).
  // ---------------------------------------------------------------------
  app.post(
    '/provider/invitations/accept',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: PROVIDER_BODY_LIMIT,
      schema: {
        body: Type.Object({ token: Type.String({ minLength: 16, maxLength: 128 }) }),
        response: {
          200: Type.Object({
            status: Type.Literal('invitationAccepted'),
            organizationId: Uuid,
            membershipId: Uuid,
          }),
          ...PROVIDER_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const decision = await deps.rateLimiter.consume(
        `invite-accept:${rateLimitDigest(principal.userId)}`,
        deps.rules.invitationAccept,
        1,
      );
      if (!decision.allowed) {
        return sendOutcome(reply, 'rateLimited', {
          'retry-after': String(decision.retryAfterSeconds),
        });
      }
      const result = await acceptStaffInvitation(
        invitationDeps,
        { userId: principal.userId },
        { token: request.body.token },
      );
      if (result.kind === 'invitationAccepted') {
        return reply.status(200).send({
          status: 'invitationAccepted',
          organizationId: result.organizationId,
          membershipId: result.membershipId,
        });
      }
      return sendOutcome(reply, 'invitationInvalid');
    },
  );
}
