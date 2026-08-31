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
  // RI-3 — booking/checkout outcomes (the certified vocabulary; customer-
  // safe wording only, no internals):
  sessionFull: 'This session just filled up. Pick another time.',
  registrationClosed: 'Registration for this session has closed.',
  participantIneligible: 'This participant can’t join this program.',
  quoteExpired: 'The price check expired. We’ll refresh it for you.',
  invalidQuote: 'Something changed with this booking. Let’s start again.',
  holdExpired: 'Your held spot expired. Check availability to book again.',
  holdNotActive: 'Your held spot is no longer active. Check availability to book again.',
  holdAlreadyActive: 'You already have a spot held for this session.',
  alreadyBooked: 'This participant is already booked for this session.',
  alreadyConfirmed: 'This booking is already confirmed.',
  trialAlreadyRedeemed: 'This trial has already been used for this participant.',
  notFreeQuote: 'This booking needs payment to complete.',
  paymentNotRequired: 'No payment is needed for this booking.',
  // A missing provider commercial configuration is INTERNAL — customers
  // only ever learn that payment is unavailable right now.
  paymentUnavailable: 'Payments are temporarily unavailable. Please try again later.',
  checkoutAlreadyActive: 'A payment for this booking is already in progress.',
  checkoutConcluded: 'This checkout has already finished. Check your bookings.',
  checkoutCreateFailed: 'We couldn’t start the payment. Please try again.',
  checkoutPending: 'We’re still preparing your payment. Try again in a moment.',
  policyUnavailable: 'Booking is temporarily unavailable. Please try again later.',
  idempotencyConflict: 'That request was already processed. Refresh and check your bookings.',
  // RI-4 — Passes & Memberships / check-in outcomes (the certified S6
  // vocabulary; customer-safe wording only, no internals):
  fulfillmentUnavailable: 'This option isn’t available right now. Please try again later.',
  entitlementNotActive: 'This pass isn’t active right now.',
  entitlementExhausted: 'This pass has no visits left.',
  entitlementFullyCommitted:
    'All remaining visits on this pass are reserved for upcoming sessions.',
  reservationNotPermitted: 'This pass doesn’t use session reservations.',
  reservationRequired: 'This pass checks in through a booked session.',
  occurrenceRequired: 'Choose which day you’re checking in for.',
  occurrenceNotApplicable: 'This booking has a single session — no day selection is needed.',
  occurrenceNotEligible: 'That day and time isn’t part of this booking.',
  outsideCheckInWindow: 'Check-in opens closer to your session time.',
  alreadyCheckedIn: 'This session is already checked in.',
  credentialExpired: 'This code has expired. Generate a new one to check in.',
  credentialAlreadyUsed: 'This code has already been used.',
};

export function customerErrorCopy(error: unknown): string {
  if (error instanceof NetworkError) return OFFLINE;
  if (error instanceof ApiError) return COPY[error.code] ?? GENERIC;
  return GENERIC;
}
