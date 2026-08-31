/**
 * RI-1 — AuthSession controller behavior with contract doubles (the mocks
 * allowed in tests; the running app composes the real HTTP adapters —
 * composition-lock.test.ts pins that).
 */
import { describe, expect, it } from '@jest/globals';
import { AuthSession } from '@/services/auth/auth-session';
import type { StoredSession, TokenStorage } from '@/services/auth/token-storage';
import type {
  CustomerProfile,
  IdentityGateway,
  SessionApi,
} from '@/services/contracts/identity';
import { ApiError, NetworkError } from '@/services/http/http-client';
import { subscribeAuthReset } from '@/services/auth/auth-signals';

const PROFILE: CustomerProfile = {
  user: { id: 'user-1' },
  account: { id: 'acct-1', displayName: 'Parent', contactEmail: 'p@x.test' },
  participants: [{ id: 'self-1', kind: 'self', firstName: 'Me' }],
};

function memoryStorage(initial: StoredSession | null = null) {
  let stored = initial;
  const storage: TokenStorage = {
    async load() {
      return stored;
    },
    async save(session) {
      stored = session;
    },
    async clear() {
      stored = null;
    },
  };
  return { storage, get: () => stored };
}

function tokens(overrides: Partial<Record<string, string>> = {}) {
  return {
    accessToken: overrides.accessToken ?? 'access-1',
    idToken: 'id-1',
    refreshToken: 'refresh-1',
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
  };
}

function gatewayDouble(overrides: Partial<IdentityGateway> = {}): IdentityGateway {
  return {
    signUp: async () => tokens(),
    signIn: async () => tokens(),
    refresh: async () => ({
      accessToken: 'access-refreshed',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
    ...overrides,
  };
}

function sessionDouble(overrides: Partial<SessionApi> = {}): SessionApi {
  return {
    establishSession: async () => ({
      userId: 'user-1',
      accountId: 'acct-1',
      sessionId: 'sess-1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
    me: async () => PROFILE,
    logout: async () => {},
    ...overrides,
  };
}

function makeSession(deps: {
  gateway?: Partial<IdentityGateway>;
  session?: Partial<SessionApi>;
  stored?: StoredSession | null;
}) {
  const { storage, get } = memoryStorage(deps.stored ?? null);
  const tokenFeed: (string | null)[] = [];
  const auth = new AuthSession({
    gateway: gatewayDouble(deps.gateway),
    session: sessionDouble(deps.session),
    storage,
    onAccessToken: (token) => tokenFeed.push(token),
  });
  return { auth, get, tokenFeed };
}

const STORED: StoredSession = {
  accessToken: 'stored-access',
  refreshToken: 'stored-refresh',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  userId: 'user-1',
  accountId: 'acct-1',
};

describe('sign in / sign up', () => {
  it('acquires tokens, establishes the real session, loads the profile, persists', async () => {
    const { auth, get, tokenFeed } = makeSession({});
    const snapshot = await auth.signIn('p@x.test', 'password123');
    expect(snapshot.userId).toBe('user-1');
    expect(snapshot.accountId).toBe('acct-1');
    expect(snapshot.profile).toEqual(PROFILE);
    expect(get()).toMatchObject({ accessToken: 'access-1', userId: 'user-1' });
    expect(tokenFeed.at(-1)).toBe('access-1');
  });

  it('a failed establishment persists NOTHING and clears the client token', async () => {
    const { auth, get, tokenFeed } = makeSession({
      session: {
        establishSession: async () => {
          throw new ApiError(401, 'invalidCredentials', 'no');
        },
      },
    });
    await expect(auth.signIn('p@x.test', 'wrong')).rejects.toBeInstanceOf(ApiError);
    expect(get()).toBeNull();
    expect(tokenFeed.at(-1)).toBeNull();
  });
});

describe('restore', () => {
  it('nothing stored → guest', async () => {
    const { auth } = makeSession({ stored: null });
    expect(await auth.restore()).toBeNull();
  });

  it('valid stored token → verified against /me → authenticated', async () => {
    const { auth, tokenFeed } = makeSession({ stored: STORED });
    const snapshot = await auth.restore();
    expect(snapshot?.userId).toBe('user-1');
    expect(tokenFeed.at(-1)).toBe('stored-access');
  });

  it('expired stored token → gateway refresh → authenticated with the new token', async () => {
    const { auth, get, tokenFeed } = makeSession({
      stored: { ...STORED, expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    const snapshot = await auth.restore();
    expect(snapshot?.userId).toBe('user-1');
    expect(get()?.accessToken).toBe('access-refreshed');
    expect(tokenFeed.at(-1)).toBe('access-refreshed');
  });

  it('RI-6: a TRANSIENT refresh failure retains the stored session and rethrows (retry-later, never sign-out)', async () => {
    const { auth, get } = makeSession({
      stored: { ...STORED, expiresAt: new Date(Date.now() - 1000).toISOString() },
      gateway: {
        refresh: async () => {
          throw new NetworkError(new Error('offline'));
        },
      },
    });
    await expect(auth.restore()).rejects.toBeInstanceOf(NetworkError);
    expect(get()).not.toBeNull(); // material retained for the next launch
  });

  it('expired + refresh refused → storage cleared, guest', async () => {
    const { auth, get } = makeSession({
      stored: { ...STORED, expiresAt: new Date(Date.now() - 1000).toISOString() },
      gateway: {
        refresh: async () => {
          throw new ApiError(401, 'sessionExpired', 'expired');
        },
      },
    });
    expect(await auth.restore()).toBeNull();
    expect(get()).toBeNull();
  });

  it('server rejects the session (401) → storage cleared, guest', async () => {
    const { auth, get } = makeSession({
      stored: STORED,
      session: {
        me: async () => {
          throw new ApiError(401, 'sessionExpired', 'revoked');
        },
      },
    });
    expect(await auth.restore()).toBeNull();
    expect(get()).toBeNull();
  });

  it('backend unreachable → restore THROWS, session material retained for the next launch', async () => {
    const { auth, get, tokenFeed } = makeSession({
      stored: STORED,
      session: {
        me: async () => {
          throw new NetworkError(new Error('offline'));
        },
      },
    });
    await expect(auth.restore()).rejects.toBeInstanceOf(NetworkError);
    expect(get()).not.toBeNull(); // retained — unreachable ≠ signed out
    expect(tokenFeed.at(-1)).toBeNull(); // but no live bearer is exposed
  });
});

describe('logout', () => {
  it('revokes server-side then forgets locally', async () => {
    let serverLogouts = 0;
    const { auth, get } = makeSession({
      stored: STORED,
      session: {
        logout: async () => {
          serverLogouts += 1;
        },
      },
    });
    await auth.restore();
    await auth.logout();
    expect(serverLogouts).toBe(1);
    expect(get()).toBeNull();
  });

  it('the device forgets EVEN IF the server call fails', async () => {
    const { auth, get, tokenFeed } = makeSession({
      stored: STORED,
      session: {
        logout: async () => {
          throw new NetworkError(new Error('offline'));
        },
      },
    });
    await auth.restore();
    await auth.logout();
    expect(get()).toBeNull();
    expect(tokenFeed.at(-1)).toBeNull();
  });
});

describe('RI-6: authoritative invalidation + account-scoped reset signal', () => {
  it('invalidate() clears local auth state without a server call and fires the auth-reset signal', async () => {
    const resets: number[] = [];
    const unsubscribe = subscribeAuthReset(() => resets.push(1));
    const { auth, get, tokenFeed } = makeSession({ stored: STORED });
    await auth.invalidate();
    expect(get()).toBeNull();
    expect(tokenFeed.at(-1)).toBeNull();
    expect(resets).toHaveLength(1);
    unsubscribe();
  });

  it('logout fires the auth-reset signal (pending checkout, stashed secret, recents all clear through it)', async () => {
    const resets: number[] = [];
    const unsubscribe = subscribeAuthReset(() => resets.push(1));
    const { auth } = makeSession({ stored: STORED });
    await auth.logout();
    expect(resets).toHaveLength(1);
    unsubscribe();
  });
});
