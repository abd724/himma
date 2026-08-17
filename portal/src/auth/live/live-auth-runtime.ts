import { createApiClient, type ApiClient, type FetchLike } from '../../api/client';
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
 * TOKEN OWNERSHIP: all token material lives in this module's closure, in
 * memory only — never localStorage/sessionStorage, never React state,
 * never URLs, never logs, and nothing token-shaped crosses the adapter
 * boundary. The docs/26 §4.7(9) refresh-token cookie channel needs the
 * §14.E backend cookie/CSRF wiring, which does not exist yet — until it
 * does, a hard reload simply starts signed out (fail-closed, recorded as
 * an operational dependency). The refresh token is held ONLY so logout can
 * pass it to `POST /auth/logout` for provider-side revocation (the route's
 * documented ephemeral pass-through) — the portal never runs its own
 * refresh flow and no second refresh mechanism exists.
 */

export interface LiveAuthConfig {
  readonly apiBaseUrl: string;
  readonly cognitoIssuer: string;
  readonly cognitoClientId: string;
  /** Test seam only; defaults to the platform fetch. */
  readonly fetchImpl?: FetchLike;
}

export interface LiveAuthRuntime {
  readonly adapter: PortalAuthAdapter;
  readonly accessPort: ProviderAccessPort;
}

interface HeldSession {
  readonly tokens: CognitoTokens;
  readonly assurance: 'single_factor' | 'mfa';
  readonly identity: SessionIdentity;
}

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
  const listeners = new Set<(interrupt: SessionInterrupt) => void>();

  const notify = (interrupt: SessionInterrupt) => {
    for (const listener of listeners) {
      listener(interrupt);
    }
  };

  const dropSession = () => {
    held = null;
  };

  /** Authorized Himma API call; a dead session clears held tokens and
   *  pushes the one canonical interrupt (docs/26: revocation ⇒ sessionExpired). */
  const authorizedRequest = async (
    path: string,
    options: { method?: 'GET' | 'POST'; body?: unknown } = {},
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

  /** Present a fresh Cognito token pair to the REAL Himma session route. */
  const establishHimmaSession = async (
    tokens: CognitoTokens,
    assurance: 'single_factor' | 'mfa',
    email: string,
  ): Promise<SignInOutcome> => {
    const response = await api.request('/auth/session', {
      method: 'POST',
      body: {
        accessToken: tokens.accessToken,
        ...(tokens.idToken !== null ? { idToken: tokens.idToken } : {}),
        deviceLabel: 'Himma Provider Portal',
      },
    });
    if (response.networkFailure) {
      return { kind: 'providerUnavailable' };
    }
    if (response.status === 200) {
      const identity = identityFrom(tokens.idToken, email);
      held = { tokens, assurance, identity };
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
     * Memory-only session ownership: no persisted token can exist at load,
     * so bootstrap truthfully reports no session. Reload-surviving sessions
     * arrive with the docs/26 §14.E refresh-cookie channel (backend work,
     * recorded as pending) — never with browser token storage.
     */
    async bootstrap(): Promise<BootstrapOutcome> {
      return { kind: 'noSession' };
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
     * Logout: revoke the Himma session-of-record (`POST /auth/logout`,
     * passing the refresh token through the route's documented EPHEMERAL
     * provider-revocation channel), fall back to direct provider
     * revocation if Himma was unreachable, and ALWAYS land signed out
     * locally with every token dropped from memory.
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

  return { adapter, accessPort };
}
