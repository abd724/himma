/**
 * W5 · W5-1 — narrow payment-provider port + deterministic test provider
 * certification (docs/33 §6, §13; owner rulings D-W5-1/2/5/6, docs/33
 * §14.1). Pure in-process proofs: the port's CLOSED Himma vocabulary (no
 * gateway status ever leaks into the domain), provider-request idempotency
 * (a retried creation never doubles a session), timeout/unknown-outcome
 * semantics (resolution via inspection, never a guess), late success,
 * explicit session expiry (the D-W5-5 seam — requested vs ACTUAL expiry
 * divergence representable), same-amount reversal incl. compensation
 * failure (the A1.2 seam), webhook signature verification over raw bytes
 * with timestamp/replay rejection (the W5-3 contract, proven
 * deterministically now), duplicate event deliveries (dedup is the
 * database's job), and the FAIL-CLOSED composition: production is
 * unconfigured BY CONSTRUCTION in W5-1 and the deterministic provider is
 * refused there even when explicitly injected — no `paymentReady=true`
 * switch exists to set (D-W5-6). No network, no Stripe SDK, no route.
 */
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import { resolvePaymentProvider } from '../src/modules/payment/provider-composition';
import { NORMALIZED_PAYMENT_STATUSES } from '../src/modules/payment/provider-port';
import type { CreateHostedCheckoutInput } from '../src/modules/payment/provider-port';

const NOW = new Date('2026-08-21T12:00:00.000Z');

function checkoutInput(
  intentId: string,
  overrides: Partial<CreateHostedCheckoutInput> = {},
): CreateHostedCheckoutInput {
  return {
    intentId,
    idempotencyKey: `create-${intentId}`,
    amountFils: 5000,
    currency: 'AED',
    description: 'Himma booking',
    returnUrl: 'https://himma.test/return',
    cancelUrl: 'https://himma.test/cancel',
    // Deliberately BELOW the hosted floor: D-W5-5 — a 10-minute hold TTL
    // cannot be pushed into the session expiry; the provider reports the
    // ACTUAL (clamped) expiry and the caller must reconcile the two.
    requestedExpiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    ...overrides,
  };
}

describe('hosted-checkout creation (D-W5-2)', () => {
  it('creates a redirect action with an opaque ref and reports the ACTUAL clamped expiry — requested ≠ actual is representable', async () => {
    const provider = new DeterministicPaymentProvider({ now: NOW });
    const result = await provider.createHostedCheckout(checkoutInput('intent-a'));
    if (result.kind !== 'created') throw new Error(result.kind);
    expect(result.clientAction.kind).toBe('redirect');
    expect(result.gatewayRef).toContain('intent-a');
    // 10 minutes requested, ~30-minute floor reported (the Stripe bound).
    expect(result.gatewayExpiresAt.getTime()).toBe(NOW.getTime() + 30 * 60 * 1000);
  });

  it('replays the SAME outcome for the SAME provider-request idempotency key — a crashed retry never doubles a session', async () => {
    const provider = new DeterministicPaymentProvider({ now: NOW });
    const first = await provider.createHostedCheckout(checkoutInput('intent-b'));
    const replay = await provider.createHostedCheckout(checkoutInput('intent-b'));
    expect(replay).toEqual(first);
  });

  it('timeout is an UNKNOWN outcome, not a failure: the session exists provider-side and only inspection resolves it', async () => {
    const provider = new DeterministicPaymentProvider({
      now: NOW,
      scenarios: { 'intent-t': 'timeout' },
    });
    const result = await provider.createHostedCheckout(checkoutInput('intent-t'));
    expect(result.kind).toBe('unknownOutcome');
    // The lost session is discoverable — never re-created on a guess.
    const inspection = await provider.inspectPayment('dt_cs_intent-t');
    if (inspection.kind !== 'payment') throw new Error(inspection.kind);
    expect(inspection.status).toBe('pending');
  });
});

describe('inspection, late success, decline — the closed Himma vocabulary', () => {
  it('success and decline normalize into the CLOSED status set; unknown refs are notFound; no gateway vocabulary leaks', async () => {
    const provider = new DeterministicPaymentProvider({
      now: NOW,
      scenarios: { 'intent-ok': 'succeed', 'intent-no': 'decline' },
    });
    const ok = await provider.createHostedCheckout(checkoutInput('intent-ok'));
    const no = await provider.createHostedCheckout(checkoutInput('intent-no'));
    if (ok.kind !== 'created' || no.kind !== 'created') throw new Error('setup');

    provider.completeCheckout(ok.gatewayRef);
    provider.completeCheckout(no.gatewayRef);

    const captured = await provider.inspectPayment(ok.gatewayRef);
    const declined = await provider.inspectPayment(no.gatewayRef);
    if (captured.kind !== 'payment' || declined.kind !== 'payment') throw new Error('inspect');
    expect(captured.status).toBe('captured');
    expect(captured.gatewayTransactionId).toBeDefined();
    expect(declined.status).toBe('declined');
    // The vocabulary is CLOSED (docs/33 §6): every reported status is a
    // member of the normalized set — never a Stripe-shaped string.
    for (const status of [captured.status, declined.status]) {
      expect(NORMALIZED_PAYMENT_STATUSES).toContain(status);
    }
    expect(await provider.inspectPayment('dt_cs_never_created')).toEqual({ kind: 'notFound' });
  });

  it('late success: pending until the customer completes, captured after — deterministic, no clock reads', async () => {
    const provider = new DeterministicPaymentProvider({
      now: NOW,
      scenarios: { 'intent-late': 'lateSuccess' },
    });
    const created = await provider.createHostedCheckout(checkoutInput('intent-late'));
    if (created.kind !== 'created') throw new Error(created.kind);
    const before = await provider.inspectPayment(created.gatewayRef);
    if (before.kind !== 'payment') throw new Error(before.kind);
    expect(before.status).toBe('pending');
    provider.completeCheckout(created.gatewayRef);
    const after = await provider.inspectPayment(created.gatewayRef);
    if (after.kind !== 'payment') throw new Error(after.kind);
    expect(after.status).toBe('captured');
  });
});

describe('explicit expiry and reversal (D-W5-5 timing seam; A1.2 compensation seam)', () => {
  it('an open session can be explicitly expired; a finalized one refuses with its status', async () => {
    const provider = new DeterministicPaymentProvider({ now: NOW });
    const open = await provider.createHostedCheckout(checkoutInput('intent-x1'));
    if (open.kind !== 'created') throw new Error(open.kind);
    expect(await provider.expireCheckout(open.gatewayRef)).toEqual({ kind: 'expired' });
    const inspection = await provider.inspectPayment(open.gatewayRef);
    if (inspection.kind !== 'payment') throw new Error(inspection.kind);
    expect(inspection.status).toBe('expired');
    // Expiry can no longer reach a captured session.
    const done = await provider.createHostedCheckout(checkoutInput('intent-x2'));
    if (done.kind !== 'created') throw new Error(done.kind);
    provider.completeCheckout(done.gatewayRef);
    expect(await provider.expireCheckout(done.gatewayRef)).toEqual({
      kind: 'alreadyFinalized',
      status: 'captured',
    });
    expect(await provider.expireCheckout('dt_cs_missing')).toEqual({ kind: 'notFound' });
  });

  it('same-amount reversal succeeds exactly once on a captured payment; uncaptured refuses; compensation failure is representable', async () => {
    const provider = new DeterministicPaymentProvider({
      now: NOW,
      scenarios: { 'intent-r2': 'compensationFailure' },
    });
    const captured = await provider.createHostedCheckout(checkoutInput('intent-r1'));
    if (captured.kind !== 'created') throw new Error(captured.kind);
    provider.completeCheckout(captured.gatewayRef);

    // Wrong amount is refused — the A1.2 compensation is SAME-amount.
    expect(await provider.reverse(captured.gatewayRef, 1)).toEqual({
      kind: 'refused',
      reason: 'providerRefused',
    });
    const reversed = await provider.reverse(captured.gatewayRef, 5000);
    if (reversed.kind !== 'reversed') throw new Error(reversed.kind);
    expect(reversed.gatewayTransactionId).toContain('dt_rev_');
    // Amended by W5-4 (the owning slice): with the driver's STABLE
    // idempotency key, a repeated reversal replays the SAME completed
    // reversal (Stripe's idempotent behavior) — never a duplicate, never
    // an error. Exactly-once lives at the ledger's unique transaction id.
    expect(await provider.reverse(captured.gatewayRef, 5000)).toEqual({
      kind: 'reversed',
      gatewayTransactionId: reversed.gatewayTransactionId,
    });

    const open = await provider.createHostedCheckout(checkoutInput('intent-r3'));
    if (open.kind !== 'created') throw new Error(open.kind);
    expect(await provider.reverse(open.gatewayRef, 5000)).toEqual({
      kind: 'refused',
      reason: 'notCaptured',
    });

    // Compensation failure: unknown outcome — the caller retries/reconciles,
    // never assumes.
    const failing = await provider.createHostedCheckout(checkoutInput('intent-r2'));
    if (failing.kind !== 'created') throw new Error(failing.kind);
    provider.completeCheckout(failing.gatewayRef);
    expect(await provider.reverse(failing.gatewayRef, 5000)).toEqual({ kind: 'unknownOutcome' });
  });
});

describe('webhook verification — the W5-3 trust contract, proven deterministically', () => {
  it('accepts a correctly signed raw body and normalizes it; rejects corrupted signatures, tampered bodies, stale timestamps, malformed deliveries', () => {
    const provider = new DeterministicPaymentProvider({ now: NOW });
    const delivery = provider.buildWebhookDelivery({
      gatewayEventId: 'evt_1',
      eventType: 'payment.captured',
      gatewayRef: 'dt_cs_intent-a',
      gatewayTransactionId: 'dt_txn_1',
    });
    const verified = provider.verifyWebhook(delivery.rawBody, delivery.headers);
    if (verified.kind !== 'verified') throw new Error(verified.kind);
    expect(verified.event).toMatchObject({
      provider: 'deterministicTest',
      gatewayEventId: 'evt_1',
      eventType: 'payment.captured',
      gatewayRef: 'dt_cs_intent-a',
      gatewayTransactionId: 'dt_txn_1',
    });
    expect(verified.event.payloadDigest).toHaveLength(64);

    // Corrupted signature.
    const forged = provider.buildWebhookDelivery({
      gatewayEventId: 'evt_2',
      eventType: 'payment.captured',
      corruptSignature: true,
    });
    expect(provider.verifyWebhook(forged.rawBody, forged.headers)).toEqual({
      kind: 'rejected',
      reason: 'invalidSignature',
    });

    // Tampered raw body under a valid signature for other bytes.
    const tampered = provider.buildWebhookDelivery({
      gatewayEventId: 'evt_3',
      eventType: 'payment.captured',
    });
    const flipped = Buffer.from(tampered.rawBody);
    flipped[flipped.length - 2] = flipped[flipped.length - 2]! ^ 0xff;
    expect(provider.verifyWebhook(flipped, tampered.headers)).toEqual({
      kind: 'rejected',
      reason: 'invalidSignature',
    });

    // Replay outside the tolerance window.
    const stale = provider.buildWebhookDelivery({
      gatewayEventId: 'evt_4',
      eventType: 'payment.captured',
      timestampSeconds: Math.floor(NOW.getTime() / 1000) - 3600,
    });
    expect(provider.verifyWebhook(stale.rawBody, stale.headers)).toEqual({
      kind: 'rejected',
      reason: 'staleTimestamp',
    });

    // Missing headers.
    expect(provider.verifyWebhook(delivery.rawBody, {})).toEqual({
      kind: 'rejected',
      reason: 'malformed',
    });
  });

  it('unknown event types verify but normalize to `unrecognized` (quarantine, never a guess); duplicate deliveries carry the SAME event id for DB dedup', () => {
    const provider = new DeterministicPaymentProvider({ now: NOW });
    const raw = provider.buildWebhookDelivery({
      gatewayEventId: 'evt_5',
      // Cast through the builder deliberately: the WIRE may carry anything;
      // normalization is the driver's job.
      eventType: 'gateway.someday.new' as never,
    });
    const verified = provider.verifyWebhook(raw.rawBody, raw.headers);
    if (verified.kind !== 'verified') throw new Error(verified.kind);
    expect(verified.event.eventType).toBe('unrecognized');

    const d1 = provider.buildWebhookDelivery({
      gatewayEventId: 'evt_dup',
      eventType: 'payment.captured',
    });
    const d2 = provider.buildWebhookDelivery({
      gatewayEventId: 'evt_dup',
      eventType: 'payment.captured',
    });
    const v1 = provider.verifyWebhook(d1.rawBody, d1.headers);
    const v2 = provider.verifyWebhook(d2.rawBody, d2.headers);
    if (v1.kind !== 'verified' || v2.kind !== 'verified') throw new Error('verify');
    expect(v1.event.gatewayEventId).toBe(v2.event.gatewayEventId);
  });
});

describe('composition — production fails closed BY CONSTRUCTION (D-W5-6)', () => {
  it('production resolves unconfigured with no provider, and REFUSES the deterministic provider even when explicitly injected', () => {
    const bare = resolvePaymentProvider('production');
    expect(bare.kind).toBe('unconfigured');

    const injected = resolvePaymentProvider('production', {
      deterministic: new DeterministicPaymentProvider({ now: NOW }),
    });
    expect(injected.kind).toBe('unconfigured');
    if (injected.kind !== 'unconfigured') throw new Error('unreachable');
    expect(injected.reason).toMatch(/never available in production/i);
  });

  it('development/test resolve the deterministic provider ONLY by explicit injection; nothing is configured by default', () => {
    expect(resolvePaymentProvider('development').kind).toBe('unconfigured');
    expect(resolvePaymentProvider('test').kind).toBe('unconfigured');
    const provider = new DeterministicPaymentProvider({ now: NOW });
    const resolved = resolvePaymentProvider('test', { deterministic: provider });
    if (resolved.kind !== 'configured') throw new Error(resolved.kind);
    expect(resolved.provider.provider).toBe('deterministicTest');
  });
});
