import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuditPort } from '../../app/app';
import type { AuditEventFilter } from '../../audit/contract';
import { useDebouncedValue } from '../../hooks/use-debounced-value';
import pageStyles from '../pages.module.css';
import styles from '../providers/providers.module.css';

/**
 * W3-9 audit explorer (AD-18) over the NEW `GET /admin/audit-events`
 * read — the real append-only trail, paginated by keyset, filtered
 * server-side. Read-only by construction: no mutation control exists,
 * and the projection is the bounded "who did what to which entity,
 * when" the backend serves (nothing internal to render even if we
 * wanted to).
 */

const dateTimeFormat = new Intl.DateTimeFormat('en-AE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function AuditPage() {
  const port = useAuditPort();
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [action, setAction] = useState('');
  const debounced = useDebouncedValue({ entityType, entityId, action }, 300);
  const filter: AuditEventFilter = {
    ...(debounced.entityType.trim() !== '' ? { entityType: debounced.entityType.trim() } : {}),
    ...(debounced.entityId.trim() !== '' ? { entityId: debounced.entityId.trim() } : {}),
    ...(debounced.action.trim() !== '' ? { action: debounced.action.trim() } : {}),
  };

  const query = useInfiniteQuery({
    queryKey: ['admin-audit-events', filter],
    initialPageParam: undefined as string | undefined,
    async queryFn({ pageParam }) {
      const outcome = await port.listEvents({
        ...filter,
        ...(pageParam !== undefined ? { cursor: pageParam } : {}),
      });
      if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
      return outcome;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: (failureCount, error) => error.message !== 'forbidden' && failureCount < 1,
  });
  const events = query.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <>
      <h1 className={pageStyles.pageTitle}>Audit</h1>
      <p className={pageStyles.lead}>
        The append-only record of administrative actions: who did what to which entity, and when.
        Viewing this record changes nothing.
      </p>
      <div className={styles.controls}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="audit-entity-type">
            Entity type
          </label>
          <input
            id="audit-entity-type"
            className={styles.searchInput}
            placeholder="e.g. organization"
            value={entityType}
            onChange={(event) => setEntityType(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="audit-entity-id">
            Entity id
          </label>
          <input
            id="audit-entity-id"
            className={styles.searchInput}
            value={entityId}
            onChange={(event) => setEntityId(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="audit-action">
            Action
          </label>
          <input
            id="audit-action"
            className={styles.searchInput}
            placeholder="e.g. listing.approved"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          />
        </div>
      </div>

      {query.isPending ? (
        <div className={styles.statusPanel} role="status">
          Loading the audit record…
        </div>
      ) : query.isError ? (
        query.error.message === 'forbidden' ? (
          <div className={styles.statusPanel}>Your roles don’t include audit review.</div>
        ) : (
          <div className={styles.statusPanel} role="alert">
            <p style={{ marginTop: 0 }}>We couldn’t load the audit record.</p>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void query.refetch()}
            >
              Try again
            </button>
          </div>
        )
      ) : events.length === 0 ? (
        <div className={styles.statusPanel}>No audit events match this view.</div>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Entity</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td data-label="When">{dateTimeFormat.format(new Date(event.occurredAt))}</td>
                    <td data-label="Actor">
                      {event.actorId === null ? (
                        <span className={styles.muted}>{event.actorType}</span>
                      ) : (
                        <code>{event.actorId}</code>
                      )}
                    </td>
                    <td data-label="Action">
                      <code>{event.action}</code>
                    </td>
                    <td data-label="Entity">
                      {event.entityType} · <code>{event.entityId}</code>
                    </td>
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
                {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
