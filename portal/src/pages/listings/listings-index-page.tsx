import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ClipboardList, Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePortalPorts } from '../../app/ports-context';
import type { ProgramListPage, ProgramSummaryRecord } from '../../catalogue/contract';
import { LISTING_STATES } from '../../catalogue/contract';
import { ActionLink } from '../../components/ui/action-link';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { PageHeader } from '../../components/ui/page-header';
import { SelectField } from '../../components/ui/select-field';
import { TextField } from '../../components/ui/text-field';
import { usePageTitle } from '../../hooks/use-page-title';
import { organizationPath } from '../../navigation/nav-items';
import { useActiveOrganization } from '../../organization/organization-context';
import type { OrganizationView } from '../../profile/contract';
import {
  CATALOGUE_NO_ACCESS_COPY,
  SUSPENDED_CATALOGUE_COPY,
  catalogueAuthority,
  formatAedFromFils,
  formatListingDate,
  LISTING_STATE_LABELS,
  listingStateLabel,
  listingStateTone,
} from './listing-domain';
import { StateChip } from './state-chip';
import styles from './listings.module.css';

/**
 * Listings index (docs/29 §6 route `/o/:organizationId/listings`) — the
 * catalogue workspace over the REAL provider-private list read
 * (`GET /provider/organizations/:orgId/listings`, capability
 * `catalogue.read`). Since W2-12C1 each summary row IS the list-card
 * projection — title, lifecycle state, activity display, thumbnail, the
 * derived D-S4-1 price summary, and the branch summary all arrive on the
 * ONE authoritative page read, so the index issues no per-row detail or
 * taxonomy requests. Nothing else is shown: no bookings, capacity,
 * sessions, ratings, or revenue exist on any backend read for this
 * surface. Status filtering and title search are CLIENT-SIDE over the
 * loaded rows (the real list API has no filter/search parameters — the
 * summary line says so truthfully); pagination mirrors the real
 * opaque-cursor keyset contract.
 */
const LISTINGS_PAGE_SIZE = 10;

export function ListingsIndexPage() {
  usePageTitle('Listings');
  const organization = useActiveOrganization();
  const { profilePort } = usePortalPorts();

  const viewQuery = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });
  const view = viewQuery.data?.kind === 'loaded' ? viewQuery.data.view : null;

  return (
    <>
      <PageHeader
        title="Listings"
        description="Create, review, and manage the activities customers see on Himma."
      />
      {viewQuery.isPending ? (
        <p className={styles.loading} role="status">
          Loading your listings…
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
      ) : !catalogueAuthority(view).canRead ? (
        <CatalogueNoAccess />
      ) : (
        <ListingsContent view={view} />
      )}
    </>
  );
}

/** Truthful no-access surface — no fake controls, no listing data fetched. */
function CatalogueNoAccess() {
  return (
    <div className={styles.emptyCard}>
      <ClipboardList className={styles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
      <h2 className={styles.emptyTitle}>Listings are managed by your catalogue team</h2>
      <p className={styles.emptyBody}>{CATALOGUE_NO_ACCESS_COPY}</p>
    </div>
  );
}

function ListingsContent({ view }: { view: OrganizationView }) {
  const { listingsPort } = usePortalPorts();
  const authority = catalogueAuthority(view);
  const organizationId = view.organization.id;

  const listQuery = useInfiniteQuery({
    queryKey: ['listings', organizationId],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<ProgramListPage> => {
      const outcome = await listingsPort.listListings(organizationId, {
        limit: LISTINGS_PAGE_SIZE,
        ...(pageParam === null ? {} : { cursor: pageParam }),
      });
      if (outcome.kind !== 'loaded') {
        throw new Error(outcome.kind);
      }
      return outcome.page;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });

  const [stateFilter, setStateFilter] = useState('all');
  const [titleSearch, setTitleSearch] = useState('');

  if (listQuery.isPending) {
    return (
      <p className={styles.loading} role="status">
        Loading your listings…
      </p>
    );
  }

  const loadedRows: ProgramSummaryRecord[] =
    listQuery.data?.pages.flatMap((page) => page.programs) ?? [];

  if (listQuery.isError && loadedRows.length === 0) {
    return (
      <div className={styles.unavailable}>
        <InlineAlert tone="error">
          We couldn&rsquo;t load your listings. Try again in a moment.
        </InlineAlert>
        <Button variant="secondary" onClick={() => void listQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (loadedRows.length === 0) {
    return (
      <div className={styles.contentWrap}>
        {authority.suspended ? (
          <InlineAlert tone="info">{SUSPENDED_CATALOGUE_COPY}</InlineAlert>
        ) : null}
        <div className={styles.emptyCard}>
          <ClipboardList className={styles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
          <h2 className={styles.emptyTitle}>No listings yet</h2>
          {authority.canManage && !authority.suspended ? (
            <>
              <p className={styles.emptyBody}>
                This is where your programs will live — each listing describes one activity or
                service, with its own pricing options and locations. It starts as a private
                draft.
              </p>
              <ActionLink to={organizationPath(view.organization.id, 'listings/new')}>
                Create listing
              </ActionLink>
            </>
          ) : (
            <p className={styles.emptyBody}>
              This organization hasn&rsquo;t added any programs to its Himma catalogue yet.
            </p>
          )}
        </div>
      </div>
    );
  }

  const trimmedSearch = titleSearch.trim().toLowerCase();
  const filtered = loadedRows.filter(
    (row) =>
      (stateFilter === 'all' || row.listingState === stateFilter) &&
      (trimmedSearch === '' || row.titleEn.toLowerCase().includes(trimmedSearch)),
  );
  const filtering = stateFilter !== 'all' || trimmedSearch !== '';
  const hasMore = listQuery.hasNextPage;

  return (
    <div className={styles.contentWrap}>
      {authority.suspended ? (
        <InlineAlert tone="info">{SUSPENDED_CATALOGUE_COPY}</InlineAlert>
      ) : null}
      {authority.assignedActiveBranchIds !== null ? (
        <InlineAlert tone="info">
          You see the listings that run at your assigned branches, plus drafts that aren&rsquo;t
          placed at a branch yet.
        </InlineAlert>
      ) : null}
      {authority.canManage && !authority.suspended ? (
        <div className={styles.createActionWrap}>
          <ActionLink to={organizationPath(organizationId, 'listings/new')}>
            Create listing
          </ActionLink>
          <ActionLink
            variant="secondary"
            to={organizationPath(organizationId, 'listings/import')}
          >
            Import listings from a spreadsheet
          </ActionLink>
        </div>
      ) : null}

      <div className={styles.filterBar}>
        <SelectField
          label="Filter by status"
          value={stateFilter}
          onChange={(event) => setStateFilter(event.target.value)}
        >
          <option value="all">All statuses</option>
          {LISTING_STATES.map((state) => (
            <option key={state} value={state}>
              {LISTING_STATE_LABELS[state]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Search by title"
          type="search"
          value={titleSearch}
          onChange={(event) => setTitleSearch(event.target.value)}
          placeholder="e.g. swimming"
        />
      </div>

      <p className={styles.summary} role="status">
        {filtering
          ? `Showing ${filtered.length} of ${loadedRows.length} loaded ${loadedRows.length === 1 ? 'listing' : 'listings'}`
          : `${loadedRows.length} ${loadedRows.length === 1 ? 'listing' : 'listings'}${hasMore ? ' loaded so far' : ''}`}
      </p>
      {filtering && hasMore ? (
        <p className={styles.filterNote}>
          Filters apply to the listings loaded so far — load more below to include the rest.
        </p>
      ) : null}

      {filtered.length === 0 ? (
        <p className={styles.emptyNote}>No loaded listings match your filters.</p>
      ) : (
        <ul className={styles.listingList} aria-label="Listings">
          {filtered.map((row) => (
            <ListingRow key={row.id} row={row} organizationId={organizationId} />
          ))}
        </ul>
      )}

      {listQuery.isError ? (
        <InlineAlert tone="error">
          We couldn&rsquo;t load more listings. Try again in a moment.
        </InlineAlert>
      ) : null}
      {hasMore ? (
        <div className={styles.loadMoreWrap}>
          <Button
            variant="secondary"
            busy={listQuery.isFetchingNextPage}
            busyLabel="Loading…"
            onClick={() => void listQuery.fetchNextPage()}
          >
            Load more listings
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Compact price line under the binding D-S4-1 semantics: an active free
 *  option shows "Free"; otherwise "From" the LOWEST active option; no
 *  active option shows the honest readiness state. Never a Program.price,
 *  never a range, never an average. */
function priceSummaryLabel(row: ProgramSummaryRecord): string {
  if (row.priceSummary.kind === 'free') return 'Free';
  if (row.priceSummary.kind === 'from') {
    return `From ${formatAedFromFils(row.priceSummary.amountFils)}`;
  }
  return 'No pricing yet';
}

/** Concise branch summary ("Marina" / "Marina + 2 more" / not placed yet). */
function branchSummaryLabel(row: ProgramSummaryRecord): string {
  const { firstLabel, activeCount } = row.branchSummary;
  if (activeCount === 0 || firstLabel === null) return 'No branch yet';
  return activeCount === 1 ? firstLabel : `${firstLabel} + ${activeCount - 1} more`;
}

function ListingRow({
  row,
  organizationId,
}: {
  row: ProgramSummaryRecord;
  organizationId: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const thumbnailUrl = row.thumbnailUrl;
  const showImage = thumbnailUrl !== null && !imageFailed;
  const contextLine = [row.activityType.labelEn, branchSummaryLabel(row)].join(' · ');
  const commerceLine = [priceSummaryLabel(row), `Updated ${formatListingDate(row.updatedAt)}`].join(
    ' · ',
  );

  return (
    <li className={styles.listingRow}>
      <Link className={styles.listingLink} to={organizationPath(organizationId, `listings/${row.id}`)}>
        {/* The adjacent title names the listing — the image adds no new
            information, so it stays decorative for assistive tech. */}
        {showImage ? (
          <img
            className={styles.listingThumb}
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span className={styles.listingThumbFallback} aria-hidden="true">
            <ImageIcon strokeWidth={1.5} className={styles.listingThumbIcon} />
          </span>
        )}
        <span className={styles.listingMain}>
          <span className={styles.listingTitle}>{row.titleEn}</span>
          {contextLine !== '' ? <span className={styles.listingMeta}>{contextLine}</span> : null}
          <span className={styles.listingMeta}>{commerceLine}</span>
        </span>
        <StateChip label={listingStateLabel(row.listingState)} tone={listingStateTone(row.listingState)} />
      </Link>
    </li>
  );
}
