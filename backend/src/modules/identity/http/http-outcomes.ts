/**
 * Service-outcome → HTTP envelope mapping (docs/24 §11.2, docs/26 §10) —
 * B2-4. One stable envelope `{ code, message }`; nothing here ever exposes
 * PostgreSQL constraint names, provider/JWKS errors, stack traces, raw
 * provider responses, or account-existence information.
 *
 * External vocabulary is the docs/26 §10 set. Deliberate collapses
 * (documented, internally the outcomes stay fully typed):
 * - accountLocked / accountSuspended / accountDeleted → `accountSuspended`
 *   (the §3.8 single non-specific customer message);
 * - sessionNotRegistered / sessionRevoked / sessionExpired / identityEnded
 *   on BEARER requests → `sessionExpired` (revocation state is not leaked);
 * - login-flow evidence failures → `invalidCredentials` (single class,
 *   §5.5); bearer failures → `invalidAccessToken`.
 */
import type { FastifyReply } from 'fastify';

export interface HttpOutcome {
  statusCode: number;
  code: string;
  message: string;
}

export const HTTP_OUTCOMES = {
  invalidAccessToken: {
    statusCode: 401,
    code: 'invalidAccessToken',
    message: 'A valid access token is required.',
  },
  invalidCredentials: {
    statusCode: 401,
    code: 'invalidCredentials',
    message: 'Sign-in could not be completed with the provided credentials.',
  },
  sessionExpired: {
    statusCode: 401,
    code: 'sessionExpired',
    message: 'Your session has ended. Please sign in again.',
  },
  accountSuspended: {
    statusCode: 403,
    code: 'accountSuspended',
    message: 'This account is currently unavailable. Contact support for help.',
  },
  stepUpRequired: {
    statusCode: 403,
    code: 'stepUpRequired',
    message: 'Please re-authenticate to continue.',
  },
  mfaRequired: {
    statusCode: 403,
    code: 'mfaRequired',
    message: 'Multi-factor authentication is required for this action.',
  },
  dualControlViolation: {
    statusCode: 409,
    code: 'dualControlViolation',
    message: 'A different Access Administrator must approve this request.',
  },
  roleConflict: {
    statusCode: 409,
    code: 'roleConflict',
    message: 'This role conflicts with a role the user already holds.',
  },
  assignmentAlreadyFinalized: {
    statusCode: 409,
    code: 'assignmentAlreadyFinalized',
    message: 'This assignment has already been finalized.',
  },
  forbidden: {
    statusCode: 403,
    code: 'forbidden',
    message: 'You do not have access to this resource.',
  },
  notFound: {
    statusCode: 404,
    code: 'notFound',
    message: 'The requested resource was not found.',
  },
  accountLinkConflict: {
    statusCode: 409,
    code: 'accountLinkConflict',
    message:
      'This sign-in method conflicts with an existing account. Sign in with your existing method, then link it explicitly.',
  },
  identityAlreadyLinked: {
    statusCode: 409,
    code: 'identityAlreadyLinked',
    message: 'This sign-in method is already linked to a different account.',
  },
  lastLoginMethod: {
    statusCode: 409,
    code: 'lastLoginMethod',
    message: 'This is your only sign-in method and cannot be removed.',
  },
  challengeInvalid: {
    statusCode: 400,
    code: 'challengeInvalid',
    message: 'The verification could not be completed. Request a new challenge and try again.',
  },
  staleVersion: {
    statusCode: 409,
    code: 'staleVersion',
    message: 'The resource changed since you loaded it. Refresh and try again.',
  },
  rateLimited: {
    statusCode: 429,
    code: 'rateLimited',
    message: 'Too many attempts. Please try again later.',
  },
  providerUnavailable: {
    statusCode: 503,
    code: 'providerUnavailable',
    message: 'Sign-in is temporarily unavailable. Please try again shortly.',
  },
  internalError: {
    statusCode: 500,
    code: 'internalError',
    message: 'Internal error',
  },
} as const satisfies Record<string, HttpOutcome>;

export type HttpOutcomeName = keyof typeof HTTP_OUTCOMES;

export function sendOutcome(
  reply: FastifyReply,
  name: HttpOutcomeName,
  headers: Record<string, string> = {},
): FastifyReply {
  const outcome = HTTP_OUTCOMES[name];
  for (const [header, value] of Object.entries(headers)) {
    void reply.header(header, value);
  }
  return reply
    .status(outcome.statusCode)
    .send({ code: outcome.code, message: outcome.message });
}

/** Bearer-pipeline liveness outcomes → external vocabulary. */
export function livenessOutcomeName(
  kind:
    | 'invalidAccessToken'
    | 'sessionNotRegistered'
    | 'sessionExpired'
    | 'sessionRevoked'
    | 'identityEnded'
    | 'accountLocked'
    | 'accountSuspended'
    | 'accountDeleted',
): HttpOutcomeName {
  switch (kind) {
    case 'invalidAccessToken':
      return 'invalidAccessToken';
    case 'sessionNotRegistered':
    case 'sessionExpired':
    case 'sessionRevoked':
    case 'identityEnded':
      return 'sessionExpired';
    case 'accountLocked':
    case 'accountSuspended':
    case 'accountDeleted':
      return 'accountSuspended';
  }
}
