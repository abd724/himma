/**
 * Structural secret-column guard (docs/26 Amendment A1.1; B2-6A; owner
 * correction to S3-2, 2026-08-07).
 *
 * The approved distinction: a handful of SPECIFICALLY REVIEWED one-way
 * verifier/digest columns are deliberately stored (recovery-code digests,
 * the staff-invitation token digest, audit/request/IP digests), while
 * Cognito-managed credentials, tokens, TOTP secrets, and provider
 * challenge/session material must never exist in Himma PostgreSQL — in raw
 * OR hashed form. A `_digest`/`_hash` suffix therefore NEVER exempts a
 * column by itself: exemption is an explicit, table-qualified allowlist
 * entry, added only with owner review. `refresh_token_digest`,
 * `password_digest`, `totp_secret_digest`, `credential_digest`, and every
 * other prohibited name stays an offender wherever it appears.
 */

export interface ColumnRow {
  table_name: string;
  column_name: string;
}

/**
 * Every sanctioned digest/hash column currently in the schema, exactly
 * table-qualified. Entries exempt ONE column of ONE table — the same
 * column name on any other table stays flagged. The structural-secret-guard
 * suite asserts every entry still exists, so removing or renaming an
 * approved column forces this list to shrink with it instead of leaving a
 * dormant exemption behind.
 */
export const SANCTIONED_VERIFIER_COLUMNS: ReadonlySet<string> = new Set([
  // Slice 1 — append-only audit state digests and the request-deduplication
  // payload digest.
  'audit_event.before_digest',
  'audit_event.after_digest',
  'idempotency_key.request_digest',
  // Slice 2 — bootstrap manifest digest, session IP digest (privacy form),
  // and the B2-6A recovery-code verifier digests.
  'bootstrap_seal.manifest_digest',
  'login_session.ip_digest',
  'mfa_recovery_code.code_hash',
  // Slice 3 (S3-2) — the staff-invitation one-time-token digest (docs/27 §9).
  'staff_invitation.token_digest',
]);

/** B2-6A structural pattern: no TOTP secrets, raw codes, tokens, QR
 *  contents, or key material anywhere in the public schema. */
export const MFA_SECRET_COLUMN_PATTERN =
  /(secret|token|password|credential|totp|recovery|qr|seed|pepper_value|encryption_key|signing_key|hash_key|plain|raw)/i;

/** Amendment A1.1 structural pattern: no password/secret/token/totp/
 *  recovery/credential columns in the public schema. */
export const IDENTITY_SECRET_COLUMN_PATTERN =
  /(password|secret|token|totp|recovery|credential)/i;

/**
 * Columns that match a prohibited pattern and are NOT explicitly
 * sanctioned. This is the single guard predicate both structural sweeps
 * and the guard suite use — there is no other exemption path.
 */
export function findSecretColumnOffenders(
  columns: ColumnRow[],
  pattern: RegExp,
): ColumnRow[] {
  return columns.filter(
    (row) =>
      pattern.test(row.column_name) &&
      !SANCTIONED_VERIFIER_COLUMNS.has(`${row.table_name}.${row.column_name}`),
  );
}
