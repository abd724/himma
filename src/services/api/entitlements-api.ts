/**
 * RI-4 — the HTTP adapter for the Passes & Memberships contract. Thin,
 * typed, bearer-authenticated (the certified `authenticatedCustomer`
 * surface). The customer authors ONLY identifiers, idempotency context,
 * and — for multi-occurrence check-in — the SERVER-derived canonical
 * occurrence pair passed back verbatim. Typed `ApiError`s pass through
 * untouched — screens map codes to customer copy via error-copy.ts.
 *
 * Secrets: `displayCode`/`token` appear only in the issuance response and
 * are handed straight to the caller — this module never stores or logs
 * them.
 */
import type {
  AcquisitionCheckoutStart,
  AcquisitionPaymentStatus,
  AcquisitionQuote,
  CalendarOccurrence,
  ConfirmedReservation,
  CredentialStatus,
  CustomerEntitlement,
  EntitlementPurchaseView,
  EntitlementsApi,
  IssueCredentialOutcome,
  IssuedCredential,
  ReservableSession,
  ReservationQuote,
} from '@/services/contracts/entitlements';
import { ApiError, type HttpClient } from '@/services/http/http-client';

function listQuery(input: { limit?: number; cursor?: string } = {}): string {
  const query = new URLSearchParams();
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.cursor !== undefined) query.set('cursor', input.cursor);
  return query.toString() === '' ? '' : `?${query.toString()}`;
}

/** The issuance responses share one wire shape; `alreadyLive` (HTTP 200)
 *  carries metadata WITHOUT secrets, a 201 carries the one-time secrets. */
function toIssueOutcome(body: {
  credential: IssuedCredential & { alreadyLive?: boolean };
}): IssueCredentialOutcome {
  const credential = body.credential;
  if (credential.alreadyLive === true) {
    return {
      kind: 'alreadyLive',
      credential: {
        credentialId: credential.credentialId,
        expiresAt: credential.expiresAt,
        alreadyLive: true,
      },
    };
  }
  return { kind: 'issued', credential };
}

export function createEntitlementsApi(client: HttpClient): EntitlementsApi {
  return {
    async listEntitlements(input = {}) {
      return client.request('GET', `/customer/entitlements${listQuery(input)}`);
    },

    async getEntitlement(entitlementId) {
      try {
        const body = await client.request<{ entitlement: CustomerEntitlement }>(
          'GET',
          `/customer/entitlements/${entitlementId}`,
        );
        return body.entitlement;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
      }
    },

    async listAttendance(entitlementId, input = {}) {
      return client.request(
        'GET',
        `/customer/entitlements/${entitlementId}/attendance${listQuery(input)}`,
      );
    },

    async listReservableSessions(entitlementId, input = {}) {
      const query = new URLSearchParams();
      if (input.from !== undefined) query.set('from', input.from);
      if (input.to !== undefined) query.set('to', input.to);
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
      return client.request<{ sessions: ReservableSession[]; finite?: ReservationQuote['finite'] }>(
        'GET',
        `/customer/entitlements/${entitlementId}/reservable-sessions${suffix}`,
      );
    },

    async requestReservationQuote(entitlementId, sessionId) {
      const body = await client.request<{ quote: ReservationQuote }>(
        'POST',
        `/customer/entitlements/${entitlementId}/reservation-quote`,
        { body: { sessionId } },
      );
      return body.quote;
    },

    async confirmReservation(holdId, idempotencyKey) {
      const body = await client.request<{ reservation: ConfirmedReservation }>(
        'POST',
        '/customer/entitlement-reservations/confirm',
        { body: { holdId, idempotencyKey } },
      );
      return body.reservation;
    },

    async requestAcquisitionQuote(input) {
      const body = await client.request<{ quote: AcquisitionQuote }>(
        'POST',
        '/customer/entitlement-purchases/quote',
        { body: input },
      );
      return body.quote;
    },

    async confirmFreeAcquisition(quoteId, idempotencyKey) {
      const body = await client.request<{ purchase: EntitlementPurchaseView }>(
        'POST',
        '/customer/entitlement-purchases/confirm-free',
        { body: { quoteId, idempotencyKey } },
      );
      return body.purchase;
    },

    async initiateAcquisition(quoteId, idempotencyKey) {
      const body = await client.request<{ checkout: AcquisitionCheckoutStart }>(
        'POST',
        '/customer/entitlement-purchases/initiate',
        { body: { quoteId, idempotencyKey } },
      );
      return body.checkout;
    },

    async acquisitionPaymentStatus(purchaseId) {
      const body = await client.request<{ payment: AcquisitionPaymentStatus }>(
        'GET',
        `/customer/entitlement-purchases/${purchaseId}/payment`,
      );
      return body.payment;
    },

    async getPurchase(purchaseId) {
      try {
        const body = await client.request<{ purchase: EntitlementPurchaseView }>(
          'GET',
          `/customer/entitlement-purchases/${purchaseId}`,
        );
        return body.purchase;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
      }
    },

    async issueBookingCredential(bookingId, input) {
      const body = await client.request<{ credential: IssuedCredential }>(
        'POST',
        `/customer/bookings/${bookingId}/credential`,
        {
          body: {
            idempotencyKey: input.idempotencyKey,
            ...(input.occurrence !== undefined ? { occurrence: input.occurrence } : {}),
            ...(input.regenerateCredentialId !== undefined
              ? { regenerateCredentialId: input.regenerateCredentialId }
              : {}),
          },
        },
      );
      return toIssueOutcome(body);
    },

    async issueEntitlementCredential(entitlementId, input) {
      const body = await client.request<{ credential: IssuedCredential }>(
        'POST',
        `/customer/entitlements/${entitlementId}/credential`,
        {
          body: {
            idempotencyKey: input.idempotencyKey,
            ...(input.regenerateCredentialId !== undefined
              ? { regenerateCredentialId: input.regenerateCredentialId }
              : {}),
          },
        },
      );
      return toIssueOutcome(body);
    },

    async credentialStatus(credentialId) {
      try {
        const body = await client.request<{ credential: CredentialStatus }>(
          'GET',
          `/customer/credentials/${credentialId}`,
        );
        return body.credential;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
      }
    },

    async listOccurrences(input) {
      const body = await client.request<{ events: CalendarOccurrence[] }>(
        'GET',
        `/customer/calendar?from=${input.from}&to=${input.to}`,
      );
      return body.events;
    },
  };
}
