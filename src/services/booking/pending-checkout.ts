/**
 * RI-3 — the persisted PENDING-CHECKOUT record (owner RI-3 §15/§17).
 *
 * Written BEFORE paid-checkout initiation and updated with the server's
 * response, so a lost response, page navigation, or web reload recovers
 * the SAME commercial intent: the same idempotency key re-initiates and
 * the certified W5-5 replay returns the same hosted session while the
 * Himma hold lives. Browser return carries NO authority — the return
 * route uses this record only to know WHICH booking's status to READ.
 * Contains identifiers only (no tokens, no money, no gateway internals).
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = 'himma.checkout.pending.v1';

export interface PendingCheckout {
  /** RI-4: the commercial trail. Absent = 'booking' (RI-3 records). */
  kind?: 'booking' | 'purchase';
  programId: string;
  /** Booking trail only — a purchase holds no inventory. */
  holdId?: string;
  quoteId: string;
  /** The STABLE checkout idempotency key for this commercial intent. */
  idempotencyKey: string;
  /** Known after the server responded (initiation may have been lost). */
  bookingId?: string;
  /** Purchase trail only. */
  purchaseId?: string;
  holdExpiresAt?: string;
  createdAt: string;
}

export interface PendingCheckoutStore {
  load(): Promise<PendingCheckout | null>;
  save(record: PendingCheckout): Promise<void>;
  clear(): Promise<void>;
}

function parse(raw: string | null): PendingCheckout | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as PendingCheckout;
    if (
      typeof parsed.programId !== 'string' ||
      typeof parsed.quoteId !== 'string' ||
      typeof parsed.idempotencyKey !== 'string'
    ) {
      return null;
    }
    if (parsed.kind === 'purchase') return parsed;
    if (typeof parsed.holdId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

const webStore: PendingCheckoutStore = {
  async load() {
    if (typeof localStorage === 'undefined') return null;
    return parse(localStorage.getItem(STORAGE_KEY));
  },
  async save(record) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  },
  async clear() {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
  },
};

const nativeStore: PendingCheckoutStore = {
  async load() {
    return parse(await SecureStore.getItemAsync(STORAGE_KEY));
  },
  async save(record) {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(record));
  },
  async clear() {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  },
};

export const pendingCheckoutStore: PendingCheckoutStore =
  Platform.OS === 'web' ? webStore : nativeStore;
