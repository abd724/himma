/**
 * RI-3 — the HTTP adapter for the customer commerce contract. Thin, typed,
 * bearer-authenticated (the certified `authenticatedCustomer` surface);
 * every request carries identifiers + idempotency context only. Typed
 * `ApiError`s pass through untouched — screens map codes to customer copy
 * via error-copy.ts, never here.
 */
import type {
  CapacityHold,
  CheckoutStart,
  CommerceApi,
  ConfirmedBooking,
  CustomerBooking,
  CustomerPaymentStatus,
  HoldRequest,
  HoldStatus,
  Quote,
  QuoteRequest,
} from '@/services/contracts/commerce';
import { ApiError, type HttpClient } from '@/services/http/http-client';

export function createCommerceApi(client: HttpClient): CommerceApi {
  return {
    async requestQuote(input: QuoteRequest): Promise<Quote> {
      const body = await client.request<{ quote: Quote }>('POST', '/customer/quotes', {
        body: input,
      });
      return body.quote;
    },

    async claimHold(input: HoldRequest): Promise<CapacityHold> {
      const body = await client.request<{ hold: CapacityHold }>('POST', '/customer/holds', {
        body: input,
      });
      return body.hold;
    },

    async holdStatus(holdId: string): Promise<HoldStatus> {
      const body = await client.request<{ hold: HoldStatus }>(
        'GET',
        `/customer/holds/${holdId}`,
      );
      return body.hold;
    },

    async releaseHold(holdId: string, idempotencyKey: string) {
      const body = await client.request<{ status: 'holdReleased' | 'holdExpired' }>(
        'POST',
        `/customer/holds/${holdId}/release`,
        { body: { idempotencyKey } },
      );
      return body.status;
    },

    async confirmFree(holdId: string, idempotencyKey: string): Promise<ConfirmedBooking> {
      const body = await client.request<{ booking: ConfirmedBooking }>(
        'POST',
        '/customer/bookings/confirm-free',
        { body: { holdId, idempotencyKey } },
      );
      return body.booking;
    },

    async initiateCheckout(input): Promise<CheckoutStart> {
      const body = await client.request<{ checkout: CheckoutStart }>(
        'POST',
        '/customer/bookings/initiate',
        { body: input },
      );
      return body.checkout;
    },

    async paymentStatus(bookingId: string): Promise<CustomerPaymentStatus> {
      const body = await client.request<{ payment: CustomerPaymentStatus }>(
        'GET',
        `/customer/bookings/${bookingId}/payment`,
      );
      return body.payment;
    },

    async listBookings(input = {}) {
      const query = new URLSearchParams();
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      if (input.cursor !== undefined) query.set('cursor', input.cursor);
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
      return client.request('GET', `/customer/bookings${suffix}`);
    },

    async getBooking(bookingId: string): Promise<CustomerBooking | undefined> {
      try {
        const body = await client.request<{ booking: CustomerBooking }>(
          'GET',
          `/customer/bookings/${bookingId}`,
        );
        return body.booking;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
      }
    },
  };
}
