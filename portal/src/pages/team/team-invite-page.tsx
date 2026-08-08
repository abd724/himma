import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useBlocker, useLocation, useNavigate } from 'react-router-dom';
import { usePortalPorts } from '../../app/ports-context';
import { ActionLink } from '../../components/ui/action-link';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { InlineAlert } from '../../components/ui/inline-alert';
import { PageHeader } from '../../components/ui/page-header';
import { SelectField } from '../../components/ui/select-field';
import { TextField } from '../../components/ui/text-field';
import { usePageTitle } from '../../hooks/use-page-title';
import { organizationPath } from '../../navigation/nav-items';
import { useActiveOrganization } from '../../organization/organization-context';
import type { OrganizationView } from '../../profile/contract';
import { PROVIDER_ROLE_LABELS, type ProviderRole } from '../../provider-access/contract';
import {
  SUSPENDED_TEAM_COPY,
  STEP_UP_NOTICE_COPY,
  formatTeamDate,
  teamAuthority,
} from './team-authority';
import {
  emptyInviteFormValues,
  inviteFormSchema,
  inviteRoleValues,
  roleIsOrgWideOnly,
  toBranchScope,
  type InviteFormValues,
} from './invite-form';
import { saveTeamIntent, takeTeamIntent } from './team-pending-intent';
import styles from './team.module.css';

/** Router-state prefill (from "Send a new invitation" / the change-access
 *  flow) — display-level convenience only, never an authority signal. */
interface InvitePrefillState {
  prefill?: Partial<InviteFormValues>;
  /** Set by the member change-access flow after the revocation step. */
  afterAccessChange?: boolean;
}

/**
 * Invite workflow (docs/29 §6 route `/o/:organizationId/team/invite`) —
 * mirrors `POST /provider/organizations/:orgId/staff/invitations`
 * (`staff.manage`, owner only, step-up gated). An invitation is issued by
 * an already-authorized member to a specific email address; the person
 * accepts it with that verified email. There is no open self-registration
 * and no acceptance link in any response — the one-time code travels only
 * in the invitation email.
 */
export function TeamInvitePage() {
  usePageTitle('Invite someone');
  const organization = useActiveOrganization();
  const { profilePort } = usePortalPorts();

  const query = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });

  return (
    <>
      <PageHeader
        title="Invite someone"
        description="They get access when they accept the invitation sent to their email address."
      />
      {query.isPending ? (
        <p className={styles.loading} role="status">
          Preparing the invitation form…
        </p>
      ) : !query.isError && query.data && query.data.kind === 'loaded' ? (
        <InviteGate view={query.data.view} />
      ) : (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load this workspace. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

function InviteGate({ view }: { view: OrganizationView }) {
  const authority = teamAuthority(view);

  if (authority.suspended) {
    return (
      <div className={styles.unavailable}>
        <InlineAlert tone="info">{SUSPENDED_TEAM_COPY}</InlineAlert>
        <ActionLink to={organizationPath(view.organization.id, 'team')}>Back to Team</ActionLink>
      </div>
    );
  }
  if (!view.membership.capabilities.includes('staff.manage')) {
    return (
      <div className={styles.unavailable}>
        <InlineAlert tone="info">
          Your role can&rsquo;t invite people. The organization&rsquo;s Owner manages the team.
        </InlineAlert>
        <ActionLink to={organizationPath(view.organization.id, 'team')}>Back to Team</ActionLink>
      </div>
    );
  }
  return <InviteForm view={view} />;
}

type InvitePhase =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | {
      phase: 'sent';
      email: string;
      expiresAt: string;
      mailDelivery: 'delivered' | 'failed';
      supersededPending: boolean;
    }
  | { phase: 'error'; message: string };

function InviteForm({ view }: { view: OrganizationView }) {
  const { teamPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const routerState = (location.state ?? {}) as InvitePrefillState;
  const [send, setSend] = useState<InvitePhase>({ phase: 'idle' });
  const alertRef = useRef<HTMLDivElement>(null);
  // Same-tick duplicate-submit lock: React state alone can't stop a second
  // submit dispatched before the first render commits.
  const sendingRef = useRef(false);

  // The caller is an Owner here (gate above), so the staff read is theirs
  // to see — it powers the truthful supersede note on success.
  const staffQuery = useQuery({
    queryKey: ['staff', view.organization.id],
    queryFn: () => teamPort.loadStaff(view.organization.id),
  });

  // Step-up return: the preserved intent wins (single consumption) and the
  // user re-sends EXPLICITLY — never an automatic retry.
  const [restored] = useState<{ values: InviteFormValues; fromStepUp: boolean }>(() => {
    const intent = takeTeamIntent();
    if (intent?.kind === 'invite' && intent.organizationId === view.organization.id) {
      return { values: intent.values, fromStepUp: true };
    }
    return {
      values: { ...emptyInviteFormValues(), ...routerState.prefill },
      fromStepUp: false,
    };
  });
  const stepUpReturned = restored.fromStepUp;

  const form = useForm<InviteFormValues>({
    resolver: standardSchemaResolver(inviteFormSchema),
    defaultValues: restored.values,
    mode: 'onTouched',
  });
  const { isDirty } = form.formState;
  const role = form.watch('role');
  const scopeMode = form.watch('scopeMode');
  const orgWideOnly = roleIsOrgWideOnly(role);

  const activeBranches = view.branches.filter((branch) => branch.active);

  const departingRef = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !departingRef.current &&
      isDirty &&
      send.phase !== 'sent' &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!isDirty || send.phase === 'sent') {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty, send.phase]);

  const focusAlert = () => {
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  useEffect(() => {
    if (stepUpReturned || routerState.afterAccessChange) {
      focusAlert();
    }
    // Announce once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = form.handleSubmit(async (values) => {
    // Refuse anything but a fresh attempt: a queued second submit from the
    // same gesture arrives AFTER a fast success and must not re-issue.
    if (sendingRef.current || send.phase === 'sending' || send.phase === 'sent') {
      return;
    }
    sendingRef.current = true;
    setSend({ phase: 'sending' });
    const email = values.email.trim().toLowerCase();
    // Truthful supersede note: the backend revokes a still-open invitation
    // for the same address in the same transaction.
    const loadedStaff = staffQuery.data?.kind === 'loaded' ? staffQuery.data.staff : null;
    const supersededPending =
      loadedStaff?.invitations.some(
        (candidate) => candidate.email === email && candidate.state === 'sent',
      ) ?? false;

    const outcome = await teamPort.issueInvitation(view.organization.id, {
      email,
      role: values.role,
      branchScope: toBranchScope(values),
    });
    // The lock stays LATCHED through success and the step-up handoff — a
    // queued duplicate submit from the same gesture arrives after the fast
    // fixture mutation resolves and must find the lock still closed. Only
    // an error (form stays live) re-arms it.
    if (outcome.kind !== 'invitationIssued' && outcome.kind !== 'stepUpRequired') {
      sendingRef.current = false;
    }
    switch (outcome.kind) {
      case 'invitationIssued':
        departingRef.current = true;
        form.reset(values);
        await queryClient.invalidateQueries({ queryKey: ['staff', view.organization.id] });
        setSend({
          phase: 'sent',
          email,
          expiresAt: outcome.expiresAt,
          mailDelivery: outcome.mailDelivery,
          supersededPending,
        });
        focusAlert();
        return;
      case 'stepUpRequired':
        // Nothing executed. Preserve the intent in memory, stand the
        // unsaved-changes blocker down, and route through the W2-2
        // interstitial — the user re-sends explicitly on return.
        saveTeamIntent({ kind: 'invite', organizationId: view.organization.id, values });
        departingRef.current = true;
        navigate(`/step-up?returnTo=${encodeURIComponent(location.pathname)}`);
        return;
      case 'invalidBranchScope':
        setSend({
          phase: 'error',
          message:
            'That branch selection isn’t valid any more — a chosen branch may have been deactivated. Review the branches and try again.',
        });
        void queryClient.invalidateQueries({ queryKey: ['organizationView', view.organization.id] });
        focusAlert();
        return;
      case 'validationError':
        setSend({
          phase: 'error',
          message: 'Some of these details aren’t valid. Check the email address and try again.',
        });
        focusAlert();
        return;
      case 'organizationSuspended':
        setSend({ phase: 'error', message: SUSPENDED_TEAM_COPY });
        void queryClient.invalidateQueries({ queryKey: ['organizationView', view.organization.id] });
        focusAlert();
        return;
      case 'forbidden':
        setSend({
          phase: 'error',
          message: 'Your role can’t invite people. The organization’s Owner manages the team.',
        });
        focusAlert();
        return;
      case 'notFound':
        setSend({
          phase: 'error',
          message: 'We can’t reach this workspace any more. Try again in a moment.',
        });
        focusAlert();
        return;
      default:
        setSend({
          phase: 'error',
          message: 'We couldn’t send this invitation right now. Try again in a moment.',
        });
        focusAlert();
    }
  });

  if (send.phase === 'sent') {
    return (
      <div className={styles.successCard} ref={alertRef} tabIndex={-1}>
        <h2 className={styles.sectionTitle}>Invitation sent</h2>
        <p className={styles.emptyBody}>
          We&rsquo;ve created an invitation for <strong>{send.email}</strong> as{' '}
          {PROVIDER_ROLE_LABELS[role]}. It expires on {formatTeamDate(send.expiresAt)}. They get
          access when they accept it using that email address.
        </p>
        {send.supersededPending ? (
          <InlineAlert tone="info">
            This replaces the earlier open invitation for this address — the previous code no
            longer works.
          </InlineAlert>
        ) : null}
        {send.mailDelivery === 'failed' ? (
          <InlineAlert tone="error">
            The invitation was created, but the email couldn&rsquo;t be delivered. To try again,
            send a new invitation to the same address — it replaces this one.
          </InlineAlert>
        ) : null}
        <div className={styles.successActions}>
          <ActionLink to={organizationPath(view.organization.id, 'team')}>Back to Team</ActionLink>
          <Button
            variant="secondary"
            onClick={() => {
              departingRef.current = false;
              sendingRef.current = false;
              form.reset(emptyInviteFormValues());
              setSend({ phase: 'idle' });
            }}
          >
            Invite someone else
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className={styles.inviteForm} onSubmit={(event) => void submit(event)} noValidate>
      <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
        {stepUpReturned ? <InlineAlert tone="info">{STEP_UP_NOTICE_COPY}</InlineAlert> : null}
        {routerState.afterAccessChange ? (
          <InlineAlert tone="info">
            Their previous access has been removed. Send the new invitation below — their new
            access starts when they accept it.
          </InlineAlert>
        ) : null}
        {send.phase === 'error' ? <InlineAlert tone="error">{send.message}</InlineAlert> : null}
      </div>

      <TextField
        label="Email address"
        hint="The invitation is tied to this address — they accept it with the same verified email."
        autoComplete="off"
        inputMode="email"
        error={form.formState.errors.email?.message ?? null}
        {...form.register('email')}
      />

      <SelectField
        label="Role"
        hint="What they can do in this organization."
        error={form.formState.errors.role?.message ?? null}
        {...form.register('role')}
      >
        {inviteRoleValues.map((value) => (
          <option key={value} value={value}>
            {PROVIDER_ROLE_LABELS[value]}
          </option>
        ))}
      </SelectField>

      <fieldset className={styles.scopeFieldset}>
        <legend className={styles.scopeLegend}>Branch access</legend>
        {orgWideOnly ? (
          <p className={styles.scopeNote}>
            {PROVIDER_ROLE_LABELS[role as ProviderRole]} always covers the whole organization —
            every branch, including ones added later.
          </p>
        ) : (
          <>
            <label className={styles.scopeChoice}>
              <input
                type="radio"
                value="all"
                {...form.register('scopeMode')}
              />
              <span>
                <span className={styles.scopeChoiceLabel}>All branches</span>
                <span className={styles.scopeChoiceHint}>
                  Covers every branch, including ones added later.
                </span>
              </span>
            </label>
            <label className={styles.scopeChoice}>
              <input
                type="radio"
                value="selected"
                {...form.register('scopeMode')}
              />
              <span>
                <span className={styles.scopeChoiceLabel}>Specific branches</span>
                <span className={styles.scopeChoiceHint}>
                  Only the branches you choose below.
                </span>
              </span>
            </label>
            {scopeMode === 'selected' ? (
              activeBranches.length === 0 ? (
                <p className={styles.scopeNote}>
                  There are no active branches to choose from yet. Add a branch first, or choose
                  all branches.
                </p>
              ) : (
                <div className={styles.branchChecklist} role="group" aria-label="Branches">
                  {activeBranches.map((branch) => (
                    <label key={branch.id} className={styles.branchChoice}>
                      <input type="checkbox" value={branch.id} {...form.register('branchIds')} />
                      <span>
                        <span className={styles.scopeChoiceLabel}>{branch.label}</span>
                        <span className={styles.scopeChoiceHint}>{branch.areaLabel}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )
            ) : null}
            {form.formState.errors.branchIds?.message ? (
              <p className={styles.fieldError} role="alert">
                {form.formState.errors.branchIds.message}
              </p>
            ) : null}
            {form.formState.errors.scopeMode?.message ? (
              <p className={styles.fieldError} role="alert">
                {form.formState.errors.scopeMode.message}
              </p>
            ) : null}
          </>
        )}
      </fieldset>

      <div className={styles.formActions}>
        <Button type="submit" busy={send.phase === 'sending'} busyLabel="Sending…">
          Send invitation
        </Button>
      </div>

      {blocker.state === 'blocked' ? (
        <ConfirmDialog
          title="Leave without sending?"
          confirmLabel="Leave"
          cancelLabel="Stay"
          onConfirm={() => blocker.proceed?.()}
          onCancel={() => blocker.reset?.()}
        >
          <p>The invitation hasn&rsquo;t been sent. If you leave now, it will be discarded.</p>
        </ConfirmDialog>
      ) : null}
    </form>
  );
}
