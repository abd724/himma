import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useBlocker, useNavigate } from 'react-router-dom';
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
import type { AreaRecord } from '../../taxonomy/contract';
import { isStillOnboarding } from '../profile/organization-state';
import { SUSPENDED_BRANCH_COPY } from './branch-authority';
import {
  branchFormSchema,
  buildBranchInput,
  emptyBranchFormValues,
  type BranchFormValues,
} from './branch-form';
import { BranchFormFields } from './branch-form-fields';
import { useAreas } from './use-areas';
import styles from './branches.module.css';

/**
 * Branch creation (docs/29 §6 route `/o/:organizationId/branches/new`) —
 * mirrors `POST /provider/organizations/:orgId/branches` (`branch.create`:
 * owner + org_manager, org-wide by nature). The owning organization is the
 * route context and is never an input; roles without the capability get a
 * truthful explanation, not a disabled form.
 */
export function BranchCreatePage() {
  usePageTitle('Add branch');
  const organization = useActiveOrganization();
  const { profilePort } = usePortalPorts();

  const query = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });

  return (
    <>
      <PageHeader
        title="Add branch"
        description="A new location for this organization. Customers see active branches on your storefront."
      />
      {query.isPending ? (
        <p className={styles.loading} role="status">
          Preparing the branch form…
        </p>
      ) : !query.isError && query.data && query.data.kind === 'loaded' ? (
        <CreateGate view={query.data.view} />
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

function CreateGate({ view }: { view: OrganizationView }) {
  const suspended = view.organization.verificationState === 'suspended';
  const canCreate = view.membership.capabilities.includes('branch.create');
  const areasQuery = useAreas();

  if (suspended) {
    return (
      <div className={styles.unavailable}>
        <InlineAlert tone="info">{SUSPENDED_BRANCH_COPY}</InlineAlert>
        <ActionLink to={organizationPath(view.organization.id, 'branches')}>
          Back to Branches
        </ActionLink>
      </div>
    );
  }
  if (!canCreate) {
    return (
      <div className={styles.unavailable}>
        <InlineAlert tone="info">
          Your role can&rsquo;t add branches. An owner or organization manager adds locations
          for this organization.
        </InlineAlert>
        <ActionLink to={organizationPath(view.organization.id, 'branches')}>
          Back to Branches
        </ActionLink>
      </div>
    );
  }
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
          We couldn&rsquo;t load the list of areas, which the branch form needs. Try again in a
          moment.
        </InlineAlert>
        <Button variant="secondary" onClick={() => void areasQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  return <CreateForm view={view} areas={areasQuery.data.areas} />;
}

type CreatePhase = { phase: 'idle' } | { phase: 'saving' } | { phase: 'error'; message: string };

function CreateForm({ view, areas }: { view: OrganizationView; areas: readonly AreaRecord[] }) {
  const { branchPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [create, setCreate] = useState<CreatePhase>({ phase: 'idle' });
  const alertRef = useRef<HTMLDivElement>(null);

  const form = useForm<BranchFormValues>({
    resolver: standardSchemaResolver(branchFormSchema),
    defaultValues: emptyBranchFormValues(),
    mode: 'onTouched',
  });
  const { isDirty } = form.formState;

  // Set when a successful create navigates away — the just-created branch is
  // saved, so the unsaved-changes blocker must stand down immediately (the
  // render-scoped isDirty flag only updates on the NEXT render).
  const departingRef = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !departingRef.current && isDirty && currentLocation.pathname !== nextLocation.pathname,
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
    if (create.phase === 'saving') {
      return;
    }
    setCreate({ phase: 'saving' });
    const outcome = await branchPort.createBranch(view.organization.id, buildBranchInput(values));
    switch (outcome.kind) {
      case 'branchCreated':
        // The branch is saved: stand the unsaved-changes blocker down, then
        // let the shared caches reflect the new branch (org view +
        // onboarding readiness read the same truth) before navigating.
        departingRef.current = true;
        form.reset(values);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['organizationView', view.organization.id] }),
          queryClient.invalidateQueries({ queryKey: ['onboarding', view.organization.id] }),
        ]);
        navigate(organizationPath(view.organization.id, 'branches'));
        return;
      case 'validationError':
        setCreate({
          phase: 'error',
          message: 'Some details couldn’t be saved. Review the fields below and try again.',
        });
        focusAlert();
        return;
      case 'organizationSuspended':
        setCreate({ phase: 'error', message: SUSPENDED_BRANCH_COPY });
        void queryClient.invalidateQueries({
          queryKey: ['organizationView', view.organization.id],
        });
        focusAlert();
        return;
      case 'forbidden':
        setCreate({
          phase: 'error',
          message:
            'Your role can’t add branches. An owner or organization manager adds locations.',
        });
        void queryClient.invalidateQueries({
          queryKey: ['organizationView', view.organization.id],
        });
        focusAlert();
        return;
      default:
        setCreate({
          phase: 'error',
          message:
            'We couldn’t add this branch right now — your details are still here. Try again in a moment.',
        });
        focusAlert();
    }
  });

  return (
    <div className={styles.editorWrap}>
      {isStillOnboarding(view.organization.verificationState) &&
      !view.branches.some((branch) => branch.active) ? (
        <InlineAlert tone="info">
          Your first active branch completes the branch requirement for submitting your
          organization for verification.
        </InlineAlert>
      ) : null}

      <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
        {create.phase === 'error' ? <InlineAlert tone="error">{create.message}</InlineAlert> : null}
      </div>

      <form onSubmit={(event) => void submit(event)} noValidate className={styles.form}>
        <BranchFormFields form={form} areas={areas} />
        <PublicFieldsNote />
        <div className={styles.saveArea}>
          <Button type="submit" busy={create.phase === 'saving'} busyLabel="Adding…">
            Add branch
          </Button>
        </div>
      </form>

      {blocker.state === 'blocked' ? (
        <ConfirmDialog
          title="Discard this branch?"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        >
          <p>This branch hasn&rsquo;t been added yet. If you leave now, your details are lost.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** Public/private field discipline (the §13.1 public branch projection). */
export function PublicFieldsNote() {
  return (
    <p className={styles.formNote}>
      Customers can see this branch&rsquo;s name, area, address, map pin, opening hours, and
      facilities once your organization is live and your storefront is published, while the
      branch is active. City is kept for your records only.
    </p>
  );
}
