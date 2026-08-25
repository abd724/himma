/**
 * RI-1 — persisted session material. Native builds keep tokens in the
 * platform secure store (expo-secure-store); web preview falls back to
 * localStorage (dev/review surface only — docs/12: web is a preview, not
 * the product). Nothing here is a Himma secret: the payload is the signed-
 * in user's OWN provider token material plus ids, and clearing it is the
 * frontend half of logout.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = 'himma.auth.session.v1';

export interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** ISO instant the access token expires. */
  expiresAt: string;
  userId: string;
  accountId?: string;
}

export interface TokenStorage {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

function parseStored(raw: string | null): StoredSession | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.userId !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

const webStorage: TokenStorage = {
  async load() {
    if (typeof localStorage === 'undefined') return null;
    return parseStored(localStorage.getItem(STORAGE_KEY));
  },
  async save(session) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  },
  async clear() {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
  },
};

const nativeStorage: TokenStorage = {
  async load() {
    return parseStored(await SecureStore.getItemAsync(STORAGE_KEY));
  },
  async save(session) {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(session));
  },
  async clear() {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  },
};

export const tokenStorage: TokenStorage = Platform.OS === 'web' ? webStorage : nativeStorage;
