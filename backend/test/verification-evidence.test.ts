/**
 * W3-3 — verification evidence metadata & the three-layer decision
 * architecture (docs/31 W3-3 §38/§39; D-W3-1/D-W3-2), on real PostgreSQL.
 *
 * Evidence is PRIVATE metadata only: no binary, no public URL; `stored` is
 * reachable solely through the trusted finalization boundary. Decisions are
 * append-only with the machine / provider-safe / internal layers in
 * separate named columns, and the provider-safe seam can never read notes.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import {
  finalizeEvidenceStorage,
  getInternalVerificationCaseView,
  getProviderSafeVerificationSummary,
  openVerificationCase,
  recordVerificationDecision,
  registerEvidence,
  startCaseReview,
  type VerificationCaseDeps,
} from '../src/modules/provider/services/verification-case';
import type { AdminRole } from '../src/modules/identity/persistence/admin-role-repository';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import { createProviderOrg } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let adminA: string;
let adminB: string;
let ops: string;

function deps(): VerificationCaseDeps {
  return {
    db: testDb.db,
    policyProvider: {
      currentPolicy: async () => ({
        policyVersion: 'evidence-policy-v1',
        requirements: [
          { key: 'business_document', labelEn: 'Business document', required: true },
          { key: 'optional_reference', labelEn: 'Optional reference', required: false },
        ],
      }),
    },
  };
}

async function grantRole(userId: string, role: AdminRole): Promise<void> {
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(
    testDb.db,
  );
}

async function openedCase(): Promise<{
  orgId: string;
  caseId: string;
  businessDoc: string;
}> {
  const { orgId } = await createProviderOrg(testDb.db, { state: 'submitted', branches: 1 });
  const opened = await openVerificationCase(deps(), { userId: ops }, { organizationId: orgId });
  if (opened.kind !== 'caseOpened') throw new Error(opened.kind);
  const requirement = await testDb.db
    .selectFrom('verification_case_requirement')
    .select(['id'])
    .where('case_id', '=', opened.caseId)
    .where('requirement_key', '=', 'business_document')
    .executeTakeFirstOrThrow();
  return { orgId, caseId: opened.caseId, businessDoc: requirement.id };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  ({ adminA, adminB } = await bootstrapAccessAdmins(testDb.db));
  ops = await createUser(testDb.db);
  await grantRole(ops, 'operations');
});

afterAll(async () => {
  await testDb.drop();
});

describe('evidence metadata (§38)', () => {
  it('registration creates a pending intent with safe metadata — and pending NEVER counts as stored', async () => {
    const { caseId, businessDoc } = await openedCase();
    const registered = await registerEvidence(deps(), { userId: ops }, {
      caseId,
      requirementId: businessDoc,
      originalFilename: 'trade licence.pdf',
      declaredContentType: 'application/pdf',
    });
    if (registered.kind !== 'evidenceRegistered') throw new Error(registered.kind);
    const row = await testDb.db
      .selectFrom('verification_evidence')
      .selectAll()
      .where('id', '=', registered.evidenceId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('pending_upload');
    expect(row.original_filename).toBe('trade licence.pdf');
    expect(row.declared_content_type).toBe('application/pdf');
    expect(row.byte_size).toBeNull();
    expect(row.sha256_digest).toBeNull();
    expect(row.storage_ref).toBeNull();
    // The audit trail records the registration.
    const audit = await testDb.db
      .selectFrom('audit_event')
      .select(['action'])
      .where('entity_id', '=', registered.evidenceId)
      .execute();
    expect(audit.map((entry) => entry.action)).toEqual(['org.verification_evidence_registered']);
  });

  it('invalid metadata is rejected with a typed refusal (and the schema CHECKs remain the backstop)', async () => {
    const { caseId, businessDoc } = await openedCase();
    await expect(
      registerEvidence(deps(), { userId: ops }, {
        caseId,
        requirementId: businessDoc,
        originalFilename: '   ',
        declaredContentType: 'application/pdf',
      }),
    ).resolves.toEqual({ kind: 'invalidMetadata' });
    await expect(
      registerEvidence(deps(), { userId: ops }, {
        caseId,
        requirementId: businessDoc,
        originalFilename: 'x.pdf',
        declaredContentType: 'not a mime type',
      }),
    ).resolves.toEqual({ kind: 'invalidMetadata' });
    await expect(
      sql`INSERT INTO verification_evidence (id, case_id, requirement_id, original_filename, declared_content_type, created_by)
          VALUES (${newId()}, ${caseId}, ${businessDoc}, 'x.pdf', 'NOT A MIME', ${ops})`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/ck_verification_evidence_content_type|check constraint/);
  });

  it('a browser-shaped caller cannot claim storage: stored REQUIRES the trusted metadata, and the boundary enforces it', async () => {
    const { caseId, businessDoc } = await openedCase();
    const registered = await registerEvidence(deps(), { userId: ops }, {
      caseId,
      requirementId: businessDoc,
      originalFilename: 'doc.pdf',
      declaredContentType: 'application/pdf',
    });
    if (registered.kind !== 'evidenceRegistered') throw new Error(registered.kind);

    // A direct "stored: true" without trusted storage facts violates the schema.
    await expect(
      sql`UPDATE verification_evidence SET state = 'stored' WHERE id = ${registered.evidenceId}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/ck_verification_evidence_stored_complete|check constraint/);

    // The trusted boundary validates its inputs…
    await expect(
      finalizeEvidenceStorage(deps(), {
        evidenceId: registered.evidenceId,
        expectedVersion: registered.version,
        byteSize: 0,
        sha256Digest: 'a'.repeat(64),
        storageRef: 'verification/x',
      }),
    ).resolves.toEqual({ kind: 'invalidStorageMetadata' });
    await expect(
      finalizeEvidenceStorage(deps(), {
        evidenceId: registered.evidenceId,
        expectedVersion: registered.version,
        byteSize: 10,
        sha256Digest: 'ZZ'.repeat(32),
        storageRef: 'verification/x',
      }),
    ).resolves.toEqual({ kind: 'invalidStorageMetadata' });
    // …and a PUBLIC URL can never become the locator (service AND schema).
    await expect(
      finalizeEvidenceStorage(deps(), {
        evidenceId: registered.evidenceId,
        expectedVersion: registered.version,
        byteSize: 10,
        sha256Digest: 'a'.repeat(64),
        storageRef: 'https://bucket.example/doc.pdf',
      }),
    ).resolves.toEqual({ kind: 'invalidStorageMetadata' });

    const stored = await finalizeEvidenceStorage(deps(), {
      evidenceId: registered.evidenceId,
      expectedVersion: registered.version,
      byteSize: 2048,
      sha256Digest: 'c'.repeat(64),
      storageRef: `verification/${caseId}/${registered.evidenceId}`,
    });
    if (stored.kind !== 'evidenceStored') throw new Error(stored.kind);

    // Storage facts are write-once after that.
    await expect(
      sql`UPDATE verification_evidence SET byte_size = 1 WHERE id = ${registered.evidenceId}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/storage facts are immutable/);
    // Stale/replayed finalization is refused.
    await expect(
      finalizeEvidenceStorage(deps(), {
        evidenceId: registered.evidenceId,
        expectedVersion: registered.version,
        byteSize: 2048,
        sha256Digest: 'c'.repeat(64),
        storageRef: 'verification/replay',
      }),
    ).resolves.toEqual({ kind: 'evidenceStateConflict' });
    // System audit for the storage completion.
    const audit = await testDb.db
      .selectFrom('audit_event')
      .select(['action', 'actor_type'])
      .where('entity_id', '=', registered.evidenceId)
      .execute();
    expect(audit.map((entry) => entry.action)).toContain('org.verification_evidence_stored');
    expect(
      audit.find((entry) => entry.action === 'org.verification_evidence_stored')?.actor_type,
    ).toBe('system');
  });

  it('replacement supersedes without destroying history, and ONE current row per requirement is a database invariant', async () => {
    const { caseId, businessDoc } = await openedCase();
    const first = await registerEvidence(deps(), { userId: ops }, {
      caseId,
      requirementId: businessDoc,
      originalFilename: 'v1.pdf',
      declaredContentType: 'application/pdf',
    });
    if (first.kind !== 'evidenceRegistered') throw new Error(first.kind);
    await finalizeEvidenceStorage(deps(), {
      evidenceId: first.evidenceId,
      expectedVersion: first.version,
      byteSize: 10,
      sha256Digest: 'd'.repeat(64),
      storageRef: 'verification/v1',
    });
    const second = await registerEvidence(deps(), { userId: ops }, {
      caseId,
      requirementId: businessDoc,
      originalFilename: 'v2.pdf',
      declaredContentType: 'application/pdf',
    });
    if (second.kind !== 'evidenceRegistered') throw new Error(second.kind);
    expect(second.supersededEvidenceId).toBe(first.evidenceId);

    // History intact: the superseded row keeps its trusted storage facts.
    const history = await testDb.db
      .selectFrom('verification_evidence')
      .select(['id', 'state', 'storage_ref', 'sha256_digest'])
      .where('requirement_id', '=', businessDoc)
      .orderBy('created_at')
      .execute();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      state: 'superseded',
      storage_ref: 'verification/v1',
    });
    expect(history[1]).toMatchObject({ state: 'pending_upload' });

    // The current-evidence invariant is the partial unique index.
    await expect(
      sql`INSERT INTO verification_evidence (id, case_id, requirement_id, original_filename, declared_content_type, created_by)
          VALUES (${newId()}, ${caseId}, ${businessDoc}, 'v3.pdf', 'application/pdf', ${ops})`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/ux_verification_evidence_current|duplicate key/);
  });

  it('no public-URL column and no binary column exist anywhere in the verification schema', async () => {
    const columns = await sql<{ table_name: string; column_name: string; data_type: string }>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_name LIKE 'verification_%'`.execute(testDb.db);
    for (const column of columns.rows) {
      expect(column.column_name).not.toMatch(/url|uri|link/i);
      expect(column.data_type).not.toBe('bytea');
    }
    // The one locator is the opaque internal storage_ref, checked non-URL.
    expect(
      columns.rows.some(
        (column) =>
          column.table_name === 'verification_evidence' && column.column_name === 'storage_ref',
      ),
    ).toBe(true);
  });

  it('evidence changes are refused once the round is under review', async () => {
    const { caseId, businessDoc } = await openedCase();
    const started = await startCaseReview(deps(), { userId: ops }, {
      caseId,
      expectedVersion: 1,
    });
    expect(started.kind).toBe('caseReviewStarted');
    await expect(
      registerEvidence(deps(), { userId: ops }, {
        caseId,
        requirementId: businessDoc,
        originalFilename: 'late.pdf',
        declaredContentType: 'application/pdf',
      }),
    ).resolves.toEqual({ kind: 'caseStateConflict' });
  });
});

describe('three-layer decisions (§39; D-W3-2)', () => {
  it('records the three layers in separate columns; the internal view sees all, the provider-safe seam NEVER sees the note or reviewer', async () => {
    const { orgId, caseId } = await openedCase();
    await startCaseReview(deps(), { userId: ops }, { caseId, expectedVersion: 1 });
    const decided = await recordVerificationDecision(deps(), { userId: ops }, {
      caseId,
      expectedVersion: 2,
      outcome: 'rejected',
      reasonCode: 'expired_document',
      providerSafeMessage: 'Your business document has expired — upload a current one.',
      internalNote: 'Called the issuing authority; licence lapsed in 2025. Do not fast-track.',
    });
    if (decided.kind !== 'decisionRecorded') throw new Error(decided.kind);

    const internal = await getInternalVerificationCaseView(deps(), { userId: ops }, caseId);
    if (internal.kind !== 'caseView') throw new Error(internal.kind);
    expect(internal.view.decision).toMatchObject({
      outcome: 'rejected',
      reasonCode: 'expired_document',
      providerSafeMessage: 'Your business document has expired — upload a current one.',
      internalNote: 'Called the issuing authority; licence lapsed in 2025. Do not fast-track.',
      decidedBy: ops,
    });
    expect(internal.view.state).toBe('decided');

    const providerSafe = await getProviderSafeVerificationSummary(
      { db: testDb.db },
      { organizationId: orgId },
    );
    if (providerSafe.kind !== 'summary') throw new Error(providerSafe.kind);
    expect(providerSafe.summary.decision).toEqual({
      outcome: 'rejected',
      reasonCode: 'expired_document',
      providerSafeMessage: 'Your business document has expired — upload a current one.',
      decidedAt: expect.any(String) as unknown as string,
    });
    const serialized = JSON.stringify(providerSafe);
    expect(serialized).not.toContain('internalNote');
    expect(serialized).not.toContain('Do not fast-track');
    expect(serialized).not.toContain(ops); // reviewer identity stays internal

    // The outbox event carries machine layers only — no reviewer text.
    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['payload'])
      .where('aggregate_id', '=', orgId)
      .where('event_type', '=', 'organization.verification_decision_recorded')
      .executeTakeFirstOrThrow();
    const payload = JSON.stringify(outbox.payload);
    expect(JSON.parse(payload)).toMatchObject({ outcome: 'rejected', reasonCode: 'expired_document' });
    expect(payload).not.toContain('expired — upload');
    expect(payload).not.toContain('fast-track');
  });

  it('a rejection REQUIRES the machine reason code and the provider-safe message', async () => {
    const { caseId } = await openedCase();
    await startCaseReview(deps(), { userId: ops }, { caseId, expectedVersion: 1 });
    await expect(
      recordVerificationDecision(deps(), { userId: ops }, {
        caseId,
        expectedVersion: 2,
        outcome: 'rejected',
        providerSafeMessage: 'Message without a code.',
      }),
    ).resolves.toEqual({ kind: 'invalidDecision' });
    await expect(
      recordVerificationDecision(deps(), { userId: ops }, {
        caseId,
        expectedVersion: 2,
        outcome: 'rejected',
        reasonCode: 'incomplete_evidence',
      }),
    ).resolves.toEqual({ kind: 'invalidDecision' });
    // The schema backstops the machine layer independently.
    await expect(
      sql`INSERT INTO verification_decision (id, case_id, outcome, decided_by)
          VALUES (${newId()}, ${caseId}, 'rejected', ${ops})`.execute(testDb.db),
    ).rejects.toThrow(/ck_verification_decision_rejection_reason|check constraint/);
  });

  it('decisions are append-only, one per round, case-bound, and CAS-guarded', async () => {
    const { caseId } = await openedCase();
    await startCaseReview(deps(), { userId: ops }, { caseId, expectedVersion: 1 });
    await expect(
      recordVerificationDecision(deps(), { userId: ops }, {
        caseId,
        expectedVersion: 999,
        outcome: 'approved',
      }),
    ).resolves.toEqual({ kind: 'staleVersion' });
    const decided = await recordVerificationDecision(deps(), { userId: ops }, {
      caseId,
      expectedVersion: 2,
      outcome: 'approved',
      internalNote: 'All documents verified against the registry.',
    });
    if (decided.kind !== 'decisionRecorded') throw new Error(decided.kind);

    // Historical decisions cannot be edited — not even by the owner role.
    await expect(
      sql`UPDATE verification_decision SET provider_safe_message = 'rewritten'
          WHERE id = ${decided.decisionId}`.execute(testDb.db),
    ).rejects.toThrow(/append-only/);
    // One final outcome per round (unique) …
    await expect(
      sql`INSERT INTO verification_decision (id, case_id, outcome, decided_by)
          VALUES (${newId()}, ${caseId}, 'approved', ${ops})`.execute(testDb.db),
    ).rejects.toThrow(/uq_verification_decision_case|duplicate key/);
    // …and the decided case refuses further decisions at the service.
    await expect(
      recordVerificationDecision(deps(), { userId: ops }, {
        caseId,
        expectedVersion: 3,
        outcome: 'rejected',
        reasonCode: 'x_reason',
        providerSafeMessage: 'x',
      }),
    ).resolves.toEqual({ kind: 'caseStateConflict' });
    // A decision cannot reference a nonexistent case (FK).
    await expect(
      sql`INSERT INTO verification_decision (id, case_id, outcome, decided_by)
          VALUES (${newId()}, ${newId()}, 'approved', ${ops})`.execute(testDb.db),
    ).rejects.toThrow(/fk_verification_decision_case|foreign key/);
  });

  it('the internal case view carries readiness + evidence status but never storage refs or digests', async () => {
    const { caseId, businessDoc } = await openedCase();
    const registered = await registerEvidence(deps(), { userId: ops }, {
      caseId,
      requirementId: businessDoc,
      originalFilename: 'doc.pdf',
      declaredContentType: 'application/pdf',
    });
    if (registered.kind !== 'evidenceRegistered') throw new Error(registered.kind);
    await finalizeEvidenceStorage(deps(), {
      evidenceId: registered.evidenceId,
      expectedVersion: registered.version,
      byteSize: 555,
      sha256Digest: 'e'.repeat(64),
      storageRef: 'verification/secret-location',
    });
    const view = await getInternalVerificationCaseView(deps(), { userId: ops }, caseId);
    if (view.kind !== 'caseView') throw new Error(view.kind);
    expect(view.view.readiness).toEqual({ kind: 'ready' });
    const business = view.view.requirements.find(
      (entry) => entry.requirementKey === 'business_document',
    )!;
    expect(business.currentEvidence).toMatchObject({ state: 'stored', byteSize: 555 });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('secret-location');
    expect(serialized).not.toContain('e'.repeat(64));
    // Authority: a non-operations admin cannot read the internal view.
    const stranger = await createUser(testDb.db);
    await expect(
      getInternalVerificationCaseView(deps(), { userId: stranger }, caseId),
    ).resolves.toEqual({ kind: 'forbidden' });
  });
});
