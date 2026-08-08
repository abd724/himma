import type {
  ListingState,
  PriceOptionRecord,
  ProgramDetailRecord,
} from '../../catalogue/contract';
import type { OrganizationView } from '../../profile/contract';

export const SUSPENDED_CATALOGUE_COPY =
  'This organization is currently suspended. Changes are unavailable.';

/** Truthful copy for roles without `catalogue.read` — no listing data is
 *  ever fetched for them (the backend would refuse the read the same way). */
export const CATALOGUE_NO_ACCESS_COPY =
  'Listings are managed by your organization’s catalogue roles — Owners, Organization Managers, Branch Managers, and Listings Editors. Your role doesn’t include viewing the catalogue.';

/**
 * UX mirror of the caller's catalogue authority — derived only from the
 * membership capabilities the backend returned, never from the role name.
 * `catalogue.read` = owner, org_manager, branch_manager, listings_editor in
 * the shipped registry; the backend stays the boundary.
 */
export interface CatalogueAuthority {
  readonly canRead: boolean;
  /** `listings.manage` present — decides only which INFORMATIONAL copy the
   *  empty state shows in W2-7 (no mutation affordance exists yet). */
  readonly canManage: boolean;
  readonly suspended: boolean;
  /** Explicit branch scope (never `'all'`): the assigned ACTIVE branch ids,
   *  mirroring the resolved principal (a deactivated branch grants no
   *  reach). Null for organization-wide memberships. */
  readonly assignedActiveBranchIds: readonly string[] | null;
}

export function catalogueAuthority(view: OrganizationView): CatalogueAuthority {
  const suspended = view.organization.verificationState === 'suspended';
  const capabilities = view.membership.capabilities;
  const scope = view.membership.branchScope;
  return {
    canRead: capabilities.includes('catalogue.read'),
    canManage: capabilities.includes('listings.manage'),
    suspended,
    assignedActiveBranchIds:
      scope === 'all'
        ? null
        : scope.filter((branchId) =>
            view.branches.some((branch) => branch.id === branchId && branch.active),
          ),
  };
}

// -- lifecycle vocabulary (docs/24 §5.3 — exact states, provider words) ------

export const LISTING_STATE_LABELS: Record<ListingState, string> = {
  draft: 'Draft',
  submitted: 'Submitted for review',
  in_review: 'In review',
  approved: 'Approved — not published',
  changes_requested: 'Changes requested',
  published: 'Published',
  paused: 'Paused',
  archived: 'Archived',
};

/** Longer provider-facing meaning, rendered on the detail status panel. */
export const LISTING_STATE_DESCRIPTIONS: Record<ListingState, string> = {
  draft: 'A private draft. Customers never see drafts. Submit it for review when it’s ready.',
  submitted: 'Waiting for Himma’s review. You’ll be able to publish it once it’s approved.',
  in_review: 'Himma is reviewing this listing right now. You’ll see the outcome here.',
  approved:
    'Himma approved this listing, but approval and publication are separate steps — it stays off the catalogue until an Owner or Organization Manager publishes it.',
  changes_requested:
    'Himma reviewed this listing and asked for changes before it can be approved. It needs your attention and a new submission.',
  published: 'Published to the Himma catalogue.',
  paused:
    'Temporarily hidden from customers. Pausing is reversible — it can be published again.',
  archived:
    'Permanently retired. Archiving is final: an archived listing can’t be published again.',
};

export type StateTone = 'positive' | 'pending' | 'attention' | 'neutral';

export const LISTING_STATE_TONES: Record<ListingState, StateTone> = {
  draft: 'neutral',
  submitted: 'pending',
  in_review: 'pending',
  approved: 'pending',
  changes_requested: 'attention',
  published: 'positive',
  paused: 'neutral',
  archived: 'neutral',
};

export function isListingState(value: string): value is ListingState {
  return value in LISTING_STATE_LABELS;
}

export function listingStateLabel(state: string): string {
  return isListingState(state) ? LISTING_STATE_LABELS[state] : state;
}

export function listingStateTone(state: string): StateTone {
  return isListingState(state) ? LISTING_STATE_TONES[state] : 'neutral';
}

// -- eligibility / content vocabulary ---------------------------------------

/** Canonical stored codes → presentation wording (docs/24 A3: `women` is the
 *  stored code, “Ladies only” is presentation; girls/boys are explicit). */
export const GENDER_LABELS: Record<string, string> = {
  women: 'Ladies only',
  men: 'Men only',
  girls: 'Girls',
  boys: 'Boys',
  mixed: 'Everyone',
};

export const SKILL_LABELS: Record<string, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  'all-levels': 'All levels',
};

export const SETTING_LABELS: Record<string, string> = {
  indoor: 'Indoor',
  outdoor: 'Outdoor',
};

export function ageSummary(program: {
  readonly allAges: boolean;
  readonly minAge: number | null;
  readonly maxAge: number | null;
}): string {
  if (program.allAges) {
    return 'All ages';
  }
  if (program.minAge !== null && program.maxAge !== null) {
    return `Ages ${program.minAge}–${program.maxAge}`;
  }
  if (program.minAge !== null) {
    return `Ages ${program.minAge}+`;
  }
  if (program.maxAge !== null) {
    return `Up to age ${program.maxAge}`;
  }
  return 'No age limits recorded';
}

// -- money / price options (integer fils, AED — display only) ----------------

/** Fils → AED display (100 fils = AED 1). Display convenience only — no
 *  stored Program.price exists and no quote/checkout math happens here. */
export function formatAedFromFils(amountFils: number): string {
  const whole = amountFils % 100 === 0;
  const amount = (amountFils / 100).toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `AED ${amount}`;
}

export const PRICE_OPTION_KIND_LABELS: Record<string, string> = {
  dropIn: 'Drop-in',
  monthly: 'Monthly',
  term: 'Term',
  camp: 'Camp',
  package: 'Package',
  free: 'Free',
};

export function priceOptionKindLabel(kind: string): string {
  return PRICE_OPTION_KIND_LABELS[kind] ?? kind;
}

export function priceOptionName(option: PriceOptionRecord): string {
  return option.labelEn ?? priceOptionKindLabel(option.kind);
}

export function priceOptionAmountDisplay(option: PriceOptionRecord): string {
  if (option.kind === 'free' || option.amountFils === null) {
    return 'Free';
  }
  return formatAedFromFils(option.amountFils);
}

/**
 * “From AED X” convenience over the ACTIVE options only (docs/28 §14a) —
 * derived at render time, never stored, never a Program.price. Null when no
 * active option exists.
 */
export function fromPriceDisplay(options: readonly PriceOptionRecord[]): string | null {
  const active = options.filter((option) => option.state === 'active');
  if (active.length === 0) {
    return null;
  }
  if (active.some((option) => option.kind === 'free' || option.amountFils === null)) {
    return 'Free option available';
  }
  const min = Math.min(...active.map((option) => option.amountFils ?? Number.POSITIVE_INFINITY));
  return `From ${formatAedFromFils(min)}`;
}

export const OFFER_KIND_LABELS: Record<string, string> = {
  freeTrial: 'Free trial',
  paidTrial: 'Paid trial',
  discount: 'Discount',
  promo: 'Promotion',
};

export function offerKindLabel(kind: string): string {
  return OFFER_KIND_LABELS[kind] ?? kind;
}

// -- dates -------------------------------------------------------------------

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatListingDate(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return 'Unknown date';
  }
  return dateFormatter.format(time);
}

// -- public visibility (the docs/28 §6 compound predicate, fully derived) ----

export interface PublicVisibility {
  readonly visible: boolean;
  readonly listingPublished: boolean;
  readonly organizationLive: boolean;
  readonly storefrontPublished: boolean;
  readonly activeBranchAssociation: boolean;
}

/**
 * The COMPLETE canonical customer-visibility predicate, derived from truth
 * the portal already loads: listing `published` AND organization `live` AND
 * storefront profile `published` AND ≥1 active association to an active
 * branch. Lifecycle state alone never claims visibility (task §18).
 */
export function publicVisibility(
  view: OrganizationView,
  program: ProgramDetailRecord,
): PublicVisibility {
  const listingPublished = program.listingState === 'published';
  const organizationLive = view.organization.verificationState === 'live';
  const storefrontPublished = view.profile.published;
  const activeBranchAssociation = program.branches.some(
    (branch) => branch.associationActive && branch.branchActive,
  );
  return {
    visible:
      listingPublished && organizationLive && storefrontPublished && activeBranchAssociation,
    listingPublished,
    organizationLive,
    storefrontPublished,
    activeBranchAssociation,
  };
}

// -- submission readiness (exact S4 completeness rules, read-only) ----------

/** Mirrors the backend CompletenessGap vocabulary exactly. */
export type CompletenessGap = 'title' | 'activeTaxonomy' | 'activeBranch' | 'activePriceOption';

export const COMPLETENESS_GAP_COPY: Record<CompletenessGap, string> = {
  title: 'An English title',
  activeTaxonomy: 'A current activity type (its previous one is no longer in the Himma catalogue)',
  activeBranch: 'At least one active branch where it runs',
  activePriceOption: 'At least one active price option',
};

/**
 * Read-only mirror of the backend submission/publication completeness rules
 * (program-management.ts completenessGaps): non-empty English title, active
 * taxonomy, ≥1 active association to an active branch, ≥1 active price
 * option. Arabic is optional and never a requirement.
 */
export function completenessGaps(program: ProgramDetailRecord): CompletenessGap[] {
  const missing: CompletenessGap[] = [];
  if (program.titleEn.trim().length === 0) {
    missing.push('title');
  }
  if (!program.activityType.active) {
    missing.push('activeTaxonomy');
  }
  if (!program.branches.some((branch) => branch.associationActive && branch.branchActive)) {
    missing.push('activeBranch');
  }
  if (!program.priceOptions.some((option) => option.state === 'active')) {
    missing.push('activePriceOption');
  }
  return missing;
}

// -- branch-scope reach (mirror of the real LIST filter, display only) ------

/**
 * TRUE iff this listing appears in a branch-scoped caller's list: no active
 * association at all (a draft not placed anywhere) or at least one active
 * association to an assigned ACTIVE branch. The detail read itself is
 * organization-wide in the shipped backend — this only explains why a
 * listing may not appear in the caller's index.
 */
export function listingReachableForScope(
  program: ProgramDetailRecord,
  assignedActiveBranchIds: readonly string[],
): boolean {
  const activeAssociations = program.branches.filter((branch) => branch.associationActive);
  return (
    activeAssociations.length === 0 ||
    activeAssociations.some((branch) => assignedActiveBranchIds.includes(branch.branchId))
  );
}
