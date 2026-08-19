/**
 * VerificationCase domain services (W3-3; docs/31) — the authoritative
 * verification review-round foundation W3-4 storage and W3-5 review build on.
 *
 * Principles (binding):
 * - The ORGANIZATION keeps the canonical business lifecycle; a case is one
 *   review ROUND (append-only history, at most one active round per org —
 *   database invariant ux_verification_case_active).
 * - Requirement policy is INJECTED configuration (D-W3-3 deferred): the
 *   policy provider supplies definitions when a round opens, and the case
 *   snapshots them immutably. No launch checklist is hardcoded anywhere.
 * - Policy absence FAILS CLOSED: no configured policy — or a policy with
 *   zero requirements — can never mean "all requirements satisfied".
 * - Readiness ("the snapshotted required evidence is stored") is COMPUTED,
 *   never persisted, and is NOT approval: it never transitions the
 *   organization, and D-S3-3 keeps production verify/go-live fail-closed
 *   until W3-4/W3-5 complete the chain.
 * - Evidence `stored` is reachable ONLY through the trusted finalization
 *   boundary (finalizeEvidenceStorage — no HTTP route exists; W3-4 wires
 *   it to the real private-storage flow). Registration creates intent
 *   (`pending_upload`), which never satisfies a requirement.
 * - D-W3-2 three-layer decisions live in named columns (reason_code /
 *   provider_safe_message / internal_note); the provider-safe read seam
 *   below structurally never selects internal notes.
 *
 * Authorization: every mutation requires the `operations` admin role fresh
 * per transaction (the organization-admin.ts pattern). W3-4 introduces the
 * provider-scoped evidence path deliberately; it does not exist here.
 */
import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { listActiveRoles } from '../../identity/persistence/admin-role-repository';

// -- policy abstraction (D-W3-3 deferred) -------------------------------------

export interface VerificationRequirementDefinition {
  /** Stable machine key, `^[a-z][a-z0-9_]{0,63}$` (schema-checked). */
  key: string;
  labelEn: string;
  descriptionEn?: string;
  required: boolean;
  sortHint?: number;
}

export interface VerificationRequirementPolicy {
  /** Opaque policy reference recorded on the case (historical provenance). */
  policyVersion: string;
  requirements: VerificationRequirementDefinition[];
}

/** Injected configuration seam — the ONLY source of requirement truth. A
 *  deployment without a configured policy opens no cases (fail closed). */
export interface VerificationRequirementPolicyProvider {
  currentPolicy(): Promise<VerificationRequirementPolicy | null>;
}

export interface VerificationCaseDeps {
  db: Db;
  /** Absent (the default everywhere today) = policy unavailable. */
  policyProvider?: VerificationRequirementPolicyProvider;
}

export interface VerificationActor {
  userId: string;
}

export const VERIFICATION_CASE_STATES = ['open', 'in_review', 'decided', 'superseded'] as const;
export const VERIFICATION_EVIDENCE_STATES = ['pending_upload', 'stored', 'superseded'] as const;
export const VERIFICATION_DECISION_OUTCOMES = ['approved', 'rejected'] as const;
export type VerificationDecisionOutcome = (typeof VERIFICATION_DECISION_OUTCOMES)[number];

/** Organization states in which a review round may open: the org has asked
 *  for review (submitted) or Himma is reviewing (in_review). Nothing here
 *  transitions the organization — that stays with organization-admin.ts. */
const CASE_OPENABLE_ORG_STATES = ['submitted', 'in_review'] as const;

async function hasOperationsRole(trx: Trx, userId: string): Promise<boolean> {
  return (await listActiveRoles(trx, userId)).includes('operations');
}

// -- open a round -------------------------------------------------------------

export type OpenVerificationCaseResult =
  | { kind: 'caseOpened'; caseId: string; round: number; version: number }
  | { kind: 'forbidden' }
  | { kind: 'organizationNotFound' }
  | { kind: 'organizationStateConflict' }
  | { kind: 'activeCaseExists' }
  | { kind: 'policyUnavailable' };

export async function openVerificationCase(
  deps: VerificationCaseDeps,
  actor: VerificationActor,
  input: { organizationId: string },
): Promise<OpenVerificationCaseResult> {
  // Policy resolution outside the transaction (it may do I/O). Fail closed
  // on absence AND on an empty checklist: zero requirements must never
  // become "all requirements satisfied" (W3-3 §10).
  const policy = (await deps.policyProvider?.currentPolicy()) ?? null;
  if (policy === null || policy.requirements.length === 0) {
    return { kind: 'policyUnavailable' };
  }
  const seenKeys = new Set<string>();
  for (const requirement of policy.requirements) {
    if (seenKeys.has(requirement.key)) return { kind: 'policyUnavailable' };
    seenKeys.add(requirement.key);
  }

  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) {
      return { kind: 'forbidden' as const };
    }
    // Lock the organization row: round numbering and the single-active
    // invariant are serialized here (the partial unique index backstops).
    const org = await trx
      .selectFrom('organization')
      .select(['verification_state'])
      .where('id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (org === undefined) return { kind: 'organizationNotFound' as const };
    if (!(CASE_OPENABLE_ORG_STATES as readonly string[]).includes(org.verification_state)) {
      return { kind: 'organizationStateConflict' as const };
    }
    const active = await trx
      .selectFrom('verification_case')
      .select(['id'])
      .where('organization_id', '=', input.organizationId)
      .where('state', 'in', ['open', 'in_review'])
      .executeTakeFirst();
    if (active !== undefined) return { kind: 'activeCaseExists' as const };

    const previous = await trx
      .selectFrom('verification_case')
      .select((eb) => eb.fn.max('round').as('max_round'))
      .where('organization_id', '=', input.organizationId)
      .executeTakeFirst();
    const round = Number(previous?.max_round ?? 0) + 1;

    const caseId = newId();
    await trx
      .insertInto('verification_case')
      .values({
        id: caseId,
        organization_id: input.organizationId,
        round,
        state: 'open',
        policy_version: policy.policyVersion,
        opened_by: actor.userId,
      })
      .execute();
    // The immutable requirement snapshot for THIS round.
    for (const [index, requirement] of policy.requirements.entries()) {
      await trx
        .insertInto('verification_case_requirement')
        .values({
          id: newId(),
          case_id: caseId,
          organization_id: input.organizationId,
          requirement_key: requirement.key,
          label_en: requirement.labelEn,
          description_en: requirement.descriptionEn ?? null,
          required: requirement.required,
          sort_hint: requirement.sortHint ?? index,
        })
        .execute();
    }
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'org.verification_case_opened',
      entityType: 'verification_case',
      entityId: caseId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: input.organizationId,
      eventType: 'organization.verification_case_opened',
      payload: {
        organizationId: input.organizationId,
        caseId,
        round,
        policyVersion: policy.policyVersion,
      },
    });
    return { kind: 'caseOpened' as const, caseId, round, version: 1 };
  });
}

// -- round state operations ---------------------------------------------------

type CaseMutationRefusal =
  | { kind: 'forbidden' }
  | { kind: 'caseNotFound' }
  | { kind: 'caseStateConflict' }
  | { kind: 'staleVersion' };

async function lockCase(
  trx: Trx,
  caseId: string,
): Promise<
  | { id: string; organization_id: string; round: number; state: string; version: number }
  | undefined
> {
  return trx
    .selectFrom('verification_case')
    .select(['id', 'organization_id', 'round', 'state', 'version'])
    .where('id', '=', caseId)
    .forUpdate()
    .executeTakeFirst();
}

export type StartCaseReviewResult = { kind: 'caseReviewStarted'; version: number } | CaseMutationRefusal;

export async function startCaseReview(
  deps: VerificationCaseDeps,
  actor: VerificationActor,
  input: { caseId: string; expectedVersion: number },
): Promise<StartCaseReviewResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const row = await lockCase(trx, input.caseId);
    if (row === undefined) return { kind: 'caseNotFound' as const };
    if (row.state !== 'open') return { kind: 'caseStateConflict' as const };
    if (row.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('verification_case')
      .set({ state: 'in_review' })
      .where('id', '=', input.caseId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'org.verification_case_review_started',
      entityType: 'verification_case',
      entityId: input.caseId,
    });
    return { kind: 'caseReviewStarted' as const, version: updated.version };
  });
}

export type SupersedeCaseResult = { kind: 'caseSuperseded'; version: number } | CaseMutationRefusal;

/** Closes an ACTIVE round WITHOUT a decision (e.g. the organization was
 *  withdrawn/offboarded mid-round) so the single-active invariant can
 *  always be restored; the round remains immutable history. */
export async function supersedeCase(
  deps: VerificationCaseDeps,
  actor: VerificationActor,
  input: { caseId: string; expectedVersion: number },
): Promise<SupersedeCaseResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const row = await lockCase(trx, input.caseId);
    if (row === undefined) return { kind: 'caseNotFound' as const };
    if (row.state !== 'open' && row.state !== 'in_review') {
      return { kind: 'caseStateConflict' as const };
    }
    if (row.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('verification_case')
      .set({ state: 'superseded', superseded_at: new Date() })
      .where('id', '=', input.caseId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'org.verification_case_superseded',
      entityType: 'verification_case',
      entityId: input.caseId,
    });
    return { kind: 'caseSuperseded' as const, version: updated.version };
  });
}

// -- evidence metadata --------------------------------------------------------

export type RegisterEvidenceResult =
  | {
      kind: 'evidenceRegistered';
      evidenceId: string;
      version: number;
      /** Set when this registration superseded a previous submission. */
      supersededEvidenceId?: string;
    }
  | { kind: 'forbidden' }
  | { kind: 'caseNotFound' }
  | { kind: 'requirementNotFound' }
  | { kind: 'caseStateConflict' }
  | { kind: 'invalidMetadata' };

/**
 * Registers a document metadata INTENT (`pending_upload`) for one
 * requirement of an OPEN case. If a current (non-superseded) submission
 * exists, it is superseded in the same transaction — replacement never
 * destroys history. The intent NEVER satisfies readiness: only the trusted
 * finalization boundary can mark evidence `stored`.
 */
export async function registerEvidence(
  deps: VerificationCaseDeps,
  actor: VerificationActor,
  input: {
    caseId: string;
    requirementId: string;
    originalFilename: string;
    declaredContentType: string;
  },
): Promise<RegisterEvidenceResult> {
  // Typed refusal ahead of the schema CHECKs (which remain the backstop).
  if (!evidenceMetadataAcceptable(input.originalFilename, input.declaredContentType)) {
    return { kind: 'invalidMetadata' };
  }
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const row = await lockCase(trx, input.caseId);
    if (row === undefined) return { kind: 'caseNotFound' as const };
    return registerEvidenceForOpenCaseInTrx(trx, actor.userId, row, input);
  });
}

export function evidenceMetadataAcceptable(
  originalFilename: string,
  declaredContentType: string,
): boolean {
  return (
    originalFilename.trim().length > 0 &&
    originalFilename.length <= 300 &&
    /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,128}$/.test(declaredContentType)
  );
}

/** @internal — shared registration core (the operations path above and the
 *  W3-4 provider-scoped path). The CALLER owns authorization and must have
 *  locked/verified the case row belongs to the acting context; this core
 *  owns the open-state rule, supersession, insertion, and auditing. */
export async function registerEvidenceForOpenCaseInTrx(
  trx: Trx,
  actorUserId: string,
  caseRow: { id: string; state: string },
  input: { requirementId: string; originalFilename: string; declaredContentType: string },
): Promise<RegisterEvidenceResult> {
  // Evidence changes only while the round is collecting (`open`): a round
  // under review or terminal is never a moving target.
  if (caseRow.state !== 'open') return { kind: 'caseStateConflict' };
  const requirement = await trx
    .selectFrom('verification_case_requirement')
    .select(['id'])
    .where('id', '=', input.requirementId)
    .where('case_id', '=', caseRow.id)
    .executeTakeFirst();
  if (requirement === undefined) return { kind: 'requirementNotFound' };

  const current = await trx
    .selectFrom('verification_evidence')
    .select(['id', 'state'])
    .where('requirement_id', '=', input.requirementId)
    .where('state', '<>', 'superseded')
    .forUpdate()
    .executeTakeFirst();
  let supersededEvidenceId: string | undefined;
  if (current !== undefined) {
    await trx
      .updateTable('verification_evidence')
      .set({ state: 'superseded', superseded_at: new Date() })
      .where('id', '=', current.id)
      .execute();
    supersededEvidenceId = current.id;
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actorUserId,
      action: 'org.verification_evidence_superseded',
      entityType: 'verification_evidence',
      entityId: current.id,
    });
  }

  const evidenceId = newId();
  await trx
    .insertInto('verification_evidence')
    .values({
      id: evidenceId,
      case_id: caseRow.id,
      requirement_id: input.requirementId,
      state: 'pending_upload',
      original_filename: input.originalFilename,
      declared_content_type: input.declaredContentType,
      created_by: actorUserId,
    })
    .execute();
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: actorUserId,
    action: 'org.verification_evidence_registered',
    entityType: 'verification_evidence',
    entityId: evidenceId,
  });
  return {
    kind: 'evidenceRegistered',
    evidenceId,
    version: 1,
    ...(supersededEvidenceId !== undefined ? { supersededEvidenceId } : {}),
  };
}

export type FinalizeEvidenceStorageResult =
  | { kind: 'evidenceStored'; version: number }
  | { kind: 'evidenceNotFound' }
  | { kind: 'evidenceStateConflict' }
  | { kind: 'invalidStorageMetadata' }
  | { kind: 'staleVersion' };

/**
 * TRUSTED finalization boundary (W3-3 §13/§25): confirms the complete
 * private binary is safely stored and records the write-once storage facts.
 * NO HTTP route reaches this function — W3-4's private-storage flow is its
 * only production caller, so a browser can never claim `stored: true`.
 * Audited as a SYSTEM action referencing the storage flow.
 */
export async function finalizeEvidenceStorage(
  deps: VerificationCaseDeps,
  input: {
    evidenceId: string;
    expectedVersion: number;
    byteSize: number;
    sha256Digest: string;
    storageRef: string;
  },
): Promise<FinalizeEvidenceStorageResult> {
  if (
    !Number.isInteger(input.byteSize) ||
    input.byteSize <= 0 ||
    !/^[0-9a-f]{64}$/.test(input.sha256Digest) ||
    input.storageRef.length === 0 ||
    input.storageRef.length > 300 ||
    /^https?:\/\//i.test(input.storageRef)
  ) {
    return { kind: 'invalidStorageMetadata' };
  }
  return withTransaction(deps.db, async (trx) => {
    const row = await trx
      .selectFrom('verification_evidence')
      .select(['id', 'state', 'version'])
      .where('id', '=', input.evidenceId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) return { kind: 'evidenceNotFound' as const };
    if (row.state !== 'pending_upload') return { kind: 'evidenceStateConflict' as const };
    if (row.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('verification_evidence')
      .set({
        state: 'stored',
        byte_size: input.byteSize,
        sha256_digest: input.sha256Digest,
        storage_ref: input.storageRef,
        stored_at: new Date(),
      })
      .where('id', '=', input.evidenceId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, {
      actorType: 'system',
      action: 'org.verification_evidence_stored',
      entityType: 'verification_evidence',
      entityId: input.evidenceId,
    });
    return { kind: 'evidenceStored' as const, version: updated.version };
  });
}

// -- readiness (computed, never persisted; readiness ≠ approval) --------------

export type CaseReadiness =
  | { kind: 'ready' }
  | {
      kind: 'missingRequirements';
      missing: Array<{ requirementKey: string; labelEn: string }>;
    }
  /** No/empty requirement snapshot — fail closed (W3-3 §10). */
  | { kind: 'policyUnavailable' };

/** Pure evaluation over one case's snapshot + current stored evidence.
 *  Runs inside the caller's transaction/connection (read-only). */
export async function evaluateCaseReadiness(
  db: Db | Trx,
  caseId: string,
): Promise<CaseReadiness | { kind: 'caseNotFound' }> {
  const requirements = await db
    .selectFrom('verification_case_requirement')
    .leftJoin('verification_evidence', (join) =>
      join
        .onRef('verification_evidence.requirement_id', '=', 'verification_case_requirement.id')
        .on('verification_evidence.state', '=', 'stored'),
    )
    .select([
      'verification_case_requirement.requirement_key as requirement_key',
      'verification_case_requirement.label_en as label_en',
      'verification_case_requirement.required as required',
      'verification_evidence.id as stored_evidence_id',
    ])
    .where('verification_case_requirement.case_id', '=', caseId)
    .orderBy('verification_case_requirement.sort_hint')
    .orderBy('verification_case_requirement.requirement_key')
    .execute();
  if (requirements.length === 0) {
    const exists = await db
      .selectFrom('verification_case')
      .select('id')
      .where('id', '=', caseId)
      .executeTakeFirst();
    // A case can only exist with ≥1 snapshotted requirement (opening fails
    // closed otherwise) — but the evaluator never assumes that: an empty
    // snapshot is policyUnavailable, NEVER "everything satisfied".
    return exists === undefined ? { kind: 'caseNotFound' } : { kind: 'policyUnavailable' };
  }
  const missing = requirements
    .filter((row) => row.required && row.stored_evidence_id === null)
    .map((row) => ({ requirementKey: row.requirement_key, labelEn: row.label_en }));
  return missing.length === 0 ? { kind: 'ready' } : { kind: 'missingRequirements', missing };
}

// -- decisions (D-W3-2 three layers) ------------------------------------------

export type RecordVerificationDecisionResult =
  | { kind: 'decisionRecorded'; decisionId: string; caseVersion: number }
  | { kind: 'invalidDecision' }
  | CaseMutationRefusal;

/**
 * Records the ONE final outcome of a round and closes the case (`decided`)
 * in the same transaction. Case-scoped only: nothing here transitions the
 * ORGANIZATION — composing the org edge with this record is W3-5's job,
 * and D-S3-3 keeps production verify/go-live fail-closed until then.
 * A rejection must carry the machine reason code AND the provider-safe
 * message (the only reviewer text ever intended for provider exposure);
 * the internal note stays staff-only forever.
 */
export async function recordVerificationDecision(
  deps: VerificationCaseDeps,
  actor: VerificationActor,
  input: {
    caseId: string;
    expectedVersion: number;
    outcome: VerificationDecisionOutcome;
    reasonCode?: string;
    providerSafeMessage?: string;
    internalNote?: string;
  },
): Promise<RecordVerificationDecisionResult> {
  if (
    input.outcome === 'rejected' &&
    (input.reasonCode === undefined || input.providerSafeMessage === undefined)
  ) {
    return { kind: 'invalidDecision' };
  }
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const row = await lockCase(trx, input.caseId);
    if (row === undefined) return { kind: 'caseNotFound' as const };
    if (row.state !== 'in_review') return { kind: 'caseStateConflict' as const };
    if (row.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    const decisionId = newId();
    await trx
      .insertInto('verification_decision')
      .values({
        id: decisionId,
        case_id: input.caseId,
        outcome: input.outcome,
        reason_code: input.reasonCode ?? null,
        provider_safe_message: input.providerSafeMessage ?? null,
        internal_note: input.internalNote ?? null,
        decided_by: actor.userId,
      })
      .execute();
    const updated = await trx
      .updateTable('verification_case')
      .set({ state: 'decided', decided_at: new Date() })
      .where('id', '=', input.caseId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'org.verification_decision_recorded',
      entityType: 'verification_decision',
      entityId: decisionId,
    });
    // Machine layers only — no reviewer text of ANY kind rides the event.
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: row.organization_id,
      eventType: 'organization.verification_decision_recorded',
      payload: {
        organizationId: row.organization_id,
        caseId: input.caseId,
        round: row.round,
        outcome: input.outcome,
        ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
      },
    });
    return { kind: 'decisionRecorded' as const, decisionId, caseVersion: updated.version };
  });
}

// -- read models: internal vs provider-safe (W3-3 §34/§35) --------------------

export interface InternalVerificationCaseView {
  caseId: string;
  organizationId: string;
  round: number;
  state: string;
  policyVersion: string;
  readiness: CaseReadiness;
  requirements: Array<{
    requirementId: string;
    requirementKey: string;
    labelEn: string;
    descriptionEn: string | null;
    required: boolean;
    /** Current (non-superseded) submission, if any — metadata only. */
    currentEvidence: {
      evidenceId: string;
      state: string;
      originalFilename: string;
      declaredContentType: string;
      byteSize: number | null;
      storedAt: string | null;
      version: number;
    } | null;
  }>;
  decision: {
    outcome: string;
    reasonCode: string | null;
    providerSafeMessage: string | null;
    /** Staff-only — NEVER present in any provider-safe projection. */
    internalNote: string | null;
    decidedBy: string;
    decidedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type GetInternalCaseViewResult =
  | { kind: 'caseView'; view: InternalVerificationCaseView }
  | { kind: 'forbidden' }
  | { kind: 'caseNotFound' };

/** INTERNAL operations read (W3-5's data source). Never returns binaries,
 *  public URLs, storage refs, digests, or auth material. */
export async function getInternalVerificationCaseView(
  deps: VerificationCaseDeps,
  actor: VerificationActor,
  caseId: string,
): Promise<GetInternalCaseViewResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const caseRow = await trx
      .selectFrom('verification_case')
      .selectAll()
      .where('id', '=', caseId)
      .executeTakeFirst();
    if (caseRow === undefined) return { kind: 'caseNotFound' as const };
    const requirements = await trx
      .selectFrom('verification_case_requirement')
      .leftJoin('verification_evidence', (join) =>
        join
          .onRef('verification_evidence.requirement_id', '=', 'verification_case_requirement.id')
          .on('verification_evidence.state', '<>', 'superseded'),
      )
      .select([
        'verification_case_requirement.id as requirement_id',
        'verification_case_requirement.requirement_key as requirement_key',
        'verification_case_requirement.label_en as label_en',
        'verification_case_requirement.description_en as description_en',
        'verification_case_requirement.required as required',
        'verification_evidence.id as evidence_id',
        'verification_evidence.state as evidence_state',
        'verification_evidence.original_filename as original_filename',
        'verification_evidence.declared_content_type as declared_content_type',
        'verification_evidence.byte_size as byte_size',
        'verification_evidence.stored_at as stored_at',
        'verification_evidence.version as evidence_version',
      ])
      .where('verification_case_requirement.case_id', '=', caseId)
      .orderBy('verification_case_requirement.sort_hint')
      .orderBy('verification_case_requirement.requirement_key')
      .execute();
    const decision = await trx
      .selectFrom('verification_decision')
      .selectAll()
      .where('case_id', '=', caseId)
      .executeTakeFirst();
    const readiness = await evaluateCaseReadiness(trx, caseId);
    return {
      kind: 'caseView' as const,
      view: {
        caseId: caseRow.id,
        organizationId: caseRow.organization_id,
        round: caseRow.round,
        state: caseRow.state,
        policyVersion: caseRow.policy_version,
        readiness: readiness.kind === 'caseNotFound' ? { kind: 'policyUnavailable' } : readiness,
        requirements: requirements.map((row) => ({
          requirementId: row.requirement_id,
          requirementKey: row.requirement_key,
          labelEn: row.label_en,
          descriptionEn: row.description_en,
          required: row.required,
          currentEvidence:
            row.evidence_id === null
              ? null
              : {
                  evidenceId: row.evidence_id,
                  state: String(row.evidence_state),
                  originalFilename: String(row.original_filename),
                  declaredContentType: String(row.declared_content_type),
                  byteSize: row.byte_size === null ? null : Number(row.byte_size),
                  storedAt: row.stored_at?.toISOString() ?? null,
                  version: Number(row.evidence_version),
                },
        })),
        decision:
          decision === undefined
            ? null
            : {
                outcome: decision.outcome,
                reasonCode: decision.reason_code,
                providerSafeMessage: decision.provider_safe_message,
                internalNote: decision.internal_note,
                decidedBy: decision.decided_by,
                decidedAt: decision.decided_at.toISOString(),
              },
        createdAt: caseRow.created_at.toISOString(),
        updatedAt: caseRow.updated_at.toISOString(),
        version: caseRow.version,
      },
    };
  });
}

/** PROVIDER-SAFE seam (W3-8 exposure lands later; no HTTP route exists).
 *  Structurally distinct from the internal view: internal notes, reviewer
 *  identity, storage metadata, and policy internals are never selected —
 *  a future provider surface consuming this seam cannot leak them. */
export interface ProviderSafeVerificationSummary {
  round: number;
  caseState: string;
  decision: {
    outcome: string;
    reasonCode: string | null;
    /** The ONE reviewer-authored text intended for providers (D-W3-2). */
    providerSafeMessage: string | null;
    decidedAt: string;
  } | null;
}

export async function getProviderSafeVerificationSummary(
  deps: { db: Db },
  input: { organizationId: string },
): Promise<{ kind: 'summary'; summary: ProviderSafeVerificationSummary } | { kind: 'noCase' }> {
  const latest = await deps.db
    .selectFrom('verification_case')
    .select(['id', 'round', 'state'])
    .where('organization_id', '=', input.organizationId)
    .orderBy('round', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (latest === undefined) return { kind: 'noCase' };
  const decision = await deps.db
    .selectFrom('verification_decision')
    // Deliberately narrow: internal_note and decided_by are UNSELECTABLE
    // through this seam.
    .select(['outcome', 'reason_code', 'provider_safe_message', 'decided_at'])
    .where('case_id', '=', latest.id)
    .executeTakeFirst();
  return {
    kind: 'summary',
    summary: {
      round: latest.round,
      caseState: latest.state,
      decision:
        decision === undefined
          ? null
          : {
              outcome: decision.outcome,
              reasonCode: decision.reason_code,
              providerSafeMessage: decision.provider_safe_message,
              decidedAt: decision.decided_at.toISOString(),
            },
    },
  };
}
