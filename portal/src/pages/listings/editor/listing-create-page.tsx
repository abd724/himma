import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useBlocker, useNavigate } from 'react-router-dom';
import { usePortalPorts } from '../../../app/ports-context';
import { ActionLink } from '../../../components/ui/action-link';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { InlineAlert } from '../../../components/ui/inline-alert';
import { PageHeader } from '../../../components/ui/page-header';
import { usePageTitle } from '../../../hooks/use-page-title';
import { organizationPath } from '../../../navigation/nav-items';
import { useActiveOrganization } from '../../../organization/organization-context';
import type { OrganizationView } from '../../../profile/contract';
import type { ActivityTypeRecord, CategoryRecord } from '../../../taxonomy/contract';
import {
  EDITOR_NO_ACCESS_COPY,
  SUSPENDED_EDITOR_COPY,
  editorAuthority,
} from './editor-domain';
import {
  buildCreateInput,
  emptyProgramFormValues,
  programFormSchema,
  type ProgramFormValues,
} from './program-form';
import { ProgramFormFields } from './program-form-fields';
import styles from './editor.module.css';

/**
 * Listing creation (docs/29 §6 route `/o/:organizationId/listings/new`) —
 * mirrors `POST /provider/organizations/:orgId/listings` (`listings.manage`).
 * Drafts may be INCOMPLETE by design (S4): only the structural create
 * fields are required here; locations, pricing, photos, and offers are
 * added afterwards in the editor. Creation never submits and never
 * publishes anything.
 */
export function ListingCreatePage() {
  usePageTitle('Create listing');
  const organization = useActiveOrganization();
  const { profilePort, activityTypePort, categoryPort } = usePortalPorts();

  const viewQuery = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });
  const taxonomyQuery = useQuery({
    queryKey: ['activityTypes'],
    queryFn: () => activityTypePort.listActivityTypes(),
  });
  // Category context for the activity selector — non-blocking: the form
  // works without it (labels render without category context).
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => categoryPort.listCategories(),
  });

  return (
    <>
      <PageHeader
        title="Create listing"
        description="A new activity for this organization. It starts as a private draft — customers never see drafts."
      />
      {viewQuery.isPending || taxonomyQuery.isPending ? (
        <p className={styles.loading} role="status">
          Preparing the listing form…
        </p>
      ) : viewQuery.data?.kind === 'loaded' ? (
        <CreateGate
          view={viewQuery.data.view}
          taxonomy={taxonomyQuery.data?.kind === 'loaded' ? taxonomyQuery.data.activityTypes : null}
          categories={
            categoriesQuery.data?.kind === 'loaded' ? categoriesQuery.data.categories : null
          }
          onRetryTaxonomy={() => void taxonomyQuery.refetch()}
        />
      ) : (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load this workspace. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void viewQuery.refetch()}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

function CreateGate({
  view,
  taxonomy,
  categories,
  onRetryTaxonomy,
}: {
  view: OrganizationView;
  taxonomy: readonly ActivityTypeRecord[] | null;
  categories: readonly CategoryRecord[] | null;
  onRetryTaxonomy: () => void;
}) {
  const authority = editorAuthority(view);

  if (authority.suspended) {
    return (
      <div className={styles.unavailable}>
        <InlineAlert tone="info">{SUSPENDED_EDITOR_COPY}</InlineAlert>
        <ActionLink to={organizationPath(view.organization.id, 'listings')}>
          Back to Listings
        </ActionLink>
      </div>
    );
  }
  if (!authority.canManage) {
    return (
      <div className={styles.unavailable}>
        <InlineAlert tone="info">{EDITOR_NO_ACCESS_COPY}</InlineAlert>
        <ActionLink to={organizationPath(view.organization.id, 'listings')}>
          Back to Listings
        </ActionLink>
      </div>
    );
  }
  if (taxonomy === null) {
    return (
      <div className={styles.unavailable}>
        <InlineAlert tone="error">
          We couldn&rsquo;t load the activity types, which the listing form needs. Try again in a
          moment.
        </InlineAlert>
        <Button variant="secondary" onClick={onRetryTaxonomy}>
          Try again
        </Button>
      </div>
    );
  }
  return <CreateForm view={view} taxonomy={taxonomy} categories={categories} />;
}

type CreatePhase = { phase: 'idle' } | { phase: 'saving' } | { phase: 'error'; message: string };

function CreateForm({
  view,
  taxonomy,
  categories,
}: {
  view: OrganizationView;
  taxonomy: readonly ActivityTypeRecord[];
  categories: readonly CategoryRecord[] | null;
}) {
  const { listingEditorPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [create, setCreate] = useState<CreatePhase>({ phase: 'idle' });
  const alertRef = useRef<HTMLDivElement>(null);

  const form = useForm<ProgramFormValues>({
    resolver: standardSchemaResolver(programFormSchema),
    defaultValues: emptyProgramFormValues(),
    mode: 'onTouched',
  });
  const { isDirty } = form.formState;

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
    const outcome = await listingEditorPort.createProgram(
      view.organization.id,
      buildCreateInput(values),
    );
    switch (outcome.kind) {
      case 'programCreated':
        departingRef.current = true;
        form.reset(values);
        await queryClient.invalidateQueries({ queryKey: ['listings', view.organization.id] });
        await queryClient.invalidateQueries({ queryKey: ['onboarding', view.organization.id] });
        navigate(
          `${organizationPath(view.organization.id, 'listings')}/${outcome.program.id}/edit`,
        );
        return;
      case 'invalidTaxonomy':
        setCreate({
          phase: 'error',
          message:
            'That activity type isn’t available any more. Choose a current activity type and try again.',
        });
        focusAlert();
        return;
      case 'invalidEligibility':
        setCreate({
          phase: 'error',
          message: 'The age settings don’t work together. Review the eligibility fields below.',
        });
        focusAlert();
        return;
      case 'organizationSuspended':
        setCreate({ phase: 'error', message: SUSPENDED_EDITOR_COPY });
        void queryClient.invalidateQueries({
          queryKey: ['organizationView', view.organization.id],
        });
        focusAlert();
        return;
      case 'forbidden':
        setCreate({ phase: 'error', message: EDITOR_NO_ACCESS_COPY });
        void queryClient.invalidateQueries({
          queryKey: ['organizationView', view.organization.id],
        });
        focusAlert();
        return;
      default:
        setCreate({
          phase: 'error',
          message:
            'We couldn’t create this listing right now — your details are still here. Try again in a moment.',
        });
        focusAlert();
    }
  });

  return (
    <div className={styles.editorWrap}>
      <InlineAlert tone="info">
        Start with the basics — drafts start private and can stay incomplete. You can add
        locations, pricing, photos, and offers after creating the draft.
      </InlineAlert>

      <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
        {create.phase === 'error' ? <InlineAlert tone="error">{create.message}</InlineAlert> : null}
      </div>

      <form onSubmit={(event) => void submit(event)} noValidate className={styles.form}>
        <ProgramFormFields
          form={form}
          activityTypes={taxonomy}
          categories={categories}
          supportPath={organizationPath(view.organization.id, 'support')}
        />
        <div className={styles.saveArea}>
          <Button type="submit" busy={create.phase === 'saving'} busyLabel="Creating…">
            Create draft listing
          </Button>
          <p className={styles.saveNote}>
            Creating never submits or publishes anything — your draft stays private.
          </p>
        </div>
      </form>

      {blocker.state === 'blocked' ? (
        <ConfirmDialog
          title="Discard this listing?"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        >
          <p>This listing hasn&rsquo;t been created yet. If you leave now, your details are lost.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
