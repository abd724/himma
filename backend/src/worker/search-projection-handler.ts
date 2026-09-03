/**
 * W6-2 — the search-projection consumer behind the outbox dispatcher
 * (docs/37 §11; docs/28 §13).
 *
 * Exactly the certified `processSearchProjectionEvents` semantics, one
 * event at a time: `organization.*` events on the `organization`
 * aggregate → inbox dedup under the `search-projection` consumer →
 * recompute every document of that organization from LIVE catalogue
 * truth (payloads are never applied). Replays, duplicates, and
 * out-of-order deliveries therefore converge on current truth; the
 * projection never authorizes (the public read ANDs the live visibility
 * predicate) and never becomes a second source of catalogue truth.
 * Program-scope refreshes stay inside the certified domain transactions.
 */
import type { Db } from '../db/kysely';
import { withTransaction } from '../db/transaction';
import {
  refreshOrganizationSearchDocumentsInTrx,
  SEARCH_PROJECTION_CONSUMER,
} from '../modules/catalogue/services/search-projection';
import { markInboxProcessed } from '../outbox/outbox';
import type { OutboxEventRow, OutboxHandler } from './outbox-dispatcher';

export function createSearchProjectionHandler(): OutboxHandler {
  return {
    consumer: SEARCH_PROJECTION_CONSUMER,
    matches(event: OutboxEventRow): boolean {
      return event.aggregateType === 'organization' && event.eventType.startsWith('organization.');
    },
    async handle(db: Db, event: OutboxEventRow) {
      return withTransaction(db, async (trx) => {
        const firstDelivery = await markInboxProcessed(trx, SEARCH_PROJECTION_CONSUMER, event.id);
        if (!firstDelivery) return 'duplicate' as const;
        await refreshOrganizationSearchDocumentsInTrx(trx, event.aggregateId);
        return 'processed' as const;
      });
    },
  };
}
