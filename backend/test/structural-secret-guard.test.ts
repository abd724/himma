/**
 * Structural secret-column guard (owner correction to S3-2, 2026-08-07).
 *
 * Proves the table-qualified allowlist semantics: every sanctioned
 * verifier/digest column passes explicitly; a `_digest`/`_hash` suffix
 * exempts NOTHING by itself (`refresh_token_digest`, `password_digest`,
 * `totp_secret_digest`, `credential_digest` all stay offenders); an
 * allowlisted column name on any OTHER table stays an offender; and a
 * removed or renamed approved column makes the stale allowlist entry fail
 * loudly instead of silently broadening the rule.
 */
import { sql } from 'kysely';

import {
  findSecretColumnOffenders,
  IDENTITY_SECRET_COLUMN_PATTERN,
  MFA_SECRET_COLUMN_PATTERN,
  SANCTIONED_VERIFIER_COLUMNS,
  type ColumnRow,
} from './helpers/structural-secrets';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

async function liveColumns(): Promise<ColumnRow[]> {
  const result = await sql<ColumnRow>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'`.execute(testDb.db);
  return result.rows;
}

describe('sanctioned verifier columns (explicit table-qualified allowlist)', () => {
  it('every allowlist entry names a real, currently-present column — removal or rename fails loudly, never silently broadens the rule', async () => {
    const present = new Set(
      (await liveColumns()).map((row) => `${row.table_name}.${row.column_name}`),
    );
    const stale = [...SANCTIONED_VERIFIER_COLUMNS].filter((entry) => !present.has(entry));
    // A stale entry could never exempt any other column (matching is exact),
    // but it must not linger either: shrink the allowlist with the schema.
    expect(stale).toEqual([]);
  });

  it('the sanctioned staff_invitation.token_digest (docs/27 §9) and every other approved digest pass both sweeps', async () => {
    const columns = await liveColumns();
    // The S3-2 column is present and matches the prohibited patterns — only
    // its explicit allowlist entry keeps the schema clean.
    const tokenDigest = columns.find(
      (row) => row.table_name === 'staff_invitation' && row.column_name === 'token_digest',
    );
    expect(tokenDigest).toBeDefined();
    expect(MFA_SECRET_COLUMN_PATTERN.test('token_digest')).toBe(true);
    expect(IDENTITY_SECRET_COLUMN_PATTERN.test('token_digest')).toBe(true);
    expect(findSecretColumnOffenders(columns, MFA_SECRET_COLUMN_PATTERN)).toEqual([]);
    expect(findSecretColumnOffenders(columns, IDENTITY_SECRET_COLUMN_PATTERN)).toEqual([]);
  });
});

describe('prohibited columns stay offenders even as hashes/digests', () => {
  it('refresh_token/password/totp_secret/credential digests fail, and an allowlisted name on another table is NOT exempt', async () => {
    await sql`
      CREATE TABLE secret_guard_probe (
        id                   uuid PRIMARY KEY,
        refresh_token        text,
        refresh_token_digest text,
        password             text,
        password_hash        text,
        password_digest      text,
        totp_secret          text,
        totp_secret_digest   text,
        credential           text,
        credential_digest    text,
        -- The exact column name sanctioned on staff_invitation: on this
        -- table it must stay an offender (allowlisting is table-qualified).
        token_digest         text
      )`.execute(testDb.db);
    try {
      const probeColumns = (await liveColumns()).filter(
        (row) => row.table_name === 'secret_guard_probe',
      );
      const expectedOffenders = [
        'credential',
        'credential_digest',
        'password',
        'password_digest',
        'password_hash',
        'refresh_token',
        'refresh_token_digest',
        'token_digest',
        'totp_secret',
        'totp_secret_digest',
      ];
      for (const pattern of [MFA_SECRET_COLUMN_PATTERN, IDENTITY_SECRET_COLUMN_PATTERN]) {
        const offenders = findSecretColumnOffenders(probeColumns, pattern)
          .map((row) => row.column_name)
          .sort();
        expect(offenders).toEqual(expectedOffenders);
      }
    } finally {
      await sql`DROP TABLE secret_guard_probe`.execute(testDb.db);
    }
  });
});
