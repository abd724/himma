/**
 * Provider program (Listing) application services (S4-2; docs/28 §16.2;
 * docs/24 §5.3 as amended; D-S4-1/D-S4-2).
 *
 * The S4-1 database lifecycle is the final invariant — these services
 * perform typed prechecks and translate DB enforcement into stable domain
 * outcomes, never exposing trigger or constraint names. Every operation is
 * explicitly organization-scoped; ownership is immutable by construction
 * (no input can even express a move). Publication is a NAMED action
 * (D-S4-2): approval never auto-publishes, and no service accepts a raw
 * target state. Sensitive edits (eligibility, safety copy — and price
 * options, in their own service) on review-gated listings create a
 * `program_revision` instead of touching live canonical fields. Mutations
 * write the docs/28 §15 audit/outbox vocabulary in the same transaction
 * with ids-only payloads.
 */
import { sql, type SqlBool } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { isDbError } from '../../../db/errors';
import { newId } from '../../../db/ids';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import type { OrgScope } from '../../provider/services/provider-principal';
import { branchInScope } from '../../provider/services/provider-principal';
import {
  editModeOf,
  findOrgProgram,
  programInBranchScope,
  programReadableInBranchScope,
  toOptionView,
  OPTION_COLUMNS,
  type CatalogueActor,
  type CatalogueServiceDeps,
  type ProgramDetailView,
  type ProgramSummaryView,
} from './catalogue-shared';
import { refreshProgramSearchDocumentsInTrx } from './search-projection';

// -- shared emit helpers ------------------------------------------------------

export async function emitListingEvent(
  trx: Trx,
  actor: CatalogueActor,
  scope: OrgScope,
  programId: string,
  action: string,
  eventType: string,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: actor.userId,
    action,
    entityType: 'program',
    entityId: programId,
  });
  await appendOutboxEvent(trx, {
    aggregateType: 'program',
    aggregateId: programId,
    eventType,
    payload: { programId, organizationId: scope.organizationId, ...extraPayload },
  });
}

// -- sensitive-field revision creation (docs/28 §7) ---------------------------

export interface RevisionChanges {
  minAge?: number | null;
  maxAge?: number | null;
  allAges?: boolean;
  genderEligibility?: string;
  skillLevel?: string | null;
  eligibilityNotes?: string | null;
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  option?: {
    /** NULL = add-intent for a new option. */
    optionId: string | null;
    kind?: string;
    amountFils?: number | null;
    sessionsCount?: number | null;
    labelEn?: string | null;
    labelAr?: string | null;
    sortHint?: number;
    state?: string;
  };
}

export type CreateRevisionResult =
  | { kind: 'revisionCreated'; revisionId: string }
  | { kind: 'revisionPending' };

/** Inserts the structured revision row (state `submitted`); the partial
 *  unique index enforces at most one OPEN revision per listing. */
export async function createSensitiveRevision(
  trx: Trx,
  scope: OrgScope,
  actor: CatalogueActor,
  programId: string,
  changes: RevisionChanges,
): Promise<CreateRevisionResult> {
  // Clean precheck (the caller holds the program row lock); the partial
  // unique index below remains the race-safe authority.
  const open = await trx
    .selectFrom('program_revision')
    .select('id')
    .where('program_id', '=', programId)
    .where('state', 'in', ['submitted', 'in_review'])
    .executeTakeFirst();
  if (open !== undefined) return { kind: 'revisionPending' };
  const id = newId();
  try {
    await trx
      .insertInto('program_revision')
      .values({
        id,
        program_id: programId,
        organization_id: scope.organizationId,
        submitted_by: actor.userId,
        ...(changes.minAge !== undefined ? { min_age: changes.minAge } : {}),
        ...(changes.maxAge !== undefined ? { max_age: changes.maxAge } : {}),
        ...(changes.allAges !== undefined ? { all_ages: changes.allAges } : {}),
        ...(changes.genderEligibility !== undefined
          ? { gender_eligibility: changes.genderEligibility }
          : {}),
        ...(changes.skillLevel !== undefined ? { skill_level: changes.skillLevel } : {}),
        ...(changes.eligibilityNotes !== undefined
          ? { eligibility_notes: changes.eligibilityNotes }
          : {}),
        ...(changes.descriptionEn !== undefined ? { description_en: changes.descriptionEn } : {}),
        ...(changes.descriptionAr !== undefined ? { description_ar: changes.descriptionAr } : {}),
        ...(changes.option !== undefined
          ? {
              option_id: changes.option.optionId,
              ...(changes.option.kind !== undefined ? { option_kind: changes.option.kind } : {}),
              ...(changes.option.amountFils !== undefined
                ? { option_amount_fils: changes.option.amountFils }
                : {}),
              ...(changes.option.sessionsCount !== undefined
                ? { option_sessions_count: changes.option.sessionsCount }
                : {}),
              ...(changes.option.labelEn !== undefined
                ? { option_label_en: changes.option.labelEn }
                : {}),
              ...(changes.option.labelAr !== undefined
                ? { option_label_ar: changes.option.labelAr }
                : {}),
              ...(changes.option.sortHint !== undefined
                ? { option_sort_hint: changes.option.sortHint }
                : {}),
              ...(changes.option.state !== undefined ? { option_state: changes.option.state } : {}),
            }
          : {}),
      })
      .execute();
  } catch (error) {
    // Inside the transaction the raw pg error has not been translated yet;
    // check both shapes for the concurrent-creator race.
    if (
      isDbError(error, 'uniqueViolation') ||
      (error as { code?: string }).code === '23505'
    ) {
      return { kind: 'revisionPending' };
    }
    throw error;
  }
  await emitListingEvent(
    trx,
    { userId: actor.userId },
    scope,
    programId,
    'listing.revision_submitted',
    'listing.revision_submitted',
    { revisionId: id },
  );
  return { kind: 'revisionCreated', revisionId: id };
}

// -- taxonomy + eligibility prechecks -----------------------------------------

async function activityTypeIsActive(trx: Trx, activityTypeId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('activity_type')
    .select('id')
    .where('id', '=', activityTypeId)
    .where('active', '=', true)
    .executeTakeFirst();
  return row !== undefined;
}

export function eligibilityValid(input: {
  minAge?: number | null;
  maxAge?: number | null;
  allAges?: boolean;
}): boolean {
  const minAge = input.minAge ?? null;
  const maxAge = input.maxAge ?? null;
  if (minAge !== null && minAge < 0) return false;
  if (maxAge !== null && maxAge < 0) return false;
  if (minAge !== null && maxAge !== null && minAge > maxAge) return false;
  if (input.allAges === true && (minAge !== null || maxAge !== null)) return false;
  return true;
}

// -- creation -----------------------------------------------------------------

export interface CreateProgramInput {
  titleEn: string;
  titleAr?: string | null;
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  activityTypeId: string;
  setting: 'indoor' | 'outdoor';
  genderEligibility: string;
  minAge?: number | null;
  maxAge?: number | null;
  allAges?: boolean;
  skillLevel?: string | null;
  eligibilityNotes?: string | null;
}

export type CreateProgramResult =
  | { kind: 'programCreated'; program: { id: string; listingState: string; version: number } }
  | { kind: 'invalidTaxonomy' }
  | { kind: 'invalidEligibility' };

export async function createProgram(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: CreateProgramInput,
): Promise<CreateProgramResult> {
  return withTransaction(deps.db, async (trx) => {
    // Providers SELECT from the approved active taxonomy — they never create
    // classifications, and an inactive type cannot be newly chosen.
    if (!(await activityTypeIsActive(trx, input.activityTypeId))) {
      return { kind: 'invalidTaxonomy' as const };
    }
    if (!eligibilityValid(input)) return { kind: 'invalidEligibility' as const };
    const id = newId();
    await trx
      .insertInto('program')
      .values({
        id,
        organization_id: scope.organizationId,
        activity_type_id: input.activityTypeId,
        title_en: input.titleEn,
        title_ar: input.titleAr ?? null,
        description_en: input.descriptionEn ?? null,
        description_ar: input.descriptionAr ?? null,
        setting: input.setting,
        gender_eligibility: input.genderEligibility,
        min_age: input.minAge ?? null,
        max_age: input.maxAge ?? null,
        all_ages: input.allAges ?? false,
        skill_level: input.skillLevel ?? null,
        eligibility_notes: input.eligibilityNotes ?? null,
      })
      .execute();
    await emitListingEvent(trx, actor, scope, id, 'listing.created', 'listing.created');
    return {
      kind: 'programCreated' as const,
      program: { id, listingState: 'draft', version: 1 },
    };
  });
}

// -- provider-private reads ---------------------------------------------------

export type GetProgramResult =
  | { kind: 'programView'; program: ProgramDetailView }
  | { kind: 'programNotFound' };

export async function getProviderProgram(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  input: { programId: string },
): Promise<GetProgramResult> {
  return withTransaction(deps.db, async (trx) => {
    // Branch-scoped staff read exactly what their list reaches — the SAME
    // canonical reachability rule, so an in-organization out-of-scope
    // program is not-found-shaped like a foreign or unknown id.
    if (scope.branchScope !== 'all') {
      const branchScope = scope.branchScope;
      const reachable = await trx
        .selectFrom('program')
        .select('id')
        .where('id', '=', input.programId)
        .where('organization_id', '=', scope.organizationId)
        .where((eb) => programReadableInBranchScope(eb, branchScope))
        .executeTakeFirst();
      if (reachable === undefined) return { kind: 'programNotFound' as const };
    }
    const program = await loadProgramDetailInTrx(trx, {
      programId: input.programId,
      organizationId: scope.organizationId,
    });
    if (program === undefined) return { kind: 'programNotFound' as const };
    return { kind: 'programView' as const, program };
  });
}

/**
 * Shared provider/moderation projection loader. Provider reads pass the
 * scope's organization (a cross-org id resolves to nothing); the
 * internal-admin moderation surface legitimately loads across
 * organizations and omits the filter.
 */
export async function loadProgramDetailInTrx(
  trx: Trx,
  input: { programId: string; organizationId?: string },
): Promise<ProgramDetailView | undefined> {
    let programQuery = trx
      .selectFrom('program')
      .innerJoin('activity_type', 'activity_type.id', 'program.activity_type_id')
      .select([
        'program.id as id',
        'program.organization_id as organization_id',
        'program.title_en as title_en',
        'program.title_ar as title_ar',
        'program.description_en as description_en',
        'program.description_ar as description_ar',
        'program.setting as setting',
        'program.min_age as min_age',
        'program.max_age as max_age',
        'program.all_ages as all_ages',
        'program.gender_eligibility as gender_eligibility',
        'program.skill_level as skill_level',
        'program.eligibility_notes as eligibility_notes',
        'program.listing_state as listing_state',
        'program.published_at as published_at',
        'program.archived_at as archived_at',
        'program.sensitive_fields_version as sensitive_fields_version',
        'program.version as version',
        'program.created_at as created_at',
        'program.updated_at as updated_at',
        'activity_type.id as activity_type_id',
        'activity_type.slug as activity_type_slug',
        'activity_type.label_en as activity_type_label_en',
        'activity_type.active as activity_type_active',
        'activity_type.category_id as activity_type_category_id',
      ])
      .where('program.id', '=', input.programId);
    if (input.organizationId !== undefined) {
      programQuery = programQuery.where('program.organization_id', '=', input.organizationId);
    }
    const program = await programQuery.executeTakeFirst();
    if (program === undefined) return undefined;

    const options = await trx
      .selectFrom('program_price_option')
      .select(OPTION_COLUMNS)
      .where('program_id', '=', input.programId)
      .orderBy('sort_hint')
      .orderBy('id')
      .execute();
    const branches = await trx
      .selectFrom('program_branch')
      .innerJoin('branch', 'branch.id', 'program_branch.branch_id')
      .select([
        'program_branch.branch_id as branch_id',
        'branch.label as label',
        'branch.active as branch_active',
        'program_branch.active as association_active',
        'program_branch.version as version',
      ])
      .where('program_branch.program_id', '=', input.programId)
      .orderBy('program_branch.created_at')
      .execute();
    const media = await trx
      .selectFrom('program_media')
      .select(['id', 'media_ref', 'sort_hint', 'alt_text_en', 'alt_text_ar', 'active', 'version'])
      .where('program_id', '=', input.programId)
      .orderBy('sort_hint')
      .orderBy('id')
      .execute();
    const offers = await trx
      .selectFrom('offer')
      .select([
        'id',
        'kind',
        'label_en',
        'label_ar',
        'trial_amount_fils',
        'effective_start',
        'effective_end',
        'state',
        'version',
      ])
      .where('program_id', '=', input.programId)
      .orderBy('created_at')
      .execute();
    const openRevision = await trx
      .selectFrom('program_revision')
      .select(['id', 'state', 'created_at', 'version'])
      .where('program_id', '=', input.programId)
      .where('state', 'in', ['submitted', 'in_review'])
      .executeTakeFirst();

    return {
        id: program.id,
        organizationId: program.organization_id,
        activityType: {
          id: program.activity_type_id,
          slug: program.activity_type_slug,
          labelEn: program.activity_type_label_en,
          active: program.activity_type_active,
          categoryId: program.activity_type_category_id,
        },
        titleEn: program.title_en,
        titleAr: program.title_ar,
        descriptionEn: program.description_en,
        descriptionAr: program.description_ar,
        setting: program.setting,
        minAge: program.min_age,
        maxAge: program.max_age,
        allAges: program.all_ages,
        genderEligibility: program.gender_eligibility,
        skillLevel: program.skill_level,
        eligibilityNotes: program.eligibility_notes,
        listingState: program.listing_state,
        publishedAt: program.published_at?.toISOString() ?? null,
        archivedAt: program.archived_at?.toISOString() ?? null,
        sensitiveFieldsVersion: program.sensitive_fields_version,
        version: program.version,
        createdAt: program.created_at.toISOString(),
        updatedAt: program.updated_at.toISOString(),
        priceOptions: options.map(toOptionView),
        branches: branches.map((row) => ({
          branchId: row.branch_id,
          label: row.label,
          branchActive: row.branch_active,
          associationActive: row.association_active,
          version: row.version,
        })),
        media: media.map((row) => ({
          id: row.id,
          mediaRef: row.media_ref,
          sortHint: row.sort_hint,
          altTextEn: row.alt_text_en,
          altTextAr: row.alt_text_ar,
          active: row.active,
          version: row.version,
        })),
        offers: offers.map((row) => ({
          id: row.id,
          kind: row.kind,
          labelEn: row.label_en,
          labelAr: row.label_ar,
          trialAmountFils: row.trial_amount_fils === null ? null : Number(row.trial_amount_fils),
          effectiveStart: row.effective_start?.toISOString() ?? null,
          effectiveEnd: row.effective_end?.toISOString() ?? null,
          state: row.state,
          version: row.version,
        })),
        openRevision:
          openRevision === undefined
            ? null
            : {
                id: openRevision.id,
                state: openRevision.state,
                createdAt: openRevision.created_at.toISOString(),
                version: openRevision.version,
              },
    };
}

export async function listProviderPrograms(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  input: { limit?: number; cursor?: string },
): Promise<{ programs: ProgramSummaryView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  return withTransaction(deps.db, async (trx) => {
    let query = trx
      .selectFrom('program')
      .select([
        'id',
        'title_en',
        'listing_state',
        'activity_type_id',
        'version',
        'created_at',
        'updated_at',
      ])
      .where('organization_id', '=', scope.organizationId);
    // Branch-scoped staff see only listings they can reach (branchless
    // drafts or ≥1 active association in scope) — the shared canonical
    // rule participates in the authoritative query BEFORE ordering, cursor
    // continuation, and the LIMIT window, so inaccessible rows never
    // consume page slots and the cursor walks the reachable set.
    if (scope.branchScope !== 'all') {
      const branchScope = scope.branchScope;
      query = query.where((eb) => programReadableInBranchScope(eb, branchScope));
    }
    if (input.cursor !== undefined) {
      const anchor = await trx
        .selectFrom('program')
        .select('id')
        .where('id', '=', input.cursor)
        .where('organization_id', '=', scope.organizationId)
        .executeTakeFirst();
      if (anchor !== undefined) {
        // Row-wise keyset continuation evaluated entirely in SQL: pulling
        // the anchor timestamp into JS would truncate `created_at` to
        // millisecond Date precision and let the anchor row re-qualify.
        query = query.where(
          sql<SqlBool>`(created_at, id) > (SELECT created_at, id FROM program WHERE id = ${input.cursor})`,
        );
      }
    }
    const rows = await query.orderBy('created_at').orderBy('id').limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    return {
      programs: page.map((row) => ({
        id: row.id,
        titleEn: row.title_en,
        listingState: row.listing_state,
        activityTypeId: row.activity_type_id,
        version: row.version,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });
}

// -- editing (sensitive-field routing per docs/28 §7) -------------------------

export interface ProgramPatch {
  titleEn?: string;
  titleAr?: string | null;
  setting?: 'indoor' | 'outdoor';
  activityTypeId?: string;
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  minAge?: number | null;
  maxAge?: number | null;
  allAges?: boolean;
  genderEligibility?: string;
  skillLevel?: string | null;
  eligibilityNotes?: string | null;
}

/** Admin-designated sensitive set (docs/28 §7 seed): eligibility + safety
 *  copy. Price options are sensitive too — handled by their own service. */
const SENSITIVE_PATCH_FIELDS = [
  'descriptionEn',
  'descriptionAr',
  'minAge',
  'maxAge',
  'allAges',
  'genderEligibility',
  'skillLevel',
  'eligibilityNotes',
] as const;
const NON_SENSITIVE_PATCH_FIELDS = ['titleEn', 'titleAr', 'setting', 'activityTypeId'] as const;

export type UpdateProgramResult =
  | { kind: 'programUpdated'; version: number }
  | {
      kind: 'revisionSubmitted';
      revisionId: string;
      appliedFields: string[];
      deferredFields: string[];
    }
  | { kind: 'revisionPending' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'invalidTaxonomy' }
  | { kind: 'invalidEligibility' }
  | { kind: 'staleVersion' };

export async function updateProgram(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; expectedVersion: number; patch: ProgramPatch },
): Promise<UpdateProgramResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (!(await programInBranchScope(trx, scope, input.programId))) {
      return { kind: 'forbidden' as const };
    }
    const mode = editModeOf(program.listing_state);
    if (mode === 'locked') return { kind: 'lifecycleConflict' as const };
    if (program.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    const patch = input.patch;
    if (patch.activityTypeId !== undefined && !(await activityTypeIsActive(trx, patch.activityTypeId))) {
      return { kind: 'invalidTaxonomy' as const };
    }
    if (
      (patch.minAge !== undefined || patch.maxAge !== undefined || patch.allAges !== undefined) &&
      !eligibilityValid(patch)
    ) {
      return { kind: 'invalidEligibility' as const };
    }

    const sensitiveFields = SENSITIVE_PATCH_FIELDS.filter((field) => patch[field] !== undefined);
    const directFields: string[] =
      mode === 'direct'
        ? [
            ...NON_SENSITIVE_PATCH_FIELDS.filter((field) => patch[field] !== undefined),
            ...sensitiveFields,
          ]
        : [...NON_SENSITIVE_PATCH_FIELDS.filter((field) => patch[field] !== undefined)];
    const deferredFields = mode === 'reviewGated' ? sensitiveFields : [];

    let version = program.version;
    if (directFields.length > 0) {
      const directSet: Record<string, unknown> = {};
      const apply = (field: string, column: string): void => {
        if (directFields.includes(field)) {
          directSet[column] = (patch as Record<string, unknown>)[field];
        }
      };
      apply('titleEn', 'title_en');
      apply('titleAr', 'title_ar');
      apply('setting', 'setting');
      apply('activityTypeId', 'activity_type_id');
      apply('descriptionEn', 'description_en');
      apply('descriptionAr', 'description_ar');
      apply('minAge', 'min_age');
      apply('maxAge', 'max_age');
      apply('allAges', 'all_ages');
      apply('genderEligibility', 'gender_eligibility');
      apply('skillLevel', 'skill_level');
      apply('eligibilityNotes', 'eligibility_notes');
      const updated = await trx
        .updateTable('program')
        .set(directSet)
        .where('id', '=', input.programId)
        .where('version', '=', input.expectedVersion)
        .returning('version')
        .executeTakeFirst();
      if (updated === undefined) return { kind: 'staleVersion' as const };
      version = updated.version;
      await emitListingEvent(trx, actor, scope, input.programId, 'listing.updated', 'listing.updated');
    }

    if (deferredFields.length > 0) {
      const changes: Record<string, unknown> = {};
      for (const field of deferredFields) {
        changes[field] = (patch as Record<string, unknown>)[field];
      }
      const revision = await createSensitiveRevision(trx, scope, actor, input.programId, changes);
      if (revision.kind === 'revisionPending') return { kind: 'revisionPending' as const };
      // Direct fields (if any) were applied above — keep the projection in
      // step within the same transaction (docs/28 §13a).
      await refreshProgramSearchDocumentsInTrx(trx, [input.programId]);
      return {
        kind: 'revisionSubmitted' as const,
        revisionId: revision.revisionId,
        appliedFields: directFields,
        deferredFields,
      };
    }
    await refreshProgramSearchDocumentsInTrx(trx, [input.programId]);
    return { kind: 'programUpdated' as const, version };
  });
}

// -- completeness (docs/28 §4/§9.6b — service-enforced) -----------------------

export type CompletenessGap = 'title' | 'activeTaxonomy' | 'activeBranch' | 'activePriceOption';

export async function completenessGaps(
  trx: Trx,
  programId: string,
): Promise<CompletenessGap[]> {
  const missing: CompletenessGap[] = [];
  const program = await trx
    .selectFrom('program')
    .innerJoin('activity_type', 'activity_type.id', 'program.activity_type_id')
    .select(['program.title_en as title_en', 'activity_type.active as taxonomy_active'])
    .where('program.id', '=', programId)
    .executeTakeFirstOrThrow();
  if (program.title_en.trim().length === 0) missing.push('title');
  if (!program.taxonomy_active) missing.push('activeTaxonomy');
  const activeBranch = await trx
    .selectFrom('program_branch')
    .innerJoin('branch', 'branch.id', 'program_branch.branch_id')
    .select('program_branch.branch_id')
    .where('program_branch.program_id', '=', programId)
    .where('program_branch.active', '=', true)
    .where('branch.active', '=', true)
    .limit(1)
    .execute();
  if (activeBranch.length === 0) missing.push('activeBranch');
  const activeOption = await trx
    .selectFrom('program_price_option')
    .select('id')
    .where('program_id', '=', programId)
    .where('state', '=', 'active')
    .limit(1)
    .execute();
  if (activeOption.length === 0) missing.push('activePriceOption');
  return missing;
}

// -- lifecycle actions (named, never state patches) ---------------------------

export type SubmitProgramResult =
  | { kind: 'programSubmitted'; version: number }
  | { kind: 'programIncomplete'; missing: CompletenessGap[] }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function submitProgram(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; expectedVersion: number },
): Promise<SubmitProgramResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (!(await programInBranchScope(trx, scope, input.programId))) {
      return { kind: 'forbidden' as const };
    }
    if (program.listing_state !== 'draft' && program.listing_state !== 'changes_requested') {
      return { kind: 'lifecycleConflict' as const };
    }
    if (program.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const missing = await completenessGaps(trx, input.programId);
    if (missing.length > 0) return { kind: 'programIncomplete' as const, missing };

    const updated = await trx
      .updateTable('program')
      .set({ listing_state: 'submitted' })
      .where('id', '=', input.programId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    if (updated === undefined) return { kind: 'staleVersion' as const };
    await emitListingEvent(trx, actor, scope, input.programId, 'listing.submitted', 'listing.submitted', {
      previousState: program.listing_state,
    });
    return { kind: 'programSubmitted' as const, version: updated.version };
  });
}

export type PublishProgramResult =
  | { kind: 'programPublished'; version: number }
  | { kind: 'programIncomplete'; missing: CompletenessGap[] }
  | { kind: 'organizationNotLive' }
  | { kind: 'programNotFound' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

/**
 * The D-S4-2 named publication action: legal ONLY from `approved` (first
 * publication) or `paused` (resume) — the DB trigger remains the final
 * authority; approval NEVER auto-publishes; the parent organization must be
 * publicly eligible (`live`); completeness must hold at publish time.
 */
export async function publishProgram(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; expectedVersion: number },
): Promise<PublishProgramResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (program.listing_state !== 'approved' && program.listing_state !== 'paused') {
      return { kind: 'lifecycleConflict' as const };
    }
    if (scope.organizationState !== 'live') return { kind: 'organizationNotLive' as const };
    if (program.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const missing = await completenessGaps(trx, input.programId);
    if (missing.length > 0) return { kind: 'programIncomplete' as const, missing };

    const updated = await trx
      .updateTable('program')
      .set({
        listing_state: 'published',
        ...(program.listing_state === 'approved' ? { published_at: new Date() } : {}),
      })
      .where('id', '=', input.programId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    if (updated === undefined) return { kind: 'staleVersion' as const };
    await emitListingEvent(trx, actor, scope, input.programId, 'listing.published', 'listing.published', {
      previousState: program.listing_state,
    });
    await refreshProgramSearchDocumentsInTrx(trx, [input.programId]);
    return { kind: 'programPublished' as const, version: updated.version };
  });
}

export type PauseProgramResult =
  | { kind: 'programPaused'; version: number }
  | { kind: 'programNotFound' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function pauseProgram(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; expectedVersion: number },
): Promise<PauseProgramResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (program.listing_state !== 'published') return { kind: 'lifecycleConflict' as const };
    if (program.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('program')
      .set({ listing_state: 'paused' })
      .where('id', '=', input.programId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    if (updated === undefined) return { kind: 'staleVersion' as const };
    await emitListingEvent(trx, actor, scope, input.programId, 'listing.paused', 'listing.paused');
    await refreshProgramSearchDocumentsInTrx(trx, [input.programId]);
    return { kind: 'programPaused' as const, version: updated.version };
  });
}

export type ArchiveProgramResult =
  | { kind: 'programArchived' }
  | { kind: 'programNotFound' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function archiveProgram(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; expectedVersion: number },
): Promise<ArchiveProgramResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (program.listing_state !== 'published' && program.listing_state !== 'paused') {
      return { kind: 'lifecycleConflict' as const };
    }
    if (program.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('program')
      .set({ listing_state: 'archived', archived_at: new Date() })
      .where('id', '=', input.programId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitListingEvent(trx, actor, scope, input.programId, 'listing.archived', 'listing.archived');
    await refreshProgramSearchDocumentsInTrx(trx, [input.programId]);
    return { kind: 'programArchived' as const };
  });
}

// -- branch associations (docs/28 §4, composite spine) ------------------------

export type AddProgramBranchResult =
  | { kind: 'branchAssociated' }
  | { kind: 'invalidBranch' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' };

export async function addProgramBranch(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; branchId: string },
): Promise<AddProgramBranchResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (editModeOf(program.listing_state) === 'locked') {
      return { kind: 'lifecycleConflict' as const };
    }
    if (!(await programInBranchScope(trx, scope, input.programId))) {
      return { kind: 'forbidden' as const };
    }
    // Branch-scoped staff may only associate branches they control.
    if (!branchInScope(scope, input.branchId)) return { kind: 'forbidden' as const };
    // Same-organization AND active: a deactivated branch cannot newly
    // qualify as an offering location (docs/28 §4).
    const branch = await trx
      .selectFrom('branch')
      .select(['id', 'active'])
      .where('id', '=', input.branchId)
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
    if (branch === undefined || !branch.active) return { kind: 'invalidBranch' as const };

    const existing = await trx
      .selectFrom('program_branch')
      .select(['active', 'version'])
      .where('program_id', '=', input.programId)
      .where('branch_id', '=', input.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (existing === undefined) {
      await trx
        .insertInto('program_branch')
        .values({
          program_id: input.programId,
          branch_id: input.branchId,
          organization_id: scope.organizationId,
        })
        .execute();
    } else if (!existing.active) {
      // Re-association reactivates the historical row (history preserved).
      await trx
        .updateTable('program_branch')
        .set({ active: true })
        .where('program_id', '=', input.programId)
        .where('branch_id', '=', input.branchId)
        .execute();
    } else {
      return { kind: 'branchAssociated' as const }; // idempotent
    }
    await emitListingEvent(
      trx,
      actor,
      scope,
      input.programId,
      'listing.branch_association_changed',
      'listing.branch_association_changed',
      { branchId: input.branchId, active: true },
    );
    await refreshProgramSearchDocumentsInTrx(trx, [input.programId]);
    return { kind: 'branchAssociated' as const };
  });
}

export type RemoveProgramBranchResult =
  | { kind: 'branchAssociationRemoved' }
  | { kind: 'associationNotFound' }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' };

export async function removeProgramBranch(
  deps: CatalogueServiceDeps,
  scope: OrgScope,
  actor: CatalogueActor,
  input: { programId: string; branchId: string },
): Promise<RemoveProgramBranchResult> {
  return withTransaction(deps.db, async (trx) => {
    const program = await findOrgProgram(trx, scope, input.programId);
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (editModeOf(program.listing_state) === 'locked') {
      return { kind: 'lifecycleConflict' as const };
    }
    if (!(await programInBranchScope(trx, scope, input.programId))) {
      return { kind: 'forbidden' as const };
    }
    if (!branchInScope(scope, input.branchId)) return { kind: 'forbidden' as const };
    const association = await trx
      .selectFrom('program_branch')
      .select(['active'])
      .where('program_id', '=', input.programId)
      .where('branch_id', '=', input.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (association === undefined) return { kind: 'associationNotFound' as const };
    if (!association.active) return { kind: 'branchAssociationRemoved' as const }; // idempotent
    await trx
      .updateTable('program_branch')
      .set({ active: false })
      .where('program_id', '=', input.programId)
      .where('branch_id', '=', input.branchId)
      .execute();
    await emitListingEvent(
      trx,
      actor,
      scope,
      input.programId,
      'listing.branch_association_changed',
      'listing.branch_association_changed',
      { branchId: input.branchId, active: false },
    );
    await refreshProgramSearchDocumentsInTrx(trx, [input.programId]);
    return { kind: 'branchAssociationRemoved' as const };
  });
}
