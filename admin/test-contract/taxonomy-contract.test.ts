/**
 * W3-7 Admin ↔ backend CONTRACT journey: the LIVE taxonomy port against
 * the REAL backend (buildApp + real PostgreSQL + fake Cognito). An
 * operations admin reads the actual seeded taxonomy and manages it
 * through the CERTIFIED S4 services: create area/category/activity type,
 * CAS edit with a stale refusal, slug conflict, deactivation with proven
 * consumer safety (a NEW provider listing can no longer select the
 * deactivated type through the certified S4 validation, an EXISTING
 * listing keeps its reference and truthful representation, and the public
 * catalogue read excludes the inactive row) — with audit/outbox emitted
 * exactly once through the canonical path, and an access_admin refused.
 */
import { sql } from 'kysely';

import { newId } from '../../backend/src/db/ids';
import {
  bootstrapAccessAdmins,
  createIdentity,
  createUser,
} from '../../backend/test/helpers/identity-fixtures';
import { createProviderOrg } from '../../backend/test/helpers/provider-fixtures';
import { capabilitiesForRole } from '../../backend/src/modules/provider/provider-capabilities';
import type { OrgScope } from '../../backend/src/modules/provider/services/provider-principal';
import {
  createProgram,
  getProviderProgram,
} from '../../backend/src/modules/catalogue/services/program-management';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import { createLiveTaxonomyPort } from '../src/services/live/live-taxonomy-port';
import type { AdminTaxonomyPort, TaxonomyAdminView } from '../src/taxonomy/contract';
import {
  CONTRACT_CLIENT_ID,
  CONTRACT_ISSUER,
  createContractHarness,
  VALID_TOTP,
  type ContractHarness,
} from '../../portal/test-contract/support/backend-harness';

let harness: ContractHarness;
let adminA: string;
let adminB: string;
let userCounter = 0;

async function provisionAdmin(
  role: 'operations' | 'access_admin',
): Promise<{ email: string; password: string }> {
  userCounter += 1;
  const email = `taxonomy-admin-${userCounter}@contract.test`;
  const password = `pw-taxonomy-${userCounter}`;
  const subject = `taxonomy-contract-sub-${userCounter}`;
  const userId = await createUser(harness.testDb.db);
  await createIdentity(harness.testDb.db, userId, {
    provider: 'email',
    issuer: CONTRACT_ISSUER,
    subject,
    email,
    emailVerified: true,
  });
  await harness.testDb.db
    .insertInto('mfa_method')
    .values({ id: newId(), user_id: userId, kind: 'totp', state: 'active', confirmed_at: new Date() })
    .execute();
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(
    harness.testDb.db,
  );
  harness.registerUser(email, {
    password,
    subject,
    email,
    displayName: `Taxonomy Admin ${userCounter}`,
    mfaConfigured: true,
  });
  return { email, password };
}

async function signedInPort(credentials: { email: string; password: string }) {
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: harness.fetchImpl,
  });
  await runtime.adapter.signIn(credentials);
  const signedIn = await runtime.adapter.completeMfaChallenge(VALID_TOTP);
  expect(signedIn).toMatchObject({ kind: 'signedIn', assurance: 'mfa' });
  return createLiveTaxonomyPort(runtime.transport);
}

async function loadView(port: AdminTaxonomyPort): Promise<TaxonomyAdminView> {
  const outcome = await port.getTaxonomy();
  if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
  return outcome.view;
}

beforeAll(async () => {
  harness = await createContractHarness();
  ({ adminA, adminB } = await bootstrapAccessAdmins(harness.testDb.db));
});

afterAll(async () => {
  await harness.close();
});

describe('the real taxonomy administration journeys through the live admin transport', () => {
  test('read → create area/category/activity type → CAS edit → stale refusal → slug conflict, over the SEEDED truth', async () => {
    const ops = await provisionAdmin('operations');
    const port = await signedInPort(ops);

    // The administration view is the real seeded database truth.
    const initial = await loadView(port);
    expect(initial.categories.length).toBeGreaterThanOrEqual(11); // D-S4-3 seed
    expect(initial.categories.some((category) => category.slug === 'fitness')).toBe(true);

    await expect(
      port.createArea({ slug: 'contract-bay', labelEn: 'Contract Bay', city: 'Dubai' }),
    ).resolves.toEqual({ kind: 'completed' });
    await expect(
      port.createCategory({ slug: 'contract-category', labelEn: 'Contract Category' }),
    ).resolves.toEqual({ kind: 'completed' });
    let view = await loadView(port);
    const category = view.categories.find((entry) => entry.slug === 'contract-category')!;
    await expect(
      port.createActivityType({
        slug: 'contract-type',
        categoryId: category.id,
        labelEn: 'Contract Type',
        synonymsEn: ['contract sport'],
      }),
    ).resolves.toEqual({ kind: 'completed' });

    // CAS edit through the certified service; the stale writer loses
    // deterministically with no partial change.
    view = await loadView(port);
    const area = view.areas.find((entry) => entry.slug === 'contract-bay')!;
    await expect(
      port.updateArea(area.id, {
        expectedVersion: area.version,
        patch: { labelEn: 'Contract Bay East' },
      }),
    ).resolves.toEqual({ kind: 'completed' });
    await expect(
      port.updateArea(area.id, {
        expectedVersion: area.version, // now stale
        patch: { labelEn: 'Never Lands' },
      }),
    ).resolves.toEqual({ kind: 'staleVersion' });
    view = await loadView(port);
    expect(view.areas.find((entry) => entry.id === area.id)!.labelEn).toBe('Contract Bay East');

    // The stable identifier is unique per entity — a duplicate is the
    // typed conflict, and no update path can express a slug at all.
    await expect(
      port.createCategory({ slug: 'contract-category', labelEn: 'Duplicate' }),
    ).resolves.toEqual({ kind: 'slugConflict' });
    // A ghost parent is the typed invalidTaxonomy refusal.
    await expect(
      port.createActivityType({
        slug: 'ghost-parent-type',
        categoryId: newId(),
        labelEn: 'Ghost',
      }),
    ).resolves.toEqual({ kind: 'invalidTaxonomy' });
  });

  test('deactivation: existing listings keep truthful references, NEW provider selection is refused, the public read excludes the row', async () => {
    const ops = await provisionAdmin('operations');
    const port = await signedInPort(ops);
    const deps = { db: harness.testDb.db };

    await expect(
      port.createCategory({ slug: 'retiring-category', labelEn: 'Retiring Category' }),
    ).resolves.toEqual({ kind: 'completed' });
    let view = await loadView(port);
    const category = view.categories.find((entry) => entry.slug === 'retiring-category')!;
    await expect(
      port.createActivityType({
        slug: 'retiring-type',
        categoryId: category.id,
        labelEn: 'Retiring Type',
      }),
    ).resolves.toEqual({ kind: 'completed' });
    view = await loadView(port);
    const retiring = view.activityTypes.find((entry) => entry.slug === 'retiring-type')!;

    // An EXISTING listing selects the type while it is active — through
    // the certified provider service, never SQL shortcuts.
    const { orgId } = await createProviderOrg(harness.testDb.db, {
      state: 'live',
      displayName: 'Taxonomy Consumer Org',
      branches: 1,
    });
    const providerUserId = await createUser(harness.testDb.db);
    const scope: OrgScope = {
      organizationId: orgId,
      membershipId: newId(),
      role: 'owner',
      capabilities: capabilitiesForRole('owner'),
      branchScope: 'all',
      organizationState: 'live',
    };
    const created = await createProgram(deps, scope, { userId: providerUserId }, {
      titleEn: 'Existing Consumer Listing',
      activityTypeId: retiring.id,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    if (created.kind !== 'programCreated') throw new Error(created.kind);

    // Deactivate through the live admin port (the canonical service path).
    await expect(
      port.updateActivityType(retiring.id, {
        expectedVersion: retiring.version,
        patch: { active: false },
      }),
    ).resolves.toEqual({ kind: 'completed' });

    // The existing listing keeps its reference — and the provider read
    // represents the type truthfully as inactive, never a hole.
    const detail = await getProviderProgram(deps, scope, { programId: created.program.id });
    if (detail.kind !== 'programView') throw new Error(detail.kind);
    expect(detail.program.activityType.id).toBe(retiring.id);
    expect(detail.program.activityType.active).toBe(false);

    // A NEW provider listing can no longer select the inactive type — the
    // S4 server-side validation, not frontend filtering.
    const refused = await createProgram(deps, scope, { userId: providerUserId }, {
      titleEn: 'New Listing After Retirement',
      activityTypeId: retiring.id,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    expect(refused.kind).toBe('invalidTaxonomy');

    // The public taxonomy read excludes the inactive row (active rows only).
    const publicRead = await harness.fetchImpl(`${harness.apiBaseUrl}/catalogue/activity-types`, {
      method: 'GET',
    });
    const publicBody = (await publicRead.json()) as {
      activityTypes: Array<{ id: string }>;
    };
    expect(publicRead.status).toBe(200);
    expect(publicBody.activityTypes.some((entry) => entry.id === retiring.id)).toBe(false);

    // The ADMIN view keeps administering the inactive row — history is
    // never erased.
    view = await loadView(port);
    expect(view.activityTypes.find((entry) => entry.id === retiring.id)!.active).toBe(false);
  });

  test('audit/outbox happen exactly once per mutation through the canonical path, with ids-only payloads', async () => {
    const ops = await provisionAdmin('operations');
    const port = await signedInPort(ops);
    await expect(
      port.createArea({ slug: 'audited-bay', labelEn: 'Audited Bay' }),
    ).resolves.toEqual({ kind: 'completed' });
    const view = await loadView(port);
    const area = view.areas.find((entry) => entry.slug === 'audited-bay')!;
    await expect(
      port.updateArea(area.id, { expectedVersion: area.version, patch: { active: false } }),
    ).resolves.toEqual({ kind: 'completed' });

    const events = await harness.testDb.db
      .selectFrom('outbox_event')
      .select(['event_type', 'payload'])
      .where('aggregate_type', '=', 'taxonomy')
      .where('aggregate_id', '=', area.id)
      .execute();
    expect(events.map((event) => event.event_type)).toEqual([
      'taxonomy.area_changed',
      'taxonomy.area_changed',
    ]);
    for (const event of events) {
      expect(Object.keys(event.payload as Record<string, unknown>).sort()).toEqual([
        'areaId',
        'change',
      ]);
    }
    const audit = await harness.testDb.db
      .selectFrom('audit_event')
      .select(['id'])
      .where('action', '=', 'taxonomy.area_changed')
      .where('entity_id', '=', area.id)
      .execute();
    expect(audit.length).toBe(2);
  });

  test('an access_admin cannot read or manage taxonomy', async () => {
    const accessAdmin = await provisionAdmin('access_admin');
    const port = await signedInPort(accessAdmin);
    await expect(port.getTaxonomy()).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      port.createArea({ slug: 'denied-bay', labelEn: 'Denied Bay' }),
    ).resolves.toEqual({ kind: 'forbidden' });
  });
});
