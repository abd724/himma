import type { MfaError, SignInError } from '../../auth/session-machine';

/**
 * Safe, non-enumerating access copy (task §19). Canon messages from the
 * backend outcome vocabulary are reused verbatim where they exist; nothing
 * here reveals whether an account exists or why a session really ended.
 */
export const SIGN_IN_ERROR_COPY: Record<SignInError, string> = {
  invalidCredentials: 'Sign-in could not be completed with the provided credentials.',
  accountSuspended: 'This account is currently unavailable. Contact support for help.',
  rateLimited: 'Too many attempts. Please try again later.',
  providerUnavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
  challengeExpired: 'That verification code expired. Sign in again to get a new one.',
  failure: 'Something went wrong. Please try again.',
};

export const MFA_ERROR_COPY: Record<MfaError, string> = {
  invalidCode: "That code didn't work. Check your authenticator app and try again.",
  rateLimited: 'Too many attempts. Please try again later.',
  failure: 'Something went wrong. Please try again.',
};

/** Canon `sessionExpired` message, shown when a session ends mid-use. */
export const SESSION_ENDED_COPY = 'Your session has ended. Please sign in again.';
