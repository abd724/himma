/**
 * RI-6 — the PRODUCTION identity boundary (owner items 8/9): exactly one
 * place decides which token-acquisition gateway a build composes.
 *
 * Selection (fail-closed, in order):
 * 1. Real Cognito configuration present (`EXPO_PUBLIC_COGNITO_ISSUER` +
 *    `EXPO_PUBLIC_COGNITO_CLIENT_ID`, both public values) → the REAL
 *    Cognito gateway. Partial or malformed configuration throws at
 *    startup — a misconfigured build never half-works.
 * 2. Development build (`__DEV__`) → the certified dev identity stand-in
 *    (its backend half is itself production-impossible — `buildApp`
 *    throws when composed with NODE_ENV=production).
 * 3. Production WITHOUT Cognito configuration → a fail-closed gateway:
 *    every operation refuses with the typed `authNotConfigured` outcome.
 *    Production email/password NEVER routes through the dev stand-in and
 *    success is never faked (D-RI-3) — the real pool remains a recorded
 *    operational launch gate.
 */
import { createCognitoIdentityGateway } from '@/services/auth/cognito-identity-gateway';
import type { IdentityGateway } from '@/services/contracts/identity';
import type { HttpClient } from '@/services/http/http-client';
import { ApiError } from '@/services/http/http-client';

export interface CognitoPublicConfig {
  issuer: string;
  clientId: string;
}

/** Parse-and-validate the PUBLIC Cognito client configuration. Returns
 *  undefined when wholly absent; throws on partial/insecure values (the
 *  backend `parseCognitoConfig` fail-closed discipline). */
export function cognitoPublicConfig(env: {
  issuer?: string;
  clientId?: string;
}): CognitoPublicConfig | undefined {
  const issuer = env.issuer?.trim() ?? '';
  const clientId = env.clientId?.trim() ?? '';
  if (issuer === '' && clientId === '') return undefined;
  if (issuer === '' || clientId === '') {
    throw new Error(
      'Cognito configuration is partial: EXPO_PUBLIC_COGNITO_ISSUER and EXPO_PUBLIC_COGNITO_CLIENT_ID must both be set (or neither).',
    );
  }
  if (!issuer.startsWith('https://')) {
    throw new Error('EXPO_PUBLIC_COGNITO_ISSUER must be an https URL.');
  }
  return { issuer, clientId };
}

/** The production refusal gateway — typed, honest, never a fake session. */
export function createUnconfiguredIdentityGateway(): IdentityGateway {
  const refuse = (): never => {
    throw new ApiError(
      503,
      'authNotConfigured',
      'Sign-in is not configured for this build.',
    );
  };
  return {
    async signUp() {
      return refuse();
    },
    async signIn() {
      return refuse();
    },
    async refresh() {
      return refuse();
    },
  };
}

export function selectIdentityGateway(input: {
  isDevBuild: boolean;
  cognito: CognitoPublicConfig | undefined;
  httpClient: HttpClient;
}): IdentityGateway {
  if (input.cognito !== undefined) return createCognitoIdentityGateway(input.cognito);
  // The `__DEV__` guard is what lets Metro DROP the dev gateway module
  // from a production bundle entirely (inline require inside an
  // eliminated branch); `isDevBuild` carries the same value explicitly so
  // the selection stays unit-testable.
  if (__DEV__ && input.isDevBuild) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dev = require('@/services/api/dev-identity-gateway') as
      typeof import('@/services/api/dev-identity-gateway');
    return dev.createDevIdentityGateway(input.httpClient);
  }
  return createUnconfiguredIdentityGateway();
}
