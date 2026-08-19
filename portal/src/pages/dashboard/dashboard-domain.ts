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
  // Defensive bound only — the loop normally ends when the cursor does.
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
      return { kind: 'loaded', programs };
    }
    cursor = outcome.page.nextCursor;
  }
  // The defensive bound exhausted with pages remaining (10,000+ listings):
  // a silently truncated catalogue would render WRONG dashboard counts as
  // if they were complete, so the summary is honestly unavailable instead
  // (W2-12D audit; a real aggregate read stays the recorded future fix).
  return { kind: 'unavailable' };
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

// -- Needs your attention / Awaiting Himma (W2-11 owner correction) -----------

/**
 * The EXACT needs-attention rule (documented + test-locked; role-aware;
 * derived only from the caller's reachable rows — since W2-12C1 each row
 * carries its own card projection):
 *
 * A listing needs the provider's attention when it is
 * 1. `changes_requested` (Himma asked for corrections), or
 * 2. `approved` AND the viewer holds `listings.publish` (ready for THEIR
 *    publication act — for other roles it is someone else's step and is
 *    deliberately not counted), or
 * 3. a `draft` whose card projection PROVES incompleteness — no active
 *    price option or no active branch. (The list surface cannot see the
 *    title/taxonomy completeness dimensions; a draft failing only those is
 *    not counted here — a recorded projection limitation, resolved by the
 *    listing's own readiness panel.)
 * Plus ONE organization item when its verification state is `draft` or
 * `rejected` (the provider's setup/resubmission action).
 *
 * NOT counted: published, paused, archived, submitted/in_review (those are
 * "Awaiting Himma"), approved for viewers without publication authority,
 * and every future booking/payment concern (no backend exists).
 */
export type AttentionItem =
  | { readonly kind: 'changesRequested'; readonly id: string; readonly titleEn: string }
  | { readonly kind: 'approvedReadyToPublish'; readonly id: string; readonly titleEn: string }
  | {
      readonly kind: 'draftIncomplete';
      readonly id: string;
      readonly titleEn: string;
      readonly reason: string;
    }
  | { readonly kind: 'organizationSetup'; readonly verificationState: string };

export function attentionItems(input: {
  readonly rows: readonly ProgramSummaryRecord[];
  readonly canPublish: boolean;
  readonly organizationVerificationState: string;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (input.organizationVerificationState === 'draft' || input.organizationVerificationState === 'rejected') {
    items.push({ kind: 'organizationSetup', verificationState: input.organizationVerificationState });
  }
  for (const row of input.rows) {
    if (row.listingState === 'changes_requested') {
      items.push({ kind: 'changesRequested', id: row.id, titleEn: row.titleEn });
      continue;
    }
    if (row.listingState === 'approved' && input.canPublish) {
      items.push({ kind: 'approvedReadyToPublish', id: row.id, titleEn: row.titleEn });
      continue;
    }
    if (row.listingState === 'draft') {
      const missingOption = row.priceSummary.kind === 'none';
      const missingBranch = row.branchSummary.activeCount === 0;
      if (missingOption || missingBranch) {
        const reason =
          missingOption && missingBranch
            ? 'Needs a branch and a price option'
            : missingOption
              ? 'Needs a price option'
              : 'Needs a branch';
        items.push({ kind: 'draftIncomplete', id: row.id, titleEn: row.titleEn, reason });
      }
    }
  }
  return items;
}

/** Things currently WITH Himma (no provider action): submitted/in-review
 *  listings from the caller's reachable set, plus the organization's own
 *  verification while it sits with Himma. */
export type AwaitingItem =
  | { readonly kind: 'listing'; readonly id: string; readonly titleEn: string; readonly listingState: ListingState }
  | { readonly kind: 'organizationVerification'; readonly verificationState: string };

export function awaitingHimmaItems(input: {
  readonly rows: readonly ProgramSummaryRecord[];
  readonly organizationVerificationState: string;
}): AwaitingItem[] {
  const items: AwaitingItem[] = [];
  if (['submitted', 'in_review', 'verified'].includes(input.organizationVerificationState)) {
    items.push({
      kind: 'organizationVerification',
      verificationState: input.organizationVerificationState,
    });
  }
  for (const row of input.rows) {
    if (row.listingState === 'submitted' || row.listingState === 'in_review') {
      items.push({
        kind: 'listing',
        id: row.id,
        titleEn: row.titleEn,
        listingState: row.listingState,
      });
    }
  }
  return items;
}

/** The most recently updated reachable listings (management recency). */
export function recentListings(
  rows: readonly ProgramSummaryRecord[],
  limit = 4,
): ProgramSummaryRecord[] {
  return [...rows]
    .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : a.id < b.id ? -1 : 1))
    .slice(0, limit);
}
