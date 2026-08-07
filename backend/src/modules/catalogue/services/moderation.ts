/**
 * Internal Himma catalogue moderation services (docs/28 §6/§7/§8/§16.3;
 * docs/24 §5.3/§10.2; D-S4-2).
 *
 * Internal admin surface, NOT the provider portal: authority is the Slice-2
 * database-backed `operations` admin role, resolved fresh inside every
 * transaction — provider memberships, customer accounts, and Cognito claims
 * are worthless here. The S4-1 state machines remain the final authority;
 * these services pre-check for typed outcomes and can never bypass the
 * triggers. Named actions only: no writable listing state exists anywhere,
 * approval NEVER publishes (publication stays the S4-2 provider action),
 * and archived listings/decided revisions are immutable history.
 *
 * Revision application (docs/28 §7): approving a revision applies the
 * STRUCTURED protected change-set to the canonical Program/option state in
 * the same transaction as the decision, bumps `sensitive_fields_version`,
 * and leaves `listing_state` untouched. Schema semantics (reconciliation
 * note, matching how S4-2 writes revisions): a NULL change column means
 * "unchanged" — clearing a sensitive field to NULL is not representable in
 * the approved §9.10 structure and would be a schema-level owner decision.
 */
import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { listActiveRoles } from '../../identity/persistence/admin-role-repository';
import {
  eligibilityValid,
  loadProgramDetailInTrx,
} from './program-management';
import { optionShapeValid, type PriceOptionKind } from './price-option-management';
import type { ProgramDetailView } from './catalogue-shared';

export interface ModerationDeps {
  db: Db;
}

export interface ModerationActor {
  userId: string;
}

/** Operations-role check, fresh from PostgreSQL inside the transaction —
 *  listing review is operations-only (docs/24 §10.2), not every admin role. */
async function hasOperationsRole(trx: Trx, userId: string): Promise<boolean> {
  return (await listActiveRoles(trx, userId)).includes('operations');
}

async function emitModerationEvent(
  trx: Trx,
  actor: ModerationActor,
  programId: string,
  organizationId: string,
  action: string,
  eventType: string,
  extraPayload: Record<string, string> = {},
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
    payload: { programId, organizationId, ...extraPayload },
  });
}

// -- moderation queue + projection (docs/28 §16.3 minimal reads) --------------

export interface ModerationQueueEntry {
  id: string;
  organizationId: string;
  organizationDisplayName: string;
  titleEn: string;
  listingState: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ListModerationQueueResult =
  | { kind: 'queue'; listings: ModerationQueueEntry[]; nextCursor: string | null }
  | { kind: 'forbidden' };

const QUEUE_STATES = ['submitted', 'in_review'] as const;

export async function listModerationQueue(
  deps: ModerationDeps,
  actor: ModerationActor,
  input: { state?: 'submitted' | 'in_review'; limit?: number; cursor?: string },
): Promise<ListModerationQueueResult> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    let query = trx
      .selectFrom('program')
      .innerJoin(
        'organization_public_profile',
        'organization_public_profile.organization_id',
        'program.organization_id',
      )
      .select([
        'program.id as id',
        'program.organization_id as organization_id',
        'organization_public_profile.display_name as display_name',
        'program.title_en as title_en',
        'program.listing_state as listing_state',
        'program.version as version',
        'program.created_at as created_at',
        'program.updated_at as updated_at',
      ])
      .where(
        'program.listing_state',
        'in',
        input.state === undefined ? [...QUEUE_STATES] : [input.state],
      )
      .orderBy('program.created_at')
      .orderBy('program.id')
      .limit(limit + 1);
    if (input.cursor !== undefined) {
      const anchor = await trx
        .selectFrom('program')
        .select(['created_at', 'id'])
        .where('id', '=', input.cursor)
        .executeTakeFirst();
      if (anchor !== undefined) {
        query = query.where((eb) =>
          eb.or([
            eb('program.created_at', '>', anchor.created_at),
            eb.and([
              eb('program.created_at', '=', anchor.created_at),
              eb('program.id', '>', anchor.id),
            ]),
          ]),
        );
      }
    }
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    return {
      kind: 'queue' as const,
      listings: page.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        organizationDisplayName: row.display_name,
        titleEn: row.title_en,
        listingState: row.listing_state,
        version: row.version,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });
}

/** The FULL structured change set an admin reviews (docs/28 §7/§9.10). */
export interface RevisionChangeSetView {
  id: string;
  programId: string;
  state: string;
  createdAt: string;
  version: number;
  minAge: number | null;
  maxAge: number | null;
  allAges: boolean | null;
  genderEligibility: string | null;
  skillLevel: string | null;
  eligibilityNotes: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  option: {
    optionId: string | null;
    kind: string | null;
    amountFils: number | null;
    sessionsCount: number | null;
    labelEn: string | null;
    labelAr: string | null;
    sortHint: number | null;
    state: string | null;
  } | null;
}

const REVISION_COLUMNS = [
  'id',
  'program_id',
  'organization_id',
  'state',
  'created_at',
  'version',
  'min_age',
  'max_age',
  'all_ages',
  'gender_eligibility',
  'skill_level',
  'eligibility_notes',
  'description_en',
  'description_ar',
  'option_id',
  'option_kind',
  'option_amount_fils',
  'option_sessions_count',
  'option_label_en',
  'option_label_ar',
  'option_sort_hint',
  'option_state',
] as const;

interface RevisionRow {
  id: string;
  program_id: string;
  organization_id: string;
  state: string;
  created_at: Date;
  version: number;
  min_age: number | null;
  max_age: number | null;
  all_ages: boolean | null;
  gender_eligibility: string | null;
  skill_level: string | null;
  eligibility_notes: string | null;
  description_en: string | null;
  description_ar: string | null;
  option_id: string | null;
  option_kind: string | null;
  option_amount_fils: string | bigint | number | null;
  option_sessions_count: number | null;
  option_label_en: string | null;
  option_label_ar: string | null;
  option_sort_hint: number | null;
  option_state: string | null;
}

function hasOptionChangeSet(revision: RevisionRow): boolean {
  return (
    revision.option_id !== null ||
    revision.option_kind !== null ||
    revision.option_amount_fils !== null ||
    revision.option_sessions_count !== null ||
    revision.option_label_en !== null ||
    revision.option_label_ar !== null ||
    revision.option_sort_hint !== null ||
    revision.option_state !== null
  );
}

function toRevisionView(revision: RevisionRow): RevisionChangeSetView {
  return {
    id: revision.id,
    programId: revision.program_id,
    state: revision.state,
    createdAt: revision.created_at.toISOString(),
    version: revision.version,
    minAge: revision.min_age,
    maxAge: revision.max_age,
    allAges: revision.all_ages,
    genderEligibility: revision.gender_eligibility,
    skillLevel: revision.skill_level,
    eligibilityNotes: revision.eligibility_notes,
    descriptionEn: revision.description_en,
    descriptionAr: revision.description_ar,
    option: hasOptionChangeSet(revision)
      ? {
          optionId: revision.option_id,
          kind: revision.option_kind,
          amountFils:
            revision.option_amount_fils === null ? null : Number(revision.option_amount_fils),
          sessionsCount: revision.option_sessions_count,
          labelEn: revision.option_label_en,
          labelAr: revision.option_label_ar,
          sortHint: revision.option_sort_hint,
          state: revision.option_state,
        }
      : null,
  };
}

export interface ModerationView {
  program: ProgramDetailView;
  organization: { id: string; displayName: string; verificationState: string };
  revision: RevisionChangeSetView | null;
}

export type GetModerationViewResult =
  | { kind: 'moderationView'; view: ModerationView }
  | { kind: 'forbidden' }
  | { kind: 'programNotFound' };

export async function getModerationView(
  deps: ModerationDeps,
  actor: ModerationActor,
  input: { programId: string },
): Promise<GetModerationViewResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const program = await loadProgramDetailInTrx(trx, { programId: input.programId });
    if (program === undefined) return { kind: 'programNotFound' as const };
    const organization = await trx
      .selectFrom('organization')
      .innerJoin(
        'organization_public_profile',
        'organization_public_profile.organization_id',
        'organization.id',
      )
      .select([
        'organization.id as id',
        'organization_public_profile.display_name as display_name',
        'organization.verification_state as verification_state',
      ])
      .where('organization.id', '=', program.organizationId)
      .executeTakeFirstOrThrow();
    const openRevision = await trx
      .selectFrom('program_revision')
      .select(REVISION_COLUMNS)
      .where('program_id', '=', input.programId)
      .where('state', 'in', ['submitted', 'in_review'])
      .executeTakeFirst();
    return {
      kind: 'moderationView' as const,
      view: {
        program,
        organization: {
          id: organization.id,
          displayName: organization.display_name,
          verificationState: organization.verification_state,
        },
        revision: openRevision === undefined ? null : toRevisionView(openRevision as RevisionRow),
      },
    };
  });
}

// -- program review transitions (docs/24 §5.3 admin edges; named actions) -----

export type ProgramReviewAction = 'start_review' | 'approve' | 'request_changes';

interface ReviewSpec {
  fromState: string;
  toState: string;
  audit: string;
  event: string;
}

const REVIEW_TRANSITIONS: Record<ProgramReviewAction, ReviewSpec> = {
  start_review: {
    fromState: 'submitted',
    toState: 'in_review',
    audit: 'listing.review_started',
    event: 'listing.review_started',
  },
  // D-S4-2 (binding): approval RESTS at `approved`. Publication remains the
  // separate provider `listings.publish` action — nothing here publishes.
  approve: {
    fromState: 'in_review',
    toState: 'approved',
    audit: 'listing.approved',
    event: 'listing.approved',
  },
  request_changes: {
    fromState: 'in_review',
    toState: 'changes_requested',
    audit: 'listing.changes_requested',
    event: 'listing.changes_requested',
  },
};

export type ReviewProgramResult =
  | { kind: 'programReviewed'; state: string; version: number }
  | { kind: 'forbidden' }
  | { kind: 'programNotFound' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function reviewProgram(
  deps: ModerationDeps,
  actor: ModerationActor,
  input: {
    programId: string;
    action: ProgramReviewAction;
    expectedVersion: number;
    /** Safe machine-readable code only — never free-text review notes. */
    reasonCode?: string;
  },
): Promise<ReviewProgramResult> {
  const spec = REVIEW_TRANSITIONS[input.action];
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const program = await trx
      .selectFrom('program')
      .select(['listing_state', 'organization_id', 'version'])
      .where('id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (program === undefined) return { kind: 'programNotFound' as const };
    if (program.listing_state !== spec.fromState) return { kind: 'lifecycleConflict' as const };
    if (program.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    const updated = await trx
      .updateTable('program')
      .set({ listing_state: spec.toState })
      .where('id', '=', input.programId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    if (updated === undefined) return { kind: 'staleVersion' as const };
    await emitModerationEvent(trx, actor, input.programId, program.organization_id, spec.audit, spec.event, {
      previousState: program.listing_state,
      ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
    });
    return { kind: 'programReviewed' as const, state: spec.toState, version: updated.version };
  });
}

// -- revision queue -----------------------------------------------------------

export interface RevisionQueueEntry {
  id: string;
  programId: string;
  organizationId: string;
  programTitleEn: string;
  state: string;
  version: number;
  createdAt: string;
}

export type ListRevisionQueueResult =
  | { kind: 'queue'; revisions: RevisionQueueEntry[]; nextCursor: string | null }
  | { kind: 'forbidden' };

export async function listRevisionQueue(
  deps: ModerationDeps,
  actor: ModerationActor,
  input: { state?: 'submitted' | 'in_review'; limit?: number; cursor?: string },
): Promise<ListRevisionQueueResult> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    let query = trx
      .selectFrom('program_revision')
      .innerJoin('program', 'program.id', 'program_revision.program_id')
      .select([
        'program_revision.id as id',
        'program_revision.program_id as program_id',
        'program_revision.organization_id as organization_id',
        'program.title_en as title_en',
        'program_revision.state as state',
        'program_revision.version as version',
        'program_revision.created_at as created_at',
      ])
      .where(
        'program_revision.state',
        'in',
        input.state === undefined ? [...QUEUE_STATES] : [input.state],
      )
      .orderBy('program_revision.created_at')
      .orderBy('program_revision.id')
      .limit(limit + 1);
    if (input.cursor !== undefined) {
      const anchor = await trx
        .selectFrom('program_revision')
        .select(['created_at', 'id'])
        .where('id', '=', input.cursor)
        .executeTakeFirst();
      if (anchor !== undefined) {
        query = query.where((eb) =>
          eb.or([
            eb('program_revision.created_at', '>', anchor.created_at),
            eb.and([
              eb('program_revision.created_at', '=', anchor.created_at),
              eb('program_revision.id', '>', anchor.id),
            ]),
          ]),
        );
      }
    }
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    return {
      kind: 'queue' as const,
      revisions: page.map((row) => ({
        id: row.id,
        programId: row.program_id,
        organizationId: row.organization_id,
        programTitleEn: row.title_en,
        state: row.state,
        version: row.version,
        createdAt: row.created_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });
}

// -- revision decisions (docs/28 §7 machine + atomic application) -------------

export type StartRevisionReviewResult =
  | { kind: 'revisionReviewStarted'; version: number }
  | { kind: 'forbidden' }
  | { kind: 'revisionNotFound' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function startRevisionReview(
  deps: ModerationDeps,
  actor: ModerationActor,
  input: { programId: string; revisionId: string; expectedVersion: number },
): Promise<StartRevisionReviewResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const revision = await trx
      .selectFrom('program_revision')
      .select(['id', 'organization_id', 'state', 'version'])
      .where('id', '=', input.revisionId)
      .where('program_id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (revision === undefined) return { kind: 'revisionNotFound' as const };
    if (revision.state !== 'submitted') return { kind: 'lifecycleConflict' as const };
    if (revision.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('program_revision')
      .set({ state: 'in_review' })
      .where('id', '=', input.revisionId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    if (updated === undefined) return { kind: 'staleVersion' as const };
    // Reconciliation note: docs/28 §15 names revision_submitted/approved/
    // rejected; the review-start state change needs an event for the same
    // reasons listing.review_started exists — smallest consistent addition
    // inside the approved namespace.
    await emitModerationEvent(
      trx,
      actor,
      input.programId,
      revision.organization_id,
      'listing.revision_review_started',
      'listing.revision_review_started',
      { revisionId: input.revisionId },
    );
    return { kind: 'revisionReviewStarted' as const, version: updated.version };
  });
}

export type DecideRevisionResult =
  | { kind: 'revisionApproved'; programVersion: number; newOptionId?: string }
  | { kind: 'revisionRejected' }
  | { kind: 'forbidden' }
  | { kind: 'revisionNotFound' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'invalidEligibility' }
  | { kind: 'invalidPriceOption' }
  | { kind: 'staleVersion' };

export async function rejectRevision(
  deps: ModerationDeps,
  actor: ModerationActor,
  input: { programId: string; revisionId: string; expectedVersion: number; reasonCode?: string },
): Promise<DecideRevisionResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const revision = await trx
      .selectFrom('program_revision')
      .select(['id', 'organization_id', 'state', 'version'])
      .where('id', '=', input.revisionId)
      .where('program_id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (revision === undefined) return { kind: 'revisionNotFound' as const };
    if (revision.state !== 'in_review') return { kind: 'lifecycleConflict' as const };
    if (revision.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('program_revision')
      .set({ state: 'rejected', decided_by: actor.userId, decided_at: new Date() })
      .where('id', '=', input.revisionId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitModerationEvent(
      trx,
      actor,
      input.programId,
      revision.organization_id,
      'listing.revision_rejected',
      'listing.revision_rejected',
      {
        revisionId: input.revisionId,
        ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
      },
    );
    return { kind: 'revisionRejected' as const };
  });
}

/**
 * Approves an in-review revision and atomically applies its protected
 * change-set: eligibility/safety-copy fields onto the program, the option
 * change onto its stable target (or a NEW option for an add-intent),
 * `sensitive_fields_version` bumped once — all in ONE transaction with the
 * decision, audit, and outbox rows. `listing_state` is never touched:
 * published stays published, approved stays approved. Canonical drift
 * (archived listing, archived target option) refuses application with a
 * typed conflict and leaves the revision open for rejection.
 */
export async function approveRevision(
  deps: ModerationDeps,
  actor: ModerationActor,
  input: { programId: string; revisionId: string; expectedVersion: number },
): Promise<DecideRevisionResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const program = await trx
      .selectFrom('program')
      .select([
        'id',
        'organization_id',
        'listing_state',
        'version',
        'min_age',
        'max_age',
        'all_ages',
        'sensitive_fields_version',
      ])
      .where('id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst();
    if (program === undefined) return { kind: 'revisionNotFound' as const };
    const revision = (await trx
      .selectFrom('program_revision')
      .select(REVISION_COLUMNS)
      .where('id', '=', input.revisionId)
      .where('program_id', '=', input.programId)
      .forUpdate()
      .executeTakeFirst()) as RevisionRow | undefined;
    if (revision === undefined) return { kind: 'revisionNotFound' as const };
    if (revision.state !== 'in_review') return { kind: 'lifecycleConflict' as const };
    if (revision.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    // An archived listing is terminal, frozen history — nothing may apply.
    if (program.listing_state === 'archived') return { kind: 'lifecycleConflict' as const };

    // Merged-eligibility precheck (NULL change column = unchanged).
    const merged = {
      minAge: revision.min_age ?? program.min_age,
      maxAge: revision.max_age ?? program.max_age,
      allAges: revision.all_ages ?? program.all_ages,
    };
    if (!eligibilityValid(merged)) return { kind: 'invalidEligibility' as const };

    // --- PRECHECK PHASE (no mutation yet: every typed refusal below leaves
    // the transaction free of writes, so a plain return can never commit a
    // partial application) -------------------------------------------------
    const changeAmount =
      revision.option_amount_fils === null ? null : Number(revision.option_amount_fils);
    let existingOption:
      | { id: string; kind: string; amount_fils: string | bigint | number | null; sessions_count: number | null; state: string }
      | undefined;
    if (hasOptionChangeSet(revision)) {
      if (revision.option_id === null) {
        // Add-intent: must describe a valid NEW active option.
        if (
          revision.option_kind === null ||
          revision.option_state === 'archived' ||
          !optionShapeValid({
            kind: revision.option_kind as PriceOptionKind,
            amountFils: changeAmount,
            sessionsCount: revision.option_sessions_count,
          })
        ) {
          return { kind: 'invalidPriceOption' as const };
        }
      } else {
        existingOption = await trx
          .selectFrom('program_price_option')
          .select(['id', 'kind', 'amount_fils', 'sessions_count', 'state'])
          .where('id', '=', revision.option_id)
          .where('program_id', '=', input.programId)
          .forUpdate()
          .executeTakeFirst();
        if (existingOption === undefined) return { kind: 'revisionNotFound' as const };
        // Archive-only retirement is absolute: an archived option is frozen
        // history — a pending revision cannot edit or resurrect it.
        if (existingOption.state === 'archived') return { kind: 'lifecycleConflict' as const };
        const mergedOption = {
          kind: (revision.option_kind ?? existingOption.kind) as PriceOptionKind,
          amountFils:
            revision.option_amount_fils !== null
              ? changeAmount
              : existingOption.amount_fils === null
                ? null
                : Number(existingOption.amount_fils),
          sessionsCount: revision.option_sessions_count ?? existingOption.sessions_count,
        };
        if (!optionShapeValid(mergedOption)) return { kind: 'invalidPriceOption' as const };
      }
    }

    // --- DECISION + APPLICATION PHASE (single transaction; any failure
    // from here on throws and rolls back everything) ------------------------
    const decided = await trx
      .updateTable('program_revision')
      .set({ state: 'approved', decided_by: actor.userId, decided_at: new Date() })
      .where('id', '=', input.revisionId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (decided.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };

    let newOptionId: string | undefined;
    if (hasOptionChangeSet(revision)) {
      if (revision.option_id === null) {
        newOptionId = newId();
        await trx
          .insertInto('program_price_option')
          .values({
            id: newOptionId,
            program_id: input.programId,
            organization_id: program.organization_id,
            kind: revision.option_kind as string,
            amount_fils: changeAmount,
            sessions_count: revision.option_sessions_count,
            label_en: revision.option_label_en,
            label_ar: revision.option_label_ar,
            sort_hint: revision.option_sort_hint ?? 0,
          })
          .execute();
      } else {
        await trx
          .updateTable('program_price_option')
          .set({
            ...(revision.option_kind !== null ? { kind: revision.option_kind } : {}),
            ...(revision.option_amount_fils !== null ? { amount_fils: changeAmount } : {}),
            ...(revision.option_sessions_count !== null
              ? { sessions_count: revision.option_sessions_count }
              : {}),
            ...(revision.option_label_en !== null ? { label_en: revision.option_label_en } : {}),
            ...(revision.option_label_ar !== null ? { label_ar: revision.option_label_ar } : {}),
            ...(revision.option_sort_hint !== null
              ? { sort_hint: revision.option_sort_hint }
              : {}),
            ...(revision.option_state !== null ? { state: revision.option_state } : {}),
          })
          .where('id', '=', revision.option_id)
          .execute();
      }
    }

    // Apply program-field changes + bump sensitive_fields_version ONCE.
    const updatedProgram = await trx
      .updateTable('program')
      .set({
        sensitive_fields_version: program.sensitive_fields_version + 1,
        ...(revision.min_age !== null ? { min_age: revision.min_age } : {}),
        ...(revision.max_age !== null ? { max_age: revision.max_age } : {}),
        ...(revision.all_ages !== null ? { all_ages: revision.all_ages } : {}),
        ...(revision.gender_eligibility !== null
          ? { gender_eligibility: revision.gender_eligibility }
          : {}),
        ...(revision.skill_level !== null ? { skill_level: revision.skill_level } : {}),
        ...(revision.eligibility_notes !== null
          ? { eligibility_notes: revision.eligibility_notes }
          : {}),
        ...(revision.description_en !== null ? { description_en: revision.description_en } : {}),
        ...(revision.description_ar !== null ? { description_ar: revision.description_ar } : {}),
      })
      .where('id', '=', input.programId)
      .returning('version')
      .executeTakeFirstOrThrow();

    await emitModerationEvent(
      trx,
      actor,
      input.programId,
      program.organization_id,
      'listing.revision_approved',
      'listing.revision_approved',
      {
        revisionId: input.revisionId,
        ...(revision.option_id !== null ? { optionId: revision.option_id } : {}),
        ...(newOptionId !== undefined ? { newOptionId } : {}),
      },
    );
    return {
      kind: 'revisionApproved' as const,
      programVersion: updatedProgram.version,
      ...(newOptionId !== undefined ? { newOptionId } : {}),
    };
  });
}
