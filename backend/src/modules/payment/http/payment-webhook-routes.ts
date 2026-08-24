/**
 * W5-3 — the gateway webhook ingress (docs/33 §7, §17 W5-3; docs/24 §7.8).
 *
 * ONE machine-to-machine route: `POST /payments/webhook/<provider>`.
 * Deliberately `authPolicy: 'public'` — this endpoint is
 * STRIPE-authenticated, not Himma-authenticated: no LoginSession, no
 * provider/admin session, no CSRF; its entire authority is successful
 * signature verification against the endpoint signing secret (runtime
 * configuration — never a database row, a response, a log line, audit, or
 * outbox). An unsigned or forged POST has ZERO commercial effect and
 * creates no row. Conversely, a Himma session grants NOTHING here — a
 * customer/provider/admin bearer cannot substitute for a signature.
 *
 * RAW BODY: Stripe signs the exact bytes, so this route is registered in
 * its own encapsulated Fastify scope whose content-type parser preserves
 * the unmodified Buffer — the app-wide JSON parser never touches it, and
 * when the W5-5 customer routes later mount, they stay outside this scope.
 * The body is size-bounded (`bodyLimit`) and never logged.
 *
 * ACKNOWLEDGEMENT SEMANTICS (docs/33 §17 W5-3 §15): rejected
 * signature/body → 4xx (Stripe stops retrying bad deliveries); any
 * failure BEFORE the durable §7.8 receipt commits → 5xx via the app error
 * handler so Stripe retries; once the receipt is durable the route
 * answers 200 `{received:true}` — the follow-up processing pass runs
 * best-effort afterward and its failure NEVER turns a durable receipt
 * into a retry (the database, not this process, is the recovery point;
 * the catch-up sweep re-drives `received` rows).
 */
import type { FastifyInstance } from 'fastify';

import type { Db } from '../../../db/kysely';
import type { PaymentProviderPort } from '../provider-port';
import {
  ingestGatewayDelivery,
  processPendingGatewayEvents,
} from '../services/webhook-ingestion';

/** Bounded unauthenticated payload (real Stripe events are a few KiB). */
const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

export interface PaymentWebhookRouteDeps {
  db: Db;
  provider: PaymentProviderPort;
}

export function registerPaymentWebhookRoutes(
  app: FastifyInstance,
  deps: PaymentWebhookRouteDeps,
): void {
  // Encapsulated scope: the raw-bytes parser lives here and nowhere else.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, payload, done) => {
      done(null, payload);
    });

    scope.post(
      `/payments/webhook/${deps.provider.provider}`,
      {
        config: { authPolicy: 'public' },
        bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
      },
      async (request, reply) => {
        const rawBody = Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.alloc(0);
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers[name] = value;
          else if (Array.isArray(value) && typeof value[0] === 'string') {
            headers[name] = value[0];
          }
        }

        const result = await ingestGatewayDelivery(deps, rawBody, headers);
        if (result.kind === 'rejected') {
          // 4xx: Stripe does not retry these; nothing was recorded, and the
          // response carries no detail beyond the typed refusal.
          return reply.status(400).send({
            code: result.reason === 'malformed' ? 'malformedWebhook' : 'invalidWebhookSignature',
            message: 'Webhook delivery refused.',
          });
        }

        // Durable receipt committed — acknowledge now; processing follows
        // best-effort (the sweep recovers anything this pass leaves).
        await reply.status(200).send({ received: true });
        try {
          await processPendingGatewayEvents(deps);
        } catch (error) {
          request.log.error({ err: error }, 'gateway event processing deferred to sweep');
        }
        return reply;
      },
    );
  });
}
