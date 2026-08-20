import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useModerationPort } from '../../app/app';
import pageStyles from '../pages.module.css';
import styles from '../providers/providers.module.css';

/**
 * W3-6 catalogue moderation queue (AD-05) — the server-filtered listing
 * review queue over the certified `/admin/listings` read. State filter =
 * the backend vocabulary only (submitted | in_review | both); rows link
 * to the moderation workspace. No client-side filtering, no fabricated
 * metrics.
 */

export const LISTING_STATE_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  in_review: 'In review',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  published: 'Published',
  paused: 'Paused',
  archived: 'Archived',
};

export function listingBadgeClass(state: string): string {
  switch (state) {
    case 'published':
    case 'approved':
      return `${styles.badge} ${styles.badgeLive}`;
    case 'submitted':
    case 'in_review':
      return `${styles.badge} ${styles.badgeQueue}`;
    case 'changes_requested':
    case 'archived':
      return `${styles.badge} ${styles.badgeBlocked}`;
    default:
      return `${styles.badge} ${styles.badgeNeutral}`;
  }
}

const dateFormat = new Intl.DateTimeFormat('en-AE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function ModerationQueuePage() {
  const port = useModerationPort();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawState = searchParams.get('state');
  const state = rawState === 'submitted' || rawState === 'in_review' ? rawState : undefined;

  const query = useQuery({
    queryKey: ['admin-moderation-queue', state ?? 'all'],
    async queryFn() {
      const outcome = await port.listListings(state !== undefined ? { state } : {});
      if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
      return outcome;
    },
    retry: (failureCount, error) => error.message !== 'forbidden' && failureCount < 1,
  });

  return (
    <>
      <h1 className={pageStyles.pageTitle}>Catalogue moderation</h1>
      <p className={pageStyles.lead}>
        Listings submitted for Himma review. Approval rests at “approved” — publication always
        remains the provider’s own action.
      </p>
      <div className={styles.controls}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="moderation-state">
            Review state
          </label>
          <select
            id="moderation-state"
            className={styles.stateSelect}
            value={state ?? ''}
            onChange={(event) => {
              setSearchParams((previous) => {
                const next = new URLSearchParams(previous);
                if (event.target.value === '') {
                  next.delete('state');
                } else {
                  next.set('state', event.target.value);
                }
                return next;
              });
            }}
          >
            <option value="">All pending review</option>
            <option value="submitted">Submitted</option>
            <option value="in_review">In review</option>
          </select>
        </div>
      </div>

      {query.isPending ? (
        <div className={styles.statusPanel} role="status">
          Loading the moderation queue…
        </div>
      ) : query.isError ? (
        query.error.message === 'forbidden' ? (
          <div className={styles.statusPanel}>
            Your roles don’t include catalogue moderation.
          </div>
        ) : (
          <div className={styles.statusPanel} role="alert">
            <p style={{ marginTop: 0 }}>We couldn’t load the moderation queue.</p>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void query.refetch()}
            >
              Try again
            </button>
          </div>
        )
      ) : query.data.rows.length === 0 ? (
        <div className={styles.statusPanel}>Nothing is waiting for catalogue review.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Listing</th>
                <th scope="col">Provider</th>
                <th scope="col">Status</th>
                <th scope="col">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((row) => (
                <tr
                  key={row.id}
                  className={styles.rowLink}
                  onClick={() => void navigate(`/moderation/${row.id}`)}
                >
                  <td data-label="Listing">
                    <Link
                      className={styles.providerName}
                      to={`/moderation/${row.id}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {row.titleEn}
                    </Link>
                  </td>
                  <td data-label="Provider">{row.organizationDisplayName}</td>
                  <td data-label="Status">
                    <span className={listingBadgeClass(row.listingState)}>
                      {LISTING_STATE_LABELS[row.listingState] ?? row.listingState}
                    </span>
                  </td>
                  <td data-label="Submitted">{dateFormat.format(new Date(row.updatedAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
