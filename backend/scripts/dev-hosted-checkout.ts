/**
 * RI-3 — the DEV hosted-checkout stand-in (owner RI-3 §13/§31).
 *
 * These routes play the PROVIDER'S OWN hosted pages, exactly the way
 * Stripe's checkout.stripe.com does: the customer's browser lands on the
 * redirect URL the certified W5 orchestration returned, presses Pay (or
 * Cancel), and the PROVIDER — not the browser, not the app — delivers the
 * signed gateway webhook through the certified trusted ingress
 * (`/payments/webhook/deterministicTest`, signature over raw bytes). The
 * browser/app never calls a trusted payment-success endpoint; browser
 * return remains navigation only.
 *
 * Delivery is two-phase with a small delay so the REAL intermediate
 * customer states are observable end-to-end:
 *   t+delay   `checkout.completed` (evidence recorded; the saga defers —
 *             provider inspection still reports pending) → `processing`
 *   t+2×delay provider capture + `payment.captured` → the certified W5-4
 *             saga confirms the Booking.
 *
 * DEV ONLY: registered exclusively by dev-server.ts (which refuses
 * production), over the deterministic provider (which provider-composition
 * refuses in production). Nothing here exists in buildApp.
 */
import type { FastifyInstance } from 'fastify';

import type { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';

export interface DevHostedCheckoutDeps {
  provider: DeterministicPaymentProvider;
  checkoutUrls: { successUrl: string; cancelUrl: string };
  webhookDelayMs: number;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function registerDevHostedCheckout(
  app: FastifyInstance,
  deps: DevHostedCheckoutDeps,
): void {
  let eventSerial = 0;

  async function deliverSignedWebhook(input: {
    eventType: 'checkout.completed' | 'payment.captured' | 'checkout.expired';
    gatewayRef: string;
    gatewayTransactionId?: string;
  }): Promise<void> {
    eventSerial += 1;
    const delivery = deps.provider.buildWebhookDelivery({
      gatewayEventId: `dt_evt_${input.gatewayRef}_${eventSerial}`,
      eventType: input.eventType,
      gatewayRef: input.gatewayRef,
      ...(input.gatewayTransactionId !== undefined
        ? { gatewayTransactionId: input.gatewayTransactionId }
        : {}),
    });
    // Provider→Himma delivery through the certified trusted ingress —
    // in-process transport, identical bytes/headers/verification.
    await app.inject({
      method: 'POST',
      url: '/payments/webhook/deterministicTest',
      payload: delivery.rawBody,
      headers: { ...delivery.headers, 'content-type': 'application/json' },
    });
  }

  // The provider's hosted page: shows the server-inspected amount and a
  // Pay / Cancel choice. Pure provider-side presentation.
  app.get(
    '/dev/payments/hosted/:gatewayRef',
    { config: { authPolicy: 'public' } },
    async (request, reply) => {
      const { gatewayRef } = request.params as { gatewayRef: string };
      const inspection = await deps.provider.inspectPayment(gatewayRef);
      if (inspection.kind !== 'payment') {
        return reply.status(404).type('text/html').send('<h1>Unknown checkout session</h1>');
      }
      const amount = `AED ${((inspection.amountFils ?? 0) / 100).toLocaleString('en-US')}`;
      return reply.type('text/html').send(`<!doctype html>
<title>Deterministic Checkout (dev)</title>
<main style="font-family: system-ui; max-width: 420px; margin: 15vh auto; text-align: center;">
  <h1 style="font-size:20px">Deterministic Checkout</h1>
  <p>Development payment stand-in — no real money exists here.</p>
  <p style="font-size:28px; font-weight:700">${escapeHtml(amount)}</p>
  <form method="post" action="/dev/payments/hosted/${escapeHtml(gatewayRef)}/pay">
    <button type="submit" data-testid="dev-pay"
      style="font-size:16px; padding:12px 32px; border-radius:8px;">Pay</button>
  </form>
  <p><a href="${escapeHtml(deps.checkoutUrls.cancelUrl)}" data-testid="dev-cancel">Cancel and return</a></p>
</main>`);
    },
  );

  // The customer pressed Pay ON THE PROVIDER'S PAGE (a plain HTML form —
  // urlencoded body, parsed as an ignored string). The provider records
  // the capture and delivers its signed webhooks (two-phase, delayed);
  // the browser is redirected back to the app — pure navigation.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.post(
    '/dev/payments/hosted/:gatewayRef/pay',
    { config: { authPolicy: 'public' } },
    async (request, reply) => {
      const { gatewayRef } = request.params as { gatewayRef: string };
      const inspection = await deps.provider.inspectPayment(gatewayRef);
      if (inspection.kind !== 'payment') {
        return reply.status(404).type('text/html').send('<h1>Unknown checkout session</h1>');
      }
      const delay = Math.max(0, deps.webhookDelayMs);
      setTimeout(() => {
        // Phase 1: completion evidence WITHOUT capture — the certified
        // saga inspects, sees pending, and defers (customer: processing).
        void deliverSignedWebhook({ eventType: 'checkout.completed', gatewayRef }).catch(() => {});
      }, delay);
      setTimeout(() => {
        // Phase 2: the provider captures and says so — the certified saga
        // corroborates via inspection and confirms the Booking.
        deps.provider.completeCheckout(gatewayRef);
        void deliverSignedWebhook({
          eventType: 'payment.captured',
          gatewayRef,
          gatewayTransactionId: `dt_txn_${gatewayRef}`,
        }).catch(() => {});
      }, delay * 2);
      return reply.redirect(deps.checkoutUrls.successUrl, 303);
    },
  );

  // Dev observability for tests: provider-side counters only (proves the
  // free path creates NO session and the paid path exactly one).
  app.get(
    '/dev/payments/state',
    { config: { authPolicy: 'public' } },
    async (_request, reply) =>
      reply.send({
        createRequestCount: deps.provider.createRequestCount,
        sessionCount: deps.provider.sessionCount,
      }),
  );
}
