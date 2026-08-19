/**
 * Verification-evidence binary storage lifecycle (W3-4; D-W3-1) — the ONE
 * trusted path between authorized callers and the private object store.
 *
 * Authorization contexts (never interchangeable):
 * - `provider`: an authenticated staff member of the ONE organization the
 *   HTTP pipeline resolved (capability `verification.evidence.manage`,
 *   owner-only). Constrained to that organization's OWN case/requirement/
 *   evidence — cross-org anything is a not-found shape, and nothing here
 *   grants or impersonates admin authority.
 * - `operations`: the internal admin path (role resolved fresh per
 *   transaction, the W3-2/W3-3 pattern).
 *
 * Trusted-facts rule (binding): byte size and SHA-256 are computed HERE
 * from the exact bytes written; the storage key is composed HERE from ids.
 * No client-supplied value ever becomes an authoritative storage fact, and
 * W3-3's `finalizeEvidenceStorage` (no HTTP route) is called only after
 * the store confirms the object. Any failure or mismatch before that
 * leaves the evidence `pending_upload` — never a false `stored`, never
 * false readiness. Re-uploading a pending evidence overwrites ONLY its own
 * key and is the deliberate recovery path for interrupted uploads.
 *
 * Nothing here deletes objects or rows (D-W3-6 retention deferred);
 * abandoned intents simply remain pending (inert: never ready, never
 * downloadable) and their objects, if any, are unreachable except through
 * authorized rows.
 */
import { createHash } from 'node:crypto';

import { appendAuditEvent } from '../../../db/audit';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { listActiveRoles } from '../../identity/persistence/admin-role-repository';
import {
  evidenceMetadataAcceptable,
  finalizeEvidenceStorage,
  registerEvidenceForOpenCaseInTrx,
  type RegisterEvidenceResult,
} from './verification-case';
import {
  EvidenceStoreError,
  evidenceObjectKey,
  type VerificationEvidenceObjectStore,
  type VerificationEvidenceUploadConfig,
} from '../storage/evidence-store';

export interface EvidenceStorageDeps {
  db: Db;
  store: VerificationEvidenceObjectStore;
  upload: VerificationEvidenceUploadConfig;
  /**
   * W3-4 correction (owner review): content safety/scanning is deferred
   * INFRASTRUCTURE, so INTERNAL retrieval of provider-controlled bytes
   * FAILS CLOSED until a trusted content-safety boundary reports ready.
   * False (the only production-representable value — build-app refuses a
   * true claim because no scanning capability exists in this build) means
   * an operations admin never receives uploaded bytes; the provider
   * owner's retrieval of their OWN organization's document is unaffected.
   * This is a capability report, not an operator switch — the D-S3-3
   * pattern, and a HARD prerequisite for live Admin evidence review.
   */
  contentSafetyReady: boolean;
}

/** Who is acting — resolved and authorized by the HTTP pipeline (provider)
 *  or checked fresh in-transaction (operations). */
export type EvidenceAccessContext =
  | { kind: 'provider'; organizationId: string; userId: string }
  | { kind: 'operations'; userId: string };

async function hasOperationsRole(trx: Trx, userId: string): Promise<boolean> {
  return (await listActiveRoles(trx, userId)).includes('operations');
}

interface EvidenceRow {
  id: string;
  case_id: string;
  organization_id: string;
  state: string;
  version: number;
  original_filename: string;
  declared_content_type: string;
  storage_ref: string | null;
  byte_size: string | number | bigint | null;
}

/** Loads evidence + owning case, enforcing the access context. Cross-org
 *  provider access collapses to `evidenceNotFound` (no existence oracle). */
async function loadAuthorizedEvidence(
  trx: Trx,
  context: EvidenceAccessContext,
  evidenceId: string,
  options: { forUpdate: boolean },
): Promise<{ kind: 'evidence'; row: EvidenceRow } | { kind: 'forbidden' } | { kind: 'evidenceNotFound' }> {
  if (context.kind === 'operations' && !(await hasOperationsRole(trx, context.userId))) {
    return { kind: 'forbidden' };
  }
  let query = trx
    .selectFrom('verification_evidence')
    .innerJoin('verification_case', 'verification_case.id', 'verification_evidence.case_id')
    .select([
      'verification_evidence.id as id',
      'verification_evidence.case_id as case_id',
      'verification_case.organization_id as organization_id',
      'verification_evidence.state as state',
      'verification_evidence.version as version',
      'verification_evidence.original_filename as original_filename',
      'verification_evidence.declared_content_type as declared_content_type',
      'verification_evidence.storage_ref as storage_ref',
      'verification_evidence.byte_size as byte_size',
    ])
    .where('verification_evidence.id', '=', evidenceId);
  if (context.kind === 'provider') {
    query = query.where('verification_case.organization_id', '=', context.organizationId);
  }
  if (options.forUpdate) {
    query = query.forUpdate('verification_evidence');
  }
  const row = await query.executeTakeFirst();
  return row === undefined ? { kind: 'evidenceNotFound' } : { kind: 'evidence', row };
}

// -- provider-scoped registration (upload initiation) -------------------------

export type ProviderRegisterEvidenceResult = RegisterEvidenceResult;

/** Provider-side upload initiation: registers the metadata intent for a
 *  requirement of the organization's OWN open case. The pipeline already
 *  authorized org membership + the owner capability; this service enforces
 *  that the case belongs to that organization and validates metadata
 *  against the configured upload boundaries. */
export async function providerRegisterEvidence(
  deps: EvidenceStorageDeps,
  context: { organizationId: string; userId: string },
  input: {
    caseId: string;
    requirementId: string;
    originalFilename: string;
    declaredContentType: string;
  },
): Promise<ProviderRegisterEvidenceResult> {
  if (
    !evidenceMetadataAcceptable(input.originalFilename, input.declaredContentType) ||
    !deps.upload.allowedContentTypes.includes(input.declaredContentType)
  ) {
    return { kind: 'invalidMetadata' };
  }
  return withTransaction(deps.db, async (trx) => {
    const caseRow = await trx
      .selectFrom('verification_case')
      .select(['id', 'state'])
      .where('id', '=', input.caseId)
      .where('organization_id', '=', context.organizationId) // own org only
      .forUpdate()
      .executeTakeFirst();
    if (caseRow === undefined) return { kind: 'caseNotFound' as const };
    return registerEvidenceForOpenCaseInTrx(trx, context.userId, caseRow, input);
  });
}

// -- binary upload → trusted finalization -------------------------------------

export type UploadEvidenceBinaryResult =
  | { kind: 'evidenceStored'; version: number }
  | { kind: 'forbidden' }
  | { kind: 'evidenceNotFound' }
  | { kind: 'evidenceStateConflict' }
  | { kind: 'invalidEvidenceUpload' }
  | { kind: 'storageUnavailable' };

export async function uploadEvidenceBinary(
  deps: EvidenceStorageDeps,
  context: EvidenceAccessContext,
  input: { evidenceId: string; body: Buffer; requestContentType: string | undefined },
): Promise<UploadEvidenceBinaryResult> {
  // 1. Authorize + validate against the row (no storage I/O inside the tx).
  const admitted = await withTransaction(deps.db, async (trx) => {
    const loaded = await loadAuthorizedEvidence(trx, context, input.evidenceId, {
      forUpdate: false,
    });
    if (loaded.kind !== 'evidence') return loaded;
    const row = loaded.row;
    if (row.state !== 'pending_upload') return { kind: 'evidenceStateConflict' as const };
    if (
      input.body.byteLength === 0 ||
      input.body.byteLength > deps.upload.maxBytes ||
      !deps.upload.allowedContentTypes.includes(row.declared_content_type) ||
      (input.requestContentType !== undefined &&
        input.requestContentType.split(';')[0]?.trim() !== row.declared_content_type)
    ) {
      return { kind: 'invalidEvidenceUpload' as const };
    }
    return { kind: 'admitted' as const, row };
  });
  if (admitted.kind !== 'admitted') return admitted;
  const row = admitted.row;

  // 2. TRUSTED facts from the actual bytes; the composed internal key.
  const sha256Digest = createHash('sha256').update(input.body).digest('hex');
  const key = evidenceObjectKey({
    organizationId: row.organization_id,
    caseId: row.case_id,
    evidenceId: row.id,
  });

  // 3. Private binary write + authoritative verification — strictly outside
  //    any DB transaction. Failure at ANY step leaves `pending_upload`.
  try {
    await deps.store.putObject({
      key,
      body: input.body,
      contentType: row.declared_content_type,
    });
    const stored = await deps.store.headObject(key);
    if (stored === null || stored.byteSize !== input.body.byteLength) {
      return { kind: 'storageUnavailable' };
    }
  } catch (error) {
    if (error instanceof EvidenceStoreError) return { kind: 'storageUnavailable' };
    throw error;
  }

  // 4. The trusted completion boundary (W3-3) — CAS on the version read at
  //    admission, so a concurrent supersession/replacement can never be
  //    overwritten into `stored`.
  const finalized = await finalizeEvidenceStorage(
    { db: deps.db },
    {
      evidenceId: row.id,
      expectedVersion: row.version,
      byteSize: input.body.byteLength,
      sha256Digest,
      storageRef: key,
    },
  );
  switch (finalized.kind) {
    case 'evidenceStored':
      return { kind: 'evidenceStored', version: finalized.version };
    case 'evidenceNotFound':
      return { kind: 'evidenceNotFound' };
    case 'staleVersion':
    case 'evidenceStateConflict':
      return { kind: 'evidenceStateConflict' };
    case 'invalidStorageMetadata':
      return { kind: 'invalidEvidenceUpload' };
  }
}

// -- authorized retrieval -----------------------------------------------------

export type DownloadEvidenceBinaryResult =
  | {
      kind: 'evidenceContent';
      body: Buffer;
      contentType: string;
      originalFilename: string;
      byteSize: number;
    }
  | { kind: 'forbidden' }
  | { kind: 'evidenceNotFound' }
  /** Internal retrieval refused: content safety unavailable (fail closed —
   *  a distinct typed condition, never disguised as storage/auth failure). */
  | { kind: 'evidenceSafetyUnavailable' }
  | { kind: 'storageUnavailable' };

/**
 * Server-mediated download. Providers may retrieve only their OWN
 * organization's CURRENT stored document; operations may additionally
 * retrieve superseded history (auditable review of replaced documents).
 * Every successful access is audited. No URL of any kind is produced.
 */
export async function downloadEvidenceBinary(
  deps: EvidenceStorageDeps,
  context: EvidenceAccessContext,
  input: { evidenceId: string },
): Promise<DownloadEvidenceBinaryResult> {
  const admitted = await withTransaction(deps.db, async (trx) => {
    const loaded = await loadAuthorizedEvidence(trx, context, input.evidenceId, {
      forUpdate: false,
    });
    if (loaded.kind !== 'evidence') return loaded;
    const row = loaded.row;
    const downloadable =
      context.kind === 'operations'
        ? row.storage_ref !== null && row.state !== 'pending_upload'
        : row.state === 'stored';
    if (!downloadable || row.storage_ref === null) {
      return { kind: 'evidenceNotFound' as const };
    }
    return { kind: 'admitted' as const, row };
  });
  if (admitted.kind !== 'admitted') return admitted;
  const row = admitted.row;

  // The content-safety gate (W3-4 correction): AFTER authorization (an
  // unauthorized or cross-org caller learns nothing about safety state),
  // BEFORE any object-store read. Provider-owner retrieval of the OWN
  // organization's document is deliberately outside this gate.
  if (context.kind === 'operations' && !deps.contentSafetyReady) {
    return { kind: 'evidenceSafetyUnavailable' };
  }

  let object: { body: Buffer; contentType: string } | null;
  try {
    object = await deps.store.getObject(row.storage_ref!);
  } catch (error) {
    if (error instanceof EvidenceStoreError) return { kind: 'storageUnavailable' };
    throw error;
  }
  if (object === null) return { kind: 'storageUnavailable' };

  // Sensitive-document access is audited (docs/24 §4.1).
  await appendAuditEvent(deps.db, {
    actorType: 'user',
    actorId: context.userId,
    action: 'org.verification_evidence_accessed',
    entityType: 'verification_evidence',
    entityId: row.id,
  });

  return {
    kind: 'evidenceContent',
    body: object.body,
    // The DECLARED type is authoritative for the response (the store echo
    // is advisory only).
    contentType: row.declared_content_type,
    originalFilename: row.original_filename,
    byteSize: object.body.byteLength,
  };
}
