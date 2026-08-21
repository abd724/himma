/**
 * W4 Slice 5 · S5-4 — provider scheduling/capacity HTTP surface (docs/32
 * §11). Real PostgreSQL + Fastify injection: the S5-4 capability
 * activation lock, the role × route matrix, cross-org not-found shaping,
 * customer/admin credential refusal, counter-input inexpressibility (no
 * contract field for held/booked counts exists; Ajv strips smuggled ones
 * before any handler and the domain values never move), the typed
 * capacity-floor refusal with structured impact, idempotent generation
 * through the wire, and the PII-lean roster projection.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import {
  ACTIVE_PROVIDER_CAPABILITIES,
  RESERVED_PROVIDER_CAPABILITIES,
  capabilitiesForRole,
} from '../src/modules/provider/provider-capabilities';
import { PROVIDER_ROLES } from '../src/modules/provider/provider-roles';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import {
  createBookingFixture,
  createContender,
  type BookingFixture,
} from './helpers/booking-fixtures';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/booking-provider-routes-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let fA: BookingFixture;
let fB: BookingFixture;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  const verifier = new FakeAccessTokenVerifier();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
  });
  await app.ready();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
  fA = await createBookingFixture(testDb.db);
  fB = await createBookingFixture(testDb.db);
  // A second orgA branch for branch-scope refusal proofs.
  const secondBranch = newId();
  await sql`INSERT INTO branch (id, organization_id, label, area_label)
            VALUES (${secondBranch}, ${fA.org.orgId}, 'Branch 2', 'Area')`.execute(testDb.db);
  fA.org.branchIds.push(secondBranch);
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function inject(method: 'GET' | 'POST' | 'PATCH', url: string, bearer: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function scheduleBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    weekdays: [1, 3],
    startTime: '16:00',
    endTime: '17:00',
    effectiveStart: '2026-09-01',
    ...extra,
  };
}

function sessionBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'session',
    programId: fA.programId,
    branchId: fA.org.branchIds[0],
    capacity: 5,
    startAt: '2026-09-10T08:00:00.000Z',
    endAt: '2026-09-10T09:00:00.000Z',
    ...extra,
  };
}

describe('S5-4 capability activation lock (the docs/27 §6 registry ruling)', () => {
  it('activates exactly schedules.manage · capacity.manage · bookings.view on the approved roles; sessions.manage and coach roster.view stay reserved', () => {
    for (const activated of ['schedules.manage', 'capacity.manage', 'bookings.view'] as const) {
      expect(ACTIVE_PROVIDER_CAPABILITIES as readonly string[]).toContain(activated);
      expect(RESERVED_PROVIDER_CAPABILITIES as readonly string[]).not.toContain(activated);
    }
    const expected: Record<string, readonly string[]> = {
      owner: ['schedules.manage', 'capacity.manage', 'bookings.view'],
      org_manager: ['schedules.manage', 'capacity.manage', 'bookings.view'],
      branch_manager: ['schedules.manage', 'capacity.manage', 'bookings.view'],
      listings_editor: ['schedules.manage'],
      coach: [],
      front_desk: ['bookings.view'],
      finance: [],
    };
    for (const role of PROVIDER_ROLES) {
      const granted = capabilitiesForRole(role).filter((capability) =>
        ['schedules.manage', 'capacity.manage', 'bookings.view'].includes(capability),
      );
      expect([...granted].sort()).toEqual([...expected[role]!].sort());
    }
    expect(RESERVED_PROVIDER_CAPABILITIES as readonly string[]).toContain('sessions.manage');
    expect(RESERVED_PROVIDER_CAPABILITIES as readonly string[]).toContain('roster.view');
  });
});

describe('role × route authorization matrix', () => {
  it('schedule creation follows schedules.manage; unit creation follows capacity.manage; roster follows bookings.view — frontend-hidden buttons are not authority', async () => {
    const results: Record<string, Record<string, number>> = {};
    for (const role of PROVIDER_ROLES) {
      const staff = await staffBearer(ctx, fA.org.orgId, role);
      const schedule = await inject(
        'POST',
        `/provider/organizations/${fA.org.orgId}/programs/${fA.programId}/schedules`,
        staff.bearer,
        scheduleBody(),
      );
      const unit = await inject(
        'POST',
        `/provider/organizations/${fA.org.orgId}/units`,
        staff.bearer,
        sessionBody(),
      );
      const roster = await inject(
        'GET',
        `/provider/organizations/${fA.org.orgId}/units/session/${newId()}/roster`,
        staff.bearer,
      );
      results[role] = {
        schedule: schedule.statusCode,
        unit: unit.statusCode,
        roster: roster.statusCode,
      };
    }
    expect(results).toEqual({
      owner: { schedule: 201, unit: 201, roster: 404 }, // 404 = unknown unit, authorized
      org_manager: { schedule: 201, unit: 201, roster: 404 },
      branch_manager: { schedule: 201, unit: 201, roster: 404 },
      listings_editor: { schedule: 201, unit: 403, roster: 403 },
      coach: { schedule: 403, unit: 403, roster: 403 },
      front_desk: { schedule: 403, unit: 403, roster: 404 },
      finance: { schedule: 403, unit: 403, roster: 403 },
    });
  });

  it('cross-organization access is not-found-shaped; customer and admin credentials never satisfy the provider surface', async () => {
    const aOwner = await staffBearer(ctx, fA.org.orgId, 'owner');
    const cross = await inject(
      'GET',
      `/provider/organizations/${fB.org.orgId}/programs/${fB.programId}/schedules`,
      aOwner.bearer,
    );
    const ghost = await inject(
      'GET',
      `/provider/organizations/${newId()}/programs/${fB.programId}/schedules`,
      aOwner.bearer,
    );
    expect(cross.statusCode).toBe(404);
    expect(cross.body).toBe(ghost.body);

    // A pure customer (no membership anywhere) is refused identically.
    const { bearer: customerBearer } = await bearerForUser(ctx, await createUser(testDb.db));
    expect(
      (
        await inject(
          'GET',
          `/provider/organizations/${fA.org.orgId}/programs/${fA.programId}/schedules`,
          customerBearer,
        )
      ).statusCode,
    ).toBe(404);
    // Admin roles never satisfy the provider surface.
    const { adminA } = await bootstrapAccessAdmins(testDb.db);
    const { bearer: adminBearer } = await bearerForUser(ctx, adminA);
    expect(
      (
        await inject(
          'POST',
          `/provider/organizations/${fA.org.orgId}/units`,
          adminBearer,
          sessionBody(),
        )
      ).statusCode,
    ).toBe(404);
  });

  it('branch-scoped staff cannot generate into or mutate out-of-scope branches', async () => {
    const scoped = await staffBearer(ctx, fA.org.orgId, 'branch_manager', {
      scopeBranchIds: [fA.org.branchIds[0]!],
    });
    // Unit creation on an out-of-scope branch of the SAME org → forbidden.
    const foreignBranch = await inject(
      'POST',
      `/provider/organizations/${fA.org.orgId}/units`,
      scoped.bearer,
      sessionBody({ branchId: fB.org.branchIds[0] }), // other org's branch: invalid anyway
    );
    expect([403, 404, 422]).toContain(foreignBranch.statusCode);
    const secondBranch = await inject(
      'POST',
      `/provider/organizations/${fA.org.orgId}/units`,
      scoped.bearer,
      sessionBody({ branchId: fA.org.branchIds[1] }),
    );
    expect(secondBranch.statusCode).toBe(403);
    // In-scope branch works.
    const inScope = await inject(
      'POST',
      `/provider/organizations/${fA.org.orgId}/units`,
      scoped.bearer,
      sessionBody(),
    );
    expect(inScope.statusCode).toBe(201);
  });
});

describe('counters are DOMAIN authority — never provider input', () => {
  it('heldCount/bookedCount/state are INEXPRESSIBLE in every body: the app-wide Ajv strips undeclared properties before the handler and no contract field exists for them — counters and lifecycle never move', async () => {
    const staff = await staffBearer(ctx, fA.org.orgId, 'owner');
    const created = await inject(
      'POST',
      `/provider/organizations/${fA.org.orgId}/units`,
      staff.bearer,
      sessionBody(),
    );
    expect(created.statusCode).toBe(201);
    const unit = created.json().unit;
    let version = unit.version as number;
    for (const smuggled of [
      { heldCount: 7 },
      { bookedCount: 7 },
      { held_count: 7 },
      { booked_count: 7 },
      { state: 'closed' },
    ]) {
      const patch = await inject(
        'PATCH',
        `/provider/organizations/${fA.org.orgId}/units/session/${unit.id}`,
        staff.bearer,
        { expectedVersion: version, ...smuggled },
      );
      // The smuggled field is discarded before the handler (repo-wide
      // convention, catalogue precedent): the request degenerates into a
      // no-field config edit and the DOMAIN values never move.
      expect(patch.statusCode).toBe(200);
      version = patch.json().unit.version;
    }
    const row = await sql<{ held_count: number; booked_count: number; state: string }>`
      SELECT held_count, booked_count, state FROM session WHERE id = ${unit.id}`.execute(
      testDb.db,
    );
    expect(row.rows[0]).toEqual({ held_count: 0, booked_count: 0, state: 'open' });
  });

  it('the capacity floor refuses typed over the wire with structured impact counts', async () => {
    const staff = await staffBearer(ctx, fA.org.orgId, 'owner');
    const created = await inject(
      'POST',
      `/provider/organizations/${fA.org.orgId}/units`,
      staff.bearer,
      sessionBody({ capacity: 2 }),
    );
    const unit = created.json().unit;
    const unitRef = { kind: 'session' as const, id: unit.id as string };
    // Two customer holds through the certified claim path.
    for (let i = 0; i < 2; i += 1) {
      const c = await createContender(fA, unitRef);
      const run = await claimHold({ db: testDb.db }, { accountId: c.accountId }, {
        unit: unitRef,
        participantId: c.participantId,
        quoteId: c.quoteId,
        idempotencyKey: newId(),
      });
      expect(run.outcome.kind).toBe('holdClaimed');
    }
    const below = await inject(
      'PATCH',
      `/provider/organizations/${fA.org.orgId}/units/session/${unit.id}`,
      staff.bearer,
      { expectedVersion: unit.version + 2, capacity: 1 },
    );
    expect(below.statusCode).toBe(409);
    expect(below.json()).toMatchObject({
      code: 'capacityBelowCommitments',
      bookedCount: 0,
      heldCount: 2,
      floor: 2,
    });
  });
});

describe('generation + roster through the wire', () => {
  it('generates deterministically and idempotently; repeats create nothing new', async () => {
    const staff = await staffBearer(ctx, fA.org.orgId, 'owner');
    const schedule = await inject(
      'POST',
      `/provider/organizations/${fA.org.orgId}/programs/${fA.programId}/schedules`,
      staff.bearer,
      scheduleBody({ weekdays: [2, 4] }),
    );
    const scheduleId = schedule.json().schedule.id;
    const url = `/provider/organizations/${fA.org.orgId}/schedules/${scheduleId}/generate-sessions`;
    const body = {
      branchId: fA.org.branchIds[0],
      capacity: 6,
      fromDate: '2026-11-02',
      toDate: '2026-11-08',
    };
    const first = await inject('POST', url, staff.bearer, body);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ created: 2, alreadyExisted: 0 }); // Tue 3rd + Thu 5th
    const second = await inject('POST', url, staff.bearer, body);
    expect(second.json()).toMatchObject({ created: 0, alreadyExisted: 2 });

    // The generated units are listable with authoritative occupancy fields.
    const units = await inject(
      'GET',
      `/provider/organizations/${fA.org.orgId}/programs/${fA.programId}/units?kind=session`,
      staff.bearer,
    );
    expect(units.statusCode).toBe(200);
    const generated = units
      .json()
      .units.filter((unit: { scheduleId: string | null }) => unit.scheduleId === scheduleId);
    expect(generated).toHaveLength(2);
    expect(generated[0]).toMatchObject({ capacity: 6, bookedCount: 0, heldCount: 0, state: 'open' });
  });

  it('front desk reads the roster (bookings.view) but cannot mutate anything', async () => {
    const owner = await staffBearer(ctx, fA.org.orgId, 'owner');
    const created = await inject(
      'POST',
      `/provider/organizations/${fA.org.orgId}/units`,
      owner.bearer,
      sessionBody(),
    );
    const unit = created.json().unit;
    const frontDesk = await staffBearer(ctx, fA.org.orgId, 'front_desk');
    const roster = await inject(
      'GET',
      `/provider/organizations/${fA.org.orgId}/units/session/${unit.id}/roster`,
      frontDesk.bearer,
    );
    expect(roster.statusCode).toBe(200);
    expect(roster.json()).toEqual({ unit: expect.anything(), entries: [] });
    const mutate = await inject(
      'PATCH',
      `/provider/organizations/${fA.org.orgId}/units/session/${unit.id}`,
      frontDesk.bearer,
      { expectedVersion: unit.version, capacity: 9 },
    );
    expect(mutate.statusCode).toBe(403);
  });
});

