import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useBlocker, useParams } from 'react-router-dom';
import { usePortalPorts } from '../../app/ports-context';
import { ActionLink } from '../../components/ui/action-link';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { InlineAlert } from '../../components/ui/inline-alert';
import { PageHeader } from '../../components/ui/page-header';
import { usePageTitle } from '../../hooks/use-page-title';
import { organizationPath } from '../../navigation/nav-items';
import { useActiveOrganization } from '../../organization/organization-context';
import type { BranchRecord, OrganizationView } from '../../profile/contract';
import type { AreaRecord } from '../../taxonomy/contract';
import {
  WEEK_DAYS,
  WEEK_DAY_LABELS,
  formatTime,
  parseOpeningHours,
} from '../../branches/opening-hours';
import { isStillOnboarding } from '../profile/organization-state';
import { SUSPENDED_BRANCH_COPY, branchEditReach, canEditBranch } from './branch-authority';
import {
  branchFormSchema,
  buildBranchPatch,
  toBranchFormValues,
  type BranchFormValues,
} from './branch-form';
import { BranchFormFields } from './branch-form-fields';
import { PublicFieldsNote } from './branch-create-page';
import { useAreas } from './use-areas';
import styles from './branches.module.css';

/**
 * Branch detail/editor (docs/29 §6 route `/o/:orgId/branches/:branchId`).
 * The read resolves against the canonical org view; a branch id that is
 * unknown, belongs to another organization, or does not exist renders ONE
 * safe not-found surface — the portal never distinguishes those cases, just
 * like the backend's not-found shaping (no enumeration oracle).
 */
export function BranchDetailPage() {
  const organization = useActiveOrganization();
  const { branchId } = useParams();
  const { profilePort } = usePortalPorts();

  const query = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });

  if (query.isPending) {
    return (
      <p className={styles.loading} role="status">
        Loading this branch…
      </p>
    );
  }
  if (query.isError || !query.data || query.data.kind !== 'loaded') {
    return (
      <div className={styles.unavailable}>
        <InlineAlert tone="error">
          We couldn&rsquo;t load this branch. Try again in a moment.
        </InlineAlert>
        <Button variant="secondary" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const view = query.data.view;
  const branch = view.branches.find((candidate) => candidate.id === branchId);
  if (!branch) {
    return <BranchNotFound organizationId={organization.id} />;
  }
  return (
    <BranchDetail
      view={view}
      branch={branch}
      onRefreshView={() => query.refetch()}
    />
  );
}

/** The one safe shape for unknown/foreign/out-of-scope-nonexistent ids. */
function BranchNotFound({ organizationId }: { organizationId: string }) {
  usePageTitle('Branch not found');
  return (
    <>
      <PageHeader
        title="Branch not found"
        description="We can't find this branch in this workspace. The link may be out of date."
      />
      <p className={styles.notFoundAction}>
        <ActionLink to={organizationPath(organizationId, 'branches')}>Go to Branches</ActionLink>
      </p>
    </>
  );
}

function BranchDetail({
  view,
  branch,
  onRefreshView,
}: {
  view: OrganizationView;
  branch: BranchRecord;
  onRefreshView: () => Promise<unknown>;
}) {
  usePageTitle(branch.label);
  const queryClient = useQueryClient();
  const suspended = view.organization.verificationState === 'suspended';
  const reach = branchEditReach(view.membership, suspended);
  const editable = canEditBranch(reach, branch);
  const canDeactivate =
    view.membership.capabilities.includes('branch.deactivate') && !suspended && branch.active;

  const refreshShared = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['organizationView', view.organization.id] }),
      queryClient.invalidateQueries({ queryKey: ['onboarding', view.organization.id] }),
    ]);

  return (
    <>
      <PageHeader
        title={branch.label}
        description={
          <>
            {branch.areaLabel}
            {branch.addressLine ? ` · ${branch.addressLine}` : ''}
            {' · '}
            <span className={branch.active ? styles.statusActiveText : styles.statusInactiveText}>
              {branch.active ? 'Active' : 'Deactivated'}
            </span>
          </>
        }
      />
      <p className={styles.backLink}>
        <ActionLink to={organizationPath(view.organization.id, 'branches')}>
          Back to Branches
        </ActionLink>
      </p>

      {suspended ? <InlineAlert tone="info">{SUSPENDED_BRANCH_COPY}</InlineAlert> : null}
      {!branch.active ? (
        <InlineAlert tone="info">
          This branch is deactivated: customers don&rsquo;t see it, and it no longer counts
          towards your organization&rsquo;s active locations. Its history is kept, and it
          can&rsquo;t be reactivated from the portal.
        </InlineAlert>
      ) : null}
      {!editable && !suspended ? (
        <InlineAlert tone="info">
          {reach.kind === 'scoped' && branch.active
            ? 'This branch isn’t assigned to you. You can view it, and edit only your assigned branches.'
            : reach.kind === 'scoped' || reach.kind === 'all'
              ? 'Deactivated branches you were assigned are view-only.'
              : 'You can view this branch. An owner or organization manager makes changes here.'}
        </InlineAlert>
      ) : null}

      {editable ? (
        <BranchEditorGate
          view={view}
          branch={branch}
          onRefreshView={onRefreshView}
          onSaved={refreshShared}
        />
      ) : (
        <BranchReadOnly branch={branch} />
      )}

      {canDeactivate ? (
        <DeactivatePanel
          view={view}
          branch={branch}
          onRefreshView={onRefreshView}
          onDeactivated={refreshShared}
        />
      ) : null}
    </>
  );
}

function BranchEditorGate({
  view,
  branch,
  onRefreshView,
  onSaved,
}: {
  view: OrganizationView;
  branch: BranchRecord;
  onRefreshView: () => Promise<unknown>;
  onSaved: () => Promise<unknown>;
}) {
  const areasQuery = useAreas();
  if (areasQuery.isPending) {
    return (
      <p className={styles.loading} role="status">
        Loading areas…
      </p>
    );
  }
  if (areasQuery.isError || !areasQuery.data || areasQuery.data.kind !== 'loaded') {
    return (
      <div className={styles.unavailable}>
        <InlineAlert tone="error">
          We couldn&rsquo;t load the list of areas, which the branch editor needs. Try again in
          a moment.
        </InlineAlert>
        <Button variant="secondary" onClick={() => void areasQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <BranchEditor
      view={view}
      branch={branch}
      areas={areasQuery.data.areas}
      onRefreshView={onRefreshView}
      onSaved={onSaved}
    />
  );
}

type SavePhase =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved' }
  /** Another writer saved first — the canonical staleVersion refusal. */
  | { phase: 'conflict' }
  | { phase: 'reloading' }
  | { phase: 'reloaded' }
  | { phase: 'error'; message: string };

function BranchEditor({
  view,
  branch,
  areas,
  onRefreshView,
  onSaved,
}: {
  view: OrganizationView;
  branch: BranchRecord;
  areas: readonly AreaRecord[];
  onRefreshView: () => Promise<unknown>;
  onSaved: () => Promise<unknown>;
}) {
  const { branchPort } = usePortalPorts();
  const [save, setSave] = useState<SavePhase>({ phase: 'idle' });
  const alertRef = useRef<HTMLDivElement>(null);

  const baseValues = useMemo(() => toBranchFormValues(branch), [branch]);
  const form = useForm<BranchFormValues>({
    resolver: standardSchemaResolver(branchFormSchema),
    defaultValues: baseValues,
    mode: 'onTouched',
  });
  const { formState, reset } = form;
  const { isDirty } = formState;

  // Refetched server state becomes the new base WITHOUT discarding this
  // editor's in-progress edits (they stay dirty against the new base).
  useEffect(() => {
    reset(baseValues, { keepDirtyValues: true });
  }, [baseValues, reset]);

  useEffect(() => {
    if (isDirty) {
      setSave((current) => (current.phase === 'saved' ? { phase: 'idle' } : current));
    }
  }, [isDirty]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!isDirty) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  const focusAlert = () => {
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  const submit = form.handleSubmit(async (values) => {
    if (save.phase === 'saving' || !formState.isDirty) {
      return;
    }
    setSave({ phase: 'saving' });
    const patch = buildBranchPatch(values, branch);
    const outcome = await branchPort.updateBranch(
      view.organization.id,
      branch.id,
      branch.version,
      patch,
    );
    switch (outcome.kind) {
      case 'branchUpdated':
        reset(values);
        // Wait for the refreshed view (and its new branch version) before
        // announcing success — an immediate follow-up save must never carry
        // the superseded expectedVersion.
        await onSaved();
        setSave({ phase: 'saved' });
        return;
      case 'staleVersion':
        setSave({ phase: 'conflict' });
        focusAlert();
        return;
      case 'validationError':
        setSave({
          phase: 'error',
          message: 'Some details couldn’t be saved. Review the fields below and try again.',
        });
        focusAlert();
        return;
      case 'organizationSuspended':
        setSave({ phase: 'error', message: SUSPENDED_BRANCH_COPY });
        void onRefreshView();
        focusAlert();
        return;
      case 'forbidden':
        setSave({
          phase: 'error',
          message:
            'You can’t edit this branch. Owners and organization managers edit every branch; branch managers edit their assigned branches.',
        });
        void onRefreshView();
        focusAlert();
        return;
      case 'notFound':
        setSave({
          phase: 'error',
          message: 'We can’t find this branch any more. It may have been removed from your view.',
        });
        void onRefreshView();
        focusAlert();
        return;
      default:
        setSave({
          phase: 'error',
          message:
            'We couldn’t save your changes right now — your edits are still here. Try again in a moment.',
        });
        focusAlert();
    }
  });

  const loadLatest = async () => {
    if (save.phase === 'reloading') {
      return;
    }
    setSave({ phase: 'reloading' });
    await onRefreshView();
    setSave({ phase: 'reloaded' });
    focusAlert();
  };

  return (
    <div className={styles.editorWrap}>
      <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
        {save.phase === 'conflict' || save.phase === 'reloading' ? (
          <InlineAlert tone="error">
            <p>
              Someone else updated this branch while you were editing, so your changes
              weren&rsquo;t saved. Load the latest version to continue — your edits here will be
              kept for you to review before saving again.
            </p>
            <div className={styles.alertActions}>
              <Button
                variant="secondary"
                busy={save.phase === 'reloading'}
                busyLabel="Loading…"
                onClick={() => void loadLatest()}
              >
                Load the latest branch
              </Button>
            </div>
          </InlineAlert>
        ) : save.phase === 'reloaded' ? (
          <InlineAlert tone="info">
            The latest branch details are loaded and your edits are kept below. Review them,
            then save again.
          </InlineAlert>
        ) : save.phase === 'error' ? (
          <InlineAlert tone="error">{save.message}</InlineAlert>
        ) : save.phase === 'saved' ? (
          <InlineAlert tone="success">
            Saved — this branch is up to date.
            {isStillOnboarding(view.organization.verificationState) ? (
              <>
                {' '}
                <ActionLink to={organizationPath(view.organization.id, 'onboarding')}>
                  Back to Getting started
                </ActionLink>
              </>
            ) : null}
          </InlineAlert>
        ) : null}
      </div>

      <form onSubmit={(event) => void submit(event)} noValidate className={styles.form}>
        <BranchFormFields form={form} areas={areas} currentAreaLabel={branch.areaLabel} />
        <PublicFieldsNote />
        <div className={styles.saveArea}>
          <Button
            type="submit"
            busy={save.phase === 'saving'}
            busyLabel="Saving…"
            aria-disabled={!isDirty || undefined}
          >
            Save changes
          </Button>
          {!isDirty && save.phase !== 'saved' ? (
            <p className={styles.saveNote}>All changes are saved.</p>
          ) : null}
        </div>
      </form>

      {blocker.state === 'blocked' ? (
        <ConfirmDialog
          title="Discard unsaved changes?"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        >
          <p>This branch has unsaved edits. If you leave now, they&rsquo;ll be lost.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

const NOT_PROVIDED = 'Not provided yet';

function BranchReadOnly({ branch }: { branch: BranchRecord }) {
  const hours = parseOpeningHours(branch.openingHours);
  const rows: Array<{ term: string; value: string }> = [
    { term: 'Area', value: branch.areaLabel },
    { term: 'Address line', value: branch.addressLine ?? '' },
    { term: 'City', value: branch.city ?? '' },
    {
      term: 'Map pin',
      value:
        branch.geoPoint === null
          ? ''
          : `${branch.geoPoint.latitude}, ${branch.geoPoint.longitude}`,
    },
    { term: 'Facilities', value: branch.facilities.join(' · ') },
  ];

  return (
    <section aria-label="Branch details (read-only)" className={styles.readOnlySection}>
      <dl className={styles.recordList}>
        {rows.map((row) => (
          <div key={row.term} className={styles.recordRow}>
            <dt className={styles.recordTerm}>{row.term}</dt>
            <dd className={styles.recordValue}>
              {row.value !== '' ? (
                row.value
              ) : (
                <span className={styles.notProvided}>{NOT_PROVIDED}</span>
              )}
            </dd>
          </div>
        ))}
        <div className={styles.recordRow}>
          <dt className={styles.recordTerm}>Opening hours</dt>
          <dd className={styles.recordValue}>
            {hours === null ? (
              <span className={styles.notProvided}>Not set</span>
            ) : (
              <ul className={styles.hoursList}>
                {WEEK_DAYS.map((day) => {
                  const dayHours = hours[day];
                  return (
                    <li key={day}>
                      {WEEK_DAY_LABELS[day]}:{' '}
                      {dayHours
                        ? `${formatTime(dayHours.open)} – ${formatTime(dayHours.close)}`
                        : 'Closed'}
                    </li>
                  );
                })}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      <PublicFieldsNote />
    </section>
  );
}

type DeactivatePhase =
  | { phase: 'idle' }
  | { phase: 'confirming' }
  | { phase: 'working' }
  | { phase: 'stale' }
  | { phase: 'error'; message: string };

/**
 * Deactivation — mirrors `POST .../branches/:branchId/deactivate`
 * (`branch.deactivate`: owner + org_manager; CAS; idempotent). It is NOT a
 * deletion: history is preserved, and no reactivation exists anywhere in
 * the provider surface today, so the copy says so plainly. Consequence
 * wording stays generic — no endpoint reports affected listings, so no
 * counts are fabricated.
 */
function DeactivatePanel({
  view,
  branch,
  onRefreshView,
  onDeactivated,
}: {
  view: OrganizationView;
  branch: BranchRecord;
  onRefreshView: () => Promise<unknown>;
  onDeactivated: () => Promise<unknown>;
}) {
  const { branchPort } = usePortalPorts();
  const [state, setState] = useState<DeactivatePhase>({ phase: 'idle' });
  const statusRef = useRef<HTMLDivElement>(null);

  const isOnlyActiveBranch =
    branch.active && view.branches.filter((candidate) => candidate.active).length === 1;

  const focusStatus = () => {
    requestAnimationFrame(() => statusRef.current?.focus());
  };

  const deactivate = async () => {
    setState({ phase: 'working' });
    const outcome = await branchPort.deactivateBranch(
      view.organization.id,
      branch.id,
      branch.version,
    );
    switch (outcome.kind) {
      case 'branchDeactivated':
        await onDeactivated();
        setState({ phase: 'idle' });
        focusStatus();
        return;
      case 'staleVersion':
        setState({ phase: 'stale' });
        focusStatus();
        return;
      case 'organizationSuspended':
        setState({ phase: 'error', message: SUSPENDED_BRANCH_COPY });
        void onRefreshView();
        focusStatus();
        return;
      case 'forbidden':
        setState({
          phase: 'error',
          message:
            'Your role can’t deactivate branches. An owner or organization manager does this.',
        });
        void onRefreshView();
        focusStatus();
        return;
      case 'notFound':
        setState({
          phase: 'error',
          message: 'We can’t find this branch any more. It may have been removed from your view.',
        });
        void onRefreshView();
        focusStatus();
        return;
      default:
        setState({
          phase: 'error',
          message: 'We couldn’t deactivate this branch right now. Try again in a moment.',
        });
        focusStatus();
    }
  };

  return (
    <section aria-label="Deactivate this branch" className={styles.deactivatePanel}>
      <h2 className={styles.deactivateTitle}>Deactivate this branch</h2>
      <p className={styles.deactivateBody}>
        Customers stop seeing this location, and listings that run here can become unavailable
        at this location. The branch and its history are kept — this is not a deletion — but it
        can&rsquo;t be reactivated from the portal.
      </p>
      <div ref={statusRef} tabIndex={-1} className={styles.alertFocus}>
        {state.phase === 'stale' ? (
          <InlineAlert tone="error">
            <p>
              This branch changed since you loaded it, so it wasn&rsquo;t deactivated. Load the
              latest details and try again.
            </p>
            <div className={styles.alertActions}>
              <Button variant="secondary" onClick={() => void onRefreshView()}>
                Load the latest branch
              </Button>
            </div>
          </InlineAlert>
        ) : state.phase === 'error' ? (
          <InlineAlert tone="error">{state.message}</InlineAlert>
        ) : null}
      </div>
      <Button
        variant="secondary"
        className={styles.deactivateButton}
        busy={state.phase === 'working'}
        busyLabel="Deactivating…"
        onClick={() => setState({ phase: 'confirming' })}
      >
        Deactivate branch
      </Button>

      {state.phase === 'confirming' ? (
        <ConfirmDialog
          title={`Deactivate ${branch.label}?`}
          confirmLabel="Deactivate branch"
          cancelLabel="Keep branch active"
          destructive
          onConfirm={() => void deactivate()}
          onCancel={() => setState({ phase: 'idle' })}
        >
          <p>
            Customers will no longer see this location, and listings that run here can become
            unavailable at this location. This can&rsquo;t be undone from the portal.
          </p>
          {isOnlyActiveBranch ? (
            <p>
              <strong>This is your only active branch.</strong>
              {isStillOnboarding(view.organization.verificationState)
                ? ' Without an active branch, your organization no longer meets the requirement for verification submission.'
                : ''}
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
