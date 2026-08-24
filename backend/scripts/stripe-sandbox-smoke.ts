/**
 * W5-2 — the OPERATIONAL Stripe sandbox smoke (docs/33 §17 W5-2 §15).
 *
 * Runs the bounded real-network proof against Stripe TEST MODE:
 *   1. real hosted Checkout Session creation (payment mode, AED,
 *      server-authored amount/references);
 *   2. the returned session's AED amount equals the Himma amount;
 *   3. provider request idempotency: re-sending the SAME key returns the
 *      SAME session (never a second charge opportunity);
 *   4. inspect/retrieve maps into the closed Himma vocabulary;
 *   5. explicit expire works, and re-expiring reports truthfully;
 *   6. no raw card data crosses Himma anywhere (nothing card-shaped exists
 *      in the request or in what we persist — the deterministic suite pins
 *      the schema side).
 *
 * DELIBERATELY SEPARATE from CI certification: this script needs a real
 * `STRIPE_SECRET_KEY` TEST-mode credential (owner-provided, D-W5-6 — via
 * `.env` in development). Without one it EXITS NON-ZERO with a clear
 * message — the smoke is never faked and never "passes" vacuously.
 *
 *   npm run stripe:smoke
 */
import { randomUUID } from 'node:crypto';

import { isStripeTestModeKey, StripeDriver } from '../src/modules/payment/stripe-driver';
import { cliConfig, fail } from './cli-env';

async function main(): Promise<void> {
  const config = cliConfig();
  if (config.nodeEnv === 'production') {
    throw new Error('The sandbox smoke never runs against production.');
  }
  const secretKey = config.stripe?.secretKey;
  if (secretKey === undefined) {
    throw new Error(
      'OPERATIONAL DEPENDENCY NOT MET: no STRIPE_SECRET_KEY is configured. ' +
        'Provide the owner-supplied Stripe TEST-mode key (D-W5-6) in .env and re-run. ' +
        'This smoke is required before W5-2 can claim real-sandbox certification — it is never faked.',
    );
  }
  if (!isStripeTestModeKey(secretKey)) {
    throw new Error(
      'Refusing to run: STRIPE_SECRET_KEY is not a TEST-mode key. ' +
        'Live charging is gated on D-W5-3 + docs/23 §19 (docs/33 §14.1).',
    );
  }

  const driver = new StripeDriver({ secretKey });
  const intentId = `smoke-${randomUUID()}`;
  const idempotencyKey = `himma:checkout:${intentId}:1`;
  const amountFils = 5000; // AED 50.00
  const report: string[] = [];

  // 1–2. Real session creation, server-authored amount and references.
  const created = await driver.createHostedCheckout({
    intentId,
    idempotencyKey,
    amountFils,
    currency: 'AED',
    description: 'Himma sandbox smoke (never fulfilled)',
    returnUrl: 'https://example.com/himma/return',
    cancelUrl: 'https://example.com/himma/cancel',
    requestedExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  if (created.kind !== 'created') {
    throw new Error(`Session creation did not succeed: ${JSON.stringify(created)}`);
  }
  report.push(`created: session ${created.gatewayRef}`);
  report.push(
    `expiry clamp (D-W5-5): requested now+10min → actual ${created.gatewayExpiresAt.toISOString()}`,
  );
  if (created.gatewayExpiresAt.getTime() < Date.now() + 29 * 60 * 1000) {
    throw new Error('Expected Stripe to enforce the ~30-minute session floor.');
  }

  // 3. Idempotent replay: SAME key → SAME session.
  const replay = await driver.createHostedCheckout({
    intentId,
    idempotencyKey,
    amountFils,
    currency: 'AED',
    description: 'Himma sandbox smoke (never fulfilled)',
    returnUrl: 'https://example.com/himma/return',
    cancelUrl: 'https://example.com/himma/cancel',
    requestedExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  if (replay.kind !== 'created' || replay.gatewayRef !== created.gatewayRef) {
    throw new Error(`Idempotent replay returned a DIFFERENT session: ${JSON.stringify(replay)}`);
  }
  report.push('idempotency: same key replayed the same session');

  // 4. Inspect/retrieve maps into the closed vocabulary with the amount.
  const inspection = await driver.inspectPayment(created.gatewayRef);
  if (inspection.kind !== 'payment') throw new Error('Inspection did not find the session.');
  if (inspection.status !== 'pending') {
    throw new Error(`Fresh session mapped to "${inspection.status}", expected "pending".`);
  }
  if (inspection.amountFils !== amountFils || inspection.currency !== 'AED') {
    throw new Error(
      `Amount mismatch: Stripe reports ${inspection.amountFils} ${inspection.currency}, Himma authored ${amountFils} AED.`,
    );
  }
  report.push(`inspect: pending · ${inspection.amountFils} fils · ${inspection.currency}`);

  // 5. Explicit expire, then truthful re-expire.
  const expired = await driver.expireCheckout(created.gatewayRef);
  if (expired.kind !== 'expired') {
    throw new Error(`Explicit expire failed: ${JSON.stringify(expired)}`);
  }
  const reExpired = await driver.expireCheckout(created.gatewayRef);
  if (reExpired.kind !== 'expired') {
    throw new Error(`Re-expire was not truthful: ${JSON.stringify(reExpired)}`);
  }
  const afterExpiry = await driver.inspectPayment(created.gatewayRef);
  if (afterExpiry.kind !== 'payment' || afterExpiry.status !== 'expired') {
    throw new Error('Expired session did not map to "expired".');
  }
  report.push('explicit expire: open → expired; re-expire truthful; inspect confirms');

  // 6. Nothing card-shaped ever existed in this process's requests; the
  //    hosted page owns all card entry (D-W5-2 / SAQ-A).
  report.push('card data: none authored, none received (hosted Checkout owns entry)');

  console.log('STRIPE SANDBOX SMOKE PASSED');
  for (const line of report) console.log(`  · ${line}`);
}

main().catch(fail);
