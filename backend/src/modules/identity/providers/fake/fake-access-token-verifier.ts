/**
 * Deterministic fake AccessTokenVerifier (docs/26 §11.4) — the verifier all
 * automated session tests use. No network, no randomness: tests mint tokens
 * for exactly the evidence they intend and exercise the session services
 * through the same port the Cognito verifier implements.
 */
import type {
  AccessTokenVerificationResult,
  AccessTokenVerifier,
} from '../access-token';
import { validateAccessTokenEvidence, type AccessTokenEvidence } from '../access-token';

export class FakeAccessTokenVerifier implements AccessTokenVerifier {
  private readonly tokens = new Map<string, unknown>();
  private unavailable = false;
  private counter = 0;

  issueToken(evidence: AccessTokenEvidence): string {
    return this.issueRawToken(evidence);
  }

  /** Mints a token carrying arbitrary evidence-shaped material. */
  issueRawToken(material: unknown): string {
    this.counter += 1;
    const token = `fake-access-token-${this.counter}`;
    this.tokens.set(token, material);
    return token;
  }

  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  async verifyAccessToken(rawToken: string): Promise<AccessTokenVerificationResult> {
    if (this.unavailable) return { ok: false, reason: 'providerUnavailable' };
    if (!this.tokens.has(rawToken)) return { ok: false, reason: 'invalidAccessToken' };
    const validation = validateAccessTokenEvidence(this.tokens.get(rawToken));
    if (!validation.ok) return { ok: false, reason: 'invalidAccessToken' };
    return { ok: true, evidence: validation.evidence };
  }
}
