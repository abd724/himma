/**
 * W6-3 — the wired NON-DESTRUCTIVE scheduled jobs over the certified
 * services on real PostgreSQL (docs/37 §13–§17/§38; docs/36 OP-02/OP-04/
 * OP-05/PA-09/PA-10). The deterministic provider drives the payment jobs
 * (test environment only — it cannot compose in production).
 *
 * Proven: lapsed-checkout expiry through the scheduler (eligible states
 * only; captured/succeeded intents never swept; hold/counters untouched;
 * repeat harmless; two replicas → one run) · reconciliation as pure
 * detection (discrepancy alert; ledger byte-identical; all-clear;
 * provider outage isolated with a bounded code) · stuck-state detection
 * with durable alert dedup + all-clear and zero mutation · hold hygiene
 * sweep and the "correct with the sweep disabled" pin (docs/37 §16) ·
 * admin-role and staff-invitation expiry with `audit_event.request_id`
 * NULL for background work.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import { sql } from 'kysely';
import { Pool } from 'pg';
import pino from 'pino';

import { newId } from '../src/db/ids';
import { provisionRuntimeRoles } from '../src/db/provision-runtime-roles';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { requestRoleAssignment } from '../src/modules/identity/services/admin-roles';
import { firstLogin } from '../src/modules/identity/services/first-login';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import type { PaymentProviderPort } from '../src/modules/payment/provider-port';
import { startPaidCheckout } from '../src/modules/payment/services/checkout-orchestration';
import { ingestGatewayDelivery } from '../src/modules/payment/services/webhook-ingestion';
import { digestStaffInvitationToken } from '../src/modules/provider/services/staff-invitations';
import { DEV_TEST_INVITATION_PEPPER } from '../src/modules/provider/staff-invitation-config';
import { createAlertEmitter, type AlertEmitter } from '../src/observability/alerts';
import { buildLoggerOptions } from '../src/observability/logging';
import { runPaymentPass } from '../src/worker/payment-processing';
import { createScheduledJobs, RECONCILIATION_ALERT_KEY, SCHEDULED_JOB_NAMES } from '../src/worker/scheduled-jobs';
import { runJobExclusively, runSchedulerTick, type JobExecutionDeps, type ScheduledJobSpec } from '../src/worker/scheduler';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createCommissionTerm,
  createCustomer,
  createPriceOption,
  createSession,
  publishProgram,
  reconcileUnit,
  type BookingFixture,
  type Customer,
} from './helpers/booking-fixtures';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(180_000);

const NOW = new Date('2026-08-26T12:00:00.000Z');
const RETURN = 'https://app.himma.test/checkout/return';
const CANCEL = 'https://app.himma.test/checkout/cancel';
const SECRET = 'w63-jobs-secret-DO-NOT-LOG-31bb';

let testDb: TestDb;
let f: BookingFixture;
let provider: DeterministicPaymentProvider;
let dropInOption: string;
let workerPool: Pool;
let secondPool: Pool;
let lines: string[];
let log: pino.Logger;
let alerts: AlertEmitter;
const workerPassword = `worker-${randomBytes(18).toString('base64url')}`;
const apiPassword = `api-${randomBytes(18).toString('base64url')}`;
let eventSerial = 0;
const nextEventId = () => `evt_w63_${(eventSerial += 1)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function poolFor(): Pool {
  return new Pool({
    host: testDb.config.database.host,
    port: testDb.config.database.port,
    database: testDb.config.database.database,
    user: 'himma_worker',
    password: workerPassword,
    options: '-c TimeZone=UTC',
    max: 4,
  });
}

function deps(pool: Pool = workerPool): JobExecutionDeps {
  return { pool, log, runtimeRole: 'worker', alerts };
}

function jobsWith(payment: PaymentProviderPort | undefined, disabledJobs: string[] = []) {
  return createScheduledJobs(
    {
      db: testDb.db,
      log,
      alerts,
      payment: payment === undefined ? { kind: 'unconfigured', reason: 'no provider' } : { kind: 'configured', provider: payment },
    },
    { disabledJobs, intervalOverridesMs: {} },
  );
}

function jobNamed(jobs: ScheduledJobSpec[], name: string): ScheduledJobSpec {
  const job = jobs.find((candidate) => candidate.name === name);
  if (job === undefined) throw new Error(`job ${name} not composed`);
  return job;
}

async function latestFacts(job: string): Promise<Record<string, unknown>> {
  const rows = await sql<{ facts: Record<string, unknown> }>`
    SELECT facts FROM job_run WHERE job_name = ${job} AND outcome = 'succeeded' ORDER BY started_at DESC LIMIT 1`.execute(testDb.db);
  return rows.rows[0]?.facts ?? {};
}

async function deliver(gatewayRef: string, eventType: 'checkout.completed' | 'payment.captured'): Promise<string> {
  const delivery = provider.buildWebhookDelivery({ gatewayEventId: nextEventId(), eventType, gatewayRef });
  const accepted = await ingestGatewayDelivery({ db: testDb.db, provider }, delivery.rawBody, delivery.headers);
  if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
  return accepted.gatewayEventRowId;
}

async function startCheckout(customer: Customer, holdTtlSeconds: number): Promise<{ bookingId: string; intentId: string; gatewayRef: string; holdId: string; sessionId: string }> {
  const sessionId = await createSession(f);
  const quote = await requestQuote({ db: testDb.db }, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: dropInOption,
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold({ db: testDb.db, holdTtlSeconds }, { accountId: customer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const started = await startPaidCheckout(
    { db: testDb.db, provider: { kind: 'configured', provider } },
    { accountId: customer.accountId },
    { holdId: hold.outcome.hold.holdId, quoteId: quote.quote.quoteId, idempotencyKey: newId(), returnUrl: RETURN, cancelUrl: CANCEL },
  );
  if (started.kind !== 'checkoutStarted') throw new Error(started.kind);
  return { bookingId: started.bookingId, intentId: started.intentId, gatewayRef: started.gatewayRef, holdId: hold.outcome.hold.holdId, sessionId };
}

async function intentTruth(intentId: string): Promise<{ state: string; attemptState: string; failureCode: string | null; captures: number; reversals: number }> {
  const rows = await sql<{ state: string; attempt_state: string; failure_code: string | null; captures: string; reversals: string }>`
    SELECT i.state, a.state AS attempt_state, a.failure_code,
           (SELECT count(*) FROM payment_transaction t JOIN payment_attempt x ON x.id = t.attempt_id WHERE x.intent_id = i.id AND t.kind = 'capture') AS captures,
           (SELECT count(*) FROM payment_transaction t JOIN payment_attempt x ON x.id = t.attempt_id WHERE x.intent_id = i.id AND t.kind = 'reversal') AS reversals
    FROM payment_intent i JOIN payment_attempt a ON a.intent_id = i.id WHERE i.id = ${intentId}
    ORDER BY a.created_at DESC LIMIT 1`.execute(testDb.db);
  const row = rows.rows[0]!;
  return { state: row.state, attemptState: row.attempt_state, failureCode: row.failure_code, captures: Number(row.captures), reversals: Number(row.reversals) };
}

/** Byte-level snapshot of every financial/booking truth table (docs/37 §14: reconciliation mutates nothing). */
async function ledgerSnapshot(): Promise<string> {
  const tables = ['payment_intent', 'payment_attempt', 'payment_transaction', 'payment_intent_economics', 'gateway_event', 'booking', 'capacity_hold', 'entitlement_purchase', 'audit_event', 'outbox_event'];
  const parts: string[] = [];
  for (const table of tables) {
    const rows = await sql<{ j: string }>`SELECT to_jsonb(t)::text AS j FROM ${sql.raw(table)} t ORDER BY 1`.execute(testDb.db);
    parts.push(`${table}:${rows.rows.map((r) => r.j).join('|')}`);
  }
  return parts.join('\n');
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  await provisionRuntimeRoles({ admin: testDb.config.database, passwords: { himma_api: apiPassword, himma_worker: workerPassword } });
  workerPool = poolFor();
  secondPool = poolFor();
  lines = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  log = pino(buildLoggerOptions({ role: 'worker', level: 'info' }) as pino.LoggerOptions, stream);
  alerts = createAlertEmitter(log, { suppressMs: 60_000 });
  f = await createBookingFixture(testDb.db);
  await createCommissionTerm(testDb.db, f.org.orgId, 1200);
  await createActivePolicyTemplate(testDb.db);
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
  await publishProgram(f);
  provider = new DeterministicPaymentProvider({ now: NOW });
});

afterAll(async () => {
  await workerPool.end();
  await secondPool.end();
  await testDb.drop();
});

describe('composition', () => {
  it('without a payment provider the two provider-dependent jobs are explicitly unavailable; disabled jobs are reported, never silently dropped', () => {
    const absent = jobsWith(undefined, ['booking.hold-sweep']);
    expect(absent.jobs.map((job) => job.name).sort()).toEqual(['identity.role-expiry', 'payment.stuck-state', 'provider.invitation-expiry']);
    expect(absent.unavailable.map((job) => job.name).sort()).toEqual(['payment.checkout-sweep', 'payment.reconciliation']);
    expect(absent.disabled).toEqual(['booking.hold-sweep']);
    const full = jobsWith(provider);
    expect(full.jobs.map((job) => job.name).sort()).toEqual(Object.values(SCHEDULED_JOB_NAMES).sort());
    expect(full.jobs.map((job) => job.intervalMs)).toEqual([60_000, 86_400_000, 300_000, 300_000, 3_600_000, 3_600_000]);
  });
});

describe('payment.checkout-sweep (D-W5-5 wind-down, scheduled)', () => {
  it('winds down only a genuinely lapsed checkout, never a captured one; the hold row and counters stay with their certified owners; repeat harmless; two replicas → one run', async () => {
    const lapsed = await startCheckout(await createCustomer(testDb.db), 1);
    const paid = await startCheckout(await createCustomer(testDb.db), 600);
    provider.completeCheckout(paid.gatewayRef);
    await deliver(paid.gatewayRef, 'checkout.completed');
    await runPaymentPass({ db: testDb.db, provider });
    expect((await intentTruth(paid.intentId)).state).toBe('succeeded');
    await sleep(1_200); // the 1 s hold lapses on the database clock

    const job = jobNamed(jobsWith(provider).jobs, 'payment.checkout-sweep');
    const [a, b] = await Promise.all([runJobExclusively(deps(workerPool), job), runJobExclusively(deps(secondPool), job)]);
    expect([a.outcome, b.outcome].sort()).toEqual(['lockHeld', 'ran']);

    expect(await intentTruth(lapsed.intentId)).toEqual({ state: 'expired', attemptState: 'errored', failureCode: 'holdExpired', captures: 0, reversals: 0 });
    expect(await intentTruth(paid.intentId)).toMatchObject({ state: 'succeeded', captures: 1, reversals: 0 });
    const hold = await sql<{ state: string }>`SELECT state FROM capacity_hold WHERE id = ${lapsed.holdId}`.execute(testDb.db);
    expect(hold.rows[0]?.state).toBe('active'); // physically unsettled — the sweep is never capacity authority
    expect((await reconcileUnit(testDb.db, { kind: 'session', id: lapsed.sessionId })).heldCount).toBe(1);
    const booking = await sql<{ state: string }>`SELECT state FROM booking WHERE id = ${lapsed.bookingId}`.execute(testDb.db);
    expect(booking.rows[0]?.state).toBe('pending_payment');
    expect(await latestFacts('payment.checkout-sweep')).toMatchObject({ woundDown: 1 });

    // Repeat: nothing live remains; the succeeded intent is not a candidate.
    const again = await job.run({ runId: newId(), previousFacts: undefined, isStopping: () => false });
    expect(again).toMatchObject({ items: 0, facts: { examined: 0, woundDown: 0 } });
    const audits = await sql<{ n: string; null_ids: string }>`
      SELECT count(*) AS n, count(*) FILTER (WHERE request_id IS NULL) AS null_ids FROM audit_event WHERE action = 'payment.intent.expired'`.execute(testDb.db);
    expect(Number(audits.rows[0]?.n)).toBe(1);
    expect(Number(audits.rows[0]?.null_ids)).toBe(1); // background work: request_id NULL
  });
});

describe('payment.reconciliation (detection, never authority)', () => {
  it('a captured-but-unposted checkout is reported as a discrepancy with an alert; the ledger stays byte-identical; convergence clears the alert', async () => {
    const unposted = await startCheckout(await createCustomer(testDb.db), 600);
    provider.completeCheckout(unposted.gatewayRef); // money captured at the provider, no webhook yet
    const before = await ledgerSnapshot();
    const job = jobNamed(jobsWith(provider).jobs, 'payment.reconciliation');
    const tick = await runSchedulerTick(deps(), [job]);
    expect(tick.outcomes[0]?.outcome).toBe('ran');
    expect(await ledgerSnapshot()).toBe(before);
    const facts = await latestFacts('payment.reconciliation');
    expect(facts).toMatchObject({ discrepancies: 1, byKind: { captureUnposted: 1 } });
    expect((facts.findings as Array<Record<string, string>>)[0]).toEqual({ kind: 'captureUnposted', intentId: unposted.intentId, attemptId: expect.any(String) });
    const joined = lines.join('');
    expect(joined).toContain(`"alertKey":"${RECONCILIATION_ALERT_KEY}"`);
    expect(joined).toContain('"code":"reconciliationDiscrepancy"');
    expect(joined).not.toContain(unposted.gatewayRef); // machine ids only — never the provider reference

    // Convergence stays with the certified path; the next run finds nothing and clears.
    await deliver(unposted.gatewayRef, 'checkout.completed');
    await runPaymentPass({ db: testDb.db, provider });
    expect((await intentTruth(unposted.intentId)).state).toBe('succeeded');
    const clean = await job.run({ runId: newId(), previousFacts: undefined, isStopping: () => false });
    expect(clean.facts).toMatchObject({ discrepancies: 0 });
    expect(lines.join('')).toContain(`"alert":"cleared","alertKey":"${RECONCILIATION_ALERT_KEY}"`);
  });

  it('a provider outage fails the reconciliation run with a bounded code (never the message) while unrelated jobs progress', async () => {
    const flaky = Object.assign(Object.create(provider) as PaymentProviderPort, {
      inspectPayment: async () => {
        throw new Error(`stripe unreachable ${SECRET}`);
      },
    });
    const composed = jobsWith(flaky).jobs;
    const tick = await runSchedulerTick(deps(), [jobNamed(composed, 'payment.reconciliation'), jobNamed(composed, 'payment.stuck-state')]);
    // reconciliation ran moments ago in the previous test → not due; force it by direct exclusive run without due check
    const forced = await runJobExclusively(deps(), jobNamed(composed, 'payment.reconciliation'), { checkDue: false });
    expect(forced).toMatchObject({ outcome: 'failed', errorCode: 'Error' });
    expect(tick.outcomes.find((o) => o.job === 'payment.stuck-state')?.outcome).toBe('ran');
    const joined = lines.join('');
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain('stripe unreachable');
  });
});

describe('payment.stuck-state (diagnostic; alert dedup + all-clear)', () => {
  it('detects only what the certified service recognizes, alerts once per state, suppresses repeats, clears when the state vacates, and mutates nothing', async () => {
    const checkout = await startCheckout(await createCustomer(testDb.db), 600);
    provider.completeCheckout(checkout.gatewayRef);
    const eventId = await deliver(checkout.gatewayRef, 'checkout.completed'); // durable receipt, unprocessed
    // Synthetic age: the certified 900 s threshold is on Himma's durable-receipt
    // clock, which is immutable by trigger — the fixture backdates it with the
    // schema owner's replica mode (test-only; the job itself uses the service
    // default threshold unchanged).
    await sql`SET session_replication_role = replica`.execute(testDb.db);
    await sql`UPDATE gateway_event SET created_at = now() - interval '1 hour' WHERE id = ${eventId}`.execute(testDb.db);
    await sql`RESET session_replication_role`.execute(testDb.db);
    const before = await ledgerSnapshot();

    const job = jobNamed(jobsWith(provider).jobs, 'payment.stuck-state');
    const first = await runJobExclusively(deps(), job, { checkDue: false });
    expect(first.outcome).toBe('ran');
    expect(await ledgerSnapshot()).toBe(before);
    const key = `stuck:gatewayEvent:${eventId}`;
    let facts = await latestFacts('payment.stuck-state');
    expect(facts).toMatchObject({ activeKeys: [key], raised: 1, suppressed: 0, cleared: 0, counts: { unprocessedGatewayEvents: 1 } });
    const raisedLines = () => lines.join('').split('\n').filter((line) => line.includes(`"alertKey":"${key}"`) && line.includes('"alert":"raised"'));
    expect(raisedLines()).toHaveLength(1);
    expect(raisedLines()[0]).toContain('"code":"stuckPaymentState"');

    const second = await runJobExclusively(deps(), job, { checkDue: false });
    expect(second.outcome).toBe('ran');
    facts = await latestFacts('payment.stuck-state');
    expect(facts).toMatchObject({ activeKeys: [key], raised: 0, suppressed: 1 });
    expect(raisedLines()).toHaveLength(1); // deduplicated

    // Convergence through the certified worker pass; the next run emits the all-clear.
    await runPaymentPass({ db: testDb.db, provider });
    const third = await runJobExclusively(deps(secondPool), job, { checkDue: false });
    expect(third.outcome).toBe('ran');
    facts = await latestFacts('payment.stuck-state');
    expect(facts).toMatchObject({ activeKeys: [], cleared: 1 });
    expect(lines.join('')).toContain(`"alert":"cleared","alertKey":"${key}"`);
  });
});

describe('booking.hold-sweep (hygiene) and the sweep-independence pin (docs/37 §16)', () => {
  it('expires lapsed holds exactly once; re-run finds nothing', async () => {
    const lapsed: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const sessionId = await createSession(f, { capacity: 2 });
      const c = await createCustomer(testDb.db);
      const quote = await requestQuote({ db: testDb.db }, { accountId: c.accountId }, {
        programId: f.programId, priceOptionId: dropInOption, unit: { kind: 'session', id: sessionId }, participantId: c.participantId,
      });
      if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
      const hold = await claimHold({ db: testDb.db, holdTtlSeconds: 0 }, { accountId: c.accountId }, {
        unit: { kind: 'session', id: sessionId }, participantId: c.participantId, quoteId: quote.quote.quoteId, idempotencyKey: newId(),
      });
      if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
      lapsed.push(hold.outcome.hold.holdId);
    }
    // Earlier cases may have left other physically-unsettled lapsed holds
    // (the checkout sweep is never capacity authority) — the sweep expires
    // exactly the currently lapsed active set, which includes our three.
    const lapsedActive = Number(
      (await sql<{ n: string }>`SELECT count(*) AS n FROM capacity_hold WHERE state = 'active' AND expires_at <= now()`.execute(testDb.db)).rows[0]?.n,
    );
    expect(lapsedActive).toBeGreaterThanOrEqual(3);
    const job = jobNamed(jobsWith(undefined).jobs, 'booking.hold-sweep');
    const run = await runJobExclusively(deps(), job, { checkDue: false });
    expect(run).toMatchObject({ outcome: 'ran', items: lapsedActive });
    const states = await sql<{ state: string }>`SELECT state FROM capacity_hold WHERE id = ANY(${sql.val(lapsed)}::uuid[])`.execute(testDb.db);
    expect(states.rows.every((row) => row.state === 'expired')).toBe(true);
    const again = await job.run({ runId: newId(), previousFacts: undefined, isStopping: () => false });
    expect(again.items).toBe(0);
  });

  it('with the hold sweep DISABLED the platform stays correct: a lapsed hold on a full unit is reclaimed inline by the next claim', async () => {
    const composition = jobsWith(undefined, ['booking.hold-sweep']);
    expect(composition.jobs.map((job) => job.name)).not.toContain('booking.hold-sweep');
    const sessionId = await createSession(f, { capacity: 1 });
    const a = await createCustomer(testDb.db);
    const b = await createCustomer(testDb.db);
    const quoteA = await requestQuote({ db: testDb.db }, { accountId: a.accountId }, {
      programId: f.programId, priceOptionId: dropInOption, unit: { kind: 'session', id: sessionId }, participantId: a.participantId,
    });
    if (quoteA.kind !== 'quoteIssued') throw new Error(quoteA.kind);
    const holdA = await claimHold({ db: testDb.db, holdTtlSeconds: 0 }, { accountId: a.accountId }, {
      unit: { kind: 'session', id: sessionId }, participantId: a.participantId, quoteId: quoteA.quote.quoteId, idempotencyKey: newId(),
    });
    expect(holdA.outcome.kind).toBe('holdClaimed');
    const quoteB = await requestQuote({ db: testDb.db }, { accountId: b.accountId }, {
      programId: f.programId, priceOptionId: dropInOption, unit: { kind: 'session', id: sessionId }, participantId: b.participantId,
    });
    if (quoteB.kind !== 'quoteIssued') throw new Error(quoteB.kind);
    const holdB = await claimHold({ db: testDb.db }, { accountId: b.accountId }, {
      unit: { kind: 'session', id: sessionId }, participantId: b.participantId, quoteId: quoteB.quote.quoteId, idempotencyKey: newId(),
    });
    expect(holdB.outcome.kind).toBe('holdClaimed'); // no sweep ran — correctness never depended on it
  });
});

describe('identity.role-expiry and provider.invitation-expiry', () => {
  it('finalize overdue admin assignments and staff invitations through the scheduler; their audit rows carry request_id NULL', async () => {
    const { adminA } = await bootstrapAccessAdmins(testDb.db);
    const evidence: ProviderEvidence = {
      provider: 'google', issuer: 'https://cognito.test/w63-pool', subject: 'w63-target', email: 'w63.target@example.test',
      emailVerified: true, isPrivateRelay: false, assurance: 'single_factor',
    };
    const login = await firstLogin({ db: testDb.db }, { evidence });
    if (login.kind !== 'newCustomerCreated') throw new Error(login.kind);
    const activated = await requestRoleAssignment({ db: testDb.db }, { userId: adminA }, {
      targetUserId: login.userId, role: 'operations', expiresAt: new Date(Date.now() + 50),
    });
    expect(activated.kind).toBe('roleActivated');

    const orgId = newId();
    await sql`INSERT INTO organization (id, legal_name, trade_name, verification_state) VALUES (${orgId}, 'Legal LLC', 'Trade', 'live')`.execute(testDb.db);
    await sql`INSERT INTO organization_public_profile (organization_id, display_name, published) VALUES (${orgId}, 'W63 Org', true)`.execute(testDb.db);
    const ownerId = await createUser(testDb.db);
    await sql`INSERT INTO staff_membership (id, user_id, organization_id, role) VALUES (${newId()}, ${ownerId}, ${orgId}, 'owner')`.execute(testDb.db);
    const invitationId = newId();
    await sql`INSERT INTO staff_invitation (id, organization_id, email, role, branch_scope_kind, branch_scope_ids, invited_by, token_digest, pepper_version, issued_at, expires_at)
              VALUES (${invitationId}, ${orgId}, 'overdue@example.com', 'coach', 'all', ARRAY[]::uuid[], ${ownerId},
                      ${digestStaffInvitationToken(DEV_TEST_INVITATION_PEPPER, 'w63-overdue')}, 1, now() - interval '2 hours', now() - interval '1 hour')`.execute(testDb.db);
    await sleep(80);

    const composed = jobsWith(undefined).jobs;
    const tick = await runSchedulerTick(deps(), [jobNamed(composed, 'identity.role-expiry'), jobNamed(composed, 'provider.invitation-expiry')]);
    expect(tick.outcomes.map((o) => o.outcome)).toEqual(['ran', 'ran']);
    expect(await latestFacts('identity.role-expiry')).toMatchObject({ expired: 1 });
    expect(await latestFacts('provider.invitation-expiry')).toMatchObject({ expired: 1 });
    const assignment = await sql<{ state: string }>`SELECT state FROM admin_role_assignment WHERE user_id = ${login.userId}`.execute(testDb.db);
    expect(assignment.rows[0]?.state).toBe('expired');
    const invitation = await sql<{ state: string }>`SELECT state FROM staff_invitation WHERE id = ${invitationId}`.execute(testDb.db);
    expect(invitation.rows[0]?.state).toBe('expired');
    const audits = await sql<{ action: string; request_id: string | null }>`
      SELECT action, request_id FROM audit_event WHERE action IN ('auth.admin_role_expired', 'org.invitation_expired') ORDER BY action`.execute(testDb.db);
    expect(audits.rows).toEqual([
      { action: 'auth.admin_role_expired', request_id: null },
      { action: 'org.invitation_expired', request_id: null },
    ]);
  });
});
