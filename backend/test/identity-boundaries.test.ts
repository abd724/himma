/**
 * B2-2 — architectural boundary and secrecy guards.
 *
 * 1. Provider SDK/JWT machinery never escapes providers/cognito (docs/26 §2:
 *    the adapter keeps the provider replaceable).
 * 2. Identity services reach tables only through the repository module
 *    (docs/25 §10 layer boundary) and write no application logs.
 * 3. The himma_app role's grants are sufficient for every identity service —
 *    proven by running the services AS himma_app (denial tests for breadth
 *    live in the B2-1 suites).
 * 4. Audit and outbox payloads written by identity services carry opaque ids
 *    only — no emails, no secrets, no free-text PII.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/db/kysely';
import { firstLogin } from '../src/modules/identity/services/first-login';
import { linkIdentity, unlinkIdentity } from '../src/modules/identity/services/link-identity';
import {
  recordChallengeCompleted,
  recordChallengeRequested,
} from '../src/modules/identity/services/challenges';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const COGNITO_DIR = path.join(SRC_ROOT, 'modules', 'identity', 'providers', 'cognito');
const SERVICES_DIR = path.join(SRC_ROOT, 'modules', 'identity', 'services');

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'generated') continue; // codegen output, not hand-written
      files.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('provider SDK import boundary', () => {
  it('jose and any AWS SDK are imported ONLY inside providers/cognito', () => {
    const offenders = listSourceFiles(SRC_ROOT)
      .filter((file) => !file.startsWith(COGNITO_DIR))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /from ['"](jose|@aws-sdk|aws-sdk|amazon-cognito)/.test(source) ||
          /require\(['"](jose|@aws-sdk|aws-sdk|amazon-cognito)/.test(source);
      });
    expect(offenders).toEqual([]);
  });

  it('the application core never mentions Cognito claim names or SDK symbols', () => {
    const offenders = listSourceFiles(path.join(SRC_ROOT, 'modules', 'identity'))
      .filter((file) => !file.startsWith(COGNITO_DIR))
      .filter((file) => /cognito:groups|CognitoIdentityProvider|token_use/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('repository/service layer boundary', () => {
  it('identity services touch no table directly — every query goes through the repository', () => {
    const offenders = listSourceFiles(SERVICES_DIR).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /\.(insertInto|updateTable|selectFrom|deleteFrom)\(/.test(source) || /sql`/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('identity services and repositories write no application logs (nowhere for secrets to leak)', () => {
    const offenders = listSourceFiles(path.join(SRC_ROOT, 'modules', 'identity')).filter((file) =>
      /console\.|process\.stdout|process\.stderr/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('application-role sufficiency and payload secrecy (real PostgreSQL)', () => {
  let testDb: TestDb;
  let appDb: Kysely<DB>;

  beforeAll(async () => {
    testDb = await createMigratedTestDb();
    // Every connection of this pool runs as himma_app (role is a settable
    // GUC, so it applies at connection startup) — the services below execute
    // with exactly the application role's grants.
    const { database } = testDb.config;
    const pool = new Pool({
      host: database.host,
      port: database.port,
      database: database.database,
      user: database.user,
      options: '-c role=himma_app',
    });
    appDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  });

  afterAll(async () => {
    await appDb.destroy();
    await testDb.drop();
  });

  const evidence: ProviderEvidence = {
    provider: 'email',
    issuer: 'https://cognito.test/app-role-pool',
    subject: 'app-role-sub-1',
    email: 'approle@example.test',
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };

  it('himma_app can execute the full first-login, linking, unlinking, and challenge services', async () => {
    const confirmed = await sql<{ role: string }>`SELECT current_user AS role`.execute(appDb);
    expect(confirmed.rows[0]?.role).toBe('himma_app');

    const created = await firstLogin({ db: appDb }, { evidence });
    expect(created.kind).toBe('newCustomerCreated');
    if (created.kind !== 'newCustomerCreated') return;

    const resolved = await firstLogin({ db: appDb }, { evidence });
    expect(resolved.kind).toBe('identityResolved');

    const linked = await linkIdentity(
      { db: appDb },
      { userId: created.userId },
      {
        evidence: {
          ...evidence,
          provider: 'google',
          issuer: 'https://accounts.google.com',
          subject: 'app-role-google-1',
        },
      },
    );
    expect(linked.kind).toBe('identityLinked');
    if (linked.kind !== 'identityLinked') return;

    const identity = await appDb
      .selectFrom('auth_identity')
      .select(['id', 'version'])
      .where('id', '=', linked.identityId)
      .executeTakeFirstOrThrow();
    const unlinked = await unlinkIdentity(
      { db: appDb },
      { userId: created.userId },
      { identityId: identity.id, expectedVersion: identity.version },
    );
    expect(unlinked.kind).toBe('identityUnlinked');

    const challenge = await recordChallengeRequested(
      { db: appDb },
      { kind: 'email_verification', identityId: created.identityId, userId: created.userId },
    );
    const completed = await recordChallengeCompleted({ db: appDb }, challenge.challengeId);
    expect(completed.kind).toBe('completed');
  });

  it('every outbox payload and audit row written by identity services carries opaque ids only', async () => {
    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['event_type', 'payload'])
      .execute();
    expect(outbox.length).toBeGreaterThan(0);
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3,4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const event of outbox) {
      const payload = (typeof event.payload === 'string'
        ? JSON.parse(event.payload)
        : event.payload) as Record<string, unknown>;
      for (const value of Object.values(payload)) {
        expect(typeof value).toBe('string');
        expect(String(value)).toMatch(uuidPattern);
      }
    }

    const audits = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE entity_id::text LIKE '%@%'
         OR coalesce(actor_id::text, '') LIKE '%@%'
         OR coalesce(before_digest, '') <> ''
         OR coalesce(after_digest, '') <> ''`.execute(testDb.db);
    expect(Number(audits.rows[0]?.n)).toBe(0);
  });
});
