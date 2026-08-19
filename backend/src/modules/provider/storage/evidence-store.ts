/**
 * Private verification-evidence object storage PORT (W3-4; D-W3-1).
 *
 * The binding W3-4 architecture decisions (docs/31 W3-4 record):
 * - COMPLETELY separate from the public ProgramMedia path: different port,
 *   different (private) store, different access tier. Nothing here is ever
 *   publicly addressable.
 * - Server-proxied I/O ONLY: uploads and downloads stream through
 *   authorized Himma routes. NO presigned upload/download URLs exist in
 *   W3-4 — every access is authorized per request and nothing reusable
 *   can leak. (If scale ever demands presigned access, that is a
 *   deliberate future change, not a default.)
 * - Keys are internal, opaque, tenant-isolated, and NEVER derived from
 *   filenames: `verification/{organizationId}/{caseId}/{evidenceId}`.
 * - The TRUSTED facts (byte size, sha256) are computed by the backend from
 *   the bytes it actually stored — a client can never supply them.
 * - Store failures throw EvidenceStoreError; callers map it to the typed
 *   `storageUnavailable` outcome and the evidence row simply stays
 *   `pending_upload` (never a false `stored`).
 */

export interface StoredObjectFacts {
  byteSize: number;
}

export interface VerificationEvidenceObjectStore {
  /** Writes the complete private object (overwrite of the SAME key is the
   *  legal retry path for an interrupted upload of a pending evidence). */
  putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  /** Authoritative post-write existence/size check. null = absent. */
  headObject(key: string): Promise<StoredObjectFacts | null>;
  /** Server-mediated retrieval for an ALREADY-authorized request. */
  getObject(key: string): Promise<{ body: Buffer; contentType: string } | null>;
}

/** Thrown by store implementations on infrastructure failure. */
export class EvidenceStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EvidenceStoreError';
  }
}

/**
 * Upload validation boundaries — TECHNICAL safety limits, deliberately
 * configuration (not schema, not business policy): D-W3-3 will define what
 * documents are required; these only bound what a single upload may be.
 */
export interface VerificationEvidenceUploadConfig {
  maxBytes: number;
  allowedContentTypes: readonly string[];
}

/** Conservative defaults: common document/image types, 20 MiB. */
export const DEFAULT_EVIDENCE_UPLOAD_CONFIG: VerificationEvidenceUploadConfig = {
  maxBytes: 20 * 1024 * 1024,
  allowedContentTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
};

/** The one canonical key shape (tenant-isolated, uuid-composed, opaque). */
export function evidenceObjectKey(input: {
  organizationId: string;
  caseId: string;
  evidenceId: string;
}): string {
  return `verification/${input.organizationId}/${input.caseId}/${input.evidenceId}`;
}
