import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import type {
  AdminRolesPort,
  RoleActionOutcome,
  RoleAssignmentRecord,
} from '../../roles/contract';

/**
 * LIVE roles-administration port (W3-9) over the CERTIFIED B2-5 routes.
 * Pass-through with fail-closed validation of exactly the consumed fields;
 * every typed backend refusal maps to its own outcome. No authority
 * semantics live here — dual control, D4 exclusivity, finance-approver
 * rules, and CAS all stay database/service truth.
 */

function assignmentFrom(raw: unknown): RoleAssignmentRecord | null {
  const row = raw as Record<string, unknown>;
  if (
    typeof row?.id !== 'string' ||
    typeof row.userId !== 'string' ||
    typeof row.role !== 'string' ||
    typeof row.state !== 'string' ||
    typeof row.requestedBy !== 'string' ||
    !(typeof row.approvedBy === 'string' || row.approvedBy === null) ||
    !(typeof row.expiresAt === 'string' || row.expiresAt === null) ||
    typeof row.createdAt !== 'string' ||
    typeof row.version !== 'number'
  ) {
    return null;
  }
  return {
    id: row.id,
    userId: row.userId,
    role: row.role,
    state: row.state,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    version: row.version,
  };
}

function actionOutcomeFrom(response: { status: number; code: string | null }): RoleActionOutcome {
  if (response.status === 200) return { kind: 'completed' };
  switch (response.code) {
    case 'stepUpRequired':
      return { kind: 'stepUpRequired' };
    case 'dualControlViolation':
      return { kind: 'dualControlViolation' };
    case 'assignmentAlreadyFinalized':
      return { kind: 'alreadyFinalized' };
    case 'roleConflict':
      return { kind: 'roleConflict' };
    case 'staleVersion':
      return { kind: 'staleVersion' };
    case 'forbidden':
      return { kind: 'forbidden' };
    case 'notFound':
      return { kind: 'notFound' };
    default:
      return { kind: 'unavailable' };
  }
}

export function createLiveRolesPort(transport: LiveTransport): AdminRolesPort {
  const act = async (
    method: 'POST' | 'DELETE',
    path: string,
    body: Record<string, unknown>,
  ): Promise<RoleActionOutcome> => {
    const response = await transport.authorizedRequest(path, { method, body });
    if (response === null || response.networkFailure) return { kind: 'unavailable' };
    return actionOutcomeFrom(response);
  };

  return {
    async listAssignments(params) {
      const query = new URLSearchParams();
      if (params.state !== undefined) query.set('state', params.state);
      if (params.userId !== undefined) query.set('userId', params.userId);
      const encoded = query.toString();
      const response = await transport.authorizedRequest(
        `/admin/role-assignments${encoded === '' ? '' : `?${encoded}`}`,
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const body = response.body as { assignments?: unknown } | null;
        if (body === null || !Array.isArray(body.assignments)) return { kind: 'unavailable' };
        const assignments: RoleAssignmentRecord[] = [];
        for (const entry of body.assignments) {
          const assignment = assignmentFrom(entry);
          if (assignment === null) return { kind: 'unavailable' };
          assignments.push(assignment);
        }
        return { kind: 'loaded', assignments };
      }
      return response.code === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
    },

    requestRole(input) {
      return act('POST', '/admin/role-requests', {
        targetUserId: input.targetUserId,
        role: input.role,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      });
    },

    approveRequest(assignmentId, input) {
      return act('POST', `/admin/role-requests/${encodeURIComponent(assignmentId)}/approve`, {
        expectedVersion: input.expectedVersion,
      });
    },

    denyRequest(assignmentId, input) {
      return act('POST', `/admin/role-requests/${encodeURIComponent(assignmentId)}/deny`, {
        expectedVersion: input.expectedVersion,
      });
    },

    revokeAssignment(assignmentId, input) {
      return act('DELETE', `/admin/role-assignments/${encodeURIComponent(assignmentId)}`, {
        expectedVersion: input.expectedVersion,
      });
    },
  };
}
