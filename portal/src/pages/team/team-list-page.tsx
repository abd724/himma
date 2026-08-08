import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { usePortalPorts } from '../../app/ports-context';
import { ActionLink } from '../../components/ui/action-link';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { InlineAlert } from '../../components/ui/inline-alert';
import { PageHeader } from '../../components/ui/page-header';
import { usePageTitle } from '../../hooks/use-page-title';
import { organizationPath } from '../../navigation/nav-items';
import { useActiveOrganization } from '../../organization/organization-context';
import type { OrganizationView } from '../../profile/contract';
import { PROVIDER_ROLE_LABELS } from '../../provider-access/contract';
import type { StaffInvitationRecord, StaffListView, StaffMembershipRecord } from '../../team/contract';
import {
  SUSPENDED_TEAM_COPY,
  TEAM_NO_ACCESS_COPY,
  STEP_UP_NOTICE_COPY,
  formatTeamDate,
  invitationIsOverdue,
  isOwnMembership,
  scopeSummary,
  teamAuthority,
} from './team-authority';
import { saveTeamIntent, takeTeamIntent } from './team-pending-intent';
import styles from './team.module.css';

/**
 * Team index (docs/29 §6 route `/o/:organizationId/team`) — the directory
 * over the ONE real staff read (`GET /provider/organizations/:orgId/staff`,
 * capability `staff.read`, OWNER ONLY in the canonical registry). Accepted
 * memberships (including revoked history) and invitations are separate
 * truths and render as separate sections — an invitation is never shown as
 * someone who already has access. Roles without `staff.read` get a
 * truthful explanation and NO staff data is fetched for them.
 */
export function TeamPage() {
  usePageTitle('Team');
  const organization = useActiveOrganization();
  const { profilePort, teamPort } = usePortalPorts();

  const viewQuery = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });

  const view = viewQuery.data?.kind === 'loaded' ? viewQuery.data.view : null;
  const canRead = view !== null && teamAuthority(view).canRead;

  const staffQuery = useQuery({
    queryKey: ['staff', organization.id],
    queryFn: () => teamPort.loadStaff(organization.id),
    // Never fetched for roles without staff.read — the backend would
    // refuse the read, and no staff data may reach their client state.
    enabled: canRead,
  });

  return (
    <>
      <PageHeader
        title="Team"
        description="Who works in this organization — their roles, branch access, and pending invitations."
      />
      {viewQuery.isPending ? (
        <p className={styles.loading} role="status">
          Loading your team…
        </p>
      ) : view === null ? (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load this workspace. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void viewQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : !canRead ? (
        <TeamNoAccess />
      ) : staffQuery.isPending ? (
        <p className={styles.loading} role="status">
          Loading your team…
        </p>
      ) : staffQuery.data?.kind === 'loaded' ? (
        <TeamContent view={view} staff={staffQuery.data.staff} />
      ) : staffQuery.data?.kind === 'forbidden' ? (
        <TeamNoAccess />
      ) : (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load your team. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void staffQuery.refetch()}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

/** Truthful no-access surface — no fake disabled controls, no staff data. */
function TeamNoAccess() {
  return (
    <div className={styles.emptyCard}>
      <Users className={styles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
      <h2 className={styles.emptyTitle}>Team is managed by the Owner</h2>
      <p className={styles.emptyBody}>{TEAM_NO_ACCESS_COPY}</p>
    </div>
  );
}

function TeamContent({ view, staff }: { view: OrganizationView; staff: StaffListView }) {
  const authority = teamAuthority(view);
  const activeMembers = staff.memberships.filter((row) => row.state === 'active');
  const formerMembers = staff.memberships.filter((row) => row.state === 'revoked');
  const openInvitations = staff.invitations.filter((row) => row.state === 'sent');
  const settledInvitations = staff.invitations.filter((row) => row.state !== 'sent');

  return (
    <div className={styles.contentWrap}>
      {authority.suspended ? <InlineAlert tone="info">{SUSPENDED_TEAM_COPY}</InlineAlert> : null}

      <section aria-labelledby="team-members-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="team-members-heading" className={styles.sectionTitle}>
            Team members
          </h2>
          {authority.canManage ? (
            <ActionLink to={organizationPath(view.organization.id, 'team/invite')}>
              Invite someone
            </ActionLink>
          ) : null}
        </div>
        <p className={styles.summary} role="status">
          {activeMembers.length} {activeMembers.length === 1 ? 'person has' : 'people have'}{' '}
          active access
        </p>
        <ul className={styles.memberList} aria-label="Team members">
          {activeMembers.map((membership) => (
            <MemberRow key={membership.id} membership={membership} view={view} />
          ))}
        </ul>
        {formerMembers.length > 0 ? (
          <details className={styles.historyDetails}>
            <summary className={styles.historySummary}>
              Former members ({formerMembers.length})
            </summary>
            <ul className={styles.memberList} aria-label="Former members">
              {formerMembers.map((membership) => (
                <MemberRow key={membership.id} membership={membership} view={view} />
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <InvitationsSection
        view={view}
        openInvitations={openInvitations}
        settledInvitations={settledInvitations}
        canManage={authority.canManage}
        suspended={authority.suspended}
      />
    </div>
  );
}

function MemberRow({
  membership,
  view,
}: {
  membership: StaffMembershipRecord;
  view: OrganizationView;
}) {
  const own = isOwnMembership(membership, view);
  const revoked = membership.state === 'revoked';
  return (
    <li className={styles.memberRow}>
      <Link
        className={styles.memberLink}
        to={organizationPath(view.organization.id, `team/${membership.id}`)}
      >
        <span className={styles.memberMain}>
          <span className={styles.memberName}>
            {PROVIDER_ROLE_LABELS[membership.role]}
            {own ? <span className={styles.youChip}>You</span> : null}
          </span>
          <span className={styles.memberMeta}>
            {scopeSummary(membership.branchScopeKind, membership.branchIds, view.branches)}
            {' · '}
            {revoked ? 'Access removed' : `Joined ${formatTeamDate(membership.createdAt)}`}
          </span>
        </span>
        <span
          className={`${styles.statusChip} ${revoked ? styles.statusInactive : styles.statusActive}`}
        >
          {revoked ? 'Removed' : 'Active'}
        </span>
      </Link>
    </li>
  );
}

type InvitationActionPhase =
  | { phase: 'idle' }
  | { phase: 'confirming'; invitation: StaffInvitationRecord; afterStepUp: boolean }
  | { phase: 'working'; invitation: StaffInvitationRecord }
  | { phase: 'error'; message: string }
  | { phase: 'revoked'; email: string };

/**
 * Pending invitations — the real lifecycle only (`sent → accepted | revoked
 * | expired`). An overdue `sent` row renders as expired (time truth: it can
 * no longer be accepted) while revocation stays available. Revoking is
 * step-up-gated by the real route policy; the intent survives the
 * round-trip in memory and is re-confirmed explicitly.
 */
function InvitationsSection({
  view,
  openInvitations,
  settledInvitations,
  canManage,
  suspended,
}: {
  view: OrganizationView;
  openInvitations: readonly StaffInvitationRecord[];
  settledInvitations: readonly StaffInvitationRecord[];
  canManage: boolean;
  suspended: boolean;
}) {
  const { teamPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<InvitationActionPhase>({ phase: 'idle' });
  const statusRef = useRef<HTMLDivElement>(null);
  // Same-tick duplicate lock: a double-activation of the confirm control
  // must never issue two mutations.
  const workingRef = useRef(false);

  const focusStatus = () => {
    requestAnimationFrame(() => statusRef.current?.focus());
  };

  // Step-up return path: rehydrate an interrupted revocation and ask for an
  // explicit re-confirmation (never auto-execute after the interstitial).
  useEffect(() => {
    const intent = takeTeamIntent();
    if (
      intent?.kind === 'revokeInvitation' &&
      intent.organizationId === view.organization.id
    ) {
      const invitation = openInvitations.find((row) => row.id === intent.invitationId);
      if (invitation) {
        setState({ phase: 'confirming', invitation, afterStepUp: true });
        focusStatus();
      }
    }
    // Run once on mount: the intent store is single-consumption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const revoke = async (invitation: StaffInvitationRecord) => {
    if (workingRef.current) {
      return;
    }
    workingRef.current = true;
    setState({ phase: 'working', invitation });
    const outcome = await teamPort.revokeInvitation(view.organization.id, invitation.id);
    workingRef.current = false;
    switch (outcome.kind) {
      case 'invitationRevoked':
        await queryClient.invalidateQueries({ queryKey: ['staff', view.organization.id] });
        setState({ phase: 'revoked', email: invitation.email });
        focusStatus();
        return;
      case 'stepUpRequired':
        saveTeamIntent({
          kind: 'revokeInvitation',
          organizationId: view.organization.id,
          invitationId: invitation.id,
        });
        navigate(`/step-up?returnTo=${encodeURIComponent(location.pathname)}`);
        return;
      case 'lifecycleConflict':
        setState({
          phase: 'error',
          message:
            'This invitation has already been answered or has expired, so it can’t be withdrawn.',
        });
        void queryClient.invalidateQueries({ queryKey: ['staff', view.organization.id] });
        focusStatus();
        return;
      case 'organizationSuspended':
        setState({ phase: 'error', message: SUSPENDED_TEAM_COPY });
        void queryClient.invalidateQueries({ queryKey: ['organizationView', view.organization.id] });
        focusStatus();
        return;
      case 'forbidden':
        setState({
          phase: 'error',
          message: 'Your role can’t manage invitations. The organization’s Owner does this.',
        });
        focusStatus();
        return;
      case 'notFound':
        setState({
          phase: 'error',
          message: 'We can’t find this invitation any more.',
        });
        void queryClient.invalidateQueries({ queryKey: ['staff', view.organization.id] });
        focusStatus();
        return;
      default:
        setState({
          phase: 'error',
          message: 'We couldn’t withdraw this invitation right now. Try again in a moment.',
        });
        focusStatus();
    }
  };

  return (
    <section aria-labelledby="invitations-heading" className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 id="invitations-heading" className={styles.sectionTitle}>
          Invitations
        </h2>
      </div>
      <p className={styles.summary}>
        People you&rsquo;ve invited who haven&rsquo;t joined yet. They get access only after
        accepting their invitation with the email address it was sent to.
      </p>

      <div ref={statusRef} tabIndex={-1} className={styles.alertFocus}>
        {state.phase === 'error' ? <InlineAlert tone="error">{state.message}</InlineAlert> : null}
        {state.phase === 'revoked' ? (
          <InlineAlert tone="success">
            The invitation for {state.email} has been withdrawn. Its code no longer works.
          </InlineAlert>
        ) : null}
        {state.phase === 'confirming' && state.afterStepUp ? (
          <InlineAlert tone="info">{STEP_UP_NOTICE_COPY}</InlineAlert>
        ) : null}
      </div>

      {openInvitations.length === 0 ? (
        <p className={styles.emptyNote}>No open invitations right now.</p>
      ) : (
        <ul className={styles.invitationList} aria-label="Open invitations">
          {openInvitations.map((invitation) => {
            const overdue = invitationIsOverdue(invitation);
            return (
              <li key={invitation.id} className={styles.invitationRow}>
                <span className={styles.memberMain}>
                  <span className={styles.memberName}>{invitation.email}</span>
                  <span className={styles.memberMeta}>
                    {PROVIDER_ROLE_LABELS[invitation.role]}
                    {' · '}
                    {scopeSummary(invitation.branchScopeKind, invitation.branchIds, view.branches)}
                    {' · '}
                    {overdue
                      ? `Expired ${formatTeamDate(invitation.expiresAt)} — it can no longer be accepted`
                      : `Expires ${formatTeamDate(invitation.expiresAt)}`}
                  </span>
                </span>
                <span className={styles.invitationActions}>
                  <span
                    className={`${styles.statusChip} ${overdue ? styles.statusInactive : styles.statusPending}`}
                  >
                    {overdue ? 'Expired' : 'Awaiting response'}
                  </span>
                  {canManage ? (
                    <Button
                      variant="secondary"
                      busy={state.phase === 'working' && state.invitation.id === invitation.id}
                      busyLabel="Withdrawing…"
                      onClick={() => setState({ phase: 'confirming', invitation, afterStepUp: false })}
                    >
                      Withdraw
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {suspended && openInvitations.length > 0 ? (
        <p className={styles.emptyNote}>
          Invitations can&rsquo;t be changed while the organization is suspended.
        </p>
      ) : null}

      {settledInvitations.length > 0 ? (
        <details className={styles.historyDetails}>
          <summary className={styles.historySummary}>
            Past invitations ({settledInvitations.length})
          </summary>
          <ul className={styles.invitationList} aria-label="Past invitations">
            {settledInvitations.map((invitation) => (
              <li key={invitation.id} className={styles.invitationRow}>
                <span className={styles.memberMain}>
                  <span className={styles.memberName}>{invitation.email}</span>
                  <span className={styles.memberMeta}>
                    {PROVIDER_ROLE_LABELS[invitation.role]}
                    {' · '}
                    {scopeSummary(invitation.branchScopeKind, invitation.branchIds, view.branches)}
                  </span>
                </span>
                <span
                  className={`${styles.statusChip} ${
                    invitation.state === 'accepted' ? styles.statusActive : styles.statusInactive
                  }`}
                >
                  {invitation.state === 'accepted'
                    ? 'Accepted'
                    : invitation.state === 'revoked'
                      ? 'Withdrawn'
                      : 'Expired'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {state.phase === 'confirming' ? (
        <ConfirmDialog
          title={`Withdraw the invitation for ${state.invitation.email}?`}
          confirmLabel="Withdraw invitation"
          cancelLabel="Keep invitation"
          destructive
          onConfirm={() => void revoke(state.invitation)}
          onCancel={() => setState({ phase: 'idle' })}
        >
          <p>
            Their invitation code stops working immediately. Anyone who has already accepted an
            invitation keeps their access — withdrawing an invitation never removes an existing
            team member.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
