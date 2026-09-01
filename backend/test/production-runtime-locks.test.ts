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
