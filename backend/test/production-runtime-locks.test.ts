/**
 * W6-1 — production runtime source locks (docs/37 §38; owner item 32): the
 * production composition graph structurally cannot reach dev identity, QA
 * actors, the deterministic payment provider, fixture composition, the
 * process-local security limiter, or a localhost fallback. Amendments to
 * this file belong to the owning W6 slice only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BACKEND = path.resolve(__dirname, '..');

function sourceOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), 'utf8');
}

describe('the production graph (start-api → production-runtime → build-app) is dev-free', () => {
  const productionGraph = ['scripts/start-api.ts', 'src/app/production-runtime.ts'];

  it('never imports the dev server, dev identity, QA/dev actors, fakes, or the deterministic payment provider', () => {
    for (const file of productionGraph) {
      const source = sourceOf(file);
      expect(source).not.toContain('dev-server');
      expect(source).not.toContain('DevPasswordIdentityProvider');
      expect(source).not.toContain('providers/dev/');
      expect(source).not.toContain('providers/fake/');
      expect(source).not.toContain('DeterministicPaymentProvider');
      expect(source).not.toContain('deterministic-provider');
      expect(source).not.toContain('dev-checkin-actor');
      expect(source).not.toContain('dev-fulfillment-actor');
      expect(source).not.toContain('dev-hosted-checkout');
      expect(source).not.toContain('fake-evidence-store');
      expect(source).not.toContain('InMemoryRateLimiterStore');
    }
  });

  it('carries no localhost/loopback fallback of any kind', () => {
    for (const file of productionGraph) {
      const source = sourceOf(file);
      expect(source).not.toMatch(/localhost|127\.0\.0\.1|0\.0\.0\.0/);
    }
  });

  it('composes the PostgreSQL rate-limit store and the canonical pool', () => {
    const bootstrap = sourceOf('src/app/production-runtime.ts');
    expect(bootstrap).toContain('PgRateLimiterStore');
    expect(bootstrap).toMatch(/import { createPool } from '..\/db\/pool'/);
    expect(bootstrap).not.toMatch(/new Pool\(/);
  });

  it('the payment seam goes through resolvePaymentProvider only — no driver construction, no mode fabrication', () => {
    const bootstrap = sourceOf('src/app/production-runtime.ts');
    expect(bootstrap).toContain('resolvePaymentProvider');
    expect(bootstrap).not.toContain('new StripeDriver');
    // The literal-false capability truth is untouched by W6-1 (re-pinned).
    const composition = sourceOf('src/modules/payment/provider-composition.ts');
    expect(composition).toMatch(/productionChargingPossible:\s*false/);
    expect(composition).toMatch(/productionChargingPossible: false;/);
  });

  it('the runtime config module never invents defaults for production public origins', () => {
    const config = sourceOf('src/config/runtime.ts');
    expect(config).not.toMatch(/successUrl:\s*'/);
    expect(config).toContain('must not point at a local address in production');
  });

  it('the dev server remains development-only (production refusal untouched)', () => {
    const devServer = sourceOf('scripts/dev-server.ts');
    expect(devServer).toContain("refuses to start in production");
  });

  it('the migration authority stays outside the API graph: start-api never imports or runs migrations', () => {
    const startApi = sourceOf('scripts/start-api.ts');
    expect(startApi).not.toContain('runMigrationsUp');
    expect(startApi).not.toContain('db/migrations');
    const bootstrap = sourceOf('src/app/production-runtime.ts');
    expect(bootstrap).not.toContain('runMigrationsUp');
  });
});

describe('W6-2: the worker graph (start-worker → worker-runtime) is equally dev-free and holds no authority', () => {
  const workerGraph = [
    'scripts/start-worker.ts',
    'src/worker/worker-runtime.ts',
    'src/worker/outbox-dispatcher.ts',
    'src/worker/search-projection-handler.ts',
    'src/worker/payment-processing.ts',
  ];

  it('never imports the dev server, dev identity, fakes, dev actors, the deterministic provider, or the in-memory limiter, and carries no localhost fallback', () => {
    for (const file of workerGraph) {
      const source = sourceOf(file);
      expect(source).not.toContain('dev-server');
      expect(source).not.toContain('DevPasswordIdentityProvider');
      expect(source).not.toContain('providers/dev/');
      expect(source).not.toContain('providers/fake/');
      expect(source).not.toContain('DeterministicPaymentProvider');
      expect(source).not.toContain('deterministic-provider');
      expect(source).not.toContain('dev-checkin-actor');
      expect(source).not.toContain('dev-hosted-checkout');
      expect(source).not.toContain('InMemoryRateLimiterStore');
      expect(source).not.toMatch(/localhost|127\.0\.0\.1|0\.0\.0\.0/);
    }
  });

  it('invokes certified authority only — no settlement/confirmation/commission logic, no Stripe driver, no migrations; the W6-3 sweeps live ONLY in scheduled-jobs.ts', () => {
    for (const file of workerGraph) {
      const source = sourceOf(file);
      expect(source).not.toContain('new StripeDriver');
      expect(source).not.toContain('runMigrationsUp');
      expect(source).not.toContain('confirmPaidBooking(');
      expect(source).not.toContain('confirmPaidEntitlementPurchase(');
      expect(source).not.toContain('computeCommissionSplit');
      expect(source).not.toContain('sweepLapsedPaidCheckouts');
      expect(source).not.toContain('sweepExpiredHolds');
      expect(source).not.toContain('reconcileLedgerAgainstProvider');
      expect(source).not.toContain('findStuckPaymentStates');
      expect(source).not.toMatch(/DELETE FROM/);
      expect(source).not.toContain('himma_maintenance');
    }
    const runtime = sourceOf('src/worker/worker-runtime.ts');
    expect(runtime).toContain('resolvePaymentProvider');
    expect(runtime).toContain("assertRuntimeDbIdentity(db, 'worker')");
    expect(runtime).toMatch(/import { createPool } from '..\/db\/pool'/);
  });
});

describe('W6-3: the scheduler graph is non-destructive and the maintenance graph is bounded', () => {
  const schedulerGraph = ['src/worker/scheduler.ts', 'src/worker/scheduled-jobs.ts', 'src/observability/alerts.ts'];
  const maintenanceGraph = ['scripts/start-maintenance.ts', 'src/maintenance/maintenance-runtime.ts'];

  it('scheduler/scheduled-jobs/alerts: dev-free, no DELETE, no maintenance authority, no settlement/commission logic, no Stripe driver, no migrations', () => {
    for (const file of schedulerGraph) {
      const source = sourceOf(file);
      expect(source).not.toContain('dev-server');
      expect(source).not.toContain('providers/dev/');
      expect(source).not.toContain('providers/fake/');
      expect(source).not.toContain('DeterministicPaymentProvider');
      expect(source).not.toContain('deterministic-provider');
      expect(source).not.toContain('InMemoryRateLimiterStore');
      expect(source).not.toMatch(/localhost|127\.0\.0\.1|0\.0\.0\.0/);
      expect(source).not.toMatch(/DELETE FROM/i);
      expect(source).not.toContain('himma_maintenance');
      expect(source).not.toContain('maintenance_prune');
      expect(source).not.toContain('new StripeDriver');
      expect(source).not.toContain('runMigrationsUp');
      expect(source).not.toContain('confirmPaidBooking(');
      expect(source).not.toContain('confirmPaidEntitlementPurchase(');
      expect(source).not.toContain('computeCommissionSplit');
      // Background correlation never touches the audit request seam.
      expect(source).not.toContain('runWithRequestContext');
      expect(source).not.toContain('appendAuditEvent');
    }
  });

  it('scheduled-jobs.ts calls exactly the certified services and nothing writes payment/booking state directly', () => {
    const source = sourceOf('src/worker/scheduled-jobs.ts');
    for (const service of [
      'sweepLapsedPaidCheckouts(',
      'reconcileLedgerAgainstProvider(',
      'findStuckPaymentStates(',
      'sweepExpiredHolds(',
      'processExpiredAssignments(',
      'expireDueStaffInvitations(',
    ]) {
      expect(source).toContain(service);
    }
    expect(source).not.toMatch(/UPDATE\s+(payment_intent|payment_attempt|booking|capacity_hold|entitlement)/i);
    expect(source).not.toMatch(/INSERT\s+INTO/i);
    expect(source).not.toContain('updateTable(');
    expect(source).not.toContain('insertInto(');
  });

  it('the maintenance graph holds no DELETE statement of its own (the bounded database functions are the only destructive authority), never composes payments/identity, and is dev-free', () => {
    for (const file of maintenanceGraph) {
      const source = sourceOf(file);
      expect(source).not.toMatch(/DELETE FROM/i);
      expect(source).not.toContain('deleteFrom(');
      expect(source).not.toContain('dev-server');
      expect(source).not.toContain('providers/dev/');
      expect(source).not.toContain('providers/fake/');
      expect(source).not.toContain('DeterministicPaymentProvider');
      expect(source).not.toContain('resolvePaymentProvider');
      expect(source).not.toContain('new StripeDriver');
      expect(source).not.toContain('runMigrationsUp');
      expect(source).not.toContain('confirmPaidBooking(');
      expect(source).not.toContain('computeCommissionSplit');
      expect(source).not.toContain('sweepLapsedPaidCheckouts');
      expect(source).not.toMatch(/localhost|127\.0\.0\.1|0\.0\.0\.0/);
    }
    const runtime = sourceOf('src/maintenance/maintenance-runtime.ts');
    expect(runtime).toContain("assertRuntimeDbIdentity(db, 'maintenance')");
    expect(runtime).toMatch(/import { createPool } from '..\/db\/pool'/);
    // Only the enumerated bounded functions are ever invoked.
    const invoked = [...runtime.matchAll(/maintenance_[a-z_]+/g)].map((m) => m[0]);
    expect(new Set(invoked)).toEqual(
      new Set([
        'maintenance_prune_rate_limit_windows',
        'maintenance_prune_redemption_lookup_attempts',
        'maintenance_prune_idempotency_keys',
        'maintenance_prune_published_outbox',
        'maintenance_prune_job_runs',
        'maintenance_unquarantine_outbox',
      ]),
    );
  });

  it('the payment capability truth is untouched by W6-3: productionChargingPossible stays the literal false and no live mode exists', () => {
    const composition = sourceOf('src/modules/payment/provider-composition.ts');
    expect(composition).toMatch(/productionChargingPossible:\s*false/);
    const config = sourceOf('src/config/runtime.ts');
    expect(config).toContain('There is no "live" value');
    expect(config).not.toMatch(/'live'\s*\|/);
  });
});
