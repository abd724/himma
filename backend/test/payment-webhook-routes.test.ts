/**
 * W5 · W5-3 — webhook ingress transport certification (docs/33 §7, §17
 * W5-3). Real Fastify transport over the deterministic provider.
 *
 * Proves the machine-to-machine trust boundary at the wire: the route is
 * Stripe-authenticated ONLY (no Himma session/CSRF is required, read, or
 * useful — bearers grant nothing, their absence blocks nothing); the RAW
 * body reaches signature verification byte-exact through an encapsulated
 * parser scope (the app-wide JSON parser is untouched elsewhere);
 * unsigned/forged/malformed deliveries are 4xx with ZERO rows and zero
 * commercial effect; oversized bodies are refused; a verified delivery is
 * durably received then acknowledged 200; unknown-but-signed types
 * quarantine; the route registers ONLY when a composed provider exists
 * (absent = 404 — production composition cannot produce one in W5);
 * webhook secrets never appear in any response; and the app-wide
 * forbidden-URL / no-trusted-confirmation locks hold with the new route
 * mounted.
 */
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { createProgram } from '../src/modules/catalogue/services/program-management';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import { startPaidCheckout } from '../src/modules/payment/services/checkout-orchestration';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import {
  createActivePolicyTemplate,
  createCommissionTerm,
} from './helpers/booking-fixtures';
import {
  createAccount,
  createSelfParticipant,
  createUser,
} from './helpers/identity-fixtures';
import { createProviderOrg } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let app: FastifyInstance;
let provider: DeterministicPaymentProvider;

const NOW = new Date('2026-08-21T12:00:00.000Z');
const WEBHOOK_URL = '/payments/webhook/deterministicTest';

let eventSerial = 0;
const nextEventId = (): string => `evt_wire_${(eventSerial += 1)}`;

async function post(
  rawBody: Buffer | string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; body: string }> {
  const response = await app.inject({
    method: 'POST',
    url: WEBHOOK_URL,
    payload: rawBody,
    headers: { 'content-type': 'application/json', ...headers },
  });
  return { statusCode: response.statusCode, body: response.body };
}

async function eventCount(gatewayEventId: string): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*) AS n FROM gateway_event
    WHERE gateway_event_id = ${gatewayEventId}`.execute(testDb.db);
  return Number(result.rows[0]!.n);
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  provider = new DeterministicPaymentProvider({ now: NOW });
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: new FakeAccessTokenVerifier(),
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
    payment: { provider },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

describe('route shape and registration', () => {
  it('mounts EXACTLY one payments route — the public webhook POST — and every forbidden-URL lock still holds with it mounted', () => {
    const paymentRoutes = app.routePolicyInventory
      .filter((route) => route.url.startsWith('/payments'))
      .map((route) => `${route.method} ${route.url} → ${route.policy}`);
    expect(paymentRoutes).toEqual(['POST /payments/webhook/deterministicTest → public']);
    for (const route of app.routePolicyInventory) {
      expect(route.url).not.toMatch(
        /confirm-paid|payment-succeeded|capture|redemption|refund|payout|waitlist/i,
      );
    }
  });

  it('an app composed WITHOUT a payment provider has no webhook route at all (fail-closed absence)', async () => {
    const bare = buildApp({
      identity: {
        db: testDb.db,
        accessTokenVerifier: new FakeAccessTokenVerifier(),
        idTokenAdapter: new FakeAuthProviderAdapter(),
        mailSender: new CaptureMailSender(),
        rateLimiterStore: new InMemoryRateLimiterStore(),
        staffInvitationConfig: parseStaffInvitationConfig('test', {}),
      },
    });
    await bare.ready();
    try {
      expect(
        bare.routePolicyInventory.filter((route) => route.url.startsWith('/payments')),
      ).toEqual([]);
      const response = await bare.inject({
        method: 'POST',
        url: WEBHOOK_URL,
        payload: '{}',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe('the trust boundary at the wire', () => {
  it('a correctly signed delivery → 200 {received:true}, durably received and processed; the exact raw bytes survived the transport', async () => {
    const eventId = nextEventId();
    // Odd spacing keeps the byte-exactness honest: any re-serialization by
    // a JSON parser would break the signature.
    const delivery = provider.buildWebhookDelivery({
      gatewayEventId: eventId,
      eventType: 'gateway.someday.new' as never,
    });
    const spaced = Buffer.concat([delivery.rawBody, Buffer.from('   ')]);
    // Signature is over the ORIGINAL bytes — the padded copy must fail…
    const padded = await post(spaced, delivery.headers);
    expect(padded.statusCode).toBe(400);
    // …and the original bytes must verify through the real transport.
    const ok = await post(delivery.rawBody, delivery.headers);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ received: true });
    expect(await eventCount(eventId)).toBe(1);
    // Unknown-but-signed → quarantined by the post-ack processing pass.
    const state = await sql<{ processing_state: string }>`
      SELECT processing_state FROM gateway_event
      WHERE gateway_event_id = ${eventId}`.execute(testDb.db);
    expect(state.rows[0]!.processing_state).toBe('quarantined');
  });

  it('unsigned, forged, and malformed deliveries → 4xx, ZERO rows, zero commercial effect; error bodies carry no secret material', async () => {
    const eventId = nextEventId();
    const unsigned = await post(Buffer.from(`{"id":"${eventId}"}`), {});
    expect(unsigned.statusCode).toBe(400);
    expect(JSON.parse(unsigned.body).code).toBe('malformedWebhook');

    const forged = provider.buildWebhookDelivery({
      gatewayEventId: eventId,
      eventType: 'checkout.completed',
      corruptSignature: true,
    });
    const rejected = await post(forged.rawBody, forged.headers);
    expect(rejected.statusCode).toBe(400);
    expect(JSON.parse(rejected.body).code).toBe('invalidWebhookSignature');

    expect(await eventCount(eventId)).toBe(0);
    for (const body of [unsigned.body, rejected.body]) {
      expect(body).not.toMatch(/dt_whsec|whsec_|sk_test|sk_live/);
    }
  });

  it('Himma sessions are IRRELEVANT here: a bearer grants no webhook authority, and its absence blocks a correctly signed event', async () => {
    const eventId = nextEventId();
    const forged = provider.buildWebhookDelivery({
      gatewayEventId: eventId,
      eventType: 'checkout.completed',
      corruptSignature: true,
    });
    // A "logged-in" caller with a broken signature stays refused — the
    // Authorization header buys nothing.
    const withBearer = await post(forged.rawBody, {
      ...forged.headers,
      authorization: `Bearer ${newId()}`,
    });
    expect(withBearer.statusCode).toBe(400);
    expect(await eventCount(eventId)).toBe(0);

    // And a correctly signed event needs NO session of any kind.
    const genuine = provider.buildWebhookDelivery({
      gatewayEventId: eventId,
      eventType: 'checkout.completed',
      gatewayRef: 'dt_cs_wire_unknown', // quarantines downstream; receipt is the point
    });
    const accepted = await post(genuine.rawBody, genuine.headers);
    expect(accepted.statusCode).toBe(200);
    expect(await eventCount(eventId)).toBe(1);
  });

  it('duplicate signed deliveries at the wire → 200 each, ONE durable row', async () => {
    const eventId = nextEventId();
    const delivery = provider.buildWebhookDelivery({
      gatewayEventId: eventId,
      eventType: 'checkout.completed',
      gatewayRef: 'dt_cs_wire_dup',
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await post(delivery.rawBody, delivery.headers)).statusCode).toBe(200);
    }
    expect(await eventCount(eventId)).toBe(1);
  });

  it('oversized unauthenticated bodies are refused by the bounded limit', async () => {
    const huge = Buffer.alloc(300 * 1024, 0x7b); // > 256 KiB
    const response = await post(huge, { 'dt-timestamp': '1', 'dt-signature': 'x' });
    expect(response.statusCode).toBe(413);
  });

  it('the app-wide JSON pipeline outside the webhook scope is untouched: ordinary routes still parse JSON and enforce their policies', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/customer/quotes',
      payload: { programId: newId() },
    });
    // Parsed as JSON and refused by the route's own typed validation/auth
    // pipeline (422 schema refusal here) — NOT by a parser change: a broken
    // global parser would 415/400 at the content-type layer instead.
    expect([401, 422]).toContain(response.statusCode);
  });
});

describe('the trusted end-to-end journey at the wire (W5-4)', () => {
  it('checkout → hosted completion → signed webhook POST → 200 → booking CONFIRMED with one capture, intent succeeded, event processed — with no Himma session anywhere', async () => {
    // Real domain spine (org → program → customer → quote → hold), the
    // certified W5-2 orchestration on the APP'S OWN provider instance, a
    // hosted completion, then one signed webhook delivery over the real
    // transport — the entire trusted path, no session, no browser claim.
    const org = await createProviderOrg(testDb.db, { state: 'live', branches: 1 });
    await createCommissionTerm(testDb.db, org.orgId, 1000); // D-W5-7: 10%
    const category = await sql<{ id: string }>`
      SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
    const typeId = newId();
    await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
              VALUES (${typeId}, ${category.rows[0]!.id}, ${`wire-type-${typeId.replace(/-/g, '').slice(-12)}`}, 'Wire Type')`.execute(
      testDb.db,
    );
    const scope: OrgScope = {
      organizationId: org.orgId,
      membershipId: newId(),
      role: 'owner',
      capabilities: capabilitiesForRole('owner'),
      branchScope: 'all',
      organizationState: 'live',
    };
    const program = await createProgram({ db: testDb.db }, scope, { userId: newId() }, {
      titleEn: 'Wire Journey Program',
      activityTypeId: typeId,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    if (program.kind !== 'programCreated') throw new Error(program.kind);
    const userId = await createUser(testDb.db);
    const accountId = await createAccount(testDb.db, userId);
    const participantId = await createSelfParticipant(testDb.db, accountId);
    await createActivePolicyTemplate(testDb.db);

    const sessionId = newId();
    await testDb.db
      .insertInto('session')
      .values({
        id: sessionId,
        program_id: program.program.id,
        organization_id: org.orgId,
        branch_id: org.branchIds[0],
        start_at: new Date('2026-09-01T08:00:00.000Z'),
        end_at: new Date('2026-09-01T09:00:00.000Z'),
        capacity: 5,
        held_count: 1,
        registration_cutoff_at: new Date('2026-09-01T08:00:00.000Z'),
      } as never)
      .execute();
    const quoteId = newId();
    await testDb.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('price_quote')
        .values({
          id: quoteId,
          organization_id: org.orgId,
          program_id: program.program.id,
          account_id: accountId,
          participant_id: participantId,
          option_kind: 'dropIn',
          session_id: sessionId,
          total_fils: 5000,
          price_kind: 'oneOff',
          expires_at: new Date('2026-09-01T08:00:00.000Z'),
        } as never)
        .execute();
      await trx
        .insertInto('price_quote_line')
        .values({
          id: newId(),
          quote_id: quoteId,
          line_no: 1,
          kind: 'base',
          label_en: '1 session',
          amount_fils: 5000,
        } as never)
        .execute();
    });
    const holdId = newId();
    await testDb.db
      .insertInto('capacity_hold')
      .values({
        id: holdId,
        organization_id: org.orgId,
        session_id: sessionId,
        account_id: accountId,
        participant_id: participantId,
        quote_id: quoteId,
        expires_at: new Date('2026-08-30T12:00:00.000Z'),
      } as never)
      .execute();

    const started = await startPaidCheckout(
      { db: testDb.db, provider: { kind: 'configured', provider } },
      { accountId },
      {
        holdId,
        quoteId,
        idempotencyKey: 'wire-journey-1',
        returnUrl: 'https://himma.test/return',
        cancelUrl: 'https://himma.test/cancel',
      },
    );
    if (started.kind !== 'checkoutStarted') throw new Error(started.kind);
    provider.completeCheckout(started.gatewayRef);

    const delivery = provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef: started.gatewayRef,
    });
    const response = await post(delivery.rawBody, delivery.headers);
    expect(response.statusCode).toBe(200);

    const state = await sql<{
      booking_state: string;
      hold_state: string;
      held_count: number;
      booked_count: number;
      intent_state: string;
      captures: string;
      event_state: string;
    }>`SELECT b.state AS booking_state, h.state AS hold_state, s.held_count, s.booked_count,
              i.state AS intent_state,
              (SELECT count(*) FROM payment_transaction t
                JOIN payment_attempt a ON a.id = t.attempt_id
                WHERE a.intent_id = i.id AND t.kind = 'capture') AS captures,
              (SELECT ge.processing_state FROM gateway_event ge
                WHERE ge.gateway_event_id = ${JSON.parse(delivery.rawBody.toString('utf8')).id}) AS event_state
       FROM booking b
       JOIN capacity_hold h ON h.id = b.hold_id
       JOIN session s ON s.id = b.session_id
       JOIN payment_intent i ON i.booking_id = b.id
       WHERE b.id = ${started.bookingId}`.execute(testDb.db);
    expect(state.rows[0]).toEqual({
      booking_state: 'confirmed',
      hold_state: 'consumed',
      held_count: 0,
      booked_count: 1,
      intent_state: 'succeeded',
      captures: '1',
      event_state: 'processed',
    });
  });
});
