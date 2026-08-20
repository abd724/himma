/**
 * Administrative role-management routes (docs/26 §10 admin set) — B2-5.
 *
 * W3-9 policy split (the W3-1 ruling applied by the owning slice): the
 * ordinary internal READS — `GET /admin/me`, the two role-assignment
 * reads, and the AD-18 audit-events read — ride the `admin` baseline,
 * while every role MUTATION (request/approve/deny/revoke) keeps its
 * pre-split recent-factor strength on `adminStepUp` (D-W3-5 — the final
 * high-risk action set — stays owner-pending; dual control on
 * approve/deny already exceeds step-up and is untouched). Specific role
 * authority is enforced by the services (access administration manages;
 * auditor reads; the audit explorer reads are auditor + operations per
 * docs/31 §8). Production registration is FAIL-CLOSED until B2-6 lands
 * admin MFA enforcement — see build-app.ts.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { listAuditEvents } from '../services/audit-read';
import {
  approveRoleAssignment,
  denyRoleAssignment,
  getRoleAssignment,
  listRoleAssignments,
  requestRoleAssignment,
  revokeRoleAssignment,
  type ProcessRoleResult,
} from '../services/admin-roles';
import { ADMIN_ROLES } from '../persistence/admin-role-repository';
import {
  ADMIN_CAPABILITIES,
  capabilitiesForAdminRoles,
} from '../services/admin-capabilities';
import { requirePrincipal } from './auth-plugin';
import { sendOutcome, type HttpOutcomeName } from './http-outcomes';

const ADMIN_BODY_LIMIT = 16_384;
const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const AssignmentView = Type.Object({
  id: Uuid,
  userId: Uuid,
  role: Type.String(),
  state: Type.String(),
  requestedBy: Uuid,
  approvedBy: Type.Union([Uuid, Type.Null()]),
  expiresAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  version: Type.Integer(),
});
const ADMIN_ERRORS = {
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  500: ErrorBody,
  503: ErrorBody,
};

function processOutcomeName(kind: Exclude<ProcessRoleResult['kind'], 'roleActivated' | 'roleDenied' | 'roleRevoked'>): HttpOutcomeName {
  switch (kind) {
    case 'requesterNotQualified':
    case 'approverNotQualified':
      return 'forbidden';
    case 'selfApprovalForbidden':
      return 'dualControlViolation';
    case 'assignmentNotFound':
      return 'notFound';
    case 'assignmentAlreadyFinalized':
      return 'assignmentAlreadyFinalized';
    case 'roleConflict':
      return 'roleConflict';
    case 'staleVersion':
      return 'staleVersion';
  }
}

export function registerAdminRoutes(instance: FastifyInstance, deps: { db: Db }): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };

  // ---------------------------------------------------------------------
  // GET /admin/me — the Admin Portal bootstrap (W3-1). The `admin`
  // BASELINE policy has already refused everyone without a live session +
  // Himma MFA assurance + ≥1 ACTIVE PostgreSQL admin role (non-admins
  // learn nothing beyond `forbidden`; Cognito claims grant no role) — and,
  // per the W3-1 final owner decision, it deliberately does NOT demand a
  // RECENT factor: an MFA-assured admin whose factor merely aged still
  // bootstraps the shell. Recent-factor step-up remains a distinct
  // action-level mechanism (`adminStepUp`, D-W3-5 deferred). The response
  // is the SAFE access projection the frontend needs and nothing more:
  // display identity, the active canonical roles, and the centralized
  // capability projection (admin-capabilities.ts) — no session internals,
  // no assignment audit fields, no provider/customer data.
  // ---------------------------------------------------------------------
  app.get(
    '/admin/me',
    {
      config: { authPolicy: 'admin' },
      schema: {
        response: {
          200: Type.Object({
            user: Type.Object({
              id: Uuid,
              displayName: Type.String(),
            }),
            roles: Type.Array(
              Type.Union(ADMIN_ROLES.map((role) => Type.Literal(role))),
            ),
            capabilities: Type.Array(
              Type.Union(ADMIN_CAPABILITIES.map((capability) => Type.Literal(capability))),
            ),
          }),
          ...ADMIN_ERRORS,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request.principal);
      const account = await serviceDeps.db
        .selectFrom('customer_account')
        .select(['display_name'])
        .where('user_id', '=', principal.userId)
        .executeTakeFirst();
      const roles = principal.adminRoles ?? [];
      return {
        user: {
          id: principal.userId,
          displayName: String(account?.display_name ?? 'Himma administrator'),
        },
        roles: [...roles],
        capabilities: [...capabilitiesForAdminRoles(roles)],
      };
    },
  );

  app.get(
    '/admin/role-assignments',
    {
      // W3-9: an ordinary internal READ — the admin BASELINE (W3-1 split);
      // the service still gates on access_admin | auditor.
      config: { authPolicy: 'admin' },
      schema: {
        querystring: Type.Object({
          state: Type.Optional(Type.String({ maxLength: 20 })),
          userId: Type.Optional(Uuid),
        }),
        response: {
          200: Type.Object({ assignments: Type.Array(AssignmentView) }),
          ...ADMIN_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await listRoleAssignments(
        serviceDeps,
        { userId: principal.userId },
        {
          ...(request.query.state !== undefined ? { state: request.query.state } : {}),
          ...(request.query.userId !== undefined ? { userId: request.query.userId } : {}),
        },
      );
      if (result.kind !== 'assignments') return sendOutcome(reply, 'forbidden');
      return reply.status(200).send({ assignments: result.assignments });
    },
  );

  app.get(
    '/admin/role-assignments/:assignmentId',
    {
      // W3-9: ordinary internal READ — admin baseline (service-gated).
      config: { authPolicy: 'admin' },
      schema: {
        params: Type.Object({ assignmentId: Uuid }),
        response: {
          200: Type.Object({ assignment: AssignmentView }),
          ...ADMIN_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await getRoleAssignment(
        serviceDeps,
        { userId: principal.userId },
        request.params.assignmentId,
      );
      if (result.kind === 'assignment') {
        return reply.status(200).send({ assignment: result.assignment });
      }
      return sendOutcome(reply, result.kind === 'forbidden' ? 'forbidden' : 'notFound');
    },
  );

  // ---------------------------------------------------------------------
  // GET /admin/audit-events — the AD-18 audit explorer (W3-9; docs/31 §8):
  // a paginated, role-gated read over the EXISTING append-only table.
  // Baseline `admin` policy; the SERVICE gates auditor | operations fresh
  // per transaction. The projection is bounded (no digests, no principal
  // context, no request ids); reading emits nothing.
  // ---------------------------------------------------------------------
  app.get(
    '/admin/audit-events',
    {
      config: { authPolicy: 'admin' },
      schema: {
        querystring: Type.Object({
          entityType: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
          entityId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
          actorId: Type.Optional(Uuid),
          action: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          cursor: Type.Optional(Uuid),
        }),
        response: {
          200: Type.Object({
            events: Type.Array(
              Type.Object({
                id: Uuid,
                actorType: Type.String(),
                actorId: Type.Union([Uuid, Type.Null()]),
                action: Type.String(),
                entityType: Type.String(),
                entityId: Type.String(),
                occurredAt: Type.String(),
              }),
            ),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          ...ADMIN_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await listAuditEvents(serviceDeps, { userId: principal.userId }, request.query);
      if (result.kind !== 'events') return sendOutcome(reply, 'forbidden');
      return reply.status(200).send({ events: result.events, nextCursor: result.nextCursor });
    },
  );

  app.post(
    '/admin/role-requests',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: ADMIN_BODY_LIMIT,
      schema: {
        body: Type.Object({
          targetUserId: Uuid,
          role: Type.Union(ADMIN_ROLES.map((role) => Type.Literal(role))),
          expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
        }),
        response: {
          200: Type.Object({
            status: Type.Union([Type.Literal('roleRequested'), Type.Literal('roleActivated')]),
            assignmentId: Uuid,
          }),
          ...ADMIN_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await requestRoleAssignment(
        serviceDeps,
        { userId: principal.userId },
        {
          targetUserId: request.body.targetUserId,
          role: request.body.role,
          ...(request.body.expiresAt !== undefined
            ? { expiresAt: new Date(request.body.expiresAt) }
            : {}),
        },
      );
      if (result.kind === 'roleRequested' || result.kind === 'roleActivated') {
        return reply.status(200).send({ status: result.kind, assignmentId: result.assignmentId });
      }
      if (result.kind === 'targetNotFound') return sendOutcome(reply, 'notFound');
      if (result.kind === 'roleConflict') return sendOutcome(reply, 'roleConflict');
      return sendOutcome(reply, 'forbidden');
    },
  );

  const processBody = Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }) });
  const processResponse = (status: 'roleActivated' | 'roleDenied' | 'roleRevoked') =>
    Type.Object({ status: Type.Literal(status) });

  app.post(
    '/admin/role-requests/:assignmentId/approve',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: ADMIN_BODY_LIMIT,
      schema: {
        params: Type.Object({ assignmentId: Uuid }),
        body: processBody,
        response: { 200: processResponse('roleActivated'), ...ADMIN_ERRORS },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await approveRoleAssignment(
        serviceDeps,
        { userId: principal.userId },
        {
          assignmentId: request.params.assignmentId,
          expectedVersion: request.body.expectedVersion,
        },
      );
      if (result.kind === 'roleActivated') {
        return reply.status(200).send({ status: 'roleActivated' as const });
      }
      return sendOutcome(reply, processOutcomeName(result.kind as never));
    },
  );

  app.post(
    '/admin/role-requests/:assignmentId/deny',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: ADMIN_BODY_LIMIT,
      schema: {
        params: Type.Object({ assignmentId: Uuid }),
        body: processBody,
        response: { 200: processResponse('roleDenied'), ...ADMIN_ERRORS },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await denyRoleAssignment(
        serviceDeps,
        { userId: principal.userId },
        {
          assignmentId: request.params.assignmentId,
          expectedVersion: request.body.expectedVersion,
        },
      );
      if (result.kind === 'roleDenied') {
        return reply.status(200).send({ status: 'roleDenied' as const });
      }
      return sendOutcome(reply, processOutcomeName(result.kind as never));
    },
  );

  app.delete(
    '/admin/role-assignments/:assignmentId',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: ADMIN_BODY_LIMIT,
      schema: {
        params: Type.Object({ assignmentId: Uuid }),
        body: processBody,
        response: { 200: processResponse('roleRevoked'), ...ADMIN_ERRORS },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await revokeRoleAssignment(
        serviceDeps,
        { userId: principal.userId },
        {
          assignmentId: request.params.assignmentId,
          expectedVersion: request.body.expectedVersion,
        },
      );
      if (result.kind === 'roleRevoked') {
        return reply.status(200).send({ status: 'roleRevoked' as const });
      }
      return sendOutcome(reply, processOutcomeName(result.kind as never));
    },
  );
}
