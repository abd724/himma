/**
 * Rate limiting for authentication-sensitive routes (docs/26 §5.3, docs/23
 * §10.7) — B2-4.
 *
 * The store is an abstraction so production can use an approved distributed
 * store later. The in-memory store is deterministic for local/test use; a
 * PRODUCTION process refuses to start with it (`createRateLimiterStore`
 * fails closed) — a per-instance limiter is never silently shipped as
 * production-safe for a horizontally scaled API.
 *
 * Keys never contain raw emails, bearer tokens, or raw IPs — callers key by
 * sha256 digests over normalized values plus a route dimension.
 */
import { createHash } from 'node:crypto';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the window resets — the Retry-After value when denied. */
  retryAfterSeconds: number;
}

export interface RateLimiterStore {
  /** Records `cost` hits (0 = peek) and decides against the rule. */
  consume(key: string, rule: RateLimitRule, cost: number): Promise<RateDecision>;
}

interface WindowState {
  windowStart: number;
  count: number;
}

export class InMemoryRateLimiterStore implements RateLimiterStore {
  private readonly windows = new Map<string, WindowState>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async consume(key: string, rule: RateLimitRule, cost: number): Promise<RateDecision> {
    const at = this.now();
    let state = this.windows.get(key);
    if (state === undefined || at - state.windowStart >= rule.windowMs) {
      state = { windowStart: at, count: 0 };
      this.windows.set(key, state);
    }
    state.count += cost;
    // cost 0 = peek ("am I already at the limit?"); cost > 0 counts an
    // action and allows it while the window total stays within the limit.
    const allowed = cost === 0 ? state.count < rule.limit : state.count <= rule.limit;
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((state.windowStart + rule.windowMs - at) / 1000));
    return { allowed, retryAfterSeconds };
  }
}

/**
 * Fails closed in production: no approved distributed store exists yet, so
 * a production process must not start with rate limiting silently scoped to
 * one instance. Dev/test get the deterministic in-memory store.
 */
export function createRateLimiterStore(
  nodeEnv: 'development' | 'test' | 'production',
): RateLimiterStore {
  if (nodeEnv === 'production') {
    throw new Error(
      'No approved distributed rate-limit store is configured — production startup is refused. ' +
        'A per-instance in-memory limiter is not production-safe for a horizontally scaled API (docs/23 §10.7).',
    );
  }
  return new InMemoryRateLimiterStore();
}

/** Digest for rate-limit key dimensions — never raw emails/tokens/IPs. */
export function rateLimitDigest(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 24);
}

/** Configurable limits with safe defaults (docs/26 §14.C; env wiring later). */
export interface RateLimitRules {
  sessionEstablishment: RateLimitRule;
  resetRequest: RateLimitRule;
  identityLinking: RateLimitRule;
  invalidBearer: RateLimitRule;
  /** TOTP enrollment begin/confirm per user (B2-6C). */
  mfaEnrollment: RateLimitRule;
  /** Step-up challenge begin/complete per user (B2-6C). */
  mfaChallenge: RateLimitRule;
  /** Recovery-code presentation per user — strictest (B2-6C). */
  recoveryCode: RateLimitRule;
}

export const DEFAULT_RATE_LIMITS: RateLimitRules = {
  sessionEstablishment: { limit: 10, windowMs: 60_000 },
  resetRequest: { limit: 5, windowMs: 60_000 },
  identityLinking: { limit: 10, windowMs: 60_000 },
  invalidBearer: { limit: 10, windowMs: 60_000 },
  mfaEnrollment: { limit: 10, windowMs: 60_000 },
  mfaChallenge: { limit: 15, windowMs: 60_000 },
  recoveryCode: { limit: 5, windowMs: 60_000 },
};
