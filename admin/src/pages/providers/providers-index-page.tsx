import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useProvidersPort } from '../../app/app';
import { useDebouncedValue } from '../../hooks/use-debounced-value';
import {
  ORGANIZATION_STATES,
  type OrganizationState,
  type OrganizationSummary,
  type OrganizationsPage,
} from '../../providers/contract';
import pageStyles from '../pages.module.css';
import styles from './providers.module.css';

/**
 * W3-2 Provider Directory + Review Queue — ONE authoritative server
 * contract presented as two views: "All providers" (unfiltered) and
 * "Review queue" (`needsReview=true`, the documented state predicate:
 * submitted / in_review / verified need HIMMA action). Search, the state
 * filter, and the view live in the URL, so back-navigation restores the
 * exact directory state; every predicate is applied SERVER-side over the
 * complete authorized set before pagination — nothing filters client-side.
 * READ-ONLY: no lifecycle controls exist anywhere on this surface.
 */

const PAGE_SIZE = 10;

export const STATE_LABELS: Record<OrganizationState, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  in_review: 'In review',
  verified: 'Verified',
  rejected: 'Rejected',
  live: 'Live',
  suspended: 'Suspended',
  offboarded: 'Offboarded',
};

export const REVIEW_LABELS = {
  awaiting_review: 'Awaiting review',
  in_review: 'Review in progress',
  awaiting_go_live: 'Awaiting go-live',
  none: '—',
} as const;

function stateBadgeClass(state: OrganizationState): string {
  switch (state) {
    case 'live':
      return `${styles.badge} ${styles.badgeLive}`;
    case 'submitted':
    case 'in_review':
    case 'verified':
      return `${styles.badge} ${styles.badgeQueue}`;
    case 'rejected':
    case 'suspended':
    case 'offboarded':
      return `${styles.badge} ${styles.badgeBlocked}`;
    default:
      return `${styles.badge} ${styles.badgeNeutral}`;
  }
}

function storefrontLabel(row: OrganizationSummary): string {
  if (row.storefront.publiclyVisible) return 'Public';
  if (row.storefront.published) return 'Published (not live)';
  return 'Hidden';
}

const dateFormat = new Intl.DateTimeFormat('en-AE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function isOrganizationState(value: string | null): value is OrganizationState {
  return (ORGANIZATION_STATES as readonly string[]).includes(value ?? '');
}

export function ProvidersIndexPage() {
  const port = useProvidersPort();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const rawState = searchParams.get('state');
  const stateFilter = isOrganizationState(rawState) ? rawState : undefined;
  const view = searchParams.get('view') === 'queue' ? 'queue' : 'all';

  // The search text is LOCAL (immediate typing) and syncs to the URL only
  // after the debounce — so it can never race a same-tick state/view URL
  // write (router navigations are async), while back-navigation into the
  // directory still restores the query from the URL on mount.
  const [searchText, setSearchText] = useState(() => searchParams.get('q') ?? '');
  const debouncedQ = useDebouncedValue(searchText.trim());
  useEffect(() => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (debouncedQ === '') {
          next.delete('q');
        } else {
          next.set('q', debouncedQ);
        }
        return next;
      },
      { replace: true },
    );
  }, [debouncedQ, setSearchParams]);

  // Changing q/state/view changes the key — pagination resets and no
  // filter's pages are ever cached under another filter's key.
  const query = useInfiniteQuery<
    OrganizationsPage,
    Error,
    { pages: OrganizationsPage[] },
    readonly unknown[],
    string | undefined
  >({
    queryKey: ['admin-organizations', debouncedQ, stateFilter ?? 'all', view],
    initialPageParam: undefined,
    async queryFn({ pageParam }) {
      const outcome = await port.listOrganizations({
        limit: PAGE_SIZE,
        ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        ...(debouncedQ !== '' ? { q: debouncedQ } : {}),
        ...(stateFilter !== undefined ? { state: stateFilter } : {}),
        ...(view === 'queue' ? { needsReview: true } : {}),
      });
      if (outcome.kind !== 'loaded') {
        throw new Error(outcome.kind);
      }
      return outcome.page;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Semantic refusals are authoritative — retry only transient failures.
    retry: (failureCount, error) =>
      error.message !== 'forbidden' && error.message !== 'notFound' && failureCount < 1,
  });

  const setParam = (key: 'state' | 'view', value: string | null) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === null || value === '') {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    });
  };

  const rows = query.data?.pages.flatMap((page) => page.organizations) ?? [];
  const isFiltered = debouncedQ !== '' || stateFilter !== undefined || view === 'queue';

  return (
    <>
      <div className={styles.header}>
        <h1 className={pageStyles.pageTitle}>Providers</h1>
      </div>
      <p className={pageStyles.lead}>
        {view === 'queue'
          ? 'Provider organizations that currently need a Himma action: newly submitted, under review, or verified and awaiting go-live.'
          : 'Every provider organization on Himma, with its current lifecycle, review, and storefront state.'}
      </p>

      <div className={styles.controls}>
        <div className={styles.viewToggle} role="group" aria-label="Directory view">
          <button
            type="button"
            className={`${styles.viewButton} ${view === 'all' ? styles.viewButtonActive : ''}`}
            aria-pressed={view === 'all'}
            onClick={() => setParam('view', null)}
          >
            All providers
          </button>
          <button
            type="button"
            className={`${styles.viewButton} ${view === 'queue' ? styles.viewButtonActive : ''}`}
            aria-pressed={view === 'queue'}
            onClick={() => setParam('view', 'queue')}
          >
            Review queue
          </button>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="provider-search">
            Search providers
          </label>
          <input
            id="provider-search"
            type="search"
            className={styles.searchInput}
            placeholder="Name, trade or legal name"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="provider-state">
            Organization state
          </label>
          <select
            id="provider-state"
            className={styles.stateSelect}
            value={stateFilter ?? ''}
            onChange={(event) => setParam('state', event.target.value || null)}
          >
            <option value="">All states</option>
            {ORGANIZATION_STATES.map((state) => (
              <option key={state} value={state}>
                {STATE_LABELS[state]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {query.isPending ? (
        <div className={styles.statusPanel} role="status">
          Loading providers…
        </div>
      ) : query.isError ? (
        query.error.message === 'forbidden' ? (
          <div className={styles.statusPanel}>
            Your roles don’t include provider operations, so the directory isn’t available to you.
          </div>
        ) : (
          <div className={styles.statusPanel} role="alert">
            <p style={{ marginTop: 0 }}>We couldn’t load the provider directory.</p>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void query.refetch()}
            >
              Try again
            </button>
          </div>
        )
      ) : rows.length === 0 ? (
        <div className={styles.statusPanel}>
          {isFiltered
            ? view === 'queue'
              ? 'No providers match these filters in the review queue.'
              : 'No providers match your search or filters.'
            : 'No provider organizations exist yet.'}
        </div>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Status</th>
                  <th scope="col">Review</th>
                  <th scope="col">Storefront</th>
                  <th scope="col">Branches</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.organizationId}
                    className={styles.rowLink}
                    onClick={() => void navigate(`/providers/${row.organizationId}`)}
                  >
                    <td data-label="Provider">
                      <Link
                        className={styles.providerName}
                        to={`/providers/${row.organizationId}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {row.displayName}
                      </Link>
                      <span className={styles.tradeName}>{row.tradeName}</span>
                    </td>
                    <td data-label="Status">
                      <span className={stateBadgeClass(row.verificationState)}>
                        {STATE_LABELS[row.verificationState]}
                      </span>
                    </td>
                    <td data-label="Review">
                      {row.reviewState === 'none' ? (
                        <span className={styles.muted} aria-label="No review needed">
                          —
                        </span>
                      ) : (
                        REVIEW_LABELS[row.reviewState]
                      )}
                    </td>
                    <td data-label="Storefront">{storefrontLabel(row)}</td>
                    <td data-label="Branches">{row.activeBranchCount}</td>
                    <td data-label="Updated">{dateFormat.format(new Date(row.updatedAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {query.hasNextPage ? (
            <div className={styles.loadMoreRow}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? 'Loading…' : 'Load more providers'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
