import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, SearchX } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { usePortalPorts } from '../../../app/ports-context';
import type { ProgramDetailRecord } from '../../../catalogue/contract';
import { Button } from '../../../components/ui/button';
import { InlineAlert } from '../../../components/ui/inline-alert';
import { usePageTitle } from '../../../hooks/use-page-title';
import { organizationPath } from '../../../navigation/nav-items';
import { useActiveOrganization } from '../../../organization/organization-context';
import type { OrganizationView } from '../../../profile/contract';
import type { ActivityTypeRecord, CategoryRecord } from '../../../taxonomy/contract';
import { listingStateLabel, listingStateTone } from '../listing-domain';
import { StateChip } from '../state-chip';
import listingStyles from '../listings.module.css';
import {
  CHANGES_REQUESTED_EDITOR_COPY,
  EDITOR_NO_ACCESS_COPY,
  EDITOR_SCOPE_COPY,
  LOCKED_STATE_COPY,
  REVIEW_REQUIRED_COPY,
  REVISION_PENDING_COPY,
  SUSPENDED_EDITOR_COPY,
  editorAuthority,
  editorModeOf,
  listingMutableForScope,
  type EditorAuthority,
} from './editor-domain';
import { LocationsSection } from './locations-section';
import { MediaSection } from './media-section';
import { OffersSection } from './offers-section';
import { PricingSection } from './pricing-section';
import { ProgramDetailsSection } from './program-details-section';
import { ReadinessPanel } from './readiness-panel';
import styles from './editor.module.css';

/**
 * The listing editor (docs/29 §6 editor surface at
 * `/o/:organizationId/listings/:programId/edit`) — W2-8's management view
 * over the SAME shared catalogue truth the W2-7 read detail serves. The
 * W2-7 detail stays read-oriented; this route carries every mutation.
 *
 * Edit-state truth mirrors the backend exactly: drafts and
 * changes-requested listings edit directly; approved/published/paused
 * listings edit non-protected fields directly while protected changes
 * route through Himma review (ProgramRevision); submitted/in-review/
 * archived listings are read-only here. Lifecycle COMMANDS (submit,
 * publish, pause, resume, archive, resubmit) live in their one deliberate
 * home — the listing page's status area — and do not exist on this
 * surface; the editor links there instead.
 */
export function ListingEditorPage() {
  const organization = useActiveOrganization();
  const { programId } = useParams();
  const { profilePort, listingsPort, activityTypePort, categoryPort } = usePortalPorts();

  const viewQuery = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });
  const view = viewQuery.data?.kind === 'loaded' ? viewQuery.data.view : null;
  const authority = view !== null ? editorAuthority(view) : null;

  const detailQuery = useQuery({
    queryKey: ['listing', organization.id, programId],
    queryFn: () => listingsPort.loadListing(organization.id, programId ?? ''),
    // Never fetched for roles without catalogue management — no listing
    // data may reach their client state (the backend would refuse anyway).
    enabled: authority?.canManage === true,
  });
  const taxonomyQuery = useQuery({
    queryKey: ['activityTypes'],
    queryFn: () => activityTypePort.listActivityTypes(),
    enabled: authority?.canManage === true,
  });
  // Category context for the activity selector — non-blocking read.
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => categoryPort.listCategories(),
    enabled: authority?.canManage === true,
  });

  const program = detailQuery.data?.kind === 'loaded' ? detailQuery.data.program : null;
  usePageTitle(program === null ? 'Edit listing' : `Edit · ${program.titleEn}`);

  return (
    <>
      <p className={listingStyles.backLinkWrap}>
        <Link
          className={listingStyles.backLink}
          to={organizationPath(organization.id, 'listings')}
        >
          <ArrowLeft aria-hidden="true" strokeWidth={1.75} className={listingStyles.backIcon} />
          Back to listings
        </Link>
      </p>
      {viewQuery.isPending ? (
        <p className={styles.loading} role="status">
          Loading the editor…
        </p>
      ) : view === null || authority === null ? (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load this workspace. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void viewQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : !authority.canManage ? (
        <NoAccessSurface />
      ) : detailQuery.isPending ? (
        <p className={styles.loading} role="status">
          Loading the editor…
        </p>
      ) : program !== null ? (
        <EditorGate
          view={view}
          authority={authority}
          program={program}
          taxonomy={
            taxonomyQuery.data?.kind === 'loaded' ? taxonomyQuery.data.activityTypes : []
          }
          categories={
            categoriesQuery.data?.kind === 'loaded' ? categoriesQuery.data.categories : null
          }
        />
      ) : detailQuery.data?.kind === 'notFound' ? (
        <EditorNotFound organizationId={organization.id} />
      ) : detailQuery.data?.kind === 'forbidden' ? (
        <NoAccessSurface />
      ) : (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load this listing. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void detailQuery.refetch()}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

function NoAccessSurface() {
  return (
    <div className={listingStyles.emptyCard}>
      <SearchX className={listingStyles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
      <h2 className={listingStyles.emptyTitle}>Listings are managed by your catalogue team</h2>
      <p className={listingStyles.emptyBody}>{EDITOR_NO_ACCESS_COPY}</p>
    </div>
  );
}

/** ONE safe surface for every inaccessible id — identical shape to the
 *  W2-7 read detail (no enumeration oracle on the editor route either). */
function EditorNotFound({ organizationId }: { organizationId: string }) {
  return (
    <div className={listingStyles.emptyCard}>
      <SearchX className={listingStyles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
      <h2 className={listingStyles.emptyTitle}>Listing not found</h2>
      <p className={listingStyles.emptyBody}>
        This listing doesn&rsquo;t exist or isn&rsquo;t part of this organization.
      </p>
      <Link className={listingStyles.inlineLink} to={organizationPath(organizationId, 'listings')}>
        Go to your listings
      </Link>
    </div>
  );
}

function EditorGate({
  view,
  authority,
  program,
  taxonomy,
  categories,
}: {
  view: OrganizationView;
  authority: EditorAuthority;
  program: ProgramDetailRecord;
  taxonomy: readonly ActivityTypeRecord[];
  categories: readonly CategoryRecord[] | null;
}) {
  const mode = editorModeOf(program.listingState);

  // Branch-scope MUTATION rule (the stricter every-rule): a readable
  // listing outside the caller's editing scope gets a truthful read-only
  // surface — never a disabled-form theater, never implied authority.
  if (!listingMutableForScope(program, authority.assignedActiveBranchIds)) {
    return (
      <div className={styles.frozenCard}>
        <EditorHeadline program={program} />
        <InlineAlert tone="info">{EDITOR_SCOPE_COPY}</InlineAlert>
        <Link
          className={listingStyles.inlineLink}
          to={`${organizationPath(view.organization.id, 'listings')}/${program.id}`}
        >
          View listing
        </Link>
      </div>
    );
  }

  if (mode === 'locked') {
    return (
      <div className={styles.frozenCard}>
        <EditorHeadline program={program} />
        <InlineAlert tone="info">
          {LOCKED_STATE_COPY[program.listingState] ??
            'This listing can’t be edited in its current state.'}
        </InlineAlert>
        <Link
          className={listingStyles.inlineLink}
          to={`${organizationPath(view.organization.id, 'listings')}/${program.id}`}
        >
          View listing
        </Link>
      </div>
    );
  }

  const reviewGated = mode === 'reviewGated';
  const revisionPending = program.openRevision !== null;
  const suspended = authority.suspended;

  return (
    <div className={styles.editorWrap}>
      <div className={styles.editorHeader}>
        <EditorHeadline program={program} />
        <p className={styles.editorSubline}>
          <Link
            className={listingStyles.inlineLink}
            to={`${organizationPath(view.organization.id, 'listings')}/${program.id}`}
          >
            View listing
          </Link>
        </p>
      </div>

      {suspended ? <InlineAlert tone="info">{SUSPENDED_EDITOR_COPY}</InlineAlert> : null}
      {!suspended && program.listingState === 'changes_requested' ? (
        <InlineAlert tone="info">{CHANGES_REQUESTED_EDITOR_COPY}</InlineAlert>
      ) : null}
      {!suspended && reviewGated ? (
        <InlineAlert tone="info">
          {REVIEW_REQUIRED_COPY}
          {revisionPending ? ` ${REVISION_PENDING_COPY}` : ''}
        </InlineAlert>
      ) : null}
      {!suspended && revisionPending ? (
        <p className={styles.editorSubline}>
          <Link
            className={listingStyles.inlineLink}
            to={`${organizationPath(view.organization.id, 'listings')}/${program.id}/revision`}
          >
            View the pending review
          </Link>
        </p>
      ) : null}

      <ReadinessPanel organizationId={view.organization.id} program={program} />

      <ProgramDetailsSection
        view={view}
        program={program}
        taxonomy={taxonomy}
        categories={categories}
        reviewGated={reviewGated}
        revisionPending={revisionPending}
        readOnly={suspended}
      />
      <LocationsSection
        view={view}
        program={program}
        authority={authority}
        readOnly={suspended}
      />
      <PricingSection
        view={view}
        program={program}
        reviewGated={reviewGated}
        revisionPending={revisionPending}
        readOnly={suspended}
      />
      <MediaSection
        view={view}
        program={program}
        readOnly={suspended || !authority.canManageMedia}
      />
      <OffersSection view={view} program={program} readOnly={suspended} />
    </div>
  );
}

function EditorHeadline({ program }: { program: ProgramDetailRecord }) {
  return (
    <div className={styles.editorHeadline}>
      <h1 className={styles.editorTitle}>{program.titleEn}</h1>
      <StateChip
        label={listingStateLabel(program.listingState)}
        tone={listingStateTone(program.listingState)}
      />
    </div>
  );
}
