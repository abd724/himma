/**
 * Slice 6 closeout audit — the S6-3 structural/source locks (owner items
 * 42, 47; the S5-6/W5-6 closeout pattern).
 *
 * Pins, at closure of the Fulfillment/Entitlements/Attendance slice:
 * `confirmEntitlementReservation` reachable ONLY through the authenticated
 * customer reservation route · the reservation path free of every payment
 * import/vocabulary · the calendar a DERIVED read with no persistence of
 * its own · no mutable usage-counter authority anywhere in the entitlement
 * schema · attendance append-only · the W5 paid-confirmation seams still
 * HTTP-unreachable and `productionChargingPossible` still the literal
 * false · and NO S6-3 frontend (Customer App / Provider Portal / Admin)
 * surface in existence.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { createMigratedTestDb, type TestDb } from './helpers/test-db';

let testDb: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: new FakeAccessTokenVerifier(),
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function walkTs(dir: string, visit: (file: string, source: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.expo' || entry === 'dist') continue;
      walkTs(full, visit);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      visit(full, readFileSync(full, 'utf8'));
    }
  }
}

const BACKEND_SRC = path.resolve(__dirname, '..', 'src');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('reservation authority reachability (item 42)', () => {
  it('confirmEntitlementReservation is imported ONLY by the customer reservation routes; no provider/admin/public route touches reservations', () => {
    const importers: string[] = [];
    walkTs(BACKEND_SRC, (file, source) => {
      if (
        /import\s+[^;]*\bconfirmEntitlementReservation\b/.test(source) &&
        !file.endsWith('entitlement-reservation.ts')
      ) {
        importers.push(path.relative(BACKEND_SRC, file));
      }
    });
    expect(importers).toEqual([
      path.join('modules', 'entitlement', 'http', 'reservation-customer-routes.ts'),
    ]);

    const reservationRoutes = app.routePolicyInventory
      .filter((route) => route.method !== 'HEAD')
      .filter((route) => /reservation/i.test(route.url))
      .map((route) => `${route.method} ${route.url} → ${route.policy}`)
      .sort();
    expect(reservationRoutes).toEqual([
      'POST /customer/entitlement-reservations/confirm → authenticatedCustomer',
      'POST /customer/entitlements/:entitlementId/reservation-quote → authenticatedCustomer',
    ]);
    // The calendar exists exactly once, customer-only.
    const calendarRoutes = app.routePolicyInventory
      .filter((route) => route.method !== 'HEAD')
      .filter((route) => /calendar/i.test(route.url));
    expect(calendarRoutes.map((route) => `${route.method} ${route.url} → ${route.policy}`)).toEqual([
      'GET /customer/calendar → authenticatedCustomer',
    ]);
  });

  it('the reservation/read services import NOTHING from the payment module and carry no payment vocabulary', () => {
    for (const file of [
      path.join(BACKEND_SRC, 'modules', 'entitlement', 'services', 'entitlement-reservation.ts'),
      path.join(BACKEND_SRC, 'modules', 'entitlement', 'services', 'entitlement-read.ts'),
      path.join(BACKEND_SRC, 'modules', 'entitlement', 'http', 'reservation-customer-routes.ts'),
    ]) {
      // Doc comments legitimately RECORD the absences — strip them and
      // lock the executable source only.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source).not.toMatch(/modules\/payment/);
      expect(source).not.toMatch(/PaymentIntent|payment_intent|stripe|commission|payable/i);
    }
  });
});

describe('derived truth only (items 20, 42)', () => {
  it('no calendar persistence exists anywhere in the schema, and the read service performs no writes', async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name ILIKE '%calendar%' OR table_name ILIKE '%occurrence%'
             OR table_name ILIKE '%event_feed%')`.execute(testDb.db);
    expect(tables.rows).toEqual([]);
    const readSource = readFileSync(
      path.join(BACKEND_SRC, 'modules', 'entitlement', 'services', 'entitlement-read.ts'),
      'utf8',
    );
    expect(readSource).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM|insertInto|updateTable|deleteFrom/);
  });

  it('no mutable usage-counter authority exists: the entitlement/reservation/attendance tables carry no used/consumed counter column', async () => {
    const columns = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('entitlement', 'entitlement_reservation', 'attendance_record')
        AND (column_name ILIKE '%used%' OR column_name ILIKE '%consumed%'
             OR column_name ILIKE '%remaining%' OR column_name ILIKE '%available%')`.execute(
      testDb.db,
    );
    expect(columns.rows).toEqual([]);
    // Attendance stays append-only (the forbid-mutation trigger).
    const trigger = await sql<{ n: string }>`
      SELECT count(*) AS n FROM information_schema.triggers
      WHERE event_object_table = 'attendance_record'
        AND action_statement ILIKE '%forbid_mutation%'`.execute(testDb.db);
    expect(Number(trigger.rows[0]!.n)).toBeGreaterThan(0);
  });
});

describe('payment/production gates unchanged (items 28, 42)', () => {
  it('both trusted paid-confirmation seams remain HTTP-unreachable and productionChargingPossible remains the literal false', () => {
    const offenders: string[] = [];
    walkTs(path.join(BACKEND_SRC, 'modules'), (file, source) => {
      const relative = path.relative(BACKEND_SRC, file);
      const isHttp = relative.includes(`http${path.sep}`);
      if (
        isHttp &&
        /import\s+[^;]*\b(confirmPaidBooking|confirmPaidEntitlementPurchase)\b/.test(source)
      ) {
        offenders.push(relative);
      }
    });
    expect(offenders).toEqual([]);
    const composition = readFileSync(
      path.join(BACKEND_SRC, 'modules', 'payment', 'provider-composition.ts'),
      'utf8',
    );
    expect(composition).toMatch(/productionChargingPossible:\s*false/);
  });
});

describe('S6-3 frontend consumption boundary (items 38–40, 42; amended at RI-4 — the owning-slice pattern)', () => {
  it('the Customer App consumes the S6-3 surfaces ONLY through its composition-bound adapter; Provider Portal and Admin reference NONE', () => {
    const forbidden =
      /entitlement-reservations|reservable-sessions|customer\/calendar|reservation-quote/;
    // RI-4 (owner-authorized): the Customer App's REAL integration — the
    // customer wire lives exclusively in the one HTTP adapter (+ its unit
    // test); screens reach it through services/composition only.
    const appOffenders: string[] = [];
    walkTs(path.join(REPO_ROOT, 'src'), (file, source) => {
      if (forbidden.test(source)) appOffenders.push(path.relative(REPO_ROOT, file));
    });
    expect(appOffenders.sort()).toEqual([
      path.join('src', 'services', '__tests__', 'entitlements-api.test.ts'),
      path.join('src', 'services', 'api', 'entitlements-api.ts'),
    ]);
    // Provider Portal and Admin remain locked out of the CUSTOMER surface.
    for (const root of [path.join(REPO_ROOT, 'portal', 'src'), path.join(REPO_ROOT, 'admin', 'src')]) {
      const offenders: string[] = [];
      walkTs(root, (file, source) => {
        if (forbidden.test(source)) offenders.push(path.relative(REPO_ROOT, file));
      });
      expect(offenders).toEqual([]);
    }
  });
});
