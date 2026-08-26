/**
 * RI-1 — the composition-boundary source locks (docs/34 §7 RI-1; owner
 * item 16).
 *
 * 1. Screens/state NEVER import a mock implementation directly — every
 *    service arrives through `services/composition` (so later slices swap
 *    implementations in ONE place, and no screen can mix truths).
 * 2. The auth/account/participant contracts have NO mock implementation
 *    anywhere, and composition binds them to the real HTTP adapters — the
 *    running app cannot accidentally compose a fake authenticated state.
 * 3. No screen calls fetch/XHR directly — HTTP lives behind the client.
 */
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('composition boundary locks', () => {
  it('RI-2: the discovery family is REAL in composition — no discovery mock is imported or re-exported', () => {
    const composition = readFileSync(path.join(SRC, 'services', 'composition.ts'), 'utf8');
    // The six discovery contracts bind to the real HTTP implementations.
    expect(composition).toMatch(/catalogueService = createRealCatalogueService\(/);
    expect(composition).toMatch(/searchService = createRealSearchService\(/);
    expect(composition).toMatch(/detailsService = createRealDetailsService\(/);
    expect(composition).toMatch(/discoverFeedService = createRealDiscoverFeedService\(/);
    expect(composition).toMatch(/homeFeedService = createRealHomeFeedService\(/);
    expect(composition).toMatch(/mapService = createRealMapService\(/);
    // No discovery mock module is referenced by composition any more; the
    // ONLY remaining mock bindings are the RI-3 families (schedule/booking/
    // checkout) and the dev-QA fixture resolver.
    for (const forbidden of [
      'mock-catalogue-service',
      'mock-search-service',
      'mock-details-service',
      'mock-home-feed-service',
      'mock-discover-feed-service',
      'mock-map-service',
      'results-engine',
    ]) {
      expect(composition).not.toContain(forbidden);
    }
  });

  it('RI-3: the commerce family is REAL in composition — no booking/checkout mock is bound; the S6 boundary lives in the options composition', () => {
    const composition = readFileSync(path.join(SRC, 'services', 'composition.ts'), 'utf8');
    expect(composition).toMatch(/commerceApi = createCommerceApi\(httpClient\)/);
    expect(composition).toMatch(/bookingService = createRealBookingService\(/);
    for (const forbidden of ['mock-booking-service', 'mock-checkout-service']) {
      expect(composition).not.toContain(forbidden);
    }
    // The RI-2 pending boundary is retired; the S6 product boundary is the
    // options composition's non-purchasable rows (never a fake Session).
    expect(composition).not.toContain('BOOKING_INTEGRATION_PENDING');
    const realCommerce = readFileSync(
      path.join(SRC, 'services', 'api', 'real-commerce-services.ts'),
      'utf8',
    );
    expect(realCommerce).toMatch(/purchasable: false/);
  });

  it('RI-3: commission/economics can never enter Customer App models — and no customer payment-success authority exists', () => {
    // No frontend service/contract file may model Himma commission,
    // provider shares, or settlement economics (D-W5-7 privacy) — and no
    // code path may pretend browser return implies payment success.
    for (const dir of ['services', 'features', 'state']) {
      for (const file of sourceFiles(path.join(SRC, dir))) {
        const source = readFileSync(file, 'utf8');
        expect(source).not.toMatch(/commissionBps|commission_bps|providerShare|provider_share|rateBps|rate_bps/);
        expect(source).not.toMatch(/confirmPaidBooking|payment-success|paymentSucceeded/);
      }
    }
  });

  it('RI-2: fixture catalogue data never reaches discovery screens (presentation imagery excepted)', () => {
    // data/mock/catalogue exports the frozen fixture arrays; after RI-2 no
    // screen/state module may read them (the bundled demo IMAGES remain the
    // deterministic presentation layer and are allowed).
    const offenders: string[] = [];
    for (const dir of ['app', 'features', 'state', 'components']) {
      for (const file of sourceFiles(path.join(SRC, dir))) {
        const source = readFileSync(file, 'utf8');
        if (source.includes("'@/data/mock/catalogue'")) {
          offenders.push(path.relative(SRC, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no screen/state/app module imports a mock implementation directly', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'features', 'state', 'components', 'hooks', 'utils']) {
      for (const file of sourceFiles(path.join(SRC, dir))) {
        const source = readFileSync(file, 'utf8');
        if (source.includes("'@/services/mock/") || source.includes("'../services/mock/")) {
          offenders.push(path.relative(SRC, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('auth/account/participant services are REAL-ONLY: no mock implements them, and composition binds them to the HTTP adapters', () => {
    // No module in the mock layer may implement or export the identity
    // contracts.
    for (const file of sourceFiles(path.join(SRC, 'services', 'mock'))) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(
        /IdentityGateway|SessionApi|ParticipantApi|AuthSession|contracts\/identity/,
      );
    }
    // Composition wires the identity family from the real HTTP adapters.
    const composition = readFileSync(path.join(SRC, 'services', 'composition.ts'), 'utf8');
    expect(composition).toContain("from './api/identity-api'");
    expect(composition).toMatch(/identityGateway = createDevIdentityGateway\(httpClient\)/);
    expect(composition).toMatch(/sessionApi = createSessionApi\(httpClient\)/);
    expect(composition).toMatch(/participantApi = createParticipantApi\(httpClient\)/);
    // The auth session controller is composed from those same adapters.
    expect(composition).toMatch(/authSession = new AuthSession\(/);
  });

  it('screens never perform raw HTTP: fetch/XMLHttpRequest exist only inside the HTTP client', () => {
    for (const dir of ['app', 'features', 'state', 'components']) {
      for (const file of sourceFiles(path.join(SRC, dir))) {
        const source = readFileSync(file, 'utf8');
        expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|axios/);
      }
    }
  });

  it('no secret-shaped material is bundled into the app source', () => {
    for (const dir of ['app', 'features', 'state', 'components', 'services', 'data', 'utils']) {
      for (const file of sourceFiles(path.join(SRC, dir))) {
        const source = readFileSync(file, 'utf8');
        expect(source).not.toMatch(/sk_test|sk_live|whsec|aws_secret|api[_-]?key\s*[:=]\s*['"]/i);
      }
    }
  });
});
