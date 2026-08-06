/**
 * Administrative role-management routes (docs/26 §10 admin set) — B2-5.
 *
 * Every route declares the explicit `admin` policy: live session + MFA
 * assurance + at least one active Himma database role (pipeline), with the
 * specific role authority enforced by the services (access administration
 * manages; audit reads). Production registration is FAIL-CLOSED until B2-6
 * lands admin MFA enforcement — see build-app.ts.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
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

  app.get(
    '/admin/role-assignments',
    {
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

  app.post(
    '/admin/role-requests',
    {
      config: { authPolicy: 'admin' },
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
      config: { authPolicy: 'admin' },
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
      config: { authPolicy: 'admin' },
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
      config: { authPolicy: 'admin' },
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
