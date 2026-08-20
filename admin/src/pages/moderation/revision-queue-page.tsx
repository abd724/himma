import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useModerationPort } from '../../app/app';
import pageStyles from '../pages.module.css';
import styles from '../providers/providers.module.css';

/**
 * W3-6 revision moderation queue (AD-05) — provider-submitted PROTECTED
 * changes (ProgramRevision) awaiting review, over the certified
 * `/admin/revisions` read. Distinct by design from the listing queue: a
 * revision decision applies/rejects a change-set against an already-
 * approved listing; it never re-reviews the listing itself.
 */

const dateFormat = new Intl.DateTimeFormat('en-AE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const REVISION_STATE_LABELS: Record<string, string> = {
  submitted: 'Submitted',
  in_review: 'In review',
};

export function RevisionQueuePage() {
  const port = useModerationPort();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['admin-revision-queue'],
    async queryFn() {
      const outcome = await port.listRevisions({});
      if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
      return outcome;
    },
    retry: (failureCount, error) => error.message !== 'forbidden' && failureCount < 1,
  });

  return (
    <>
      <h1 className={pageStyles.pageTitle}>Revision moderation</h1>
      <p className={pageStyles.lead}>
        Protected changes providers submitted against approved listings. Approving a revision
        applies exactly its proposed change-set; the listing stays live throughout.
      </p>
      {query.isPending ? (
        <div className={styles.statusPanel} role="status">
          Loading the revision queue…
        </div>
      ) : query.isError ? (
        query.error.message === 'forbidden' ? (
          <div className={styles.statusPanel}>Your roles don’t include catalogue moderation.</div>
        ) : (
          <div className={styles.statusPanel} role="alert">
            <p style={{ marginTop: 0 }}>We couldn’t load the revision queue.</p>
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
        <div className={styles.statusPanel}>No revisions are waiting for review.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Listing</th>
                <th scope="col">Revision status</th>
                <th scope="col">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((row) => (
                <tr
                  key={row.id}
                  className={styles.rowLink}
                  onClick={() => void navigate(`/moderation/${row.programId}`)}
                >
                  <td data-label="Listing">
                    <Link
                      className={styles.providerName}
                      to={`/moderation/${row.programId}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {row.programTitleEn}
                    </Link>
                  </td>
                  <td data-label="Revision status">
                    <span className={`${styles.badge} ${styles.badgeQueue}`}>
                      {REVISION_STATE_LABELS[row.state] ?? row.state}
                    </span>
                  </td>
                  <td data-label="Submitted">{dateFormat.format(new Date(row.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
