/**
 * RI-1 — the app's data-source COMPOSITION BOUNDARY (docs/34 §7 RI-1).
 *
 * Screens/state import every service from THIS module and never from an
 * implementation directly (source-locked). Two implementation families
 * exist behind it:
 *
 * - REAL HTTP (identity gateway · session · participants): the only
 *   implementations that exist for these contracts — the running app
 *   always uses the real backend for auth/account/participants. In dev
 *   the token-acquisition gateway targets the backend's /dev/identity
 *   Cognito stand-in; production sign-in (Cognito email/password + Apple
 *   + Google, D-RI-3) swaps ONLY that gateway here.
 *
 * - REAL HTTP (RI-2 — public discovery): catalogue, search, details,
 *   discover feed, home feed, and map bind to the real customer-public
 *   backend (guest-readable; no bearer on public reads). The discovery
 *   mocks remain for isolated tests ONLY.
 *
 * - DETERMINISTIC MOCKS (schedule/booking/checkout): still the approved
 *   mock-driven surfaces until RI-3 replaces each binding HERE. The
 *   BOOKING_INTEGRATION_PENDING boundary below keeps real discovery
 *   identities out of mock commerce — never mixed truth on one screen.
 */
import { createDevIdentityGateway, createParticipantApi, createSessionApi } from './api/identity-api';
import { createDiscoveryApi } from './api/discovery-api';
import {
  createRealCatalogueService,
  createRealDetailsService,
  createRealDiscoverFeedService,
  createRealHomeFeedService,
  createRealMapService,
  createRealSearchService,
} from './api/real-discovery-services';
import { createTaxonomyCache } from './api/taxonomy-cache';
import { apiBaseUrl } from './http/api-config';
import { createHttpClient } from './http/http-client';
import { tokenStorage } from './auth/token-storage';
import { AuthSession } from './auth/auth-session';

// Mock-backed contracts (replaced per-slice in RI-2/RI-3):
// Mock-backed contracts remaining (replaced by their slices):
// - schedule (RI-3/RI-5 real bookings/passes/calendar reads)
// - booking + checkout (RI-3 quote/hold/payment) — see the RI-3 pending
//   boundary below: real discovery identities never enter these mocks.
export { scheduleService } from './mock/mock-schedule-service';
export { bookingService } from './mock/mock-booking-service';
export { checkoutService } from './mock/mock-checkout-service';
// Shared presentation helper (pure derivation, not data):
export { providerMonogram } from '../utils/monogram';
// Dev-QA fixture resolver (account-context __DEV__ override only):
export { resolveAccountScenario } from './mock/mock-schedule-service';

/**
 * RI-3 pending boundary (owner RI-2 §18): discovery is REAL below, but the
 * booking family above is still the deterministic mock. Real canonical
 * program/session ids must NEVER cross into mock commerce — no mixed
 * commercial truth. Screens consult this flag: the booking entry preserves
 * the real selection context and states truthfully that booking is not
 * available yet, instead of fabricating a mock quote/hold/Booking.
 */
export const BOOKING_INTEGRATION_PENDING = true;

/** The current bearer — owned by AuthSession, read by the HTTP client. */
let currentAccessToken: string | null = null;

export const httpClient = createHttpClient({
  baseUrl: apiBaseUrl(),
  getAccessToken: () => currentAccessToken,
});

export const identityGateway = createDevIdentityGateway(httpClient);
export const sessionApi = createSessionApi(httpClient);
export const participantApi = createParticipantApi(httpClient);

export const authSession = new AuthSession({
  gateway: identityGateway,
  session: sessionApi,
  storage: tokenStorage,
  onAccessToken: (token) => {
    currentAccessToken = token;
  },
});

// ---------------------------------------------------------------------------
// RI-2 — REAL public discovery composition (docs/34 §1 matrix): the ONLY
// implementations bound for catalogue/search/details/discover/home/map.
// The deterministic discovery mocks remain for isolated tests exclusively
// (source-locked out of this module).
// ---------------------------------------------------------------------------
export const discoveryApi = createDiscoveryApi(httpClient);
export const taxonomyCache = createTaxonomyCache(discoveryApi);
export const catalogueService = createRealCatalogueService(discoveryApi, taxonomyCache);
export const searchService = createRealSearchService(discoveryApi, taxonomyCache);
export const detailsService = createRealDetailsService(discoveryApi);
export const discoverFeedService = createRealDiscoverFeedService(discoveryApi, taxonomyCache);
export const homeFeedService = createRealHomeFeedService(discoveryApi, taxonomyCache);
export const mapService = createRealMapService(discoveryApi, taxonomyCache);

/**
 * D-RI-3 operational record: Sign in with Apple and Google sign-in reuse
 * the certified identity architecture (provider kinds `apple`/`google`
 * are first-class in the backend evidence model) but REQUIRE genuine
 * provider/app configuration (Apple capability + services id, Google
 * OAuth client, real Cognito pool federation). None exists yet, so the
 * boundary stays FAIL-CLOSED: no gateway method is exposed and the UI
 * presents the options as unavailable — social-login success is never
 * simulated.
 */
export const SOCIAL_SIGN_IN_AVAILABLE = { apple: false, google: false } as const;
