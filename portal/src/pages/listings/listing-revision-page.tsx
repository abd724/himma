import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, SearchX } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { usePortalPorts } from '../../app/ports-context';
import type { ProgramDetailRecord } from '../../catalogue/contract';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { usePageTitle } from '../../hooks/use-page-title';
import { organizationPath } from '../../navigation/nav-items';
import { useActiveOrganization } from '../../organization/organization-context';
import {
  CATALOGUE_NO_ACCESS_COPY,
  catalogueAuthority,
  formatListingDate,
} from './listing-domain';
import { StateChip } from './state-chip';
import styles from './listings.module.css';

/**
 * Open-revision STATUS view (docs/29 §6 route
 * `/o/:organizationId/listings/:programId/revision`) — truthful state only.
 *
 * The provider-private contract exposes exactly `openRevision {id, state,
 * createdAt, version}` for an OPEN revision and nothing once it's decided:
 * no change-set contents, no reviewer identity, no decision history. So
 * this page shows the pending review's status and what it means (live
 * values stand; protected edits stay locked) and NOTHING invented — no
 * diff, no reviewer notes, no approve/reject/cancel control (those are
 * Himma-internal). The missing provider-readable change-set remains a
 * recorded contract gap for W2-12/backend planning.
 */
export function ListingRevisionPage() {
  const organization = useActiveOrganization();
  const { programId } = useParams();
  const { profilePort, listingsPort } = usePortalPorts();

  const viewQuery = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });
  const view = viewQuery.data?.kind === 'loaded' ? viewQuery.data.view : null;
  const canRead = view !== null && catalogueAuthority(view).canRead;

  const detailQuery = useQuery({
    queryKey: ['listing', organization.id, programId],
    queryFn: () => listingsPort.loadListing(organization.id, programId ?? ''),
    enabled: canRead,
  });
  const program = detailQuery.data?.kind === 'loaded' ? detailQuery.data.program : null;
  usePageTitle(program === null ? 'Pending review' : `Pending review — ${program.titleEn}`);

  const listingHref =
    programId === undefined
      ? organizationPath(organization.id, 'listings')
      : `${organizationPath(organization.id, 'listings')}/${programId}`;

  return (
    <>
      <p className={styles.backLinkWrap}>
        <Link className={styles.backLink} to={listingHref}>
          <ArrowLeft aria-hidden="true" strokeWidth={1.75} className={styles.backIcon} />
          Back to the listing
        </Link>
      </p>
      {viewQuery.isPending ? (
        <p className={styles.loading} role="status">
          Loading the pending review…
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
        <div className={styles.emptyCard}>
          <SearchX className={styles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
          <h2 className={styles.emptyTitle}>Listings are managed by your catalogue team</h2>
          <p className={styles.emptyBody}>{CATALOGUE_NO_ACCESS_COPY}</p>
        </div>
      ) : detailQuery.isPending ? (
        <p className={styles.loading} role="status">
          Loading the pending review…
        </p>
      ) : program !== null ? (
        <RevisionStatus organizationId={organization.id} program={program} />
      ) : detailQuery.data?.kind === 'notFound' ? (
        <div className={styles.emptyCard}>
          <SearchX className={styles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
          <h2 className={styles.emptyTitle}>Listing not found</h2>
          <p className={styles.emptyBody}>
            This listing doesn&rsquo;t exist or isn&rsquo;t part of this organization.
          </p>
          <Link className={styles.inlineLink} to={organizationPath(organization.id, 'listings')}>
            Go to your listings
          </Link>
        </div>
      ) : detailQuery.data?.kind === 'forbidden' ? (
        <div className={styles.emptyCard}>
          <SearchX className={styles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
          <h2 className={styles.emptyTitle}>Listings are managed by your catalogue team</h2>
          <p className={styles.emptyBody}>{CATALOGUE_NO_ACCESS_COPY}</p>
        </div>
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

/** The open revision's provider-facing states, in provider words. */
const REVISION_STATE_LABELS: Record<string, string> = {
  submitted: 'Waiting for review',
  in_review: 'Being reviewed',
};

function RevisionStatus({
  organizationId,
  program,
}: {
  organizationId: string;
  program: ProgramDetailRecord;
}) {
  const revision = program.openRevision;
  return (
    <div className={styles.detailWrap}>
      <header className={styles.detailHeader}>
        <div className={styles.detailHeadline}>
          <h1 className={styles.detailTitle}>Pending review</h1>
          {revision !== null ? (
            <StateChip
              label={REVISION_STATE_LABELS[revision.state] ?? 'With Himma'}
              tone="pending"
            />
          ) : null}
        </div>
        <p className={styles.detailSubline}>{program.titleEn}</p>
      </header>

      <section aria-labelledby="revision-status-heading" className={styles.section}>
        <h2 id="revision-status-heading" className={styles.sectionTitle}>
          Protected changes
        </h2>
        <div className={styles.sectionCard}>
          {revision !== null ? (
            <>
              <p className={styles.bodyText}>
                A protected change on this listing is with Himma for review.
              </p>
              <dl className={styles.definitionList}>
                <div className={styles.definitionRow}>
                  <dt>Status</dt>
                  <dd>{REVISION_STATE_LABELS[revision.state] ?? 'With Himma'}</dd>
                </div>
                <div className={styles.definitionRow}>
                  <dt>Sent to Himma</dt>
                  <dd>{formatListingDate(revision.createdAt)}</dd>
                </div>
              </dl>
              <p className={styles.supportingText}>
                Your listing stays exactly as customers see it today — sensitive details like
                pricing and eligibility keep their current values until Himma finishes the review.
                Further protected changes unlock after that.
              </p>
              <p className={styles.supportingText}>
                There&rsquo;s nothing you need to do. When the review finishes, this page clears —
                approved changes appear in the listing automatically.
              </p>
            </>
          ) : (
            <>
              <p className={styles.bodyText}>No changes pending Himma review.</p>
              <p className={styles.supportingText}>
                When Himma finishes reviewing a protected change, it clears from here — approved
                changes appear in the listing automatically.
              </p>
              <p className={styles.supportingText}>
                <Link
                  className={styles.inlineLink}
                  to={`${organizationPath(organizationId, 'listings')}/${program.id}`}
                >
                  Back to the listing
                </Link>
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
