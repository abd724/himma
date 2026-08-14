import type {
  ListingState,
  ListingsReadPort,
  ProgramSummaryRecord,
} from '../../catalogue/contract';
import { LISTING_STATES } from '../../catalogue/contract';

/**
 * W2-9 dashboard truth — every number here derives from the SAME backend
 * contracts the rest of the portal reads; nothing is fabricated. Counts by
 * lifecycle state are composed CLIENT-SIDE by walking the real paginated
 * provider listings read (no aggregate/counts endpoint exists — a recorded
 * Class-A composition note for W2-12/backend planning). For a branch-scoped
 * membership the walk covers exactly the reachable set the backend serves,
 * so scoped dashboards never leak organization-wide counts.
 *
 * Deliberately absent (no truthful source): open-revision counts (the list
 * summary rows carry no revision field — composing them would need one
 * detail call per listing), and every future-domain metric — bookings,
 * revenue, attendance, ratings, capacity, conversion — whose backends do
 * not exist.
 */

export type CatalogueSummaryOutcome =
  | { readonly kind: 'loaded'; readonly programs: readonly ProgramSummaryRecord[] }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

/** Walks the real keyset pagination (limit 100 per page) to the end. */
export async function loadCatalogueSummary(
  listingsPort: ListingsReadPort,
  organizationId: string,
): Promise<CatalogueSummaryOutcome> {
  const programs: ProgramSummaryRecord[] = [];
  let cursor: string | undefined;
  // Defensive bound only — the loop ends when the cursor does.
  for (let page = 0; page < 100; page += 1) {
    const outcome = await listingsPort.listListings(organizationId, {
      limit: 100,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (outcome.kind !== 'loaded') {
      return outcome;
    }
    programs.push(...outcome.page.programs);
    if (outcome.page.nextCursor === null) {
      break;
    }
    cursor = outcome.page.nextCursor;
  }
  return { kind: 'loaded', programs };
}

/** Counts per canonical lifecycle state (unknown state strings ignored). */
export function catalogueCounts(
  programs: readonly ProgramSummaryRecord[],
): Record<ListingState, number> {
  const counts = Object.fromEntries(LISTING_STATES.map((state) => [state, 0])) as Record<
    ListingState,
    number
  >;
  for (const program of programs) {
    if ((LISTING_STATES as readonly string[]).includes(program.listingState)) {
      counts[program.listingState as ListingState] += 1;
    }
  }
  return counts;
}

/** Display order for the status summary — action-first, terminal last. */
export const DASHBOARD_STATE_ORDER: readonly ListingState[] = [
  'changes_requested',
  'draft',
  'submitted',
  'in_review',
  'approved',
  'published',
  'paused',
  'archived',
];

export function listingCountLabel(count: number): string {
  return `${count} listing${count === 1 ? '' : 's'}`;
}
