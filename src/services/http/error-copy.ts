/**
 * RI-1 — customer-safe copy for real-API failures. Backend outcome codes
 * stay diagnostic (tests/logs); customers see simple, safe language. Only
 * codes with a MEANINGFUL customer action get specific copy — everything
 * else collapses to the generic line.
 */
import { ApiError, NetworkError } from './http-client';

const GENERIC = 'Something went wrong. Please try again.';
const OFFLINE = 'Connection problem. Check your internet and try again.';

const COPY: Record<string, string> = {
  invalidCredentials: 'Email or password is incorrect.',
  emailTaken: 'An account with this email already exists. Try signing in.',
  weakPassword: 'Password must be at least 8 characters.',
  invalidEmail: 'Enter a valid email address.',
  sessionExpired: 'Your session has expired. Please sign in again.',
  accountSuspended: 'This account is currently unavailable. Contact support for help.',
  rateLimited: 'Too many attempts. Please wait a moment and try again.',
  invalidParticipant: 'Please check the name and date of birth.',
  participantArchived: 'This profile has been archived.',
  cannotArchiveSelf: 'Your own profile cannot be removed.',
  staleVersion: 'This profile changed on another device. Refresh and try again.',
  validationError: 'Please check the details and try again.',
  providerUnavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
};

export function customerErrorCopy(error: unknown): string {
  if (error instanceof NetworkError) return OFFLINE;
  if (error instanceof ApiError) return COPY[error.code] ?? GENERIC;
  return GENERIC;
}
