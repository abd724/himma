/**
 * admin_role_assignment persistence (docs/26 §7, §8.7) — B2-5. All table
 * access for the admin-role aggregate; every mutation runs inside the
 * caller's transaction. The B2-1/0003 constraints and triggers (dual
 * control, D4 exclusivity, finance-approver qualifications, immutability)
 * remain the final authority — services translate their signals, never
 * bypass them.
 */
import { newId } from '../../../db/ids';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';

export const ADMIN_ROLES = [
  'operations',
  'support',
  'finance',
  'access_admin',
  'auditor',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Finance-capable set (docs/26 §7.1; configuration-visible, not scattered). */
export const FINANCE_CAPABLE_ROLES: readonly AdminRole[] = ['finance', 'access_admin'];

export interface AdminAssignmentRow {
  id: string;
  user_id: string;
  role: string;
  state: string;
  requested_by: string;
  approved_by: string | null;
  denied_by: string | null;
  revoked_by: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

const COLUMNS = [
  'id',
  'user_id',
  'role',
  'state',
  'requested_by',
  'approved_by',
  'denied_by',
  'revoked_by',
  'expires_at',
  'created_at',
  'updated_at',
  'version',
] as const;

/** Roles that currently qualify: active AND unexpired (docs/26 §7.3). */
export async function listActiveRoles(db: Db | Trx, userId: string): Promise<AdminRole[]> {
  const rows = await db
    .selectFrom('admin_role_assignment')
    .select(['role'])
    .where('user_id', '=', userId)
    .where('state', '=', 'active')
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
    .execute();
  return rows.map((r) => r.role as AdminRole).sort();
}

export async function hasActiveAccessAdmin(trx: Trx, userId: string): Promise<boolean> {
  const roles = await listActiveRoles(trx, userId);
  return roles.includes('access_admin');
}

export interface NewAssignment {
  targetUserId: string;
  role: AdminRole;
  state: 'requested' | 'active';
  requestedBy: string;
  approvedBy?: string;
  expiresAt?: Date;
}

export async function insertAssignment(trx: Trx, assignment: NewAssignment): Promise<string> {
  const id = newId();
  await trx
    .insertInto('admin_role_assignment')
    .values({
      id,
      user_id: assignment.targetUserId,
      role: assignment.role,
      state: assignment.state,
      requested_by: assignment.requestedBy,
      approved_by: assignment.approvedBy ?? null,
      expires_at: assignment.expiresAt ?? null,
    })
    .execute();
  return id;
}

export async function findAssignmentById(
  db: Db | Trx,
  assignmentId: string,
): Promise<AdminAssignmentRow | undefined> {
  return db
    .selectFrom('admin_role_assignment')
    .select(COLUMNS)
    .where('id', '=', assignmentId)
    .executeTakeFirst();
}

export async function findAssignmentByIdForUpdate(
  trx: Trx,
  assignmentId: string,
): Promise<AdminAssignmentRow | undefined> {
  return trx
    .selectFrom('admin_role_assignment')
    .select(COLUMNS)
    .where('id', '=', assignmentId)
    .forUpdate()
    .executeTakeFirst();
}

/** CAS state transition; false when the version (or state) was stale. */
export async function casTransition(
  trx: Trx,
  assignmentId: string,
  expectedVersion: number,
  fromState: string,
  to: { state: 'active' | 'denied' | 'revoked' | 'expired'; actorColumn?: 'approved_by' | 'denied_by' | 'revoked_by'; actorId?: string },
): Promise<boolean> {
  const result = await trx
    .updateTable('admin_role_assignment')
    .set({
      state: to.state,
      ...(to.actorColumn !== undefined && to.actorId !== undefined
        ? { [to.actorColumn]: to.actorId }
        : {}),
    })
    .where('id', '=', assignmentId)
    .where('state', '=', fromState)
    .where('version', '=', expectedVersion)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export interface AssignmentFilter {
  state?: string;
  userId?: string;
}

export async function listAssignments(
  db: Db | Trx,
  filter: AssignmentFilter,
): Promise<AdminAssignmentRow[]> {
  let query = db.selectFrom('admin_role_assignment').select(COLUMNS);
  if (filter.state !== undefined) query = query.where('state', '=', filter.state);
  if (filter.userId !== undefined) query = query.where('user_id', '=', filter.userId);
  return query.orderBy('created_at', 'desc').execute();
}

/** Finalizes active assignments whose expiry passed; returns the finalized
 *  rows' identifiers. Row locks make concurrent sweeps converge: a second
 *  processor re-evaluates the committed `state` and skips already-expired
 *  rows, so each assignment transitions (and is returned) exactly once. */
export async function expireDueAssignments(
  trx: Trx,
): Promise<{ id: string; user_id: string }[]> {
  return trx
    .updateTable('admin_role_assignment')
    .set({ state: 'expired' })
    .where('state', '=', 'active')
    .where('expires_at', 'is not', null)
    .where('expires_at', '<=', new Date())
    .returning(['id', 'user_id'])
    .execute();
}

/** Any assignment rows at all (bootstrap zero-state check). */
export async function countAssignments(trx: Trx): Promise<number> {
  const row = await trx
    .selectFrom('admin_role_assignment')
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Roles a target currently holds ACTIVE that conflict with a new role
 *  (docs/26 §7.4 D4 matrix) — service-level courtesy check; the database
 *  trigger remains the authority under concurrency. */
export function conflictingRolesFor(role: AdminRole): readonly AdminRole[] {
  switch (role) {
    case 'auditor':
      return ['operations', 'support', 'finance', 'access_admin'];
    case 'access_admin':
      return ['finance', 'auditor'];
    case 'finance':
      return ['access_admin', 'auditor'];
    default:
      return ['auditor'];
  }
}
