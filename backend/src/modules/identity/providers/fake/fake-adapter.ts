/**
 * Deterministic fake AuthProviderAdapter (docs/26 §11.4).
 *
 * The adapter every automated test uses: no network, no cloud resource, no
 * randomness. Tests mint tokens for exactly the evidence they intend, then
 * exercise the application core through the same port the Cognito adapter
 * implements, so both satisfy one contract suite.
 */
import type { AuthProviderAdapter, TokenValidationResult } from '../adapter';
import { validateProviderEvidence, type ProviderEvidence } from '../evidence';

export class FakeAuthProviderAdapter implements AuthProviderAdapter {
  private readonly tokens = new Map<string, unknown>();
  private unavailable = false;
  private counter = 0;

  /** Mints a deterministic token that validates to the given evidence. */
  issueToken(evidence: ProviderEvidence): string {
    return this.issueRawToken(evidence);
  }

  /**
   * Mints a token carrying arbitrary evidence-shaped material — used to
   * prove the adapter itself rejects malformed evidence.
   */
  issueRawToken(material: unknown): string {
    this.counter += 1;
    const token = `fake-token-${this.counter}`;
    this.tokens.set(token, material);
    return token;
  }

  /** Simulates provider outage for every call until restored. */
  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  async validateToken(rawToken: string): Promise<TokenValidationResult> {
    if (this.unavailable) return { ok: false, reason: 'providerUnavailable' };
    if (!this.tokens.has(rawToken)) {
      return { ok: false, reason: 'invalidProviderEvidence' };
    }
    const validation = validateProviderEvidence(this.tokens.get(rawToken));
    if (!validation.ok) return { ok: false, reason: 'invalidProviderEvidence' };
    return { ok: true, evidence: validation.evidence };
  }
}
