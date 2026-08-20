/**
 * S4-1 — Program (Listing) catalogue schema (migration 0008; docs/28 §4–§10,
 * §9 "0008"; docs/24 §2.2/§2.5/§5.3 as amended). Real PostgreSQL: the §5.3
 * lifecycle machine DB-enforced (approval never auto-publishes — D-S4-2),
 * immutable organization ownership, eligibility CHECKs, the composite
 * Program↔Branch ownership spine, media/offer/revision foundations,
 * structural boundaries against later-slice entities, and himma_app grants.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let orgA: string;
let orgB: string;
let branchA1: string;
let branchA2: string;
let branchB1: string;
let activityType: string;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  orgA = await makeOrganization('Provider A LLC', 'Provider A');
  orgB = await makeOrganization('Provider B LLC', 'Provider B');
  branchA1 = await makeBranch(orgA, 'A — Main');
  branchA2 = await makeBranch(orgA, 'A — Second');
  branchB1 = await makeBranch(orgB, 'B — Main');
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'martial-arts'`.execute(testDb.db);
  activityType = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityType}, ${category.rows[0]!.id}, 'test-jiu-jitsu', 'Jiu-jitsu')`.execute(
    testDb.db,
  );
});

afterAll(async () => {
  await testDb.drop();
});

async function makeOrganization(legal: string, trade: string): Promise<string> {
  const id = newId();
  await sql`INSERT INTO organization (id, legal_name, trade_name)
            VALUES (${id}, ${legal}, ${trade})`.execute(testDb.db);
  return id;
}

async function makeBranch(organizationId: string, label: string): Promise<string> {
  const id = newId();
  await sql`INSERT INTO branch (id, organization_id, label, area_label)
            VALUES (${id}, ${organizationId}, ${label}, 'Khalifa City')`.execute(testDb.db);
  return id;
}

async function makeProgram(
  overrides: {
    organizationId?: string;
    state?: string;
    title?: string;
    publishedAt?: Date | null;
    archivedAt?: Date | null;
  } = {},
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO program (id, organization_id, activity_type_id, title_en, setting,
                         gender_eligibility, listing_state, published_at, archived_at)
    VALUES (${id}, ${overrides.organizationId ?? orgA}, ${activityType},
            ${overrides.title ?? 'Adult Beginner Jiu-Jitsu'}, 'indoor', 'mixed',
            ${overrides.state ?? 'draft'}, ${overrides.publishedAt ?? null},
            ${overrides.archivedAt ?? null})`.execute(testDb.db);
  return id;
}

async function transition(
  id: string,
  toState: string,
  extra: { publishedAt?: Date | null; archivedAt?: Date | null; keepPublishedAt?: boolean } = {},
): Promise<void> {
  if (extra.keepPublishedAt === true) {
    await sql`UPDATE program SET listing_state = ${toState},
              archived_at = ${extra.archivedAt ?? null} WHERE id = ${id}`.execute(testDb.db);
    return;
  }
  await sql`UPDATE program SET listing_state = ${toState},
            published_at = ${extra.publishedAt ?? null},
            archived_at = ${extra.archivedAt ?? null} WHERE id = ${id}`.execute(testDb.db);
}

async function programState(id: string): Promise<string> {
  const row = await sql<{ listing_state: string }>`
    SELECT listing_state FROM program WHERE id = ${id}`.execute(testDb.db);
  return row.rows[0]!.listing_state;
}

describe('program foundation and ownership', () => {
  it('creates a draft with approved defaults; drafts may exist incomplete', async () => {
    const id = await makeProgram();
    const row = await sql<{
      listing_state: string;
      sensitive_fields_version: number;
      version: number;
      title_ar: string | null;
    }>`SELECT listing_state, sensitive_fields_version, version, title_ar
       FROM program WHERE id = ${id}`.execute(testDb.db);
    expect(row.rows[0]).toEqual({
      listing_state: 'draft',
      sensitive_fields_version: 1,
      version: 1,
      title_ar: null,
    });
    // A draft needs no branches, options, media, or Arabic content to exist.
  });

  it('requires a real owning organization and a real activity type', async () => {
    await expect(
      sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility)
          VALUES (${newId()}, ${newId()}, ${activityType}, 'Orphan', 'indoor', 'mixed')`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility)
          VALUES (${newId()}, ${orgA}, ${newId()}, 'No taxonomy', 'indoor', 'mixed')`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('an inactive activity type keeps existing references valid (deactivation never breaks history)', async () => {
    const category = await sql<{ id: string }>`
      SELECT id FROM category WHERE slug = 'wellness'`.execute(testDb.db);
    const dormant = newId();
    await sql`INSERT INTO activity_type (id, category_id, slug, label_en, active)
              VALUES (${dormant}, ${category.rows[0]!.id}, 'test-dormant', 'Dormant', false)`.execute(
      testDb.db,
    );
    const id = newId();
    await sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility)
              VALUES (${id}, ${orgA}, ${dormant}, 'Dormant-typed', 'indoor', 'mixed')`.execute(
      testDb.db,
    );
    expect(await programState(id)).toBe('draft');
  });

  it('program ownership and identity are immutable — a listing can never move organizations', async () => {
    const id = await makeProgram();
    await expect(
      sql`UPDATE program SET organization_id = ${orgB} WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`UPDATE program SET id = ${newId()} WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
  });

  it('optimistic concurrency: stale writers lose, version bumps automatically', async () => {
    const id = await makeProgram();
    const first = await sql`UPDATE program SET title_en = 'One'
                            WHERE id = ${id} AND version = 1`.execute(testDb.db);
    const second = await sql`UPDATE program SET title_en = 'Two'
                             WHERE id = ${id} AND version = 1`.execute(testDb.db);
    expect(first.numAffectedRows).toBe(1n);
    expect(second.numAffectedRows).toBe(0n);
    const row = await sql<{ version: number; title_en: string }>`
      SELECT version, title_en FROM program WHERE id = ${id}`.execute(testDb.db);
    expect(row.rows[0]).toEqual({ version: 2, title_en: 'One' });
  });

  it('sensitive_fields_version can only move forward', async () => {
    const id = await makeProgram();
    await sql`UPDATE program SET sensitive_fields_version = 2 WHERE id = ${id}`.execute(testDb.db);
    await expect(
      sql`UPDATE program SET sensitive_fields_version = 1 WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow();
  });
});

describe('program eligibility (docs/24 §2.5 — catalogue metadata, never booking truth)', () => {
  it('accepts the approved vocabulary and rejects everything else', async () => {
    const id = newId();
    await sql`
      INSERT INTO program (id, organization_id, activity_type_id, title_en, setting,
                           gender_eligibility, min_age, max_age, skill_level, eligibility_notes)
      VALUES (${id}, ${orgA}, ${activityType}, 'Junior Jiu-Jitsu', 'indoor',
              'mixed', 6, 12, 'beginner', 'Bring a gi')`.execute(testDb.db);

    const bad = async (fragment: ReturnType<typeof sql>): Promise<void> => {
      await expect(fragment.execute(testDb.db)).rejects.toThrow();
    };
    await bad(sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility)
                  VALUES (${newId()}, ${orgA}, ${activityType}, 'Bad', 'underwater', 'mixed')`);
    await bad(sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility)
                  VALUES (${newId()}, ${orgA}, ${activityType}, 'Bad', 'indoor', 'everyone')`);
    await bad(sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility, skill_level)
                  VALUES (${newId()}, ${orgA}, ${activityType}, 'Bad', 'indoor', 'mixed', 'expert')`);
    // Age sanity: negative and inverted ranges are refused.
    await bad(sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility, min_age)
                  VALUES (${newId()}, ${orgA}, ${activityType}, 'Bad', 'indoor', 'mixed', -1)`);
    await bad(sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility, min_age, max_age)
                  VALUES (${newId()}, ${orgA}, ${activityType}, 'Bad', 'indoor', 'mixed', 12, 6)`);
    // all_ages contradicts an explicit range.
    await bad(sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility, all_ages, min_age)
                  VALUES (${newId()}, ${orgA}, ${activityType}, 'Bad', 'indoor', 'mixed', true, 6)`);
  });

  it('stores the five-value gender eligibility vocabulary exactly (owner correction, 2026-08-07)', async () => {
    // women|men|girls|boys|mixed — women is the canonical stored code
    // ("Ladies only" is later presentation wording, never database semantics).
    for (const gender of ['women', 'men', 'girls', 'boys', 'mixed']) {
      await sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility)
                VALUES (${newId()}, ${orgA}, ${activityType}, ${`Gender ${gender}`}, 'indoor', ${gender})`.execute(
        testDb.db,
      );
    }
    // The legacy three-value code and arbitrary values are rejected.
    for (const gender of ['ladies', 'everyone', 'female', 'adults']) {
      await expect(
        sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility)
            VALUES (${newId()}, ${orgA}, ${activityType}, 'Bad gender', 'indoor', ${gender})`.execute(
          testDb.db,
        ),
      ).rejects.toThrow();
    }
    // The revision change-set carries the same five-value vocabulary.
    const published = await makeProgram({ state: 'published', publishedAt: new Date() });
    await sql`INSERT INTO program_revision (id, program_id, organization_id, submitted_by, gender_eligibility)
              VALUES (${newId()}, ${published}, ${orgA}, ${newId()}, 'girls')`.execute(testDb.db);
    const other = await makeProgram({ state: 'published', publishedAt: new Date() });
    await expect(
      sql`INSERT INTO program_revision (id, program_id, organization_id, submitted_by, gender_eligibility)
          VALUES (${newId()}, ${other}, ${orgA}, ${newId()}, 'ladies')`.execute(testDb.db),
    ).rejects.toThrow();
  });

  it('never infers or rewrites girls/boys from age ranges — age and gender are independent', async () => {
    // A child-aged mixed program stays mixed.
    const childMixed = newId();
    await sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting,
                                   gender_eligibility, min_age, max_age)
              VALUES (${childMixed}, ${orgA}, ${activityType}, 'Junior Mixed', 'indoor', 'mixed', 6, 12)`.execute(
      testDb.db,
    );
    // girls/boys are storable regardless of (even adult) age bounds.
    const adultGirls = newId();
    await sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting,
                                   gender_eligibility, min_age)
              VALUES (${adultGirls}, ${orgA}, ${activityType}, 'Teen Girls 13+', 'indoor', 'girls', 13)`.execute(
      testDb.db,
    );
    // Editing ages never rewrites the stored gender code.
    await sql`UPDATE program SET min_age = 4, max_age = 10 WHERE id = ${childMixed}`.execute(testDb.db);
    const rows = await sql<{ id: string; gender_eligibility: string }>`
      SELECT id, gender_eligibility FROM program
      WHERE id IN (${childMixed}, ${adultGirls}) ORDER BY gender_eligibility`.execute(testDb.db);
    expect(rows.rows.map((r) => r.gender_eligibility)).toEqual(['girls', 'mixed']);
  });

  it('introduces no session/date/time availability columns at program level', async () => {
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'program'
        AND column_name ~ '(schedule|session|available|start_at|end_at|weekday|cutoff)'`.execute(
      testDb.db,
    );
    expect(columns.rows).toEqual([]);
  });
});

describe('program lifecycle machine (docs/24 §5.3; D-S4-2)', () => {
  it('walks every approved edge including changes_requested resubmission and pause', async () => {
    const id = await makeProgram();
    await transition(id, 'submitted');
    await transition(id, 'in_review');
    await transition(id, 'changes_requested');
    await transition(id, 'submitted');
    await transition(id, 'in_review');
    await transition(id, 'approved');
    await transition(id, 'published', { publishedAt: new Date() });
    await transition(id, 'paused', { keepPublishedAt: true });
    await transition(id, 'published', { keepPublishedAt: true });
    await transition(id, 'archived', { keepPublishedAt: true, archivedAt: new Date() });
    expect(await programState(id)).toBe('archived');
  });

  it('approval does not automatically publish (D-S4-2): approved is a resting state', async () => {
    const id = await makeProgram({ state: 'in_review' });
    await transition(id, 'approved');
    expect(await programState(id)).toBe('approved');
    // Publication is a separate, explicit transition.
    await transition(id, 'published', { publishedAt: new Date() });
    expect(await programState(id)).toBe('published');
  });

  it('refuses invalid state jumps directly in SQL', async () => {
    const draft = await makeProgram();
    for (const target of ['in_review', 'approved', 'changes_requested', 'published', 'paused', 'archived']) {
      await expect(
        transition(draft, target, {
          publishedAt: target === 'published' || target === 'paused' ? new Date() : null,
          archivedAt: target === 'archived' ? new Date() : null,
        }),
      ).rejects.toThrow(/invalid (program|listing) transition/i);
    }
    const submitted = await makeProgram({ state: 'submitted' });
    await expect(transition(submitted, 'approved')).rejects.toThrow();
    await expect(
      transition(submitted, 'published', { publishedAt: new Date() }),
    ).rejects.toThrow();
    const approved = await makeProgram({ state: 'approved' });
    await expect(transition(approved, 'paused', { publishedAt: new Date() })).rejects.toThrow();
    await expect(transition(approved, 'archived', { archivedAt: new Date() })).rejects.toThrow();
    const inReview = await makeProgram({ state: 'in_review' });
    await expect(
      transition(inReview, 'published', { publishedAt: new Date() }),
    ).rejects.toThrow();
    await expect(sql`UPDATE program SET listing_state = 'imaginary' WHERE id = ${draft}`.execute(testDb.db)).rejects.toThrow();
  });

  it('ties publication and archival timestamps to their states', async () => {
    const approved = await makeProgram({ state: 'approved' });
    // Publishing requires published_at.
    await expect(transition(approved, 'published')).rejects.toThrow();
    await transition(approved, 'published', { publishedAt: new Date() });
    // Archiving requires archived_at; published_at survives for history.
    await expect(transition(approved, 'archived', { keepPublishedAt: true })).rejects.toThrow();
    await transition(approved, 'archived', { keepPublishedAt: true, archivedAt: new Date() });
    const row = await sql<{ published_at: Date | null; archived_at: Date | null }>`
      SELECT published_at, archived_at FROM program WHERE id = ${approved}`.execute(testDb.db);
    expect(row.rows[0]?.published_at).not.toBeNull();
    expect(row.rows[0]?.archived_at).not.toBeNull();
    // archived_at may never exist outside the archived state.
    await expect(makeProgram({ archivedAt: new Date() })).rejects.toThrow();
  });

  it('archived is terminal: the row is frozen against every further edit', async () => {
    const id = await makeProgram({ state: 'paused', publishedAt: new Date() });
    await transition(id, 'archived', { keepPublishedAt: true, archivedAt: new Date() });
    await expect(
      sql`UPDATE program SET title_en = 'Rewritten history' WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/archived|immutable/);
    await expect(transition(id, 'published', { keepPublishedAt: true })).rejects.toThrow();
  });
});

describe('program ↔ branch association (composite ownership spine)', () => {
  it('associates a program with one or several branches of its own organization', async () => {
    const id = await makeProgram();
    await sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
              VALUES (${id}, ${branchA1}, ${orgA})`.execute(testDb.db);
    await sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
              VALUES (${id}, ${branchA2}, ${orgA})`.execute(testDb.db);
    const rows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program_branch WHERE program_id = ${id}`.execute(testDb.db);
    expect(Number(rows.rows[0]?.n)).toBe(2);
    // The same pair cannot be associated twice.
    await expect(
      sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
          VALUES (${id}, ${branchA1}, ${orgA})`.execute(testDb.db),
    ).rejects.toThrow();
  });

  it("a Provider A program is database-incapable of using Provider B's branch", async () => {
    const id = await makeProgram();
    // Honest attempt: foreign branch under its own org id.
    await expect(
      sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
          VALUES (${id}, ${branchB1}, ${orgB})`.execute(testDb.db),
    ).rejects.toThrow(/foreign key/i);
    // Forged attempt: foreign branch smuggled under org A's id.
    await expect(
      sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
          VALUES (${id}, ${branchB1}, ${orgA})`.execute(testDb.db),
    ).rejects.toThrow(/foreign key/i);
  });

  it('association identity is immutable; removal is deactivation, and branch deactivation keeps history', async () => {
    const id = await makeProgram();
    await sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
              VALUES (${id}, ${branchA1}, ${orgA})`.execute(testDb.db);
    await expect(
      sql`UPDATE program_branch SET branch_id = ${branchA2}
          WHERE program_id = ${id} AND branch_id = ${branchA1}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
    await sql`UPDATE program_branch SET active = false
              WHERE program_id = ${id} AND branch_id = ${branchA1}`.execute(testDb.db);
    // Deactivating the branch itself never deletes the association row.
    const branch = await makeBranch(orgA, 'A — Temp');
    await sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
              VALUES (${id}, ${branch}, ${orgA})`.execute(testDb.db);
    await sql`UPDATE branch SET active = false WHERE id = ${branch}`.execute(testDb.db);
    const still = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program_branch
      WHERE program_id = ${id} AND branch_id = ${branch}`.execute(testDb.db);
    expect(Number(still.rows[0]?.n)).toBe(1);
  });
});

describe('program media references (metadata only — docs/28 §14)', () => {
  it('carries ordered, alt-texted references owned by the program and organization', async () => {
    const id = await makeProgram();
    const mediaId = newId();
    await sql`INSERT INTO program_media (id, program_id, organization_id, media_ref, sort_hint, alt_text_en)
              VALUES (${mediaId}, ${id}, ${orgA}, ${newId()}, 10, 'Training mats')`.execute(testDb.db);
    await expect(
      sql`INSERT INTO program_media (id, program_id, organization_id, media_ref, sort_hint)
          VALUES (${newId()}, ${id}, ${orgB}, ${newId()}, 20)`.execute(testDb.db),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      sql`UPDATE program_media SET program_id = ${await makeProgram()} WHERE id = ${mediaId}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/immutable/);
    // Retirement is deactivation, never deletion.
    await sql`UPDATE program_media SET active = false WHERE id = ${mediaId}`.execute(testDb.db);
  });
});

describe('offer foundation (structured, informational — docs/24 §2.2)', () => {
  it('enforces the approved kinds and the paid-trial amount tie', async () => {
    const id = await makeProgram();
    await sql`INSERT INTO offer (id, program_id, organization_id, kind, label_en)
              VALUES (${newId()}, ${id}, ${orgA}, 'freeTrial', 'Free trial class')`.execute(testDb.db);
    await sql`INSERT INTO offer (id, program_id, organization_id, kind, label_en, trial_amount_fils)
              VALUES (${newId()}, ${id}, ${orgA}, 'paidTrial', 'Trial for AED 50', 5000)`.execute(
      testDb.db,
    );
    await expect(
      sql`INSERT INTO offer (id, program_id, organization_id, kind, label_en)
          VALUES (${newId()}, ${id}, ${orgA}, 'paidTrial', 'Missing amount')`.execute(testDb.db),
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO offer (id, program_id, organization_id, kind, label_en, trial_amount_fils)
          VALUES (${newId()}, ${id}, ${orgA}, 'freeTrial', 'Free with amount', 100)`.execute(testDb.db),
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO offer (id, program_id, organization_id, kind, label_en)
          VALUES (${newId()}, ${id}, ${orgA}, 'flashSale', 'Bad kind')`.execute(testDb.db),
    ).rejects.toThrow();
    // Cross-organization offers are impossible.
    await expect(
      sql`INSERT INTO offer (id, program_id, organization_id, kind, label_en)
          VALUES (${newId()}, ${id}, ${orgB}, 'freeTrial', 'Foreign')`.execute(testDb.db),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('sensitive-field revision foundation (docs/28 §7, §9.10)', () => {
  it('allows at most one open revision per program, with the exact review machine', async () => {
    const id = await makeProgram({ state: 'published', publishedAt: new Date() });
    const revision = newId();
    await sql`INSERT INTO program_revision (id, program_id, organization_id, submitted_by, min_age, max_age)
              VALUES (${revision}, ${id}, ${orgA}, ${newId()}, 8, 14)`.execute(testDb.db);
    // A second open revision for the same program is refused.
    await expect(
      sql`INSERT INTO program_revision (id, program_id, organization_id, submitted_by, min_age)
          VALUES (${newId()}, ${id}, ${orgA}, ${newId()}, 9)`.execute(testDb.db),
    ).rejects.toThrow();
    // submitted → in_review → rejected, with decision metadata required.
    await sql`UPDATE program_revision SET state = 'in_review' WHERE id = ${revision}`.execute(testDb.db);
    await expect(
      sql`UPDATE program_revision SET state = 'rejected' WHERE id = ${revision}`.execute(testDb.db),
    ).rejects.toThrow();
    await sql`UPDATE program_revision SET state = 'rejected', decided_by = ${newId()},
              decided_at = now() WHERE id = ${revision}`.execute(testDb.db);
    // Terminal rows are frozen.
    await expect(
      sql`UPDATE program_revision SET min_age = 1 WHERE id = ${revision}`.execute(testDb.db),
    ).rejects.toThrow();
    // Once decided, a new revision may open.
    await sql`INSERT INTO program_revision (id, program_id, organization_id, submitted_by, min_age)
              VALUES (${newId()}, ${id}, ${orgA}, ${newId()}, 10)`.execute(testDb.db);
  });

  it('refuses invalid transitions, cross-organization rows, and foreign option references', async () => {
    const id = await makeProgram();
    await expect(
      sql`INSERT INTO program_revision (id, program_id, organization_id, submitted_by)
          VALUES (${newId()}, ${id}, ${orgB}, ${newId()})`.execute(testDb.db),
    ).rejects.toThrow(/foreign key/i);

    const revision = newId();
    await sql`INSERT INTO program_revision (id, program_id, organization_id, submitted_by, eligibility_notes)
              VALUES (${revision}, ${id}, ${orgA}, ${newId()}, 'Safety note update')`.execute(testDb.db);
    await expect(
      sql`UPDATE program_revision SET state = 'approved', decided_by = ${newId()}, decided_at = now()
          WHERE id = ${revision}`.execute(testDb.db),
    ).rejects.toThrow(/invalid/i);
    await expect(
      sql`UPDATE program_revision SET program_id = ${await makeProgram()} WHERE id = ${revision}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/immutable/);

    // An option change set may only reference an option of the SAME program.
    const otherProgram = await makeProgram();
    const foreignOption = newId();
    await sql`INSERT INTO program_price_option (id, program_id, organization_id, kind, amount_fils)
              VALUES (${foreignOption}, ${otherProgram}, ${orgA}, 'monthly', 50000)`.execute(testDb.db);
    await sql`UPDATE program_revision SET state = 'in_review' WHERE id = ${revision}`.execute(testDb.db);
    await sql`UPDATE program_revision SET state = 'rejected', decided_by = ${newId()}, decided_at = now()
              WHERE id = ${revision}`.execute(testDb.db);
    await expect(
      sql`INSERT INTO program_revision (id, program_id, organization_id, submitted_by, option_id, option_amount_fils)
          VALUES (${newId()}, ${id}, ${orgA}, ${newId()}, ${foreignOption}, 60000)`.execute(testDb.db),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('structural boundaries (docs/28 §1 exclusions; task §6/§22)', () => {
  it('introduces no later-slice table: sessions, capacity, holds, bookings, payments, entitlements', async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`.execute(
      testDb.db,
    );
    const names = tables.rows.map((r) => r.table_name);
    // Exact later-slice entity names (login_session is the Slice-2 AUTH
    // session store, not the booking-domain Session — deliberately exempt;
    // program_search_document arrived legitimately with the owner-approved
    // search-foundation task and is locked by catalogue-search.test.ts;
    // the Slice-5 booking/capacity tables — session, camp_week,
    // enrolment_cohort(+_schedule), recurring_schedule, capacity_hold,
    // booking, enrolment, price_quote(+_line), package_entitlement,
    // cancellation_policy_template — arrived legitimately with the
    // owner-approved S5-1 foundation (docs/32) and are locked by
    // booking-capacity-schema.test.ts). Payments/refunds/attendance stay
    // forbidden until THEIR owning slices.
    const forbiddenExact =
      /^(payment_intent|payment_attempt|payment_transaction|gateway_event|refund|payout|payout_statement|credit_ledger_entry|attendance_record|instructor|waitlist)$/;
    const forbiddenAnywhere = /(redemption|rating|waitlist)/i;
    expect(names.filter((n) => forbiddenExact.test(n) || forbiddenAnywhere.test(n))).toEqual([]);
    for (const required of [
      'area',
      'category',
      'activity_type',
      'collection',
      'program',
      'program_price_option',
      'program_branch',
      'program_media',
      'offer',
      'program_revision',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('no S4-1 catalogue table carries capacity, booking, payment, rating, popularity, or secret columns', async () => {
    const columns = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('area', 'category', 'activity_type', 'collection', 'program',
                           'program_price_option', 'program_branch', 'program_media',
                           'offer', 'program_revision')
        AND column_name ~ '(capacity|seat|booked|held_|availab|entitle|redemption|redeem|attendance|payment|balance|rating|review|popular|rank|secret|token|password)'
        -- The approved collection filter-preset booleans (docs/28 §9 "0007.4"
        -- — typed mirrors of the mock preset) describe a FILTER, not stored
        -- availability data, and are the only sanctioned match.
        AND NOT (table_name = 'collection' AND column_name LIKE 'preset\_%')`.execute(
      testDb.db,
    );
    expect(columns.rows).toEqual([]);
  });

  it('the Slice-6 capacity-unit shapes attach to program (id, organization_id) unchanged (forward-compat probe)', async () => {
    const id = await makeProgram();
    await sql`
      CREATE TABLE session_probe (
        id              uuid PRIMARY KEY,
        program_id      uuid NOT NULL,
        organization_id uuid NOT NULL,
        branch_id       uuid NOT NULL,
        FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
        FOREIGN KEY (branch_id, organization_id) REFERENCES branch (id, organization_id)
      )`.execute(testDb.db);
    try {
      await sql`INSERT INTO session_probe (id, program_id, organization_id, branch_id)
                VALUES (${newId()}, ${id}, ${orgA}, ${branchA1})`.execute(testDb.db);
      await expect(
        sql`INSERT INTO session_probe (id, program_id, organization_id, branch_id)
            VALUES (${newId()}, ${id}, ${orgA}, ${branchB1})`.execute(testDb.db),
      ).rejects.toThrow(/foreign key/i);
    } finally {
      await sql`DROP TABLE session_probe`.execute(testDb.db);
    }
  });
});

describe('application-role permissions (catalogue)', () => {
  it('himma_app can select/insert/update catalogue tables but never delete', async () => {
    const id = await makeProgram();
    await withTransaction(testDb.db, async (trx) => {
      await sql`SET LOCAL ROLE himma_app`.execute(trx);
      const own = newId();
      await sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting, gender_eligibility)
                VALUES (${own}, ${orgA}, ${activityType}, 'App-created', 'outdoor', 'women')`.execute(
        trx,
      );
      await sql`UPDATE program SET title_en = 'App-edited' WHERE id = ${own}`.execute(trx);
      await sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
                VALUES (${own}, ${branchA1}, ${orgA})`.execute(trx);
      await sql`SELECT count(*) FROM program`.execute(trx);
    });
    for (const table of [
      'program',
      'program_price_option',
      'program_branch',
      'program_media',
      'offer',
      'program_revision',
    ]) {
      await expect(
        withTransaction(testDb.db, async (trx) => {
          await sql`SET LOCAL ROLE himma_app`.execute(trx);
          await sql.raw(`DELETE FROM ${table}`).execute(trx);
        }),
      ).rejects.toThrow(/permission denied/i);
    }
    void id;
  });

  it('himma_app cannot disable or drop the lifecycle and immutability triggers', async () => {
    await expect(
      withTransaction(testDb.db, async (trx) => {
        await sql`SET LOCAL ROLE himma_app`.execute(trx);
        await sql`ALTER TABLE program DISABLE TRIGGER ALL`.execute(trx);
      }),
    ).rejects.toThrow(/must be owner|permission denied/i);
    await expect(
      withTransaction(testDb.db, async (trx) => {
        await sql`SET LOCAL ROLE himma_app`.execute(trx);
        await sql`DROP TRIGGER trg_program_transition ON program`.execute(trx);
      }),
    ).rejects.toThrow(/must be owner|permission denied/i);
  });
});
