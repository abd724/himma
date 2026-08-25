/**
 * RI-1 — the customer auth session controller (pure logic; UI state lives
 * in auth-context). Owns the ONLY authenticated frontend state the app
 * has, and every transition is server-confirmed:
 *
 * - sign-in/sign-up: identity gateway (token acquisition) → the certified
 *   `POST /auth/session` (real Himma session in PostgreSQL) → `/me`.
 * - restore (app launch): stored token material → refresh when expired →
 *   re-verify against `/me`; ANY authentication failure clears storage and
 *   lands on guest — there is no frontend-only authenticated state.
 * - logout: best-effort server logout (the Himma session is revoked and
 *   its provider session permanently retired), then storage is cleared
 *   locally EVEN IF the network call failed — the device forgets first.
 */
import type {
  CustomerProfile,
  IdentityGateway,
  IdentityTokens,
  SessionApi,
} from '@/services/contracts/identity';
import { ApiError } from '@/services/http/http-client';
import type { StoredSession, TokenStorage } from './token-storage';

export interface AuthenticatedSnapshot {
  userId: string;
  accountId?: string;
  profile: CustomerProfile;
}

export interface AuthSessionDeps {
  gateway: IdentityGateway;
  session: SessionApi;
  storage: TokenStorage;
  /** Called whenever the current access token changes (HTTP client feed). */
  onAccessToken: (token: string | null) => void;
  now?: () => Date;
}

export class AuthSession {
  constructor(private readonly deps: AuthSessionDeps) {}

  private get now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** App-launch restoration. Returns the snapshot or null (guest). */
  async restore(): Promise<AuthenticatedSnapshot | null> {
    const stored = await this.deps.storage.load();
    if (stored === null) return null;
    let active = stored;
    if (new Date(stored.expiresAt).getTime() <= this.now.getTime()) {
      if (stored.refreshToken === undefined) return this.forget();
      try {
        const refreshed = await this.deps.gateway.refresh(stored.refreshToken);
        active = { ...stored, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
        await this.deps.storage.save(active);
      } catch {
        return this.forget();
      }
    }
    this.deps.onAccessToken(active.accessToken);
    try {
      const profile = await this.deps.session.me();
      return {
        userId: active.userId,
        ...(active.accountId !== undefined ? { accountId: active.accountId } : {}),
        profile,
      };
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        return this.forget();
      }
      // Backend unreachable ≠ signed out: surface as guest-with-error is
      // worse than retry-later — the caller treats a thrown restore as
      // "keep guest UI, session material retained for the next launch".
      this.deps.onAccessToken(null);
      throw error;
    }
  }

  async signIn(email: string, password: string): Promise<AuthenticatedSnapshot> {
    const tokens = await this.deps.gateway.signIn({ email, password });
    return this.establish(tokens);
  }

  async signUp(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<AuthenticatedSnapshot> {
    const tokens = await this.deps.gateway.signUp(input);
    return this.establish(tokens);
  }

  async logout(): Promise<void> {
    try {
      await this.deps.session.logout();
    } catch {
      // The device forgets regardless; the server session dies with its
      // token expiry and the retired provider session on next contact.
    }
    await this.forget();
  }

  private async establish(tokens: IdentityTokens): Promise<AuthenticatedSnapshot> {
    this.deps.onAccessToken(tokens.accessToken);
    try {
      const established = await this.deps.session.establishSession({
        accessToken: tokens.accessToken,
        ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
      });
      const profile = await this.deps.session.me();
      const stored: StoredSession = {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
        expiresAt: tokens.expiresAt,
        userId: established.userId,
        ...(established.accountId !== undefined ? { accountId: established.accountId } : {}),
      };
      await this.deps.storage.save(stored);
      return {
        userId: established.userId,
        ...(established.accountId !== undefined ? { accountId: established.accountId } : {}),
        profile,
      };
    } catch (error) {
      this.deps.onAccessToken(null);
      throw error;
    }
  }

  private async forget(): Promise<null> {
    this.deps.onAccessToken(null);
    await this.deps.storage.clear();
    return null;
  }
}
