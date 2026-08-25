/**
 * RI-1 — DEVELOPMENT-ONLY token-acquisition routes (D-RI-3).
 *
 * These three routes stand in for the real Cognito CLIENT flows (sign-up /
 * sign-in / refresh happen against Cognito itself in production — they are
 * NOT part of the certified Himma API and never will be). They exist so the
 * Customer App can acquire provider-shaped tokens against a local backend
 * and then use the CERTIFIED surface unchanged: `POST /auth/session`,
 * bearer-authenticated requests, `/me`, logout — all real, all PostgreSQL.
 *
 * Structural boundaries:
 * - Registered ONLY when `buildApp` receives the dev-identity composition;
 *   `buildApp` REFUSES that composition in production (test-pinned) — the
 *   routes are structurally absent there, like the deterministic payment
 *   provider.
 * - Responses carry provider-shaped token material ONLY (what a Cognito
 *   client SDK would hold); no Himma session is created here.
 * - Credentials are never logged; failures collapse to typed classes.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { DevPasswordIdentityProvider } from '../providers/dev/dev-password-identity';

const BODY_LIMIT = 16_384;
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const TokenBundle = Type.Object({
  accessToken: Type.String(),
  idToken: Type.String(),
  refreshToken: Type.String(),
  expiresAt: Type.String(),
});

export interface DevIdentityRouteDeps {
  provider: DevPasswordIdentityProvider;
}

export function registerDevIdentityRoutes(
  rawApp: FastifyInstance,
  deps: DevIdentityRouteDeps,
): void {
  const app = rawApp.withTypeProvider<TypeBoxTypeProvider>();

  app.post(
    '/dev/identity/signup',
    {
      config: { authPolicy: 'unauthenticatedAuthFlow' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          {
            email: Type.String({ minLength: 3, maxLength: 320 }),
            password: Type.String({ minLength: 1, maxLength: 256 }),
            displayName: Type.Optional(Type.String({ maxLength: 120 })),
          },
          { additionalProperties: false },
        ),
        response: { 201: TokenBundle, 401: ErrorBody, 409: ErrorBody, 422: ErrorBody },
      },
    },
    async (request, reply) => {
      const result = deps.provider.signUp(request.body);
      if (result.kind === 'emailTaken') {
        return reply
          .status(409)
          .send({ code: 'emailTaken', message: 'An account with this email already exists.' });
      }
      if (result.kind === 'invalidEmail' || result.kind === 'weakPassword') {
        return reply.status(422).send({
          code: result.kind,
          message:
            result.kind === 'invalidEmail'
              ? 'Enter a valid email address.'
              : 'Password must be at least 8 characters.',
        });
      }
      return reply.status(201).send({
        accessToken: result.tokens.accessToken,
        idToken: result.tokens.idToken,
        refreshToken: result.tokens.refreshToken,
        expiresAt: result.tokens.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/dev/identity/signin',
    {
      config: { authPolicy: 'unauthenticatedAuthFlow' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          {
            email: Type.String({ minLength: 3, maxLength: 320 }),
            password: Type.String({ minLength: 1, maxLength: 256 }),
          },
          { additionalProperties: false },
        ),
        response: { 200: TokenBundle, 401: ErrorBody },
      },
    },
    async (request, reply) => {
      const result = deps.provider.signIn(request.body);
      if (result.kind !== 'signedIn') {
        return reply
          .status(401)
          .send({ code: 'invalidCredentials', message: 'Email or password is incorrect.' });
      }
      return reply.status(200).send({
        accessToken: result.tokens.accessToken,
        idToken: result.tokens.idToken,
        refreshToken: result.tokens.refreshToken,
        expiresAt: result.tokens.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/dev/identity/refresh',
    {
      config: { authPolicy: 'unauthenticatedAuthFlow' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          { refreshToken: Type.String({ minLength: 8, maxLength: 4096 }) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ accessToken: Type.String(), expiresAt: Type.String() }),
          401: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const result = deps.provider.refresh(request.body.refreshToken);
      if (result.kind !== 'refreshed') {
        return reply
          .status(401)
          .send({ code: 'sessionExpired', message: 'Please sign in again.' });
      }
      return reply
        .status(200)
        .send({ accessToken: result.accessToken, expiresAt: result.expiresAt.toISOString() });
    },
  );
}
