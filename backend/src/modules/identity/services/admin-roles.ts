/**
 * Administrative role-assignment services (docs/26 §7, §9.7) — B2-5.
 *
 * Himma PostgreSQL is the ONLY authority for administrative roles — never
 * provider groups/claims, emails, deployment configuration, or frontend
 * state. Principal resolution reads the database directly on every request
 * (no caching, no role material in long-lived tokens), so grants, expiry,
 * and revocations take effect on the next request.
 *
 * Every mutation runs in one transaction with its audit and outbox events;
 * the B2-1/0003 constraints and triggers (dual control CHECK, D4
 * exclusivity, deferred finance-approver qualifications, immutability)
 * remain the final authority — this layer pre-checks for typed outcomes and
 * TRANSLATES database refusals; it can never bypass them. Platform-engineer
 * separation stays an infrastructure-IAM + grant-time-registry rule
 * (docs/26 §7.4) and is deliberately NOT represented as database-enforced.
 */
import { isDbError } from '../../../db/errors';
import { appendAuditEvent } from '../../../db/audit';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { findUser } from '../persistence/identity-repository';
import {
  casTransition,
  conflictingRolesFor,
  findAssignmentById,
  findAssignmentByIdForUpdate,
  FINANCE_CAPABLE_ROLES,
  hasActiveAccessAdmin,
  insertAssignment,
  listActiveRoles,
  listAssignments,
  expireDueAssignments,
  type AdminAssignmentRow,
  type AdminRole,
} from '../persistence/admin-role-repository';
import type { IdentityServiceDeps } from './account-status';

export type { AdminRole } from '../persistence/admin-role-repository';

export interface AdminActor {
  userId: string;
}

/** Direct database-backed resolution — the only source of admin authority. */
export async function resolveAdminRoles(
  deps: IdentityServiceDeps,
  userId: string,
): Promise<AdminRole[]> {
  return withTransaction(deps.db, (trx) => listActiveRoles(trx, userId));
}

async function auditRoleEvent(
  trx: Trx,
  action: string,
  eventType: string | undefined,
  assignmentId: string,
  targetUserId: string,
  actorId: string,
): Promise<void> {
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId,
    action,
    entityType: 'admin_role_assignment',
    entityId: assignmentId,
  });
  if (eventType !== undefined) {
    await appendOutboxEvent(trx, {
      aggregateType: 'app_user',
      aggregateId: targetUserId,
      eventType,
      payload: { assignmentId },
    });
  }
}

/** Classifies 0002/0003 trigger refusals into typed outcomes. Message
 *  content is an internal DB↔service contract; nothing here reaches HTTP. */
function classifyRoleTriggerError(
  error: unknown,
):
  | 'requesterNotQualified'
  | 'approverNotQualified'
  | 'roleConflict'
  | 'selfApprovalForbidden'
  | undefined {
  if (isDbError(error, 'raisedException')) {
    if (error.message.includes('requested_by')) return 'requesterNotQualified';
    if (error.message.includes('approved_by')) return 'approverNotQualified';
    if (error.message.includes('exclusivity')) return 'roleConflict';
    return undefined;
  }
  if (isDbError(error, 'checkViolation') || isDbError(error, 'uniqueViolation')) {
    if (error.constraint === 'ck_admin_role_assignment_dual_control') {
      return 'selfApprovalForbidden';
    }
    if (error.constraint === 'uq_admin_role_assignment_active') return 'roleConflict';
    return undefined;
  }
  return undefined;
}

export type RequestRoleResult =
  | { kind: 'roleRequested'; assignmentId: string }
  | { kind: 'roleActivated'; assignmentId: string }
  | { kind: 'requesterNotQualified' }
  | { kind: 'targetNotFound' }
  | { kind: 'roleConflict' };

/**
 * docs/26 §7.2: an active Access Administrator requests a grant.
 * Finance-capable roles enter `requested` awaiting a DISTINCT approver;
 * other roles activate immediately on the single access-admin request.
 */
export async function requestRoleAssignment(
  deps: IdentityServiceDeps,
  actor: AdminActor,
  input: { targetUserId: string; role: AdminRole; expiresAt?: Date },
): Promise<RequestRoleResult> {
  try {
    return await withTransaction(deps.db, async (trx) => {
      if (!(await hasActiveAccessAdmin(trx, actor.userId))) {
        return { kind: 'requesterNotQualified' as const };
      }
      const target = await findUser(trx, input.targetUserId);
      if (target === undefined) return { kind: 'targetNotFound' as const };
      const held = await listActiveRoles(trx, input.targetUserId);
      if (held.some((role) => conflictingRolesFor(input.role).includes(role))) {
        return { kind: 'roleConflict' as const };
      }

      const financeCapable = FINANCE_CAPABLE_ROLES.includes(input.role);
      const assignmentId = await insertAssignment(trx, {
        targetUserId: input.targetUserId,
        role: input.role,
        state: financeCapable ? 'requested' : 'active',
        requestedBy: actor.userId,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      });
      await auditRoleEvent(
        trx,
        'auth.admin_role_requested',
        'admin_role.requested',
        assignmentId,
        input.targetUserId,
        actor.userId,
      );
      if (!financeCapable) {
        await auditRoleEvent(
          trx,
          'auth.admin_role_approved',
          'admin_role.approved',
          assignmentId,
          input.targetUserId,
          actor.userId,
        );
        return { kind: 'roleActivated' as const, assignmentId };
      }
      return { kind: 'roleRequested' as const, assignmentId };
    });
  } catch (error) {
    const classified = classifyRoleTriggerError(error);
    if (classified === 'roleConflict') return { kind: 'roleConflict' };
    if (classified === 'requesterNotQualified') return { kind: 'requesterNotQualified' };
    throw error;
  }
}

export type ProcessRoleResult =
  | { kind: 'roleActivated' }
  | { kind: 'roleDenied' }
  | { kind: 'roleRevoked' }
  | { kind: 'requesterNotQualified' }
  | { kind: 'approverNotQualified' }
  | { kind: 'selfApprovalForbidden' }
  | { kind: 'assignmentNotFound' }
  | { kind: 'assignmentAlreadyFinalized' }
  | { kind: 'roleConflict' }
  | { kind: 'staleVersion' };

type Transition = {
  fromState: 'requested' | 'active';
  toState: 'active' | 'denied' | 'revoked';
  actorColumn: 'approved_by' | 'denied_by' | 'revoked_by';
  audit: string;
  event: string;
  success: 'roleActivated' | 'roleDenied' | 'roleRevoked';
};

async function processAssignment(
  deps: IdentityServiceDeps,
  actor: AdminActor,
  input: { assignmentId: string; expectedVersion: number },
  transition: Transition,
  guard?: (row: AdminAssignmentRow) => ProcessRoleResult | undefined,
): Promise<ProcessRoleResult> {
  try {
    return await withTransaction(deps.db, async (trx) => {
      if (!(await hasActiveAccessAdmin(trx, actor.userId))) {
        return { kind: 'approverNotQualified' as const };
      }
      const row = await findAssignmentByIdForUpdate(trx, input.assignmentId);
      if (row === undefined) return { kind: 'assignmentNotFound' as const };
      if (row.state !== transition.fromState) {
        return { kind: 'assignmentAlreadyFinalized' as const };
      }
      const guarded = guard?.(row);
      if (guarded !== undefined) return guarded;
      const moved = await casTransition(
        trx,
        row.id,
        input.expectedVersion,
        transition.fromState,
        { state: transition.toState, actorColumn: transition.actorColumn, actorId: actor.userId },
      );
      if (!moved) return { kind: 'staleVersion' as const };
      await auditRoleEvent(
        trx,
        transition.audit,
        transition.event,
        row.id,
        row.user_id,
        actor.userId,
      );
      return { kind: transition.success };
    });
  } catch (error) {
    const classified = classifyRoleTriggerError(error);
    if (classified !== undefined) return { kind: classified };
    throw error;
  }
}

export async function approveRoleAssignment(
  deps: IdentityServiceDeps,
  actor: AdminActor,
  input: { assignmentId: string; expectedVersion: number },
): Promise<ProcessRoleResult> {
  return processAssignment(
    deps,
    actor,
    input,
    {
      fromState: 'requested',
      toState: 'active',
      actorColumn: 'approved_by',
      audit: 'auth.admin_role_approved',
      event: 'admin_role.approved',
      success: 'roleActivated',
    },
    // Dual control (docs/24 §6.5): pre-typed here, CHECK-enforced beneath.
    (row) => (row.requested_by === actor.userId ? { kind: 'selfApprovalForbidden' } : undefined),
  );
}

export async function denyRoleAssignment(
  deps: IdentityServiceDeps,
  actor: AdminActor,
  input: { assignmentId: string; expectedVersion: number },
): Promise<ProcessRoleResult> {
  return processAssignment(deps, actor, input, {
    fromState: 'requested',
    toState: 'denied',
    actorColumn: 'denied_by',
    audit: 'auth.admin_role_denied',
    event: 'admin_role.denied',
    success: 'roleDenied',
  });
}

export async function revokeRoleAssignment(
  deps: IdentityServiceDeps,
  actor: AdminActor,
  input: { assignmentId: string; expectedVersion: number },
): Promise<ProcessRoleResult> {
  return processAssignment(deps, actor, input, {
    fromState: 'active',
    toState: 'revoked',
    actorColumn: 'revoked_by',
    audit: 'auth.admin_role_revoked',
    event: 'admin_role.revoked',
    success: 'roleRevoked',
  });
}

/** Expiry sweep (docs/26 §7.3): resolution already ignores overdue rows;
 *  this finalizes their state, emitting the `admin_role.expired` audit and
 *  outbox events in the SAME transaction as each canonical transition.
 *  Merely reading an overdue assignment never emits anything — only the
 *  sweep's active→expired transition does, exactly once per assignment. */
export async function processExpiredAssignments(
  deps: IdentityServiceDeps,
): Promise<{ expiredCount: number }> {
  return withTransaction(deps.db, async (trx) => {
    const expired = await expireDueAssignments(trx);
    for (const { id: assignmentId, user_id: targetUserId } of expired) {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'auth.admin_role_expired',
        entityType: 'admin_role_assignment',
        entityId: assignmentId,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'app_user',
        aggregateId: targetUserId,
        eventType: 'admin_role.expired',
        payload: { assignmentId },
      });
    }
    return { expiredCount: expired.length };
  });
}

export interface AssignmentView {
  id: string;
  userId: string;
  role: string;
  state: string;
  requestedBy: string;
  approvedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  version: number;
}

function toView(row: AdminAssignmentRow): AssignmentView {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    state: row.state,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

type ReaderGate = { kind: 'ok' } | { kind: 'forbidden' };

/** Readers: access administration manages; audit reads (docs/26 §7). */
async function gateReader(trx: Trx, userId: string): Promise<ReaderGate> {
  const roles = await listActiveRoles(trx, userId);
  return roles.includes('access_admin') || roles.includes('auditor')
    ? { kind: 'ok' }
    : { kind: 'forbidden' };
}

export type ListAssignmentsResult =
  | { kind: 'assignments'; assignments: AssignmentView[] }
  | { kind: 'forbidden' };

export async function listRoleAssignments(
  deps: IdentityServiceDeps,
  actor: AdminActor,
  filter: { state?: string; userId?: string },
): Promise<ListAssignmentsResult> {
  return withTransaction(deps.db, async (trx) => {
    if ((await gateReader(trx, actor.userId)).kind !== 'ok') {
      return { kind: 'forbidden' as const };
    }
    const rows = await listAssignments(trx, filter);
    return { kind: 'assignments' as const, assignments: rows.map(toView) };
  });
}

export type GetAssignmentResult =
  | { kind: 'assignment'; assignment: AssignmentView }
  | { kind: 'assignmentNotFound' }
  | { kind: 'forbidden' };

export async function getRoleAssignment(
  deps: IdentityServiceDeps,
  actor: AdminActor,
  assignmentId: string,
): Promise<GetAssignmentResult> {
  return withTransaction(deps.db, async (trx) => {
    if ((await gateReader(trx, actor.userId)).kind !== 'ok') {
      return { kind: 'forbidden' as const };
    }
    const row = await findAssignmentById(trx, assignmentId);
    if (row === undefined) return { kind: 'assignmentNotFound' as const };
    return { kind: 'assignment' as const, assignment: toView(row) };
  });
}
