/**
 * W6-1 — fail-closed identity adapters for a production runtime whose real
 * Cognito pool is NOT YET configured (docs/37 §6; docs/36 ID-01…ID-04 are
 * open external gates).
 *
 * The production API must be able to EXIST before the external identity
 * gates close (docs/37 §5 of the owner directive): public reads serve,
 * while every authentication surface returns its certified fail-closed
 * outcome. These adapters are honest refusals, never stand-ins:
 *
 * - every presented bearer is `invalidAccessToken` (no session can exist,
 *   so no token can be valid — refusal IS the truth);
 * - every identity-evidence presentation is `invalidProviderEvidence`
 *   (no provider is configured to have issued it);
 * - mail is NOT delivered and says so in the sanctioned log form only.
 *
 * The dev identity provider is NOT an alternative here: production
 * composition refuses it structurally (build-app), and these adapters
 * never mint, accept, or fake any credential.
 */
import type { MailMessage, MailSender } from '../../mail/mail-sender';
import { mailLogLine } from '../../mail/mail-sender';
import type {
  AccessTokenVerificationResult,
  AccessTokenVerifier,
} from '../access-token';
import type { AuthProviderAdapter, TokenValidationResult } from '../adapter';

export class UnconfiguredAccessTokenVerifier implements AccessTokenVerifier {
  async verifyAccessToken(): Promise<AccessTokenVerificationResult> {
    return { ok: false, reason: 'invalidAccessToken' };
  }
}

export class UnconfiguredAuthProviderAdapter implements AuthProviderAdapter {
  async validateToken(): Promise<TokenValidationResult> {
    return { ok: false, reason: 'invalidProviderEvidence' };
  }
}

/**
 * Production mail delivery is an unresolved external gate (docs/26 §14 D2:
 * "production sending stays disabled until the identity region and
 * email-delivery service are owner-approved"). This sender records the
 * non-delivery explicitly — the sanctioned template+digest line, never the
 * body/subject/raw address — instead of faking delivery or crashing flows
 * whose enumeration-safe responses are certified independent of delivery.
 */
export class UnconfiguredMailSender implements MailSender {
  constructor(private readonly warn: (line: string) => void) {}

  async send(message: MailMessage): Promise<void> {
    this.warn(`mail delivery is not configured; message NOT delivered — ${mailLogLine(message)}`);
  }
}
