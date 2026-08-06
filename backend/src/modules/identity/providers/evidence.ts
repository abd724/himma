/**
 * Normalized authentication evidence (docs/26 §2, §3.1–3.3, Amendment A1.1).
 *
 * This is the ONLY authentication shape the application core accepts. An
 * `AuthProviderAdapter` produces it from provider material; nothing above the
 * adapter boundary sees provider SDK types, raw tokens, or provider claims.
 * Identity matching is normalized issuer + subject — email is an attribute
 * and never an identity key (docs/26 §3.2).
 */

export type ProviderKind = 'apple' | 'google' | 'email';

/** Authentication strength asserted by the provider for this evidence. */
export type ProviderAssurance = 'single_factor' | 'mfa';

export interface ProviderEvidence {
  provider: ProviderKind;
  /** Normalized provider issuer (trimmed, verbatim case — issuers are URLs). */
  issuer: string;
  /** Provider subject (`sub`); with issuer, the permanent identity key. */
  subject: string;
  /** Email attribute as asserted by the provider; stored verbatim. */
  email?: string;
  /** Provider's verified-email claim; requires `email`. */
  emailVerified: boolean;
  /** Apple private-relay indication (docs/26 §3.3); requires `email`. */
  isPrivateRelay: boolean;
  assurance: ProviderAssurance;
  /** Optional display-name claim; used only as an account-name default. */
  displayName?: string;
}

export type EvidenceValidation =
  | { ok: true; evidence: ProviderEvidence }
  | { ok: false };

const PROVIDER_KINDS: readonly string[] = ['apple', 'google', 'email'];
const ASSURANCES: readonly string[] = ['single_factor', 'mfa'];
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_EMAIL_LENGTH = 320;
/** Printable, no whitespace/control characters — issuer and subject are opaque tokens. */
const IDENTIFIER_PATTERN = /^[!-~]+$/;
/** Structural email shape only; deliverability is not a schema concern. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Structural validation and normalization of provider evidence. Pure and
 * total: foreign input yields `{ ok: false }`, never a throw. Adapters call
 * this before returning evidence; services re-validate defensively.
 */
export function validateProviderEvidence(input: unknown): EvidenceValidation {
  if (typeof input !== 'object' || input === null) return { ok: false };
  const raw = input as Record<string, unknown>;

  if (typeof raw.provider !== 'string' || !PROVIDER_KINDS.includes(raw.provider)) {
    return { ok: false };
  }
  if (typeof raw.assurance !== 'string' || !ASSURANCES.includes(raw.assurance)) {
    return { ok: false };
  }
  if (typeof raw.issuer !== 'string' || typeof raw.subject !== 'string') {
    return { ok: false };
  }
  const issuer = raw.issuer.trim();
  const subject = raw.subject.trim();
  if (
    issuer.length === 0 ||
    subject.length === 0 ||
    issuer.length > MAX_IDENTIFIER_LENGTH ||
    subject.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(issuer) ||
    !IDENTIFIER_PATTERN.test(subject)
  ) {
    return { ok: false };
  }

  const emailVerified = raw.emailVerified === true;
  const isPrivateRelay = raw.isPrivateRelay === true;
  let email: string | undefined;
  if (raw.email !== undefined && raw.email !== null) {
    if (typeof raw.email !== 'string') return { ok: false };
    email = raw.email.trim();
    if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return { ok: false };
    }
  }
  // A verified or private-relay claim is meaningless without the email itself.
  if ((emailVerified || isPrivateRelay) && email === undefined) return { ok: false };

  let displayName: string | undefined;
  if (raw.displayName !== undefined && raw.displayName !== null) {
    if (typeof raw.displayName !== 'string') return { ok: false };
    displayName = raw.displayName.trim();
    if (displayName.length === 0 || displayName.length > MAX_IDENTIFIER_LENGTH) {
      displayName = undefined;
    }
  }

  return {
    ok: true,
    evidence: {
      provider: raw.provider as ProviderKind,
      issuer,
      subject,
      ...(email !== undefined ? { email } : {}),
      emailVerified,
      isPrivateRelay,
      assurance: raw.assurance as ProviderAssurance,
      ...(displayName !== undefined ? { displayName } : {}),
    },
  };
}
