/**
 * W3-3 — VerificationCase domain: rounds, policy snapshots, readiness, and
 * the D-S3-3 regression (docs/31 W3-3 §36/§37/§40/§41), on real PostgreSQL.
 *
 * The case is one review ROUND, never a competing organization state
 * machine; policy is INJECTED (D-W3-3 deferred) and its absence fails
 * closed; readiness is computed, never persisted, and is NOT approval.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import { isDbError } from '../src/db/errors';
import {
  evaluateCaseReadiness,
  finalizeEvidenceStorage,
  openVerificationCase,
  recordVerificationDecision,
  registerEvidence,
  startCaseReview,
  supersedeCase,
  type VerificationCaseDeps,
  type VerificationRequirementPolicy,
} from '../src/modules/provider/services/verification-case';
import { transitionOrganization } from '../src/modules/provider/services/organization-admin';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import type { AdminRole } from '../src/modules/identity/persistence/admin-role-repository';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import { createProviderOrg } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let adminA: string;
let adminB: string;
let ops: string;
let auditorUser: string;

/** Fictional deterministic policy — D-W3-3 (the real launch checklist)
 *  stays deferred; nothing here is a production default. */
const POLICY: VerificationRequirementPolicy = {
  policyVersion: 'test-policy-v1',
  requirements: [
    { key: 'business_document', labelEn: 'Business document', required: true },
    {
      key: 'operating_license',
      labelEn: 'Operating licence',
      descriptionEn: 'A licence covering the listed activities.',
      required: true,
    },
    { key: 'optional_reference', labelEn: 'Optional reference', required: false },
  ],
};

function deps(policy: VerificationRequirementPolicy | null = POLICY): VerificationCaseDeps {
  return {
    db: testDb.db,
    ...(policy === null
      ? {}
      : { policyProvider: { currentPolicy: async () => policy } }),
  };
}

async function grantRole(userId: string, role: AdminRole): Promise<void> {
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(
    testDb.db,
  );
}

async function submittedOrg(): Promise<string> {
  const { orgId } = await createProviderOrg(testDb.db, { state: 'submitted', branches: 1 });
  return orgId;
}

/** Opens a case and returns its id + requirement ids by key. */
async function openedCase(
  organizationId: string,
): Promise<{ caseId: string; requirements: Map<string, string> }> {
  const opened = await openVerificationCase(deps(), { userId: ops }, { organizationId });
  if (opened.kind !== 'caseOpened') throw new Error(opened.kind);
  const rows = await testDb.db
    .selectFrom('verification_case_requirement')
    .select(['id', 'requirement_key'])
    .where('case_id', '=', opened.caseId)
    .execute();
  return {
    caseId: opened.caseId,
    requirements: new Map(rows.map((row) => [row.requirement_key, row.id])),
  };
}

/** Registers AND (through the trusted boundary) stores evidence. */
async function storeEvidence(caseId: string, requirementId: string): Promise<string> {
  const registered = await registerEvidence(deps(), { userId: ops }, {
    caseId,
    requirementId,
    originalFilename: 'document.pdf',
    declaredContentType: 'application/pdf',
  });
  if (registered.kind !== 'evidenceRegistered') throw new Error(registered.kind);
  const stored = await finalizeEvidenceStorage(deps(), {
    evidenceId: registered.evidenceId,
    expectedVersion: registered.version,
    byteSize: 12_345,
    sha256Digest: 'a'.repeat(64),
    storageRef: `verification/${caseId}/${registered.evidenceId}`,
  });
  if (stored.kind !== 'evidenceStored') throw new Error(stored.kind);
  return registered.evidenceId;
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  ({ adminA, adminB } = await bootstrapAccessAdmins(testDb.db));
  ops = await createUser(testDb.db);
  await grantRole(ops, 'operations');
  auditorUser = await createUser(testDb.db);
  await grantRole(auditorUser, 'auditor');
});

afterAll(async () => {
  await testDb.drop();
});

describe('opening a round (§37, §41)', () => {
  it('opens round 1 with a stable id, version 1, and the full immutable policy snapshot; audit + outbox recorded', async () => {
    const orgId = await submittedOrg();
    const opened = await openVerificationCase(deps(), { userId: ops }, { organizationId: orgId });
    if (opened.kind !== 'caseOpened') throw new Error(opened.kind);
    expect(opened.round).toBe(1);
    expect(opened.version).toBe(1);

    const snapshot = await testDb.db
      .selectFrom('verification_case_requirement')
      .selectAll()
      .where('case_id', '=', opened.caseId)
      .orderBy('sort_hint')
      .execute();
    expect(snapshot.map((row) => [row.requirement_key, row.label_en, row.required])).toEqual([
      ['business_document', 'Business document', true],
      ['operating_license', 'Operating licence', true],
      ['optional_reference', 'Optional reference', false],
    ]);
    expect(snapshot[1]?.description_en).toBe('A licence covering the listed activities.');
    const caseRow = await testDb.db
      .selectFrom('verification_case')
      .selectAll()
      .where('id', '=', opened.caseId)
      .executeTakeFirstOrThrow();
    expect(caseRow.policy_version).toBe('test-policy-v1');
    expect(caseRow.state).toBe('open');

    const audit = await testDb.db
      .selectFrom('audit_event')
      .select(['action'])
      .where('entity_id', '=', opened.caseId)
      .execute();
    expect(audit.map((row) => row.action)).toContain('org.verification_case_opened');
    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', orgId)
      .where('event_type', '=', 'organization.verification_case_opened')
      .executeTakeFirstOrThrow();
    // ids + policy reference only — no labels, filenames, or reviewer text.
    expect(Object.keys(outbox.payload as object).sort()).toEqual([
      'caseId',
      'organizationId',
      'policyVersion',
      'round',
    ]);
  });

  it('policy absence FAILS CLOSED: no provider, an EMPTY checklist, and duplicate keys all refuse to open', async () => {
    const orgId = await submittedOrg();
    await expect(
      openVerificationCase(deps(null), { userId: ops }, { organizationId: orgId }),
    ).resolves.toEqual({ kind: 'policyUnavailable' });
    await expect(
      openVerificationCase(
        deps({ policyVersion: 'empty-v1', requirements: [] }),
        { userId: ops },
        { organizationId: orgId },
      ),
    ).resolves.toEqual({ kind: 'policyUnavailable' });
    await expect(
      openVerificationCase(
        deps({
          policyVersion: 'dup-v1',
          requirements: [
            { key: 'business_document', labelEn: 'A', required: true },
            { key: 'business_document', labelEn: 'B', required: true },
          ],
        }),
        { userId: ops },
        { organizationId: orgId },
      ),
    ).resolves.toEqual({ kind: 'policyUnavailable' });
  });

  it('requires the operations role and a review-eligible organization', async () => {
    const orgId = await submittedOrg();
    await expect(
      openVerificationCase(deps(), { userId: auditorUser }, { organizationId: orgId }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      openVerificationCase(deps(), { userId: ops }, { organizationId: newId() }),
    ).resolves.toEqual({ kind: 'organizationNotFound' });
    const { orgId: draftOrg } = await createProviderOrg(testDb.db, { state: 'draft', branches: 0 });
    await expect(
      openVerificationCase(deps(), { userId: ops }, { organizationId: draftOrg }),
    ).resolves.toEqual({ kind: 'organizationStateConflict' });
  });

  it('refuses a duplicate ACTIVE round in the service AND in the database itself', async () => {
    const orgId = await submittedOrg();
    const first = await openVerificationCase(deps(), { userId: ops }, { organizationId: orgId });
    expect(first.kind).toBe('caseOpened');
    await expect(
      openVerificationCase(deps(), { userId: ops }, { organizationId: orgId }),
    ).resolves.toEqual({ kind: 'activeCaseExists' });
    // The invariant is a partial unique index, not an application promise.
    await expect(
      sql`INSERT INTO verification_case (id, organization_id, round, state, policy_version, opened_by)
          VALUES (${newId()}, ${orgId}, 99, 'open', 'rogue-v1', ${ops})`.execute(testDb.db),
    ).rejects.toThrow(/ux_verification_case_active|duplicate key/);
  });

  it('historical rounds: a decided round 1 stays byte-identical when round 2 opens', async () => {
    const orgId = await submittedOrg();
    const round1 = await openedCase(orgId);
    const started = await startCaseReview(deps(), { userId: ops }, {
      caseId: round1.caseId,
      expectedVersion: 1,
    });
    if (started.kind !== 'caseReviewStarted') throw new Error(started.kind);
    const decided = await recordVerificationDecision(deps(), { userId: ops }, {
      caseId: round1.caseId,
      expectedVersion: started.version,
      outcome: 'rejected',
      reasonCode: 'incomplete_evidence',
      providerSafeMessage: 'Please provide the missing business document.',
      internalNote: 'Round 1 lacked everything.',
    });
    expect(decided.kind).toBe('decisionRecorded');
    const before = await testDb.db
      .selectFrom('verification_case')
      .selectAll()
      .where('id', '=', round1.caseId)
      .executeTakeFirstOrThrow();

    const round2 = await openVerificationCase(deps(), { userId: ops }, { organizationId: orgId });
    if (round2.kind !== 'caseOpened') throw new Error(round2.kind);
    expect(round2.round).toBe(2);

    const after = await testDb.db
      .selectFrom('verification_case')
      .selectAll()
      .where('id', '=', round1.caseId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before); // the historical round is untouched
    expect(after.state).toBe('decided');
  });

  it('stale CAS mutations are refused; terminal rounds are immutable even for direct SQL', async () => {
    const orgId = await submittedOrg();
    const { caseId } = await openedCase(orgId);
    await expect(
      startCaseReview(deps(), { userId: ops }, { caseId, expectedVersion: 41 }),
    ).resolves.toEqual({ kind: 'staleVersion' });
    const superseded = await supersedeCase(deps(), { userId: ops }, {
      caseId,
      expectedVersion: 1,
    });
    expect(superseded.kind).toBe('caseSuperseded');
    await expect(
      sql`UPDATE verification_case SET state = 'open' WHERE id = ${caseId}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
    // Illegal transition open -> decided is refused by the trigger directly.
    const orgB = await submittedOrg();
    const other = await openedCase(orgB);
    await expect(
      sql`UPDATE verification_case SET state = 'decided', decided_at = now()
          WHERE id = ${other.caseId}`.execute(testDb.db),
    ).rejects.toThrow(/illegal verification_case transition/);
  });

  it('no destructive path exists for himma_app: DELETE is not granted on any verification table', async () => {
    const statements = [
      sql`DELETE FROM verification_case`,
      sql`DELETE FROM verification_case_requirement`,
      sql`DELETE FROM verification_evidence`,
      sql`DELETE FROM verification_decision`,
      sql`UPDATE verification_case_requirement SET label_en = 'tampered'`,
      sql`UPDATE verification_decision SET internal_note = 'tampered'`,
    ];
    for (const statement of statements) {
      let caught: unknown;
      try {
        await withTransaction(testDb.db, async (trx) => {
          await sql`SET LOCAL ROLE himma_app`.execute(trx);
          await statement.execute(trx);
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(
        isDbError(caught, 'insufficientPrivilege') || isDbError(caught, 'raisedException'),
      ).toBe(true);
    }
  });
});

describe('policy snapshot integrity (§36.10)', () => {
  it('later policy changes never rewrite a historical round, and snapshot rows are database-immutable', async () => {
    const orgId = await submittedOrg();
    const mutablePolicy: VerificationRequirementPolicy = {
      policyVersion: 'drift-v1',
      requirements: [{ key: 'business_document', labelEn: 'Original label', required: true }],
    };
    const opened = await openVerificationCase(
      deps(mutablePolicy),
      { userId: ops },
      { organizationId: orgId },
    );
    if (opened.kind !== 'caseOpened') throw new Error(opened.kind);

    // The "current" policy drifts (new label, new version)…
    mutablePolicy.policyVersion = 'drift-v2';
    mutablePolicy.requirements[0]!.labelEn = 'Renamed label';

    const snapshot = await testDb.db
      .selectFrom('verification_case_requirement')
      .select(['label_en'])
      .where('case_id', '=', opened.caseId)
      .executeTakeFirstOrThrow();
    expect(snapshot.label_en).toBe('Original label');
    const caseRow = await testDb.db
      .selectFrom('verification_case')
      .select(['policy_version'])
      .where('id', '=', opened.caseId)
      .executeTakeFirstOrThrow();
    expect(caseRow.policy_version).toBe('drift-v1');

    // …and even a direct UPDATE cannot rewrite the snapshot.
    await expect(
      sql`UPDATE verification_case_requirement SET label_en = 'tampered'
          WHERE case_id = ${opened.caseId}`.execute(testDb.db),
    ).rejects.toThrow(/immutable snapshot/);
  });
});

describe('readiness (§36) — computed, fail-closed, never approval', () => {
  it('an empty requirement snapshot is policyUnavailable — zero requirements NEVER mean satisfied', async () => {
    // The service refuses to open such a case; simulate a legacy/rogue row
    // directly to pin the evaluator's own fail-closed behavior.
    const orgId = await submittedOrg();
    const rogueCase = newId();
    await sql`INSERT INTO verification_case (id, organization_id, round, state, policy_version, opened_by)
              VALUES (${rogueCase}, ${orgId}, 1, 'open', 'empty-v1', ${ops})`.execute(testDb.db);
    await expect(evaluateCaseReadiness(testDb.db, rogueCase)).resolves.toEqual({
      kind: 'policyUnavailable',
    });
    await expect(evaluateCaseReadiness(testDb.db, newId())).resolves.toEqual({
      kind: 'caseNotFound',
    });
  });

  it('walks the full evidence lifecycle: missing → pending is NOT enough → stored satisfies → optional never blocks → ready', async () => {
    const orgId = await submittedOrg();
    const { caseId, requirements } = await openedCase(orgId);
    const businessDoc = requirements.get('business_document')!;
    const licence = requirements.get('operating_license')!;

    // 1. Nothing submitted: both required requirements are missing; the
    //    optional one is NOT listed.
    const empty = await evaluateCaseReadiness(testDb.db, caseId);
    expect(empty).toEqual({
      kind: 'missingRequirements',
      missing: [
        { requirementKey: 'business_document', labelEn: 'Business document' },
        { requirementKey: 'operating_license', labelEn: 'Operating licence' },
      ],
    });

    // 2. A registered intent (pending_upload) still does not satisfy.
    const registered = await registerEvidence(deps(), { userId: ops }, {
      caseId,
      requirementId: businessDoc,
      originalFilename: 'trade.pdf',
      declaredContentType: 'application/pdf',
    });
    if (registered.kind !== 'evidenceRegistered') throw new Error(registered.kind);
    const stillMissing = await evaluateCaseReadiness(testDb.db, caseId);
    if (stillMissing.kind !== 'missingRequirements') throw new Error(stillMissing.kind);
    expect(stillMissing.missing.map((entry) => entry.requirementKey)).toContain(
      'business_document',
    );

    // 3. The trusted boundary stores it — the requirement is satisfied.
    const stored = await finalizeEvidenceStorage(deps(), {
      evidenceId: registered.evidenceId,
      expectedVersion: registered.version,
      byteSize: 100,
      sha256Digest: 'b'.repeat(64),
      storageRef: `verification/${caseId}/a`,
    });
    expect(stored.kind).toBe('evidenceStored');
    const oneLeft = await evaluateCaseReadiness(testDb.db, caseId);
    expect(oneLeft).toEqual({
      kind: 'missingRequirements',
      missing: [{ requirementKey: 'operating_license', labelEn: 'Operating licence' }],
    });

    // 4. Storing the second required document reaches ready — with the
    //    OPTIONAL requirement still absent (it never blocks).
    await storeEvidence(caseId, licence);
    await expect(evaluateCaseReadiness(testDb.db, caseId)).resolves.toEqual({ kind: 'ready' });

    // 5. Replacement resets satisfaction until the replacement is stored:
    //    registering a corrected document supersedes the stored one.
    const replacement = await registerEvidence(deps(), { userId: ops }, {
      caseId,
      requirementId: businessDoc,
      originalFilename: 'trade-corrected.pdf',
      declaredContentType: 'application/pdf',
    });
    if (replacement.kind !== 'evidenceRegistered') throw new Error(replacement.kind);
    expect(replacement.supersededEvidenceId).toBe(registered.evidenceId);
    const afterReplacement = await evaluateCaseReadiness(testDb.db, caseId);
    if (afterReplacement.kind !== 'missingRequirements') throw new Error(afterReplacement.kind);
    expect(afterReplacement.missing.map((entry) => entry.requirementKey)).toEqual([
      'business_document',
    ]);
  });

  it('evidence in ANOTHER case can never satisfy this case (structural)', async () => {
    const orgA = await submittedOrg();
    const orgB = await submittedOrg();
    const caseA = await openedCase(orgA);
    const caseB = await openedCase(orgB);
    // Satisfy org B's business_document fully.
    await storeEvidence(caseB.caseId, caseB.requirements.get('business_document')!);
    // Case A remains missing — B's evidence is invisible to it.
    const readiness = await evaluateCaseReadiness(testDb.db, caseA.caseId);
    if (readiness.kind !== 'missingRequirements') throw new Error(readiness.kind);
    expect(readiness.missing).toHaveLength(2);
    // And the cross-case reference itself is impossible at the service…
    await expect(
      registerEvidence(deps(), { userId: ops }, {
        caseId: caseA.caseId,
        requirementId: caseB.requirements.get('business_document')!,
        originalFilename: 'sneaky.pdf',
        declaredContentType: 'application/pdf',
      }),
    ).resolves.toEqual({ kind: 'requirementNotFound' });
    // …and at the database (composite FK), so cross-organization evidence
    // relationships cannot exist either (probed on an evidence-free
    // requirement, so the FK itself — not the current-evidence index — is
    // what refuses).
    await expect(
      sql`INSERT INTO verification_evidence (id, case_id, requirement_id, original_filename, declared_content_type, created_by)
          VALUES (${newId()}, ${caseA.caseId}, ${caseB.requirements.get('optional_reference')!}, 'x.pdf', 'application/pdf', ${ops})`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/fk_verification_evidence_requirement|foreign key/);
  });
});

describe('D-S3-3 regression (§40) — the production gate is UNCHANGED by W3-3', () => {
  it('a fully READY case does not unlock production verify: it remains fail-closed until W3-4/W3-5', async () => {
    const orgId = await submittedOrg();
    const { caseId, requirements } = await openedCase(orgId);
    await storeEvidence(caseId, requirements.get('business_document')!);
    await storeEvidence(caseId, requirements.get('operating_license')!);
    await expect(evaluateCaseReadiness(testDb.db, caseId)).resolves.toEqual({ kind: 'ready' });

    // Move the ORGANIZATION to in_review through the certified admin edge.
    const adminDeps = {
      db: testDb.db,
      mailSender: new CaptureMailSender(),
      invitationConfig: parseStaffInvitationConfig('test', {}),
      lifecycle: { nodeEnv: 'production' as const, verificationEvidenceCapabilityReady: false },
    };
    const org = await testDb.db
      .selectFrom('organization')
      .select(['version'])
      .where('id', '=', orgId)
      .executeTakeFirstOrThrow();
    const started = await transitionOrganization(adminDeps, { userId: ops }, {
      organizationId: orgId,
      action: 'start_review',
      expectedVersion: org.version,
    });
    if (started.kind !== 'organizationTransitioned') throw new Error(started.kind);

    // PRODUCTION verify: STILL refused — the ready case grants nothing yet.
    const verify = await transitionOrganization(adminDeps, { userId: ops }, {
      organizationId: orgId,
      action: 'verify',
      expectedVersion: started.version,
    });
    expect(verify).toEqual({ kind: 'verificationEvidenceUnavailable' });
  });

  it('production go-live remains fail-closed too', async () => {
    const { orgId } = await createProviderOrg(testDb.db, { state: 'verified', branches: 1 });
    const adminDeps = {
      db: testDb.db,
      mailSender: new CaptureMailSender(),
      invitationConfig: parseStaffInvitationConfig('test', {}),
      lifecycle: { nodeEnv: 'production' as const, verificationEvidenceCapabilityReady: false },
    };
    const org = await testDb.db
      .selectFrom('organization')
      .select(['version'])
      .where('id', '=', orgId)
      .executeTakeFirstOrThrow();
    await expect(
      transitionOrganization(adminDeps, { userId: ops }, {
        organizationId: orgId,
        action: 'go_live',
        expectedVersion: org.version,
      }),
    ).resolves.toEqual({ kind: 'verificationEvidenceUnavailable' });
  });
});
