import {
  createApiClient,
  type ApiClient,
  type ApiJsonResponse,
  type FetchLike,
} from '../../api/client';
import type {
  BootstrapOutcome,
  MfaChallengeOutcome,
  PortalAuthAdapter,
  SessionIdentity,
  SessionInterrupt,
  SignInOutcome,
  StepUpOutcome,
} from '../adapter';
import {
  PROVIDER_ROLES,
  type ProviderAccessOutcome,
  type ProviderAccessPort,
  type ProviderMembership,
  type ProviderRole,
} from '../../provider-access/contract';
import {
  initiatePasswordAuth,
  respondToTotpChallenge,
  revokeRefreshToken,
  type CognitoClientConfig,
  type CognitoTokens,
} from './cognito-api';

/**
 * LIVE portal auth runtime (W2-12A) — the production implementation of the
 * W2-2 adapter seam over the APPROVED identity architecture (docs/26,
 * Amendment A1.1):
 *
 * 1. The browser authenticates with Amazon Cognito directly (public app
 *    client; USER_PASSWORD_AUTH + SOFTWARE_TOKEN_MFA) through the one
 *    Cognito boundary module.
 * 2. The issued token pair is presented ONCE to `POST /auth/session` —
 *    first-login/identity resolution plus Himma `login_session`
 *    establishment (Himma PostgreSQL stays the session-of-record).
 * 3. The Cognito ACCESS token is the only API bearer credential; every
 *    Himma call carries it in the Authorization header, and Himma's
 *    per-request liveness check (issuer + subject + origin_jti) remains the
 *    revocation authority.
 * 4. Provider access comes ONLY from `GET /provider/me` (Himma
 *    `staff_membership` truth) — Cognito claims never grant anything.
 *
 * TOKEN OWNERSHIP (docs/26 §4.7(9) — the §14.E channel is now REAL):
 * - The ACCESS (and display ID) token live in this module's closure, in
 *   memory only — never localStorage/sessionStorage, never React state,
 *   never URLs, never logs.
 * - The REFRESH token is presented EXACTLY ONCE to `POST /auth/session`,
 *   which moves it into the server-set Secure/HttpOnly/SameSite=Strict
 *   auth-path cookie; after that, browser JavaScript neither holds nor can
 *   read it (it is dropped from memory the moment the cookie channel
 *   engages). Session continuity across hard reloads is the server-mediated
 *   `GET /auth/csrf` → `POST /auth/refresh` bootstrap — Himma's
 *   `login_session` liveness remains the authority a still-valid provider
 *   refresh token can never bypass.
 * - CSRF: the double-submit value from the session/refresh responses is
 *   held in memory and echoed as the `x-csrf-token` header on every
 *   cookie-authenticated call. It is channel binding, never a credential.
 */

export interface LiveAuthConfig {
  readonly apiBaseUrl: string;
  readonly cognitoIssuer: string;
  readonly cognitoClientId: string;
  /** Test seam only; defaults to the platform fetch. */
  readonly fetchImpl?: FetchLike;
}

/**
 * Authorized transport handed to the LIVE domain ports (W2-12B): domain
 * code gets the CAPABILITY to make authenticated Himma calls — never the
 * token itself, which stays inside this module's closure. A dead session
 * (401 sessionExpired/invalidAccessToken) is handled here once: tokens
 * drop, the canonical interrupt fires, and the caller sees the response.
 */
export interface LiveTransport {
  /** Bearer-authenticated Himma API call; null when no session is held. */
  authorizedRequest(
    path: string,
    options?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown },
  ): Promise<ApiJsonResponse | null>;
  /** Unauthenticated Himma API call (public reads such as areas). */
  publicRequest(path: string): Promise<ApiJsonResponse>;
  /**
   * The caller's effective access may have changed (own membership
   * revoked, organization state moved, invitation accepted, shell display
   * identity edited) — pushes the W2-2 `accessChanged` interrupt so the
   * session layer re-resolves `/provider/me` authoritatively (task §18).
   */
  notifyAccessChanged(): void;
}

export interface LiveAuthRuntime {
  readonly adapter: PortalAuthAdapter;
  readonly accessPort: ProviderAccessPort;
  readonly transport: LiveTransport;
}

interface HeldSession {
  readonly tokens: CognitoTokens;
  readonly assurance: 'single_factor' | 'mfa';
  readonly identity: SessionIdentity;
}

/** Display fallback when a refreshed session carries no parseable ID
 *  token — semantic placeholder only, replaced on the next full sign-in. */
const FALLBACK_IDENTITY: SessionIdentity = {
  email: '',
  displayName: 'Provider account',
};

interface PendingChallenge {
  readonly session: string;
  readonly email: string;
  readonly password: null; // never retained — documented shape guard
}

/** Display-only ID-token claim extraction (never authorization material —
 *  business authority comes exclusively from Himma via /provider/me). */
function identityFrom(idToken: string | null, fallbackEmail: string): SessionIdentity {
  const fallback: SessionIdentity = { email: fallbackEmail, displayName: fallbackEmail };
  if (idToken === null) {
    return fallback;
  }
  const segments = idToken.split('.');
  if (segments.length !== 3 || segments[1] === undefined) {
    return fallback;
  }
  try {
    const normalized = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(normalized));
    if (typeof claims !== 'object' || claims === null) {
      return fallback;
    }
    const raw = claims as Record<string, unknown>;
    const email = typeof raw.email === 'string' && raw.email !== '' ? raw.email : fallbackEmail;
    const name =
      typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : email;
    return { email, displayName: name };
  } catch {
    return fallback;
  }
}

function membershipFrom(row: unknown): ProviderMembership | null {
  if (typeof row !== 'object' || row === null) {
    return null;
  }
  const raw = row as Record<string, unknown>;
  const role = raw.role;
  const branchScope = raw.branchScope;
  const scopeValid =
    branchScope === 'all' ||
    (Array.isArray(branchScope) && branchScope.every((id) => typeof id === 'string'));
  if (
    typeof raw.organizationId !== 'string' ||
    typeof raw.displayName !== 'string' ||
    typeof raw.organizationState !== 'string' ||
    typeof role !== 'string' ||
    !(PROVIDER_ROLES as readonly string[]).includes(role) ||
    !scopeValid
  ) {
    return null;
  }
  return {
    organizationId: raw.organizationId,
    displayName: raw.displayName,
    role: role as ProviderRole,
    branchScope: branchScope === 'all' ? 'all' : (branchScope as string[]),
    organizationState: raw.organizationState,
  };
}

export function createLiveAuthRuntime(config: LiveAuthConfig): LiveAuthRuntime {
  const api: ApiClient = createApiClient({
    baseUrl: config.apiBaseUrl,
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  });
  const cognito: CognitoClientConfig = {
    issuer: config.cognitoIssuer,
    clientId: config.cognitoClientId,
    fetchImpl: config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
  };

  let held: HeldSession | null = null;
  let pendingChallenge: PendingChallenge | null = null;
  /** Double-submit CSRF value for the cookie channel (memory-only). */
  let csrfToken: string | null = null;
  const listeners = new Set<(interrupt: SessionInterrupt) => void>();

  const notify = (interrupt: SessionInterrupt) => {
    for (const listener of listeners) {
      listener(interrupt);
    }
  };

  const dropSession = () => {
    held = null;
    csrfToken = null;
  };

  /** Authorized Himma API call; a dead session clears held tokens and
   *  pushes the one canonical interrupt (docs/26: revocation ⇒ sessionExpired). */
  const authorizedRequest = async (
    path: string,
    options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
  ) => {
    if (held === null) {
      return null;
    }
    const response = await api.request(path, {
      ...options,
      accessToken: held.tokens.accessToken,
    });
    if (
      response.status === 401 &&
      (response.code === 'sessionExpired' || response.code === 'invalidAccessToken')
    ) {
      dropSession();
      notify({ kind: 'sessionExpired' });
    }
    return response;
  };

  /**
   * Present a fresh Cognito token pair to the REAL Himma session route.
   * The refresh token rides along EXACTLY ONCE so the server can move it
   * into the HttpOnly cookie; when the response confirms the channel
   * (csrfToken present), the refresh token is dropped from JS memory.
   */
  const establishHimmaSession = async (
    tokens: CognitoTokens,
    assurance: 'single_factor' | 'mfa',
    email: string,
  ): Promise<SignInOutcome> => {
    const response = await api.request('/auth/session', {
      method: 'POST',
      withCredentials: true,
      body: {
        accessToken: tokens.accessToken,
        ...(tokens.idToken !== null ? { idToken: tokens.idToken } : {}),
        ...(tokens.refreshToken !== null ? { refreshToken: tokens.refreshToken } : {}),
        deviceLabel: 'Himma Provider Portal',
      },
    });
    if (response.networkFailure) {
      return { kind: 'providerUnavailable' };
    }
    if (response.status === 200) {
      const identity = identityFrom(tokens.idToken, email);
      const issuedCsrf = (response.body as { csrfToken?: unknown } | null)?.csrfToken;
      if (typeof issuedCsrf === 'string') {
        // Cookie channel engaged: the server owns the refresh token now.
        csrfToken = issuedCsrf;
        held = { tokens: { ...tokens, refreshToken: null }, assurance, identity };
      } else {
        held = { tokens, assurance, identity };
      }
      return { kind: 'signedIn', assurance, identity };
    }
    switch (response.code) {
      case 'accountSuspended':
        return { kind: 'accountSuspended' };
      case 'rateLimited':
        return { kind: 'rateLimited' };
      case 'providerUnavailable':
        return { kind: 'providerUnavailable' };
      case 'invalidCredentials':
        return { kind: 'invalidCredentials' };
      default:
        return { kind: 'failure' };
    }
  };

  const adapter: PortalAuthAdapter = {
    /**
     * Hard-reload bootstrap over the §14.E cookie channel: obtain the
     * double-submit value (`GET /auth/csrf`), then perform the
     * server-mediated refresh (`POST /auth/refresh`). ONE attempt, no
     * loops: any refusal — no cookie, revoked/expired Himma session,
     * invalid provider refresh, outage — lands signed out and the W2-2
     * sign-in UX takes over. No token ever touches browser storage.
     */
    async bootstrap(): Promise<BootstrapOutcome> {
      const csrf = await api.request('/auth/csrf', { withCredentials: true });
      const issued = (csrf.body as { csrfToken?: unknown } | null)?.csrfToken;
      if (csrf.status !== 200 || typeof issued !== 'string') {
        return { kind: 'noSession' };
      }
      const refreshed = await api.request('/auth/refresh', {
        method: 'POST',
        withCredentials: true,
        csrfToken: issued,
        body: {},
      });
      if (refreshed.status !== 200) {
        return { kind: 'noSession' };
      }
      const body = refreshed.body as {
        accessToken?: unknown;
        idToken?: unknown;
        assurance?: unknown;
        csrfToken?: unknown;
      } | null;
      if (body === null || typeof body.accessToken !== 'string') {
        return { kind: 'noSession' };
      }
      const assurance = body.assurance === 'mfa' ? 'mfa' : 'single_factor';
      const idToken = typeof body.idToken === 'string' ? body.idToken : null;
      const parsed = identityFrom(idToken, '');
      const identity =
        parsed.email === '' && parsed.displayName === '' ? FALLBACK_IDENTITY : parsed;
      csrfToken = typeof body.csrfToken === 'string' ? body.csrfToken : csrfToken;
      held = {
        tokens: { accessToken: body.accessToken, idToken, refreshToken: null },
        assurance,
        identity,
      };
      return { kind: 'session', assurance, identity };
    },

    async signIn(input): Promise<SignInOutcome> {
      pendingChallenge = null;
      const result = await initiatePasswordAuth(cognito, input);
      switch (result.kind) {
        case 'tokens':
          return establishHimmaSession(result.tokens, 'single_factor', input.email);
        case 'mfaChallenge':
          pendingChallenge = { session: result.session, email: input.email, password: null };
          return { kind: 'mfaChallenge' };
        default:
          return result;
      }
    },

    async completeMfaChallenge(code): Promise<MfaChallengeOutcome> {
      if (pendingChallenge === null) {
        return { kind: 'challengeExpired' };
      }
      const challenge = pendingChallenge;
      const result = await respondToTotpChallenge(cognito, {
        session: challenge.session,
        email: challenge.email,
        code,
      });
      switch (result.kind) {
        case 'tokens': {
          pendingChallenge = null;
          const outcome = await establishHimmaSession(result.tokens, 'mfa', challenge.email);
          if (outcome.kind === 'signedIn') {
            return { kind: 'signedIn', assurance: 'mfa', identity: outcome.identity };
          }
          // The Himma session leg refused after a valid TOTP — the Cognito
          // challenge is consumed, so the flow restarts from credentials.
          return { kind: 'failure' };
        }
        case 'invalidCode':
          return { kind: 'invalidCode' };
        case 'challengeExpired':
          pendingChallenge = null;
          return { kind: 'challengeExpired' };
        case 'rateLimited':
          return { kind: 'rateLimited' };
        default:
          return { kind: 'failure' };
      }
    },

    async cancelMfaChallenge(): Promise<void> {
      pendingChallenge = null;
    },

    /** Two-legged Himma step-up (`/auth/step-up/totp/begin` → `/complete`)
     *  behind the one-call W2-2 seam. */
    async completeStepUpTotp(code): Promise<StepUpOutcome> {
      const begin = await authorizedRequest('/auth/step-up/totp/begin', { method: 'POST' });
      if (begin === null || begin.status !== 200) {
        return begin?.code === 'rateLimited' ? { kind: 'rateLimited' } : { kind: 'failure' };
      }
      const started = begin.body as {
        challengeId?: unknown;
        providerChallenge?: unknown;
      } | null;
      if (
        started === null ||
        typeof started.challengeId !== 'string' ||
        typeof started.providerChallenge !== 'string'
      ) {
        return { kind: 'failure' };
      }
      const complete = await authorizedRequest('/auth/step-up/totp/complete', {
        method: 'POST',
        body: {
          challengeId: started.challengeId,
          providerChallenge: started.providerChallenge,
          code,
        },
      });
      if (complete === null) {
        return { kind: 'failure' };
      }
      if (complete.status === 200) {
        const body = complete.body as { expiresAt?: unknown } | null;
        return {
          kind: 'completed',
          expiresAt: typeof body?.expiresAt === 'string' ? body.expiresAt : new Date(0).toISOString(),
        };
      }
      switch (complete.code) {
        case 'challengeInvalid':
          // The backend deliberately collapses wrong-code/expired/invalid
          // into ONE sanitized class (no oracle) — surfaced as a retryable
          // wrong-code state; a truly dead challenge fails the next begin.
          return { kind: 'invalidCode' };
        case 'rateLimited':
          return { kind: 'rateLimited' };
        default:
          return { kind: 'failure' };
      }
    },

    async completeStepUpRecoveryCode(code): Promise<StepUpOutcome> {
      const response = await authorizedRequest('/auth/step-up/recovery-code', {
        method: 'POST',
        body: { code },
      });
      if (response === null) {
        return { kind: 'failure' };
      }
      if (response.status === 200) {
        const body = response.body as { expiresAt?: unknown } | null;
        return {
          kind: 'completed',
          expiresAt: typeof body?.expiresAt === 'string' ? body.expiresAt : new Date(0).toISOString(),
        };
      }
      switch (response.code) {
        case 'challengeInvalid':
          return { kind: 'invalidCode' };
        case 'rateLimited':
          return { kind: 'rateLimited' };
        default:
          return { kind: 'failure' };
      }
    },

    /**
     * Final §14.E logout: `POST /auth/logout` revokes the Himma
     * session-of-record, clears the HttpOnly refresh + CSRF cookies
     * server-side, and performs provider revocation from the cookie
     * channel. The legacy in-memory refresh pass-through (with a direct
     * provider-revocation fallback) remains only for a backend WITHOUT the
     * cookie channel. Always lands signed out locally, tokens dropped.
     */
    async signOut(): Promise<void> {
      const session = held;
      pendingChallenge = null;
      if (session === null) {
        return;
      }
      const response = await api
        .request('/auth/logout', {
          method: 'POST',
          withCredentials: true,
          accessToken: session.tokens.accessToken,
          body:
            session.tokens.refreshToken !== null
              ? { refreshToken: session.tokens.refreshToken }
              : {},
        })
        .catch(() => null);
      if (
        (response === null || response.networkFailure) &&
        session.tokens.refreshToken !== null
      ) {
        await revokeRefreshToken(cognito, session.tokens.refreshToken).catch(() => undefined);
      }
      dropSession();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const accessPort: ProviderAccessPort = {
    /** The authoritative access bootstrap — Himma `staff_membership` truth
     *  via the REAL `GET /provider/me`; claims grant nothing. */
    async resolveAccess(): Promise<ProviderAccessOutcome> {
      const response = await authorizedRequest('/provider/me');
      if (response === null || response.status !== 200) {
        return { kind: 'unavailable' };
      }
      const body = response.body as { memberships?: unknown } | null;
      if (body === null || !Array.isArray(body.memberships)) {
        return { kind: 'unavailable' };
      }
      const memberships: ProviderMembership[] = [];
      for (const row of body.memberships) {
        const membership = membershipFrom(row);
        if (membership === null) {
          // A row outside the approved contract is a contract violation —
          // fail closed rather than render partial access truth.
          return { kind: 'unavailable' };
        }
        memberships.push(membership);
      }
      return { kind: 'resolved', memberships };
    },
  };

  const transport: LiveTransport = {
    authorizedRequest,
    publicRequest: (path) => api.request(path),
    notifyAccessChanged: () => notify({ kind: 'accessChanged' }),
  };

  return { adapter, accessPort, transport };
}
