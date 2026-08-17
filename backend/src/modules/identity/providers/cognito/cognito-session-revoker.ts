/**
 * CONCRETE production ProviderSessionRevoker (docs/26 §4.5–4.6, §9.6) —
 * W2-12A final correction. Closes the fake-only gap in the production
 * Cognito adapter set: logout's provider-side follow-up now has a real
 * implementation.
 *
 * Uses Cognito's `RevokeToken` operation for the PUBLIC portal app client
 * (unsigned JSON API — no AWS credential, no client secret): revoking the
 * session's refresh token invalidates that token chain provider-side.
 * Honest capability boundaries per the port's typed contract:
 *
 * - `session` scope WITH ephemeral refresh-token material → `RevokeToken`.
 * - `allSessions`, or `session` without token material → `notSupported`:
 *   Cognito's global sign-out is an ADMIN operation requiring signed AWS
 *   credentials, which the approved public-client architecture does not
 *   hold. This is safe by design — Himma's `login_session` revocation is
 *   the API-denial authority regardless (docs/26 §4.6), and the port's
 *   delivery status exists precisely so undelivered provider revocations
 *   can be retried by later operational tooling.
 *
 * Token material is pass-through only: never stored, logged, or echoed.
 * Provider errors collapse into the port's typed outcome.
 */
import type {
  ProviderRevocationOutcome,
  ProviderRevocationTarget,
  ProviderSessionRevoker,
} from '../revocation';
import {
  refreshClientIdOf,
  assertCompleteConfig,
  type CognitoAdapterConfig,
} from './config';
import type { RefreshFetchLike } from './cognito-token-refresher';

export class CognitoSessionRevoker implements ProviderSessionRevoker {
  private readonly endpoint: string;
  private readonly clientId: string;
  private readonly fetchImpl: RefreshFetchLike;

  constructor(
    config: CognitoAdapterConfig,
    options: { fetchImpl?: RefreshFetchLike } = {},
  ) {
    assertCompleteConfig(config);
    this.endpoint = `${new URL(config.issuer).origin}/`;
    this.clientId = refreshClientIdOf(config);
    this.fetchImpl =
      options.fetchImpl ??
      ((input, init) => globalThis.fetch(input, init) as ReturnType<RefreshFetchLike>);
  }

  async revokeProviderSessions(
    target: ProviderRevocationTarget,
  ): Promise<ProviderRevocationOutcome> {
    if (target.scope !== 'session' || target.ephemeralToken === undefined) {
      return { delivered: false, reason: 'notSupported' };
    }
    let response: Awaited<ReturnType<RefreshFetchLike>>;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'AWSCognitoIdentityProviderService.RevokeToken',
        },
        body: JSON.stringify({
          ClientId: this.clientId,
          Token: target.ephemeralToken,
        }),
      });
    } catch {
      return { delivered: false, reason: 'providerUnavailable' };
    }
    if (!response.ok) {
      // An already-revoked/unknown token is converged state provider-side;
      // service failures stay retryable.
      return response.status >= 500
        ? { delivered: false, reason: 'providerUnavailable' }
        : { delivered: true };
    }
    return { delivered: true };
  }
}
