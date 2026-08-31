/**
 * RI-1/RI-6 — the DEVELOPMENT-ONLY token-acquisition gateway targeting
 * the backend's /dev/identity routes (the certified Cognito stand-in;
 * its backend half refuses to compose in production). This module is
 * loaded ONLY through the `__DEV__`-eliminated branch of the identity
 * gateway selection, so production bundles contain none of it.
 */
import type { IdentityGateway, IdentityTokens } from '@/services/contracts/identity';
import type { HttpClient } from '@/services/http/http-client';

export function createDevIdentityGateway(client: HttpClient): IdentityGateway {
  return {
    async signUp(input) {
      return client.request<IdentityTokens>('POST', '/dev/identity/signup', {
        body: input,
        auth: false,
      });
    },
    async signIn(input) {
      return client.request<IdentityTokens>('POST', '/dev/identity/signin', {
        body: input,
        auth: false,
      });
    },
    async refresh(refreshToken) {
      return client.request<{ accessToken: string; expiresAt: string }>(
        'POST',
        '/dev/identity/refresh',
        { body: { refreshToken }, auth: false },
      );
    },
  };
}
