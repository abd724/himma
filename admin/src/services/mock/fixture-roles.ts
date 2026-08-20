import type { AdminRolesPort, RoleActionOutcome } from '../../roles/contract';

/**
 * Deterministic FIXTURE roles-administration data (W3-9) behind the same
 * port the live runtime implements. Semantics mirror the CERTIFIED B2-5
 * machine truthfully:
 * - exactly five roles; NO superadmin can be expressed;
 * - FINANCE-CAPABLE grants (finance, access_admin) are DUAL-CONTROL: they
 *   rest at `requested` and the requester can never approve their own
 *   request (dualControlViolation), exactly like the database trigger;
 *   other roles activate immediately on an access administrator's request
 *   (the certified B2-5 truth);
 * - requested → active|denied, active → revoked; finalized rows refuse
 *   further decisions (alreadyFinalized); an active duplicate refuses
 *   roleConflict;
 * - every decision is CAS-checked (stale → staleVersion, no change);
 * - reads need roles.view; mutations need roles.administer AND honour the
 *   action-level step-up seam (D-W3-5).
 * Live mode can never reach this module (composition-locked).
 */

interface FixtureAssignmentRow {
  id: string;
  userId: string;
  role: string;
  state: string;
  requestedBy: string;
  approvedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  version: number;
  targetEmail: string;
}

export interface FixtureRolesData {
  assignments: FixtureAssignmentRow[];
  createdCounter: number;
}

/** Stable fictional user ids for the demo identities (fixture-admin's
 *  accessView uses `fixture-<email>` — these mirror that shape). */
const USER = {
  ops: 'fixture-ops@himma.demo',
  access: 'fixture-access@himma.demo',
  audit: 'fixture-audit@himma.demo',
  duo: 'fixture-duo@himma.demo',
  support: 'fixture-support@himma.demo',
  newcomer: 'fixture-newcomer@himma.demo',
};

export function createFixtureRolesData(): FixtureRolesData {
  return {
    createdCounter: 0,
    assignments: [
      {
        id: 'assignment-ops',
        userId: USER.ops,
        targetEmail: 'ops@himma.demo',
        role: 'operations',
        state: 'active',
        requestedBy: USER.access,
        approvedBy: USER.duo,
        expiresAt: null,
        createdAt: '2026-08-01T09:00:00.000Z',
        version: 2,
      },
      {
        id: 'assignment-audit',
        userId: USER.audit,
        targetEmail: 'audit@himma.demo',
        role: 'auditor',
        state: 'active',
        requestedBy: USER.access,
        approvedBy: USER.duo,
        expiresAt: null,
        createdAt: '2026-08-02T09:00:00.000Z',
        version: 2,
      },
      {
        id: 'assignment-support',
        userId: USER.support,
        targetEmail: 'support@himma.demo',
        role: 'support',
        state: 'active',
        requestedBy: USER.access,
        approvedBy: USER.duo,
        expiresAt: null,
        createdAt: '2026-08-03T09:00:00.000Z',
        version: 2,
      },
      // A PENDING request awaiting a SECOND access administrator — the
      // dual-control demo case. Requested by access@himma.demo, so that
      // identity's own approval must refuse.
      {
        id: 'assignment-pending-finance',
        userId: USER.newcomer,
        targetEmail: 'newcomer@himma.demo',
        role: 'finance',
        state: 'requested',
        requestedBy: USER.access,
        approvedBy: null,
        expiresAt: null,
        createdAt: '2026-08-18T09:00:00.000Z',
        version: 1,
      },
      {
        id: 'assignment-revoked-old',
        userId: USER.support,
        targetEmail: 'support@himma.demo',
        role: 'finance',
        state: 'revoked',
        requestedBy: USER.access,
        approvedBy: USER.duo,
        expiresAt: null,
        createdAt: '2026-07-01T09:00:00.000Z',
        version: 3,
      },
    ],
  };
}

export interface FixtureRolesAuthority {
  /** null = no session; the ids mirror fixture-admin's accessView. */
  currentAuthority(): {
    userId: string;
    hasRolesView: boolean;
    hasRolesAdminister: boolean;
  } | null;
  takeFailure(): boolean;
  stepUpDemanded(): boolean;
}

export function createFixtureRolesPort(
  authority: FixtureRolesAuthority,
  data: FixtureRolesData,
): AdminRolesPort {
  const admitRead = (): RoleActionOutcome | null => {
    const auth = authority.currentAuthority();
    if (auth === null) return { kind: 'unavailable' };
    if (authority.takeFailure()) return { kind: 'unavailable' };
    if (!auth.hasRolesView) return { kind: 'forbidden' };
    return null;
  };
  const admitMutation = (): { refused: RoleActionOutcome | null; userId: string } => {
    const auth = authority.currentAuthority();
    if (auth === null) return { refused: { kind: 'unavailable' }, userId: '' };
    if (authority.takeFailure()) return { refused: { kind: 'unavailable' }, userId: auth.userId };
    if (!auth.hasRolesAdminister) return { refused: { kind: 'forbidden' }, userId: auth.userId };
    if (authority.stepUpDemanded()) {
      return { refused: { kind: 'stepUpRequired' }, userId: auth.userId };
    }
    return { refused: null, userId: auth.userId };
  };
  const byId = (assignmentId: string) =>
    data.assignments.find((entry) => entry.id === assignmentId);

  return {
    async listAssignments(params) {
      const refused = admitRead();
      if (refused !== null) {
        return refused.kind === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
      }
      const assignments = data.assignments
        .filter(
          (entry) =>
            (params.state === undefined || entry.state === params.state) &&
            (params.userId === undefined || entry.userId === params.userId),
        )
        .map(({ targetEmail, ...assignment }) => {
          void targetEmail;
          return { ...assignment };
        });
      return { kind: 'loaded', assignments };
    },

    async requestRole(input) {
      const { refused, userId } = admitMutation();
      if (refused !== null) return refused;
      if (
        data.assignments.some(
          (entry) =>
            entry.userId === input.targetUserId &&
            entry.role === input.role &&
            (entry.state === 'active' || entry.state === 'requested'),
        )
      ) {
        return { kind: 'roleConflict' };
      }
      data.createdCounter += 1;
      // The certified split: finance-capable roles rest at `requested`
      // (dual control); every other role activates immediately.
      const financeCapable = input.role === 'finance' || input.role === 'access_admin';
      data.assignments.unshift({
        id: `assignment-created-${data.createdCounter}`,
        userId: input.targetUserId,
        targetEmail: input.targetUserId,
        role: input.role,
        state: financeCapable ? 'requested' : 'active',
        requestedBy: userId,
        approvedBy: financeCapable ? null : userId,
        expiresAt: input.expiresAt ?? null,
        createdAt: '2026-08-20T09:00:00.000Z',
        version: 1,
      });
      return { kind: 'completed' };
    },

    async approveRequest(assignmentId, input) {
      const { refused, userId } = admitMutation();
      if (refused !== null) return refused;
      const assignment = byId(assignmentId);
      if (assignment === undefined) return { kind: 'notFound' };
      if (assignment.state !== 'requested') return { kind: 'alreadyFinalized' };
      if (assignment.version !== input.expectedVersion) return { kind: 'staleVersion' };
      // DUAL CONTROL — the database trigger truth: requester ≠ approver.
      if (assignment.requestedBy === userId) return { kind: 'dualControlViolation' };
      assignment.state = 'active';
      assignment.approvedBy = userId;
      assignment.version += 1;
      return { kind: 'completed' };
    },

    async denyRequest(assignmentId, input) {
      const { refused, userId } = admitMutation();
      if (refused !== null) return refused;
      const assignment = byId(assignmentId);
      if (assignment === undefined) return { kind: 'notFound' };
      if (assignment.state !== 'requested') return { kind: 'alreadyFinalized' };
      if (assignment.version !== input.expectedVersion) return { kind: 'staleVersion' };
      if (assignment.requestedBy === userId) return { kind: 'dualControlViolation' };
      assignment.state = 'denied';
      assignment.approvedBy = userId;
      assignment.version += 1;
      return { kind: 'completed' };
    },

    async revokeAssignment(assignmentId, input) {
      const { refused } = admitMutation();
      if (refused !== null) return refused;
      const assignment = byId(assignmentId);
      if (assignment === undefined) return { kind: 'notFound' };
      if (assignment.state !== 'active') return { kind: 'alreadyFinalized' };
      if (assignment.version !== input.expectedVersion) return { kind: 'staleVersion' };
      assignment.state = 'revoked';
      assignment.version += 1;
      return { kind: 'completed' };
    },
  };
}
