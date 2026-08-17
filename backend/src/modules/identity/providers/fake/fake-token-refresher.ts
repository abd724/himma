/**
 * Deterministic fake ProviderTokenRefresher (docs/26 §11.4) — W2-12A
 * session-continuity correction. No network, no cloud resource: tests
 * register exactly the refresh tokens they intend, each minting a fresh
 * token pair on use; invalidation simulates provider-side
 * revocation/rotation-reuse.
 */
import type {
  ProviderRefreshResult,
  ProviderTokenRefresher,
  RefreshedProviderTokens,
} from '../refresh';

export class FakeTokenRefresher implements ProviderTokenRefresher {
  private readonly registry = new Map<string, () => RefreshedProviderTokens>();
  private unavailable = false;

  /** Registers a refresh token; `mint` runs per refresh (fresh pair each time). */
  register(refreshToken: string, mint: () => RefreshedProviderTokens): void {
    this.registry.set(refreshToken, mint);
  }

  /** Simulates provider-side revocation / rotation-reuse detection. */
  invalidate(refreshToken: string): void {
    this.registry.delete(refreshToken);
  }

  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  async refreshTokens(input: { refreshToken: string }): Promise<ProviderRefreshResult> {
    if (this.unavailable) return { ok: false, reason: 'providerUnavailable' };
    const mint = this.registry.get(input.refreshToken);
    if (mint === undefined) return { ok: false, reason: 'invalidRefreshToken' };
    return { ok: true, tokens: mint() };
  }
}
