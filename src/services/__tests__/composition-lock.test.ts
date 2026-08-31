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

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

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
    // The RI-2 pending boundary is retired; since RI-4 the S6 product
    // boundary itself is retired — packages/memberships ride the REAL
    // acquisition trail (asserted in the RI-4 lock below).
    expect(composition).not.toContain('BOOKING_INTEGRATION_PENDING');
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

  it('RI-4: the Passes/entitlements family is REAL-ONLY — composition binds the HTTP adapter, no mock implements it, and the acquisition trail is never a Booking hack', () => {
    const composition = readFileSync(path.join(SRC, 'services', 'composition.ts'), 'utf8');
    expect(composition).toMatch(/entitlementsApi = createEntitlementsApi\(httpClient\)/);
    // The options composition routes package/membership through the S6
    // acquisition trail — the RI-3 'Coming soon' boundary is retired and
    // no package is ever forced into a capacity Booking.
    const realCommerce = readFileSync(
      path.join(SRC, 'services', 'api', 'real-commerce-services.ts'),
      'utf8',
    );
    expect(stripComments(realCommerce)).not.toContain('Coming soon');
    expect(realCommerce).toMatch(/commercial: 'entitlementAcquisition'/);
    // No mock module implements the entitlements/check-in contracts.
    for (const file of sourceFiles(path.join(SRC, 'services', 'mock'))) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/EntitlementsApi|contracts\/entitlements|credential|checkIn/);
    }
  });

  it('RI-4: credential secrets never persist or log — the check-in/passes features touch NO storage and the store is memory-only', () => {
    for (const dir of [
      path.join(SRC, 'features', 'checkin'),
      path.join(SRC, 'features', 'passes'),
    ]) {
      for (const file of sourceFiles(dir)) {
        // Doc comments legitimately RECORD the prohibitions — lock the
        // executable source only (the slice-closeout precedent).
        const source = stripComments(readFileSync(file, 'utf8'));
        expect(source).not.toMatch(/AsyncStorage|SecureStore|localStorage|sessionStorage/);
        expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
        expect(source).not.toMatch(/analytics|Sentry|crashlytics/i);
      }
    }
    // The display code never rides a route/URL (hrefs carry identifiers
    // only — asserted behaviorally in checkin.test.ts, structurally here).
    const entry = readFileSync(
      path.join(SRC, 'features', 'checkin', 'checkin-entry.ts'),
      'utf8',
    );
    expect(entry).not.toMatch(/displayCode.*params\.set|params\.set.*displayCode/);
  });

  it('RI-4 correction: calendar event keys are OPAQUE — no app code parses them for occurrence authority; the explicit server DTO is the only source', () => {
    // The canonical occurrence pair arrives as the backend's explicit
    // `occurrence` field and is passed to credential issuance verbatim.
    // Event keys serve rendering identity/deduplication ONLY: no module
    // may dissect one (split/match/regex on the `booking:<id>:<date>:<time>`
    // encoding) to reconstruct dates or times.
    for (const dir of ['app', 'features', 'state', 'services', 'components']) {
      for (const file of sourceFiles(path.join(SRC, dir))) {
        const source = stripComments(readFileSync(file, 'utf8'));
        expect(source).not.toMatch(/eventKey\.(split|match|slice|substring|replace|exec)/);
        expect(source).not.toMatch(/exec\(\s*[a-zA-Z_.]*eventKey/);
        expect(source).not.toMatch(/\^booking:|booking:\(|new RegExp\([^)]*booking/);
        expect(source).not.toMatch(/parseOccurrenceKey/);
      }
    }
    // The occurrence-select surface consumes the explicit DTO field.
    const presentation = readFileSync(
      path.join(SRC, 'features', 'passes', 'passes-presentation.ts'),
      'utf8',
    );
    expect(presentation).toMatch(/event\.occurrence\.date/);
    expect(presentation).toMatch(/event\.occurrence\.startTime/);
  });

  it('RI-4: no client-authored balances, no manual consumption', () => {
    // Balances arrive from the server: no feature/state module computes
    // remaining/available counts by arithmetic on the entitlement truths.
    for (const dir of ['features', 'state', 'app']) {
      for (const file of sourceFiles(path.join(SRC, dir))) {
        const source = readFileSync(file, 'utf8');
        expect(source).not.toMatch(/usesTotal\s*-|-\s*reservedUpcoming|remaining\s*-\s*1|used\s*\+\s*1/);
        // No manual consumption affordance exists anywhere (owner §30).
        expect(source).not.toMatch(/markAttended|useOneCredit|decrementVisits|manualCheckIn/);
      }
    }
    // RI-5 (owning-slice amendment of the RI-4 no-Calendar-UI lock): the
    // unified Calendar now EXISTS, and the bounded server read has exactly
    // the certified consumer set — the Calendar surface, Home's account
    // derivation source, and RI-4 check-in occurrence selection. Nothing
    // else may issue calendar reads (no scattered fetching, no competing
    // client-side aggregation of bookings/passes/recurrences).
    const occurrenceConsumers: string[] = [];
    for (const dir of ['app', 'features', 'state', 'components']) {
      for (const file of sourceFiles(path.join(SRC, dir))) {
        const source = readFileSync(file, 'utf8');
        if (source.includes('listOccurrences')) {
          occurrenceConsumers.push(path.relative(SRC, file));
        }
      }
    }
    expect(occurrenceConsumers.sort()).toEqual([
      path.join('features', 'calendar', 'calendar-view.tsx'),
      path.join('features', 'checkin', 'occurrence-select-screen.tsx'),
      path.join('state', 'account-context.tsx'),
    ]);
  });

  it('RI-5: the Calendar is real, read-only, and never a second aggregation authority', () => {
    // The Calendar surface consumes the composition-bound entitlements
    // adapter (the certified bounded server Calendar read; the wire path
    // itself is named ONLY inside that adapter) — no mock exists for it
    // anywhere (the RI-4 mock-layer lock above already bans the contracts
    // from services/mock; pin the binding here too).
    const view = readFileSync(
      path.join(SRC, 'features', 'calendar', 'calendar-view.tsx'),
      'utf8',
    );
    expect(view).toContain("from '@/services/composition'");
    expect(view).toContain('entitlementsApi.listOccurrences');
    // Read-only: the calendar feature performs NO mutation and duplicates
    // no credential/reservation authority (owner items 14–15 — one
    // check-in and one reservation implementation stay canonical).
    for (const file of sourceFiles(path.join(SRC, 'features', 'calendar'))) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(source).not.toMatch(
        /issueBookingCredential|issueEntitlementCredential|credentialStatus|confirmReservation|requestReservationQuote|confirmFreeAcquisition|initiateAcquisition|claimHold/,
      );
      expect(source).not.toMatch(/commerceApi|displayCode/);
    }
    // The backend Calendar projection is the ONE aggregation authority: no
    // app module expands recurrence rules, generates occurrence dates from
    // camp spans, or fabricates calendar events (the server list renders
    // verbatim; a flexible pass with no reservation has no dates to show).
    for (const dir of ['app', 'features', 'state', 'components']) {
      for (const file of sourceFiles(path.join(SRC, dir))) {
        const source = stripComments(readFileSync(file, 'utf8'));
        expect(source).not.toMatch(/rrule|byweekday|exceptionDates|exception_dates/i);
        // No module constructs a calendar event object (server data only —
        // the opaque key cannot be minted client-side).
        expect(source).not.toMatch(/eventKey\s*:\s*[`'"]/);
        // Camp spans are presentation metadata, never a date generator.
        expect(source).not.toMatch(/span\.(startDate|endDate)[^)]*(for|while|\.map)\s*\(/);
      }
    }
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
