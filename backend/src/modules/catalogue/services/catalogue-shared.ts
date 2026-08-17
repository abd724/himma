/**
 * Shared catalogue service foundation (S4-2; docs/28 §16.2 semantics).
 *
 * Cross-module dependency note (docs/25 §2, reviewed): the catalogue module
 * owns the S4-1 tables (`program`, `program_price_option`, `program_branch`,
 * `program_media`, `offer`, `program_revision`, taxonomy reads). It consumes
 * the provider module's resolved `OrgScope` and — deliberately — reads the
 * provider-owned `branch` table for same-organization association guards:
 * the composite `branch (id, organization_id)` key IS the published
 * cross-module contract the S4-1 schema binds against, and duplicating it
 * behind a service call would re-implement the FK. Recorded here as the
 * consuming module per docs/25 §2.
 *
 * Every function takes an already-resolved OrgScope; every query is
 * organization-scoped so foreign or unknown ids are not-found-shaped by
 * construction. Branch-scoped memberships (docs/28 §6 "branch_manager
 * within branch scope only") may mutate a listing only while EVERY active
 * branch association lies inside their assigned scope (vacuously true for
 * branchless drafts), and may only add/remove associations for branches
 * they control.
 */
import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';

import type { Db, DB } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { branchInScope, type OrgScope } from '../../provider/services/provider-principal';

export interface CatalogueServiceDeps {
  db: Db;
}

export interface CatalogueActor {
  userId: string;
}

/** docs/24 §5.3 states in which the provider edits content DIRECTLY. */
const DIRECT_EDIT_STATES = ['draft', 'changes_requested'] as const;
/** States in which sensitive edits must route through a revision
 *  (docs/28 §7: approved content must not change without re-review). */
const REVIEW_GATED_STATES = ['approved', 'published', 'paused'] as const;
/** States in which the listing is with Himma review — provider edits wait. */
const IN_REVIEW_STATES = ['submitted', 'in_review'] as const;

export type EditMode = 'direct' | 'reviewGated' | 'locked';

export function editModeOf(listingState: string): EditMode {
  if ((DIRECT_EDIT_STATES as readonly string[]).includes(listingState)) return 'direct';
  if ((REVIEW_GATED_STATES as readonly string[]).includes(listingState)) return 'reviewGated';
  // submitted / in_review / archived: no provider content mutation.
  void IN_REVIEW_STATES;
  return 'locked';
}

export interface ProgramRow {
  id: string;
  listing_state: string;
  version: number;
}

/** Org-scoped, row-locked program lookup: a foreign organization's program
 *  id resolves to nothing here — cross-org is not-found-shaped. */
export async function findOrgProgram(
  trx: Trx,
  scope: OrgScope,
  programId: string,
): Promise<ProgramRow | undefined> {
  return trx
    .selectFrom('program')
    .select(['id', 'listing_state', 'version'])
    .where('id', '=', programId)
    .where('organization_id', '=', scope.organizationId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * TRUE iff the scope may mutate this program under the branch-scope rule:
 * org-wide scopes always; branch-scoped memberships only when every ACTIVE
 * association lies inside their assigned active branches.
 */
export async function programInBranchScope(
  trx: Trx,
  scope: OrgScope,
  programId: string,
): Promise<boolean> {
  if (scope.branchScope === 'all') return true;
  const associations = await trx
    .selectFrom('program_branch')
    .select('branch_id')
    .where('program_id', '=', programId)
    .where('active', '=', true)
    .execute();
  return associations.every((row) => branchInScope(scope, row.branch_id));
}

/**
 * The canonical branch-scoped READ-reachability rule, shared by the
 * provider-private catalogue LIST and DETAIL (one rule, expressed inside
 * the authoritative SQL query): a program is reachable iff it has no
 * ACTIVE branch association at all (a draft not yet placed anywhere) or at
 * least one active association to an assigned active branch. The resolved
 * scope already carries assigned ACTIVE branches only, and an empty scope
 * grants nothing beyond branchless drafts (never a fallback to org-wide).
 * Mutations keep their stricter `every` rule (programInBranchScope).
 */
export function programReadableInBranchScope(
  eb: ExpressionBuilder<DB, 'program'>,
  branchScope: readonly string[],
): Expression<SqlBool> {
  const activeAssociations = eb
    .selectFrom('program_branch')
    .select('program_branch.program_id')
    .whereRef('program_branch.program_id', '=', 'program.id')
    .where('program_branch.active', '=', true);
  const branchless = eb.not(eb.exists(activeAssociations));
  if (branchScope.length === 0) return branchless;
  return eb.or([
    branchless,
    eb.exists(activeAssociations.where('program_branch.branch_id', 'in', [...branchScope])),
  ]);
}

/** Deterministic option ordering (D-S4-1): (sort_hint, id). */
export const OPTION_ORDER = ['sort_hint', 'id'] as const;

// -- provider-private views (explicit column projections) ---------------------

export interface PriceOptionView {
  id: string;
  kind: string;
  amountFils: number | null;
  currency: string;
  sessionsCount: number | null;
  labelEn: string | null;
  labelAr: string | null;
  sortHint: number;
  state: string;
  version: number;
}

export interface ProgramBranchView {
  branchId: string;
  label: string;
  branchActive: boolean;
  associationActive: boolean;
  version: number;
}

export interface ProgramMediaView {
  id: string;
  mediaRef: string;
  sortHint: number;
  altTextEn: string | null;
  altTextAr: string | null;
  active: boolean;
  version: number;
}

export interface OfferView {
  id: string;
  kind: string;
  labelEn: string;
  labelAr: string | null;
  trialAmountFils: number | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  state: string;
  version: number;
}

export interface OpenRevisionView {
  id: string;
  state: string;
  createdAt: string;
  version: number;
}

/** Derived D-S4-1 row price display: an active free option wins, otherwise
 *  the LOWEST active amount, otherwise the honest `none` readiness state.
 *  Never a stored Program.price, never a range, never an average. */
export type ProgramPriceSummary =
  | { kind: 'free' }
  | { kind: 'from'; amountFils: number; currency: 'AED' }
  | { kind: 'none' };

/**
 * W2-12C1 list-card projection: the provider listings index renders one
 * management row (activity display · price summary · branch summary ·
 * thumbnail metadata) from this single read — never from N+1 detail,
 * price, or branch requests. Thumbnails stay real METADATA (mediaRef +
 * alt text); no URL is fabricated while media binaries remain pending.
 */
export interface ProgramSummaryView {
  id: string;
  titleEn: string;
  listingState: string;
  activityType: { id: string; labelEn: string; active: boolean };
  version: number;
  createdAt: string;
  updatedAt: string;
  priceSummary: ProgramPriceSummary;
  /** ACTIVE associations only, named by the earliest one — the same
   *  association order the detail view lists. */
  branchSummary: { firstLabel: string | null; activeCount: number };
  thumbnail: { mediaRef: string; altTextEn: string | null } | null;
}

export interface ProgramDetailView {
  id: string;
  organizationId: string;
  activityType: { id: string; slug: string; labelEn: string; active: boolean; categoryId: string };
  titleEn: string;
  titleAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  setting: string;
  minAge: number | null;
  maxAge: number | null;
  allAges: boolean;
  genderEligibility: string;
  skillLevel: string | null;
  eligibilityNotes: string | null;
  listingState: string;
  publishedAt: string | null;
  archivedAt: string | null;
  sensitiveFieldsVersion: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  priceOptions: PriceOptionView[];
  branches: ProgramBranchView[];
  media: ProgramMediaView[];
  offers: OfferView[];
  openRevision: OpenRevisionView | null;
}

export function toOptionView(row: {
  id: string;
  kind: string;
  amount_fils: string | bigint | number | null;
  currency: string;
  sessions_count: number | null;
  label_en: string | null;
  label_ar: string | null;
  sort_hint: number;
  state: string;
  version: number;
}): PriceOptionView {
  return {
    id: row.id,
    kind: row.kind,
    amountFils: row.amount_fils === null ? null : Number(row.amount_fils),
    currency: row.currency,
    sessionsCount: row.sessions_count,
    labelEn: row.label_en,
    labelAr: row.label_ar,
    sortHint: row.sort_hint,
    state: row.state,
    version: row.version,
  };
}

export const OPTION_COLUMNS = [
  'id',
  'kind',
  'amount_fils',
  'currency',
  'sessions_count',
  'label_en',
  'label_ar',
  'sort_hint',
  'state',
  'version',
] as const;
