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
 * - DETERMINISTIC MOCKS (discovery/booking/checkout page services): still
 *   the approved mock-driven surfaces until their integration slices
 *   (RI-2 discovery, RI-3 booking/checkout) replace each binding HERE —
 *   one line per contract, no screen changes, never mixed truth on one
 *   screen.
 */
import { createDevIdentityGateway, createParticipantApi, createSessionApi } from './api/identity-api';
import { apiBaseUrl } from './http/api-config';
import { createHttpClient } from './http/http-client';
import { tokenStorage } from './auth/token-storage';
import { AuthSession } from './auth/auth-session';

// Mock-backed contracts (replaced per-slice in RI-2/RI-3):
export { catalogueService } from './mock/mock-catalogue-service';
export { searchService } from './mock/mock-search-service';
export { detailsService } from './mock/mock-details-service';
export { homeFeedService } from './mock/mock-home-feed-service';
export { discoverFeedService } from './mock/mock-discover-feed-service';
export { scheduleService } from './mock/mock-schedule-service';
export { mapService } from './mock/mock-map-service';
export { bookingService } from './mock/mock-booking-service';
export { checkoutService } from './mock/mock-checkout-service';
// Pure display/derivation helpers that live beside the mocks today:
export { providerProgramCount } from './mock/results-engine';
export { providerMonogram } from './mock/mock-details-service';
// Dev-QA fixture resolver (account-context __DEV__ override only):
export { resolveAccountScenario } from './mock/mock-schedule-service';

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
