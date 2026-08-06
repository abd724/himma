/**
 * Deterministic fake ProviderSessionRevoker (docs/26 §11.4).
 *
 * Records every revocation request — WITHOUT retaining ephemeral token
 * material (only its presence), demonstrating the non-retention rule at the
 * port boundary — and supports failure injection so tests prove local
 * denial survives provider failure.
 */
import type {
  ProviderRevocationOutcome,
  ProviderRevocationTarget,
  ProviderSessionRevoker,
} from '../revocation';

export interface RecordedRevocation {
  scope: 'session' | 'allSessions';
  issuer: string;
  subject: string;
  originJti?: string;
  /** Whether ephemeral material was supplied — never the material itself. */
  ephemeralTokenPresent: boolean;
}

export class FakeProviderRevoker implements ProviderSessionRevoker {
  readonly recorded: RecordedRevocation[] = [];
  private failWith?: 'providerUnavailable' | 'notSupported';

  setFailure(reason?: 'providerUnavailable' | 'notSupported'): void {
    if (reason === undefined) {
      delete this.failWith;
    } else {
      this.failWith = reason;
    }
  }

  async revokeProviderSessions(
    target: ProviderRevocationTarget,
  ): Promise<ProviderRevocationOutcome> {
    this.recorded.push({
      scope: target.scope,
      issuer: target.issuer,
      subject: target.subject,
      ...(target.originJti !== undefined ? { originJti: target.originJti } : {}),
      ephemeralTokenPresent: target.ephemeralToken !== undefined,
    });
    if (this.failWith !== undefined) return { delivered: false, reason: this.failWith };
    return { delivered: true };
  }
}
