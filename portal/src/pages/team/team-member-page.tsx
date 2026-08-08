import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
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
import type { StaffListView, StaffMembershipRecord } from '../../team/contract';
import {
  LAST_OWNER_COPY,
  SUSPENDED_TEAM_COPY,
  STEP_UP_NOTICE_COPY,
  TEAM_NO_ACCESS_COPY,
  formatTeamDate,
  isOwnMembership,
  isSoleActiveOwner,
  scopeSummary,
  teamAuthority,
} from './team-authority';
import { saveTeamIntent, takeTeamIntent } from './team-pending-intent';
import styles from './team.module.css';

/**
 * Member detail (docs/29 §6 route `/o/:organizationId/team/:membershipId`)
 * — a client-side composition over the ONE real staff read (no member
 * detail route exists in the backend). Unknown ids, other organizations'
 * membership ids, and revoked-elsewhere rows all render the SAME safe
 * not-found surface — no enumeration oracle. Role/scope CHANGE follows the
 * canonical backend semantics exactly: revoke the current membership, then
 * issue a NEW invitation the person accepts again — membership rows are
 * append-only history and are never edited in place.
 */
export function TeamMemberPage() {
  usePageTitle('Team member');
  const organization = useActiveOrganization();
  const { membershipId } = useParams<{ membershipId: string }>();
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
    enabled: canRead,
  });

  const backLink = (
    <ActionLink to={organizationPath(organization.id, 'team')}>Back to Team</ActionLink>
  );

  if (viewQuery.isPending || (canRead && staffQuery.isPending)) {
    return (
      <>
        <PageHeader title="Team member" description="Their role and branch access." />
        <p className={styles.loading} role="status">
          Loading team member…
        </p>
      </>
    );
  }
  if (view === null) {
    return (
      <>
        <PageHeader title="Team member" description="Their role and branch access." />
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load this workspace. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void viewQuery.refetch()}>
            Try again
          </Button>
        </div>
      </>
    );
  }
  if (!canRead || staffQuery.data?.kind === 'forbidden') {
    return (
      <>
        <PageHeader title="Team member" description="Their role and branch access." />
        <div className={styles.unavailable}>
          <InlineAlert tone="info">{TEAM_NO_ACCESS_COPY}</InlineAlert>
        </div>
      </>
    );
  }
  if (staffQuery.data?.kind !== 'loaded') {
    return (
      <>
        <PageHeader title="Team member" description="Their role and branch access." />
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load your team. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void staffQuery.refetch()}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  const staff = staffQuery.data.staff;
  const membership = staff.memberships.find((candidate) => candidate.id === membershipId);
  if (!membership) {
    // ONE safe shape for unknown/foreign ids — never a different message.
    return (
      <>
        <PageHeader title="Team member not found" description="" />
        <div className={styles.unavailable}>
          <p className={styles.emptyBody}>
            This team member doesn&rsquo;t exist in this organization.
          </p>
          {backLink}
        </div>
      </>
    );
  }

  return <MemberDetail view={view} staff={staff} membership={membership} />;
}

type RevokePhase =
  | { phase: 'idle' }
  | { phase: 'confirming'; afterStepUp: boolean }
  | { phase: 'changing'; afterStepUp: boolean }
  | { phase: 'working'; nextStep: 'none' | 'invite' }
  | { phase: 'stale' }
  | { phase: 'reloading' }
  | { phase: 'lastOwner' }
  | { phase: 'error'; message: string };

function MemberDetail({
  view,
  staff,
  membership,
}: {
  view: OrganizationView;
  staff: StaffListView;
  membership: StaffMembershipRecord;
}) {
  const { teamPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<RevokePhase>({ phase: 'idle' });
  const statusRef = useRef<HTMLDivElement>(null);
  // Same-tick duplicate lock: a double-activation of the confirm control
  // must never issue two mutations.
  const workingRef = useRef(false);

  const authority = teamAuthority(view);
  const own = isOwnMembership(membership, view);
  const revoked = membership.state === 'revoked';
  const soleOwner = isSoleActiveOwner(membership, staff.memberships);
  const roleLabel = PROVIDER_ROLE_LABELS[membership.role];

  usePageTitle(roleLabel);

  const focusStatus = () => {
    requestAnimationFrame(() => statusRef.current?.focus());
  };

  // Step-up return: rehydrate the interrupted removal for explicit
  // re-confirmation (never auto-execute).
  useEffect(() => {
    const intent = takeTeamIntent();
    if (
      intent?.kind === 'revokeMembership' &&
      intent.organizationId === view.organization.id &&
      intent.membershipId === membership.id &&
      membership.state === 'active'
    ) {
      setState({ phase: 'confirming', afterStepUp: true });
      focusStatus();
    }
    // Single consumption on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshStaff = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['staff', view.organization.id] }),
      queryClient.invalidateQueries({ queryKey: ['organizationView', view.organization.id] }),
    ]);

  const revoke = async (nextStep: 'none' | 'invite') => {
    if (workingRef.current) {
      return;
    }
    workingRef.current = true;
    setState({ phase: 'working', nextStep });
    const outcome = await teamPort.revokeMembership(
      view.organization.id,
      membership.id,
      membership.version,
    );
    // Stay latched through success and the step-up handoff (both leave
    // this page); a refusal that keeps the page live re-arms the action.
    if (outcome.kind !== 'membershipRevoked' && outcome.kind !== 'stepUpRequired') {
      workingRef.current = false;
    }
    switch (outcome.kind) {
      case 'membershipRevoked':
        await refreshStaff();
        if (nextStep === 'invite') {
          navigate(organizationPath(view.organization.id, 'team/invite'), {
            state: { prefill: { role: membership.role }, afterAccessChange: true },
          });
          return;
        }
        if (own) {
          // The caller removed their OWN access: the portal re-resolves it
          // (the fixture emits accessChanged) — leave the member page.
          navigate('/', { replace: true });
          return;
        }
        navigate(organizationPath(view.organization.id, 'team'));
        return;
      case 'stepUpRequired':
        saveTeamIntent({
          kind: 'revokeMembership',
          organizationId: view.organization.id,
          membershipId: membership.id,
        });
        navigate(`/step-up?returnTo=${encodeURIComponent(location.pathname)}`);
        return;
      case 'lastOwnerProtected':
        setState({ phase: 'lastOwner' });
        void refreshStaff();
        focusStatus();
        return;
      case 'staleVersion':
        setState({ phase: 'stale' });
        focusStatus();
        return;
      case 'organizationSuspended':
        setState({ phase: 'error', message: SUSPENDED_TEAM_COPY });
        void refreshStaff();
        focusStatus();
        return;
      case 'forbidden':
        setState({
          phase: 'error',
          message: 'Your role can’t change team access. The organization’s Owner does this.',
        });
        focusStatus();
        return;
      case 'notFound':
        setState({
          phase: 'error',
          message: 'We can’t find this team member any more.',
        });
        void refreshStaff();
        focusStatus();
        return;
      default:
        setState({
          phase: 'error',
          message: 'We couldn’t change this access right now. Try again in a moment.',
        });
        focusStatus();
    }
  };

  const loadLatest = async () => {
    setState({ phase: 'reloading' });
    await refreshStaff();
    setState({ phase: 'idle' });
    focusStatus();
  };

  return (
    <>
      <PageHeader
        title={own ? `${roleLabel} (you)` : roleLabel}
        description={
          revoked
            ? 'This person’s access has been removed. The record is kept for your organization’s history.'
            : 'Their role and branch access in this organization.'
        }
      />
      <div className={styles.detailWrap}>
        <ActionLink to={organizationPath(view.organization.id, 'team')}>Back to Team</ActionLink>

        {authority.suspended ? (
          <InlineAlert tone="info">{SUSPENDED_TEAM_COPY}</InlineAlert>
        ) : null}

        <div ref={statusRef} tabIndex={-1} className={styles.alertFocus}>
          {state.phase === 'confirming' && state.afterStepUp ? (
            <InlineAlert tone="info">{STEP_UP_NOTICE_COPY}</InlineAlert>
          ) : null}
          {state.phase === 'lastOwner' ? (
            <InlineAlert tone="error">{LAST_OWNER_COPY}</InlineAlert>
          ) : null}
          {state.phase === 'stale' ? (
            <InlineAlert tone="error">
              <p>
                This person&rsquo;s access changed since you loaded this page, so nothing was
                changed. Load the latest team and review before trying again.
              </p>
              <div className={styles.alertActions}>
                <Button variant="secondary" onClick={() => void loadLatest()}>
                  Load the latest team
                </Button>
              </div>
            </InlineAlert>
          ) : null}
          {state.phase === 'error' ? (
            <InlineAlert tone="error">{state.message}</InlineAlert>
          ) : null}
        </div>

        <section aria-label="Access details" className={styles.detailCard}>
          <dl className={styles.detailList}>
            <div className={styles.detailItem}>
              <dt>Person</dt>
              <dd>{own ? 'You' : 'Team member'}</dd>
            </div>
            <div className={styles.detailItem}>
              <dt>Role</dt>
              <dd>{roleLabel}</dd>
            </div>
            <div className={styles.detailItem}>
              <dt>Branch access</dt>
              <dd>{scopeSummary(membership.branchScopeKind, membership.branchIds, view.branches)}</dd>
            </div>
            <div className={styles.detailItem}>
              <dt>Joined</dt>
              <dd>{formatTeamDate(membership.createdAt)}</dd>
            </div>
            <div className={styles.detailItem}>
              <dt>Status</dt>
              <dd>{revoked ? 'Access removed' : 'Active'}</dd>
            </div>
          </dl>
        </section>

        {!revoked && authority.canManage ? (
          <>
            <section aria-label="Change role or branches" className={styles.managePanel}>
              <h2 className={styles.sectionTitle}>Change role or branches</h2>
              <p className={styles.emptyBody}>
                Access history is never edited. To change what{' '}
                {own ? 'you' : 'this person'} can do, their current access is removed and a new
                invitation is sent — the new access starts when they accept it with their email
                address.
              </p>
              {soleOwner ? (
                <p className={styles.protectNote}>{LAST_OWNER_COPY}</p>
              ) : (
                <Button
                  variant="secondary"
                  busy={state.phase === 'working' && state.nextStep === 'invite'}
                  busyLabel="Removing access…"
                  onClick={() => setState({ phase: 'changing', afterStepUp: false })}
                >
                  Change role or branches
                </Button>
              )}
            </section>

            <section aria-label="Remove access" className={styles.managePanel}>
              <h2 className={styles.sectionTitle}>Remove access</h2>
              <p className={styles.emptyBody}>
                {own
                  ? 'You lose access to this organization immediately. The membership record is kept in the team history.'
                  : 'They lose access to this organization immediately. The membership record is kept in the team history.'}
              </p>
              {soleOwner ? (
                <p className={styles.protectNote}>{LAST_OWNER_COPY}</p>
              ) : (
                <Button
                  variant="secondary"
                  busy={state.phase === 'working' && state.nextStep === 'none'}
                  busyLabel="Removing access…"
                  onClick={() => setState({ phase: 'confirming', afterStepUp: false })}
                >
                  Remove access
                </Button>
              )}
            </section>
          </>
        ) : null}

        {revoked ? (
          <p className={styles.protectNote}>
            To give this person access again, send them a new invitation from the Team page.
          </p>
        ) : null}
      </div>

      {state.phase === 'confirming' ? (
        <ConfirmDialog
          title={own ? 'Remove your own access?' : `Remove this ${roleLabel}’s access?`}
          confirmLabel="Remove access"
          cancelLabel="Keep access"
          destructive
          onConfirm={() => void revoke('none')}
          onCancel={() => setState({ phase: 'idle' })}
        >
          <p>
            {own ? 'Your' : 'Their'} access —{' '}
            <strong>
              {roleLabel} ·{' '}
              {scopeSummary(membership.branchScopeKind, membership.branchIds, view.branches)}
            </strong>{' '}
            — ends immediately. The record stays in your team history.
          </p>
          {own ? (
            <p>
              <strong>This is your own access.</strong> You&rsquo;ll be signed out of this
              organization&rsquo;s workspace right away and can&rsquo;t undo this yourself.
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}

      {state.phase === 'changing' ? (
        <ConfirmDialog
          title="Change role or branches?"
          confirmLabel="Remove access and continue"
          cancelLabel="Cancel"
          destructive
          onConfirm={() => void revoke('invite')}
          onCancel={() => setState({ phase: 'idle' })}
        >
          <p>
            This happens in two steps, exactly as your organization&rsquo;s records work:
          </p>
          <p>
            1. {own ? 'Your' : 'Their'} current access —{' '}
            <strong>
              {roleLabel} ·{' '}
              {scopeSummary(membership.branchScopeKind, membership.branchIds, view.branches)}
            </strong>{' '}
            — is removed now.
          </p>
          <p>
            2. You send a new invitation with the new role and branches. The new access starts
            only when they accept it with their email address — until then they have no access.
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
