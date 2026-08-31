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
 * - REAL HTTP (RI-3 — commerce): quote/hold/free-confirm/paid-initiate/
 *   payment-status/own-bookings and the real booking-options composition.
 *   The S6 product boundary (packages/passes) lives in the options
 *   composition as non-purchasable rows — never mixed truth.
 *
 * - DETERMINISTIC MOCK (schedule): fixture layer for the dev-QA scenario
 *   override only; Home's real schedule derives from real bookings.
 */
import { createParticipantApi, createSessionApi } from './api/identity-api';
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
import { createCommerceApi } from './api/commerce-api';
import { createEntitlementsApi } from './api/entitlements-api';
import { createRealBookingService } from './api/real-commerce-services';
import { apiBaseUrl } from './http/api-config';
import { createHttpClient } from './http/http-client';
import { notifySessionInvalidated, subscribeAuthReset } from './auth/auth-signals';
import { cognitoPublicConfig, selectIdentityGateway } from './auth/identity-gateway-selection';
import { tokenStorage } from './auth/token-storage';
import { AuthSession } from './auth/auth-session';

// RI-5: no mock-backed contract binding remains — the schedule family's
// real composition derives from the unified Calendar read + the real
// Entitlement family (account-derivation.ts); the mock schedule module
// serves ONLY the dev-QA fixture resolver below and its isolated tests.
// Shared presentation helper (pure derivation, not data):
export { providerMonogram } from '../utils/monogram';

/**
 * Dev-QA fixture resolver (account-context `?qa-scenario` override only).
 * RI-6: resolved LAZILY behind `__DEV__` so the fictional fixture graph
 * (mock schedule/catalogue data) never ships in a production bundle —
 * Metro drops the inline require with the eliminated branch. Production
 * builds always return undefined (the caller falls back to real truth).
 */
export function resolveAccountScenario(
  scenario: import('./contracts/schedule').AccountScenarioId,
): import('./contracts/schedule').ResolvedAccount | undefined {
  if (__DEV__) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mock = require('./mock/mock-schedule-service') as typeof import('./mock/mock-schedule-service');
    return mock.resolveAccountScenario(scenario);
  }
  return undefined;
}

/** The current bearer — owned by AuthSession, read by the HTTP client. */
let currentAccessToken: string | null = null;

export const httpClient = createHttpClient({
  baseUrl: apiBaseUrl(),
  getAccessToken: () => currentAccessToken,
  // RI-6: an authenticated request the server answers 401 means the bearer
  // is authoritatively dead — the auth context clears local auth state so
  // no stale authenticated UI survives (owner item 6).
  onUnauthorized: () => notifySessionInvalidated(),
});

// RI-6 — the production identity boundary (owner items 8/9): real Cognito
// configuration selects the REAL gateway; development selects the certified
// dev stand-in; an UNCONFIGURED production build fails closed with the
// typed `authNotConfigured` refusal. Production never routes through the
// dev identity stand-in (D-RI-3) — selection logic lives in ONE place
// (identity-gateway-selection.ts, unit-locked).
export const identityGateway = selectIdentityGateway({
  isDevBuild: __DEV__,
  cognito: cognitoPublicConfig({
    issuer: process.env.EXPO_PUBLIC_COGNITO_ISSUER,
    clientId: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID,
  }),
  httpClient,
});
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
// RI-6 — device recents are account-scoped convenience: they clear with
// the rest of the account-scoped state whenever local auth is forgotten.
subscribeAuthReset(() => {
  void searchService.clearRecentSearches();
});
export const detailsService = createRealDetailsService(discoveryApi);
export const discoverFeedService = createRealDiscoverFeedService(discoveryApi, taxonomyCache);
export const homeFeedService = createRealHomeFeedService(discoveryApi, taxonomyCache);
export const mapService = createRealMapService(discoveryApi, taxonomyCache);

// ---------------------------------------------------------------------------
// RI-3 — REAL commerce composition (docs/34 §2; the certified W4/W5
// customer APIs): quote/hold/free-confirm/paid-initiate/payment-status/
// own-bookings plus the real booking-options/summary composition. The
// RI-2 pending boundary is RETIRED for supported products; the S6 product
// boundary now lives in the options composition itself (non-purchasable
// package rows). The deterministic booking/checkout mocks remain for
// isolated tests exclusively (source-locked out of this module).
// ---------------------------------------------------------------------------
export const commerceApi = createCommerceApi(httpClient);

// ---------------------------------------------------------------------------
// RI-4 — REAL Passes & Memberships composition (docs/35 §8/§9/§13): the S6
// entitlement acquisition, Passes projections, reservation, and redemption-
// credential surfaces. No mock implementation exists for this family — the
// running app always uses the real backend, and the acquisition path rides
// the SAME booking-flow screens through the options composition below.
// ---------------------------------------------------------------------------
export const entitlementsApi = createEntitlementsApi(httpClient);
export const bookingService = createRealBookingService(discoveryApi, commerceApi, entitlementsApi);

/**
 * D-RI-3 operational record (RI-6: now CONFIGURATION-derived, still
 * fail-closed): Sign in with Apple and Google sign-in reuse the certified
 * identity architecture (provider kinds `apple`/`google` are first-class
 * in the backend evidence model, and `POST /auth/session` already binds
 * federated Cognito idToken evidence) but REQUIRE genuine external
 * configuration — Apple developer program membership + Sign-in capability
 * + Services ID + the `expo-apple-authentication` module; Google OAuth
 * clients + the native sign-in module; real Cognito pool federation for
 * both. None exists in this environment, so the flags stay false and the
 * UI presents the options as honestly unavailable — social-login success
 * is never simulated. Operational enablement flips the env flags AND
 * ships the provider modules; the flags alone never fake availability.
 */
export const SOCIAL_SIGN_IN_AVAILABLE = {
  apple: process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED === 'true',
  google: process.env.EXPO_PUBLIC_GOOGLE_SIGN_IN_ENABLED === 'true',
} as const;
