import type { ApiJsonResponse } from '../src/api/client';
import type { LiveTransport } from '../src/auth/live/live-auth-runtime';
import { createLiveDomainPorts } from '../src/services/live/live-domain-ports';

/**
 * Live domain ports (W2-12B) — deterministic mapping coverage over a
 * stubbed transport: outcome-code translation, DTO validation fail-closed,
 * access-refresh notifications, and fixture isolation. The REAL backend
 * behavior behind the same ports is proven by the contract suite
 * (test-contract/domain-contract.test.ts on real PostgreSQL).
 */

interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
  authorized: boolean;
}

function makeTransport(
  respond: (call: RecordedCall) => { status: number; body?: unknown; code?: string } | 'network' | 'noSession',
) {
  const calls: RecordedCall[] = [];
  let accessChangedCount = 0;
  const toResponse = (
    result: { status: number; body?: unknown; code?: string },
  ): ApiJsonResponse => ({
    status: result.status,
    code: result.code ?? null,
    body:
      result.body ??
      (result.code !== undefined ? { code: result.code, message: 'refused' } : null),
    networkFailure: false,
  });
  const dispatch = (call: RecordedCall): ApiJsonResponse | null => {
    const result = respond(call);
    if (result === 'noSession') return null;
    if (result === 'network') {
      return { status: 0, code: null, body: null, networkFailure: true };
    }
    return toResponse(result);
  };
  const transport: LiveTransport = {
    async authorizedRequest(path, options = {}) {
      const call: RecordedCall = {
        path,
        method: options.method ?? 'GET',
        body: options.body,
        authorized: true,
      };
      calls.push(call);
      return dispatch(call);
    },
    async publicRequest(path) {
      const call: RecordedCall = { path, method: 'GET', body: undefined, authorized: false };
      calls.push(call);
      const result = dispatch(call);
      if (result === null) throw new Error('public requests never lack a session');
      return result;
    },
    notifyAccessChanged() {
      accessChangedCount += 1;
    },
  };
  return { transport, calls, accessChanged: () => accessChangedCount };
}

const ORG = '018f0000-0000-7000-8000-00000000b001';

const VIEW_BODY = {
  organization: {
    id: ORG,
    tradeName: 'Blue Wave Swimming LLC',
    legalName: 'Blue Wave Legal LLC',
    orgKind: 'company',
    verificationState: 'live',
    version: 3,
  },
  profile: {
    displayName: 'Blue Wave Swimming',
    descriptionEn: 'Swim school',
    descriptionAr: null,
    logoMediaRef: null,
    coverMediaRef: null,
    galleryMediaRefs: [],
    publicPhone: '+9714000000',
    publicEmail: null,
    publicWebsite: null,
    publicInstagram: null,
    published: true,
    version: 7,
  },
  branches: [
    {
      id: '018f0000-0000-7000-8000-00000000br01',
      label: 'Marina pool',
      addressLine: null,
      city: 'Dubai',
      areaLabel: 'Dubai Marina',
      geoPoint: null,
      openingHours: null,
      facilities: ['parking'],
      active: true,
      version: 1,
    },
  ],
  membership: {
    id: '018f0000-0000-7000-8000-00000000m001',
    role: 'owner',
    branchScope: 'all',
    capabilities: ['org.read', 'profile.edit', 'branch.create'],
  },
};

describe('organization view / profile port', () => {
  test('the real org-view DTO maps field-for-field', async () => {
    const { transport } = makeTransport(() => ({ status: 200, body: VIEW_BODY }));
    const { profilePort } = createLiveDomainPorts(transport);
    const outcome = await profilePort.loadOrganizationView(ORG);
    expect(outcome).toMatchObject({
      kind: 'loaded',
      view: {
        organization: { tradeName: 'Blue Wave Swimming LLC', legalName: 'Blue Wave Legal LLC' },
        profile: { displayName: 'Blue Wave Swimming', published: true, version: 7 },
        branches: [{ label: 'Marina pool', areaLabel: 'Dubai Marina', active: true }],
        membership: { role: 'owner', branchScope: 'all' },
      },
    });
  });

  test('a contract-violating view (unknown role) FAILS CLOSED — never partial truth, never fixture data', async () => {
    const broken = {
      ...VIEW_BODY,
      membership: { ...VIEW_BODY.membership, role: 'super_admin' },
    };
    const { transport } = makeTransport(() => ({ status: 200, body: broken }));
    const { profilePort } = createLiveDomainPorts(transport);
    await expect(profilePort.loadOrganizationView(ORG)).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  test('foreign/unknown organizations are the canonical not-found shape; outages are unavailable', async () => {
    const notFound = makeTransport(() => ({ status: 404, code: 'notFound' }));
    await expect(
      createLiveDomainPorts(notFound.transport).profilePort.loadOrganizationView(ORG),
    ).resolves.toEqual({ kind: 'notFound' });
    const outage = makeTransport(() => 'network');
    await expect(
      createLiveDomainPorts(outage.transport).profilePort.loadOrganizationView(ORG),
    ).resolves.toEqual({ kind: 'unavailable' });
    const signedOut = makeTransport(() => 'noSession');
    await expect(
      createLiveDomainPorts(signedOut.transport).profilePort.loadOrganizationView(ORG),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  test('profile PATCH carries expectedVersion + dirty fields; a displayName change re-resolves shell access', async () => {
    const { transport, calls, accessChanged } = makeTransport(() => ({
      status: 200,
      body: { status: 'profileUpdated', version: 8 },
    }));
    const { profilePort } = createLiveDomainPorts(transport);
    await expect(
      profilePort.updateProfile(ORG, 7, { displayName: 'New Name' }),
    ).resolves.toEqual({ kind: 'profileUpdated', version: 8 });
    expect(calls[0]).toMatchObject({
      path: `/provider/organizations/${ORG}/profile`,
      method: 'PATCH',
      body: { expectedVersion: 7, displayName: 'New Name' },
    });
    expect(accessChanged()).toBe(1);

    // A non-identity field does NOT trigger the access re-read.
    await profilePort.updateProfile(ORG, 8, { descriptionEn: 'Updated' });
    expect(accessChanged()).toBe(1);
  });

  test.each([
    ['staleVersion', 'staleVersion'],
    ['validationError', 'validationError'],
    ['organizationSuspended', 'organizationSuspended'],
    ['forbidden', 'forbidden'],
    ['notFound', 'notFound'],
  ])('profile PATCH %s maps to the existing W2-4 outcome', async (code, kind) => {
    const { transport } = makeTransport(() => ({ status: 409, code }));
    const { profilePort } = createLiveDomainPorts(transport);
    await expect(profilePort.updateProfile(ORG, 1, {})).resolves.toEqual({ kind });
  });
});

describe('onboarding port', () => {
  test('the snapshot is the documented composition over the org view; without catalogue.read the count is truthfully UNKNOWN and NO listings request fires', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 200, body: VIEW_BODY }));
    const { onboardingPort } = createLiveDomainPorts(transport);
    const outcome = await onboardingPort.loadSnapshot(ORG);
    expect(outcome).toEqual({
      kind: 'loaded',
      snapshot: {
        organization: {
          id: ORG,
          tradeName: 'Blue Wave Swimming LLC',
          verificationState: 'live',
          version: 3,
        },
        profile: { displayName: 'Blue Wave Swimming', published: true },
        branches: [
          { id: VIEW_BODY.branches[0]?.id, label: 'Marina pool', active: true },
        ],
        membership: {
          role: 'owner',
          capabilities: ['org.read', 'profile.edit', 'branch.create'],
        },
        listingCount: null,
      },
    });
    expect(calls.some((call) => call.path.includes('/listings'))).toBe(false);
  });

  test('W2-12D: with catalogue.read the REAL listing count rides the bounded authoritative page walk', async () => {
    const readerView = {
      ...VIEW_BODY,
      membership: { ...VIEW_BODY.membership, capabilities: ['org.read', 'catalogue.read'] },
    };
    const { transport, calls } = makeTransport((call) => {
      if (!call.path.includes('/listings')) return { status: 200, body: readerView };
      return call.path.includes('cursor=')
        ? { status: 200, body: { programs: [{}, {}], nextCursor: null } }
        : { status: 200, body: { programs: [{}, {}, {}], nextCursor: 'next-1' } };
    });
    const outcome = await createLiveDomainPorts(transport).onboardingPort.loadSnapshot(ORG);
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(outcome.snapshot.listingCount).toBe(5);
    expect(calls.filter((call) => call.path.includes('/listings'))).toHaveLength(2);
  });

  test('W2-12D: a failed count walk yields UNKNOWN (null) — the snapshot still loads and nothing is fabricated', async () => {
    const readerView = {
      ...VIEW_BODY,
      membership: { ...VIEW_BODY.membership, capabilities: ['org.read', 'catalogue.read'] },
    };
    const { transport } = makeTransport((call) =>
      call.path.includes('/listings')
        ? { status: 500, code: 'internalError' }
        : { status: 200, body: readerView },
    );
    const outcome = await createLiveDomainPorts(transport).onboardingPort.loadSnapshot(ORG);
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(outcome.snapshot.listingCount).toBeNull();
  });

  test('submission maps the real outcomes and a success re-resolves access (organizationState changed)', async () => {
    const ok = makeTransport(() => ({
      status: 200,
      body: { status: 'organizationSubmitted', version: 4 },
    }));
    const { onboardingPort } = createLiveDomainPorts(ok.transport);
    await expect(onboardingPort.submitForVerification(ORG, 3)).resolves.toEqual({
      kind: 'organizationSubmitted',
      version: 4,
    });
    expect(ok.accessChanged()).toBe(1);

    const incomplete = makeTransport(() => ({ status: 409, code: 'organizationIncomplete' }));
    await expect(
      createLiveDomainPorts(incomplete.transport).onboardingPort.submitForVerification(ORG, 3),
    ).resolves.toEqual({ kind: 'organizationIncomplete' });
    expect(incomplete.accessChanged()).toBe(0);
  });
});

describe('branch port', () => {
  test('create/update/deactivate ride the real routes with CAS and map the real branch DTO back', async () => {
    const branchBody = { status: 'branchCreated', branch: VIEW_BODY.branches[0] };
    const { transport, calls } = makeTransport(() => ({ status: 200, body: branchBody }));
    const { branchPort } = createLiveDomainPorts(transport);
    const created = await branchPort.createBranch(ORG, {
      label: 'Marina pool',
      areaLabel: 'Dubai Marina',
    });
    expect(created).toMatchObject({ kind: 'branchCreated', branch: { label: 'Marina pool' } });
    expect(calls[0]).toMatchObject({
      path: `/provider/organizations/${ORG}/branches`,
      method: 'POST',
    });

    const stale = makeTransport(() => ({ status: 409, code: 'staleVersion' }));
    await expect(
      createLiveDomainPorts(stale.transport).branchPort.updateBranch(ORG, 'branch-1', 2, {
        label: 'Renamed',
      }),
    ).resolves.toEqual({ kind: 'staleVersion' });

    const forbidden = makeTransport(() => ({ status: 403, code: 'forbidden' }));
    await expect(
      createLiveDomainPorts(forbidden.transport).branchPort.deactivateBranch(ORG, 'branch-1', 2),
    ).resolves.toEqual({ kind: 'forbidden' });
  });
});

describe('area read (the branch editor dependency)', () => {
  test('the public areas read maps and a malformed row fails closed', async () => {
    const good = makeTransport(() => ({
      status: 200,
      body: { areas: [{ id: 'a1', slug: 'marina', labelEn: 'Dubai Marina', labelAr: null, city: 'Dubai' }] },
    }));
    await expect(createLiveDomainPorts(good.transport).areaPort.listAreas()).resolves.toEqual({
      kind: 'loaded',
      areas: [{ id: 'a1', slug: 'marina', labelEn: 'Dubai Marina', labelAr: null, city: 'Dubai' }],
    });
    const bad = makeTransport(() => ({ status: 200, body: { areas: [{ id: 42 }] } }));
    await expect(createLiveDomainPorts(bad.transport).areaPort.listAreas()).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});

describe('team port', () => {
  const STAFF_BODY = {
    memberships: [
      {
        id: 'm1',
        userId: 'u1',
        role: 'listings_editor',
        branchScopeKind: 'all',
        branchIds: [],
        state: 'active',
        createdAt: '2026-08-01T08:00:00.000Z',
        version: 1,
      },
    ],
    invitations: [
      {
        id: 'i1',
        email: 'new@bluewave.test',
        role: 'coach',
        branchScopeKind: 'branches',
        branchIds: ['b1'],
        state: 'sent',
        expiresAt: '2026-09-01T08:00:00.000Z',
        version: 1,
      },
    ],
  };

  test('the composed staff read maps field-for-field; the wire branch-scope body shape is exact', async () => {
    const { transport, calls } = makeTransport((call) =>
      call.path.endsWith('/staff')
        ? { status: 200, body: STAFF_BODY }
        : {
            status: 200,
            body: {
              status: 'invitationIssued',
              invitationId: 'i2',
              expiresAt: '2026-09-01T08:00:00.000Z',
              mailDelivery: 'delivered',
            },
          },
    );
    const { teamPort } = createLiveDomainPorts(transport);
    await expect(teamPort.loadStaff(ORG)).resolves.toMatchObject({
      kind: 'loaded',
      staff: {
        memberships: [{ role: 'listings_editor', state: 'active' }],
        invitations: [{ email: 'new@bluewave.test', branchScopeKind: 'branches' }],
      },
    });

    await teamPort.issueInvitation(ORG, {
      email: 'scoped@bluewave.test',
      role: 'branch_manager',
      branchScope: ['b1', 'b2'],
    });
    const invite = calls.find((call) => call.path.endsWith('/staff/invitations'));
    expect(invite?.body).toEqual({
      email: 'scoped@bluewave.test',
      role: 'branch_manager',
      branchScope: { kind: 'branches', branchIds: ['b1', 'b2'] },
    });
  });

  test.each([
    ['stepUpRequired', 'stepUpRequired'],
    ['invalidBranchScope', 'invalidBranchScope'],
    ['forbidden', 'forbidden'],
  ])('invitation issue %s maps to the existing W2-6 outcome', async (code, kind) => {
    const { transport } = makeTransport(() => ({ status: 403, code }));
    await expect(
      createLiveDomainPorts(transport).teamPort.issueInvitation(ORG, {
        email: 'a@b.test',
        role: 'coach',
        branchScope: 'all',
      }),
    ).resolves.toEqual({ kind });
  });

  test('membership revocation re-resolves access (the seat may be the caller’s own); refusals do not', async () => {
    const ok = makeTransport(() => ({ status: 200, body: { status: 'membershipRevoked' } }));
    await expect(
      createLiveDomainPorts(ok.transport).teamPort.revokeMembership(ORG, 'm1', 1),
    ).resolves.toEqual({ kind: 'membershipRevoked' });
    expect(ok.accessChanged()).toBe(1);

    const protectedOwner = makeTransport(() => ({ status: 409, code: 'lastOwnerProtected' }));
    await expect(
      createLiveDomainPorts(protectedOwner.transport).teamPort.revokeMembership(ORG, 'm1', 1),
    ).resolves.toEqual({ kind: 'lastOwnerProtected' });
    expect(protectedOwner.accessChanged()).toBe(0);
  });
});

describe('invitation acceptance', () => {
  test('acceptance grants new access and re-resolves /provider/me; every refusal is the ONE canonical class', async () => {
    const ok = makeTransport(() => ({
      status: 200,
      body: { status: 'invitationAccepted', organizationId: ORG, membershipId: 'm9' },
    }));
    await expect(createLiveDomainPorts(ok.transport).invitationPort.accept('tok-123456789012')).resolves.toEqual({
      kind: 'invitationAccepted',
      organizationId: ORG,
      membershipId: 'm9',
    });
    expect(ok.accessChanged()).toBe(1);

    const refused = makeTransport(() => ({ status: 409, code: 'invitationInvalid' }));
    await expect(
      createLiveDomainPorts(refused.transport).invitationPort.accept('tok-123456789012'),
    ).resolves.toEqual({ kind: 'invitationInvalid' });
  });
});

describe('fixture isolation (task §22)', () => {
  test('the live domain module is structurally isolated from fixture data', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as { readFileSync: (p: string, e: string) => string };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as { join: (...parts: string[]) => string };
    const source = fs
      .readFileSync(path.join(__dirname, '..', 'src/services/live/live-domain-ports.ts'), 'utf8')
      // Comments may DOCUMENT the isolation; only code counts.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/services\/mock|fixture/i);
  });

  test('a failed live request yields the safe unavailable outcome — no fixture value can appear', async () => {
    const { transport } = makeTransport(() => ({ status: 500, code: 'internalError' }));
    const ports = createLiveDomainPorts(transport);
    await expect(ports.profilePort.loadOrganizationView(ORG)).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(ports.teamPort.loadStaff(ORG)).resolves.toEqual({ kind: 'unavailable' });
    await expect(ports.onboardingPort.loadSnapshot(ORG)).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});
