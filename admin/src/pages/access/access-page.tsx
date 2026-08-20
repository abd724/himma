import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRolesPort } from '../../app/app';
import { useSession, useSessionActions } from '../../auth/session-context';
import {
  ADMIN_ROLE_OPTIONS,
  type AdminRoleOption,
  type RoleActionOutcome,
  type RoleAssignmentRecord,
} from '../../roles/contract';
import pageStyles from '../pages.module.css';
import styles from '../providers/providers.module.css';

/**
 * W3-9 access administration workspace (AD-17) over the CERTIFIED B2-5
 * routes. Exactly five canonical roles — no superadmin exists anywhere to
 * offer. Grants are DUAL-CONTROL: one access administrator requests, a
 * DIFFERENT one approves (the database trigger is the final authority;
 * this page only explains its distinct refusal). Auditors read; only
 * access administrators mutate — and every mutation additionally rides
 * the adminStepUp recent-factor boundary (D-W3-5 owner-pending), handled
 * by the same action-level re-verification seam as every other workspace.
 */

const STATE_OPTIONS = ['requested', 'active', 'denied', 'revoked', 'expired'] as const;

const ACTION_MESSAGES: Record<
  Exclude<RoleActionOutcome['kind'], 'completed' | 'stepUpRequired'>,
  string
> = {
  dualControlViolation:
    'Dual control: the administrator who requested a role can never approve it. A different access administrator must decide.',
  alreadyFinalized: 'This assignment was already decided. Refresh and re-check.',
  roleConflict: 'That user already holds (or is already requested for) this role.',
  staleVersion: 'This assignment changed while you were working. The view has been refreshed — re-check and try again.',
  forbidden: 'Your roles don’t include access administration.',
  notFound: 'This assignment could not be found. Refresh the view.',
  unavailable: 'The access administration service is temporarily unavailable. Try again shortly.',
};

function stateBadge(state: string): ReactNode {
  const tone =
    state === 'active'
      ? styles.badgeLive
      : state === 'requested'
        ? styles.badgeQueue
        : state === 'denied' || state === 'revoked'
          ? styles.badgeBlocked
          : styles.badgeNeutral;
  return <span className={`${styles.badge} ${tone}`}>{state}</span>;
}

const dateFormat = new Intl.DateTimeFormat('en-AE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function AccessPage() {
  const port = useRolesPort();
  const session = useSession();
  const sessionActions = useSessionActions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawState = searchParams.get('state');
  const state = STATE_OPTIONS.includes(rawState as (typeof STATE_OPTIONS)[number])
    ? (rawState as string)
    : undefined;
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpNeeded, setStepUpNeeded] = useState(false);
  const [stepUpCode, setStepUpCode] = useState('');
  const [request, setRequest] = useState({ targetUserId: '', role: 'support' as AdminRoleOption });

  const canAdminister =
    session.status === 'active' && session.access.capabilities.includes('roles.administer');

  const query = useQuery({
    queryKey: ['admin-role-assignments', state ?? 'all'],
    async queryFn() {
      const outcome = await port.listAssignments(state !== undefined ? { state } : {});
      if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
      return outcome.assignments;
    },
    retry: (failureCount, error) => error.message !== 'forbidden' && failureCount < 1,
  });

  const afterAction = async (outcome: RoleActionOutcome) => {
    if (outcome.kind === 'completed') {
      setNotice(null);
      setStepUpNeeded(false);
      await queryClient.invalidateQueries({ queryKey: ['admin-role-assignments'] });
      return;
    }
    if (outcome.kind === 'stepUpRequired') {
      setStepUpNeeded(true);
      setNotice(
        'This action needs a fresh verification of your identity. Enter your authenticator code, then try the action again.',
      );
      return;
    }
    if (outcome.kind === 'staleVersion' || outcome.kind === 'alreadyFinalized') {
      await queryClient.invalidateQueries({ queryKey: ['admin-role-assignments'] });
    }
    setNotice(ACTION_MESSAGES[outcome.kind]);
  };

  const decide = useMutation({
    mutationFn: (input: {
      action: 'approve' | 'deny' | 'revoke';
      assignmentId: string;
      expectedVersion: number;
    }) =>
      input.action === 'approve'
        ? port.approveRequest(input.assignmentId, { expectedVersion: input.expectedVersion })
        : input.action === 'deny'
          ? port.denyRequest(input.assignmentId, { expectedVersion: input.expectedVersion })
          : port.revokeAssignment(input.assignmentId, { expectedVersion: input.expectedVersion }),
    onSuccess: afterAction,
  });
  const create = useMutation({
    mutationFn: () =>
      port.requestRole({ targetUserId: request.targetUserId.trim(), role: request.role }),
    async onSuccess(outcome) {
      await afterAction(outcome);
      if (outcome.kind === 'completed') setRequest({ targetUserId: '', role: 'support' });
    },
  });
  const busy = decide.isPending || create.isPending;

  const submitStepUp = async (event: FormEvent) => {
    event.preventDefault();
    const result = await sessionActions.completeStepUpTotp(stepUpCode.trim());
    if (result.kind === 'completed') {
      setStepUpNeeded(false);
      setStepUpCode('');
      setNotice('Identity re-verified — you can run the action again now.');
    } else {
      setNotice('That code wasn’t accepted. Try again.');
    }
  };

  const rowActions = (assignment: RoleAssignmentRecord): ReactNode => {
    if (!canAdminister) return <span className={styles.muted}>—</span>;
    if (assignment.state === 'requested') {
      return (
        <span className={styles.actionRow}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() =>
              decide.mutate({
                action: 'approve',
                assignmentId: assignment.id,
                expectedVersion: assignment.version,
              })
            }
          >
            Approve
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() =>
              decide.mutate({
                action: 'deny',
                assignmentId: assignment.id,
                expectedVersion: assignment.version,
              })
            }
          >
            Deny
          </button>
        </span>
      );
    }
    if (assignment.state === 'active') {
      return (
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy}
          onClick={() =>
            decide.mutate({
              action: 'revoke',
              assignmentId: assignment.id,
              expectedVersion: assignment.version,
            })
          }
        >
          Revoke
        </button>
      );
    }
    return <span className={styles.muted}>Finalized</span>;
  };

  return (
    <>
      <h1 className={pageStyles.pageTitle}>Access administration</h1>
      <p className={pageStyles.lead}>
        Exactly five internal roles exist — there is no super-administrator. Sensitive grants
        (finance, access administrator) take TWO access administrators: one requests, a different
        one approves (dual control, enforced by the database). Other roles activate on request.
      </p>
      {!canAdminister ? (
        <p className={styles.subSecondary}>
          Your roles allow reviewing assignments, not changing them — access administration
          actions belong to the Access Administrator role.
        </p>
      ) : null}
      <div className={styles.controls}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="access-state">
            Assignment state
          </label>
          <select
            id="access-state"
            className={styles.stateSelect}
            value={state ?? ''}
            onChange={(event) => {
              setSearchParams((previous) => {
                const next = new URLSearchParams(previous);
                if (event.target.value === '') {
                  next.delete('state');
                } else {
                  next.set('state', event.target.value);
                }
                return next;
              });
            }}
          >
            <option value="">All assignments</option>
            {STATE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      {notice !== null ? (
        <p className={styles.actionNotice} role="alert">
          {notice}
        </p>
      ) : null}
      {stepUpNeeded ? (
        <form className={styles.stepUpForm} onSubmit={(event) => void submitStepUp(event)}>
          <label className={styles.fieldLabel} htmlFor="access-step-up">
            Verification code
          </label>
          <input
            id="access-step-up"
            className={styles.searchInput}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={stepUpCode}
            onChange={(event) => setStepUpCode(event.target.value)}
          />
          <button type="submit" className={styles.secondaryButton}>
            Confirm identity
          </button>
        </form>
      ) : null}

      {query.isPending ? (
        <div className={styles.statusPanel} role="status">
          Loading role assignments…
        </div>
      ) : query.isError ? (
        query.error.message === 'forbidden' ? (
          <div className={styles.statusPanel}>Your roles don’t include access review.</div>
        ) : (
          <div className={styles.statusPanel} role="alert">
            <p style={{ marginTop: 0 }}>We couldn’t load the role assignments.</p>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void query.refetch()}
            >
              Try again
            </button>
          </div>
        )
      ) : query.data.length === 0 ? (
        <div className={styles.statusPanel}>No role assignments match this view.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">State</th>
                <th scope="col">Requested by</th>
                <th scope="col">Approved by</th>
                <th scope="col">Created</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((assignment) => (
                <tr key={assignment.id}>
                  <td data-label="User">
                    <code>{assignment.userId}</code>
                  </td>
                  <td data-label="Role">{assignment.role}</td>
                  <td data-label="State">{stateBadge(assignment.state)}</td>
                  <td data-label="Requested by">
                    <code>{assignment.requestedBy}</code>
                  </td>
                  <td data-label="Approved by">
                    {assignment.approvedBy === null ? '—' : <code>{assignment.approvedBy}</code>}
                  </td>
                  <td data-label="Created">{dateFormat.format(new Date(assignment.createdAt))}</td>
                  <td data-label="Actions">{rowActions(assignment)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canAdminister ? (
        <section className={styles.sectionPanel} aria-labelledby="access-request-title">
          <h2 id="access-request-title" className={styles.sectionTitle}>
            Request a role
          </h2>
          <p className={styles.subSecondary}>
            Finance and access-administrator requests stay pending until a DIFFERENT access
            administrator approves them; other roles activate immediately.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="access-target">
                Target user id
              </label>
              <input
                id="access-target"
                className={styles.searchInput}
                required
                value={request.targetUserId}
                onChange={(event) =>
                  setRequest({ ...request, targetUserId: event.target.value })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="access-role">
                Role
              </label>
              <select
                id="access-role"
                className={styles.stateSelect}
                value={request.role}
                onChange={(event) =>
                  setRequest({ ...request, role: event.target.value as AdminRoleOption })
                }
              >
                {ADMIN_ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.actionRow}>
              <button type="submit" className={styles.primaryButton} disabled={busy}>
                Request role
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </>
  );
}
