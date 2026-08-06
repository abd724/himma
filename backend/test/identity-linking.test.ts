/**
 * B2-2 — identity linking and unlinking core services (docs/26 §3.6–3.7,
 * §9.2–9.3). The target user always arrives through the authenticated
 * application-context abstraction; step-up presentation is B2-4. Matching is
 * issuer + subject; email never merges accounts; unlinking can never remove
 * the final login method.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { firstLogin } from '../src/modules/identity/services/first-login';
import {
  linkIdentity,
  unlinkIdentity,
} from '../src/modules/identity/services/link-identity';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

let counter = 0;
type EmailedEvidence = ProviderEvidence & { email: string };
function makeEvidence(overrides: Partial<ProviderEvidence> = {}): EmailedEvidence {
  counter += 1;
  return {
    provider: 'apple',
    issuer: 'https://appleid.apple.com',
    subject: `link-sub-${counter}`,
    email: `link${counter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
    ...overrides,
  };
}

async function makeCustomer(): Promise<{ userId: string; accountId: string; identityId: string; evidence: EmailedEvidence }> {
  const evidence = makeEvidence();
  const result = await firstLogin({ db: testDb.db }, { evidence });
  if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);
  return { userId: result.userId, accountId: result.accountId, identityId: result.identityId, evidence };
}

describe('identity linking', () => {
  it('links a new identity to the authenticated user with audit and outbox events', async () => {
    const { userId } = await makeCustomer();
    const evidence = makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com' });
    const result = await linkIdentity({ db: testDb.db }, { userId }, { evidence });
    expect(result.kind).toBe('identityLinked');

    const identities = await testDb.db
      .selectFrom('auth_identity')
      .select(['status'])
      .where('user_id', '=', userId)
      .execute();
    expect(identities).toHaveLength(2);

    const audit = await testDb.db
      .selectFrom('audit_event')
      .select(['action'])
      .where('action', '=', 'auth.identity_linked')
      .where('entity_id', '=', result.kind === 'identityLinked' ? result.identityId : '')
      .execute();
    expect(audit).toHaveLength(1);
    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['event_type'])
      .where('aggregate_id', '=', userId)
      .where('event_type', '=', 'identity.linked')
      .execute();
    expect(outbox).toHaveLength(1);
  });

  it('is idempotent when the same identity is linked to the same user again', async () => {
    const { userId } = await makeCustomer();
    const evidence = makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com' });
    const first = await linkIdentity({ db: testDb.db }, { userId }, { evidence });
    if (first.kind !== 'identityLinked') throw new Error(first.kind);
    const repeat = await linkIdentity({ db: testDb.db }, { userId }, { evidence });
    expect(repeat.kind).toBe('identityAlreadyLinked');
    if (repeat.kind === 'identityAlreadyLinked') {
      expect(repeat.identityId).toBe(first.identityId);
    }
    const count = await testDb.db
      .selectFrom('auth_identity')
      .select(sql<string>`count(*)`.as('n'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(2);
  });

  it('rejects an identity already linked to another user — active or ended, the subject is bound forever', async () => {
    const owner = await makeCustomer();
    const other = await makeCustomer();
    // Active elsewhere:
    const activeElsewhere = await linkIdentity(
      { db: testDb.db },
      { userId: other.userId },
      { evidence: owner.evidence },
    );
    expect(activeElsewhere.kind).toBe('identityLinkedToAnotherUser');

    // Ended elsewhere: end the owner's identity, then try to claim it.
    const second = await linkIdentity(
      { db: testDb.db },
      { userId: owner.userId },
      { evidence: makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com' }) },
    );
    if (second.kind !== 'identityLinked') throw new Error(second.kind);
    const ownRow = await testDb.db
      .selectFrom('auth_identity')
      .select(['id', 'version'])
      .where('user_id', '=', owner.userId)
      .where('subject', '=', owner.evidence.subject)
      .executeTakeFirstOrThrow();
    const unlinked = await unlinkIdentity(
      { db: testDb.db },
      { userId: owner.userId },
      { identityId: ownRow.id, expectedVersion: ownRow.version },
    );
    if (unlinked.kind !== 'identityUnlinked') throw new Error(unlinked.kind);
    const endedElsewhere = await linkIdentity(
      { db: testDb.db },
      { userId: other.userId },
      { evidence: owner.evidence },
    );
    expect(endedElsewhere.kind).toBe('identityLinkedToAnotherUser');
  });

  it('re-linking a previously ended own identity reactivates it and refreshes email attributes', async () => {
    const customer = await makeCustomer();
    const extra = await linkIdentity(
      { db: testDb.db },
      { userId: customer.userId },
      { evidence: makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com' }) },
    );
    if (extra.kind !== 'identityLinked') throw new Error(extra.kind);
    const row = await testDb.db
      .selectFrom('auth_identity')
      .select(['id', 'version'])
      .where('id', '=', extra.identityId)
      .executeTakeFirstOrThrow();
    const unlinked = await unlinkIdentity(
      { db: testDb.db },
      { userId: customer.userId },
      { identityId: row.id, expectedVersion: row.version },
    );
    if (unlinked.kind !== 'identityUnlinked') throw new Error(unlinked.kind);

    const relink = await linkIdentity(
      { db: testDb.db },
      { userId: customer.userId },
      {
        evidence: {
          ...makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com' }),
          subject: (await testDb.db
            .selectFrom('auth_identity')
            .select(['subject'])
            .where('id', '=', extra.identityId)
            .executeTakeFirstOrThrow()).subject,
          email: 'refreshed@example.test',
          emailVerified: false,
        },
      },
    );
    expect(relink.kind).toBe('identityLinked');
    const after = await testDb.db
      .selectFrom('auth_identity')
      .select(['status', 'email', 'email_verified'])
      .where('id', '=', extra.identityId)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('active');
    expect(after.email).toBe('refreshed@example.test');
    expect(after.email_verified).toBe(false);
  });

  it('refuses a verified email owned by another user (typed conflict, never a merge)', async () => {
    const owner = await makeCustomer(); // owns its verified email
    const target = await makeCustomer();
    const result = await linkIdentity(
      { db: testDb.db },
      { userId: target.userId },
      {
        evidence: makeEvidence({
          provider: 'google',
          issuer: 'https://accounts.google.com',
          email: owner.evidence.email,
          emailVerified: true,
        }),
      },
    );
    expect(result.kind).toBe('verifiedEmailConflict');
    const identities = await testDb.db
      .selectFrom('auth_identity')
      .select(['id'])
      .where('user_id', '=', target.userId)
      .execute();
    expect(identities).toHaveLength(1);
  });

  it('allows one user to hold multiple identities sharing one verified email', async () => {
    const customer = await makeCustomer();
    const result = await linkIdentity(
      { db: testDb.db },
      { userId: customer.userId },
      {
        evidence: makeEvidence({
          provider: 'google',
          issuer: 'https://accounts.google.com',
          email: customer.evidence.email,
          emailVerified: true,
        }),
      },
    );
    expect(result.kind).toBe('identityLinked');
  });

  it('admits exactly one winner when two users concurrently link one subject', async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    const evidence = makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com', emailVerified: false });
    const results = await Promise.all([
      linkIdentity({ db: testDb.db }, { userId: a.userId }, { evidence }),
      linkIdentity({ db: testDb.db }, { userId: b.userId }, { evidence }),
    ]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['identityLinked', 'identityLinkedToAnotherUser']);
    const rows = await testDb.db
      .selectFrom('auth_identity')
      .select(['user_id'])
      .where('subject', '=', evidence.subject)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('converges concurrent identical link requests for one user (linked once, then idempotent)', async () => {
    const customer = await makeCustomer();
    const evidence = makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com', emailVerified: false });
    const results = await Promise.all([
      linkIdentity({ db: testDb.db }, { userId: customer.userId }, { evidence }),
      linkIdentity({ db: testDb.db }, { userId: customer.userId }, { evidence }),
    ]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['identityAlreadyLinked', 'identityLinked']);
  });

  it('returns typed outcomes for locked and deleted target users and malformed evidence', async () => {
    const locked = await makeCustomer();
    await testDb.db
      .updateTable('app_user')
      .set({ status: 'locked', locked_reason: 'test' })
      .where('id', '=', locked.userId)
      .execute();
    const lockedResult = await linkIdentity(
      { db: testDb.db },
      { userId: locked.userId },
      { evidence: makeEvidence() },
    );
    expect(lockedResult.kind).toBe('accountLocked');

    const deleted = await makeCustomer();
    await testDb.db
      .updateTable('app_user')
      .set({ status: 'deleted' })
      .where('id', '=', deleted.userId)
      .execute();
    const deletedResult = await linkIdentity(
      { db: testDb.db },
      { userId: deleted.userId },
      { evidence: makeEvidence() },
    );
    expect(deletedResult.kind).toBe('accountDeleted');

    const healthy = await makeCustomer();
    const malformed = await linkIdentity(
      { db: testDb.db },
      { userId: healthy.userId },
      { evidence: { ...makeEvidence(), subject: '' } },
    );
    expect(malformed.kind).toBe('invalidProviderEvidence');
  });
});

describe('identity unlinking (docs/26 §9.3)', () => {
  it('ends an identity with audit and outbox, and never removes the final login method', async () => {
    const customer = await makeCustomer();
    const extra = await linkIdentity(
      { db: testDb.db },
      { userId: customer.userId },
      { evidence: makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com', emailVerified: false }) },
    );
    if (extra.kind !== 'identityLinked') throw new Error(extra.kind);

    const row = await testDb.db
      .selectFrom('auth_identity')
      .select(['id', 'version'])
      .where('id', '=', extra.identityId)
      .executeTakeFirstOrThrow();
    const unlinked = await unlinkIdentity(
      { db: testDb.db },
      { userId: customer.userId },
      { identityId: row.id, expectedVersion: row.version },
    );
    expect(unlinked.kind).toBe('identityUnlinked');
    const ended = await testDb.db
      .selectFrom('auth_identity')
      .select(['status'])
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(ended.status).toBe('ended');
    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['event_type'])
      .where('aggregate_id', '=', customer.userId)
      .where('event_type', '=', 'identity.unlinked')
      .execute();
    expect(outbox).toHaveLength(1);

    // The remaining identity is the final login method.
    const last = await testDb.db
      .selectFrom('auth_identity')
      .select(['id', 'version'])
      .where('user_id', '=', customer.userId)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    const refused = await unlinkIdentity(
      { db: testDb.db },
      { userId: customer.userId },
      { identityId: last.id, expectedVersion: last.version },
    );
    expect(refused.kind).toBe('lastLoginMethod');
  });

  it("treats another user's identity as not found and stale versions as typed staleVersion", async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    const foreign = await unlinkIdentity(
      { db: testDb.db },
      { userId: a.userId },
      { identityId: b.identityId, expectedVersion: 1 },
    );
    expect(foreign.kind).toBe('identityNotFound');
    const unknown = await unlinkIdentity(
      { db: testDb.db },
      { userId: a.userId },
      { identityId: newId(), expectedVersion: 1 },
    );
    expect(unknown.kind).toBe('identityNotFound');

    const extra = await linkIdentity(
      { db: testDb.db },
      { userId: a.userId },
      { evidence: makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com', emailVerified: false }) },
    );
    if (extra.kind !== 'identityLinked') throw new Error(extra.kind);
    const stale = await unlinkIdentity(
      { db: testDb.db },
      { userId: a.userId },
      { identityId: extra.identityId, expectedVersion: 99 },
    );
    expect(stale.kind).toBe('staleVersion');
  });

  it('cannot strand a user under concurrent unlinks of their two identities', async () => {
    const customer = await makeCustomer();
    const extra = await linkIdentity(
      { db: testDb.db },
      { userId: customer.userId },
      { evidence: makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com', emailVerified: false }) },
    );
    if (extra.kind !== 'identityLinked') throw new Error(extra.kind);
    const rows = await testDb.db
      .selectFrom('auth_identity')
      .select(['id', 'version'])
      .where('user_id', '=', customer.userId)
      .where('status', '=', 'active')
      .execute();
    expect(rows).toHaveLength(2);

    const results = await Promise.all(
      rows.map((row) =>
        unlinkIdentity(
          { db: testDb.db },
          { userId: customer.userId },
          { identityId: row.id, expectedVersion: row.version },
        ),
      ),
    );
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['identityUnlinked', 'lastLoginMethod']);
    const active = await testDb.db
      .selectFrom('auth_identity')
      .select(['id'])
      .where('user_id', '=', customer.userId)
      .where('status', '=', 'active')
      .execute();
    expect(active).toHaveLength(1);
  });
});

describe('ended identity at first login', () => {
  it('returns the typed identityEnded outcome instead of resurrecting or reassigning the identity', async () => {
    const customer = await makeCustomer();
    const extra = await linkIdentity(
      { db: testDb.db },
      { userId: customer.userId },
      { evidence: makeEvidence({ provider: 'google', issuer: 'https://accounts.google.com', emailVerified: false }) },
    );
    if (extra.kind !== 'identityLinked') throw new Error(extra.kind);
    // End the ORIGINAL identity, then present its evidence as a login.
    const original = await testDb.db
      .selectFrom('auth_identity')
      .select(['id', 'version'])
      .where('id', '=', customer.identityId)
      .executeTakeFirstOrThrow();
    const unlinked = await unlinkIdentity(
      { db: testDb.db },
      { userId: customer.userId },
      { identityId: original.id, expectedVersion: original.version },
    );
    if (unlinked.kind !== 'identityUnlinked') throw new Error(unlinked.kind);

    const login = await firstLogin({ db: testDb.db }, { evidence: customer.evidence });
    expect(login.kind).toBe('identityEnded');
    const row = await testDb.db
      .selectFrom('auth_identity')
      .select(['status', 'user_id'])
      .where('id', '=', customer.identityId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ended');
    expect(row.user_id).toBe(customer.userId);
  });
});
