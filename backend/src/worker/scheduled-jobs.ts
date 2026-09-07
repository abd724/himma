/**
 * W6-3 — the NON-DESTRUCTIVE scheduled jobs hosted by the worker (docs/37
 * §13–§17; docs/36 OP-01/OP-02/OP-04/OP-05/PA-09/PA-10).
 *
 * Every job below CALLS an already-certified idempotent service exactly as
 * the tests do; no business rule, threshold, grace period, or state
 * transition is defined here. The scheduler (scheduler.ts) decides WHEN;
 * the services decide WHAT. Cadences are the docs/37 §13 engineering
 * recommendations (env-overridable operational policy, never a correctness
 * input — every service stays correct when run late, early, twice, or not
 * at all).
 *
 *   payment.checkout-sweep      60 s   sweepLapsedPaidCheckouts (D-W5-5)   provider required
 *   payment.reconciliation      24 h   reconcileLedgerAgainstProvider      provider required — pure read
 *   payment.stuck-state         5 min  findStuckPaymentStates               pure read — alerts only
 *   booking.hold-sweep          5 min  sweepExpiredHolds (hygiene, §16)
 *   identity.role-expiry        1 h    processExpiredAssignments
 *   provider.invitation-expiry  1 h    expireDueStaffInvitations
 *
 * The two provider-dependent jobs compose ONLY when a payment provider
 * composes (absent or TEST — docs/37 §33); otherwise they are reported as
 * explicitly UNAVAILABLE rather than silently absent. Reconciliation and
 * stuck-state detection are DIAGNOSTIC: they write nothing and alert
 * through the generic seam (docs/37 §14/§15) — findings are signals for
 * operations, never authority.
 */
import type pino from 'pino';

import type { Db } from '../db/kysely';
import { sweepExpiredHolds } from '../modules/booking/services/hold-lifecycle';
import { processExpiredAssignments } from '../modules/identity/services/admin-roles';
import type { PaymentProviderPort } from '../modules/payment/provider-port';
import { sweepLapsedPaidCheckouts } from '../modules/payment/services/checkout-orchestration';
import {
  findStuckPaymentStates,
  reconcileLedgerAgainstProvider,
  type ReconciliationFinding,
  type StuckPaymentStates,
} from '../modules/payment/services/payment-reconciliation';
import { expireDueStaffInvitations } from '../modules/provider/services/staff-invitations';
import type { AlertEmitter } from '../observability/alerts';
import type { JobRunContext, JobRunResult, ScheduledJobSpec } from './scheduler';

export const SCHEDULED_JOB_NAMES = {
  checkoutSweep: 'payment.checkout-sweep',
  reconciliation: 'payment.reconciliation',
  stuckState: 'payment.stuck-state',
  holdSweep: 'booking.hold-sweep',
  roleExpiry: 'identity.role-expiry',
  invitationExpiry: 'provider.invitation-expiry',
} as const;

/** docs/37 §13 engineering cadences (ms). */
export const DEFAULT_JOB_INTERVALS_MS: Readonly<Record<string, number>> = {
  [SCHEDULED_JOB_NAMES.checkoutSweep]: 60_000,
  [SCHEDULED_JOB_NAMES.reconciliation]: 24 * 3_600_000,
  [SCHEDULED_JOB_NAMES.stuckState]: 5 * 60_000,
  [SCHEDULED_JOB_NAMES.holdSweep]: 5 * 60_000,
  [SCHEDULED_JOB_NAMES.roleExpiry]: 3_600_000,
  [SCHEDULED_JOB_NAMES.invitationExpiry]: 3_600_000,
};

/** Bounded drain: a pass re-runs while a round examined a full batch. */
const MAX_ROUNDS = 10;
const CHECKOUT_SWEEP_LIMIT = 20;
const HOLD_SWEEP_LIMIT = 100;
const RECONCILIATION_LIMIT = 50;
/** Machine-fact bound on per-finding detail persisted/alerted. */
const MAX_FINDING_FACTS = 20;

export const RECONCILIATION_ALERT_KEY = 'payment.reconciliation.discrepancy';

export type PaymentComposition =
  | { kind: 'configured'; provider: PaymentProviderPort }
  | { kind: 'unconfigured'; reason: string };

export interface ScheduledJobsDeps {
  db: Db;
  log: pino.Logger;
  alerts: AlertEmitter;
  payment: PaymentComposition;
}

export interface ScheduledJobsPolicy {
  disabledJobs: readonly string[];
  intervalOverridesMs: Readonly<Record<string, number>>;
}

export interface ScheduledJobsComposition {
  jobs: ScheduledJobSpec[];
  /** Jobs that could not compose (reason is a bounded operational message). */
  unavailable: Array<{ name: string; reason: string }>;
  disabled: string[];
}

// ---------------------------------------------------------------------------
// Job bodies — each is one bounded call (or bounded rounds) into certified
// authority. Facts are counts/ids only.
// ---------------------------------------------------------------------------

async function checkoutSweepPass(db: Db, provider: PaymentProviderPort, context: JobRunContext): Promise<JobRunResult> {
  let rounds = 0;
  let examined = 0;
  let woundDown = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (context.isStopping() && round > 0) break;
    rounds += 1;
    const summary = await sweepLapsedPaidCheckouts({ db, provider }, { limit: CHECKOUT_SWEEP_LIMIT });
    examined += summary.examined;
    woundDown += summary.woundDown;
    // Both trails (booking + purchase) share the limit; a partial batch means drained.
    if (summary.examined < CHECKOUT_SWEEP_LIMIT * 2) break;
  }
  return { items: woundDown, facts: { rounds, examined, woundDown } };
}

function findingFacts(findings: readonly ReconciliationFinding[]): Array<Record<string, string>> {
  return findings.slice(0, MAX_FINDING_FACTS).map((finding) => ({
    kind: finding.kind,
    intentId: finding.intentId,
    attemptId: finding.attemptId,
  }));
}

async function reconciliationPass(
  db: Db,
  provider: PaymentProviderPort,
  alerts: AlertEmitter,
): Promise<JobRunResult> {
  const summary = await reconcileLedgerAgainstProvider({ db, provider }, { limit: RECONCILIATION_LIMIT });
  const byKind: Record<string, number> = {};
  for (const finding of summary.findings) {
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  }
  const facts = {
    examined: summary.examined,
    consistent: summary.consistent,
    discrepancies: summary.findings.length,
    byKind,
    findings: findingFacts(summary.findings),
  };
  if (summary.findings.length > 0) {
    alerts.raise({
      key: RECONCILIATION_ALERT_KEY,
      severity: 'critical',
      code: 'reconciliationDiscrepancy',
      facts,
    });
  } else {
    alerts.clear(RECONCILIATION_ALERT_KEY);
  }
  return { items: summary.examined, facts };
}

/** Stable per-state alert keys — intent/attempt/event id + condition. */
function stuckStateKeys(states: StuckPaymentStates): Map<string, Record<string, string>> {
  const keys = new Map<string, Record<string, string>>();
  for (const event of states.unprocessedGatewayEvents) {
    keys.set(`stuck:gatewayEvent:${event.id}`, {
      condition: 'unprocessedGatewayEvent',
      gatewayEventId: event.id,
      processingState: event.processingState,
    });
  }
  for (const intent of states.liveIntentsOnDeadHolds) {
    keys.set(`stuck:intentDeadHold:${intent.intentId}`, {
      condition: 'liveIntentOnDeadHold',
      intentId: intent.intentId,
      holdId: intent.holdId,
    });
  }
  for (const intent of states.liveIntentsOnConcludedPurchases) {
    keys.set(`stuck:intentConcludedPurchase:${intent.intentId}`, {
      condition: 'liveIntentOnConcludedPurchase',
      intentId: intent.intentId,
      purchaseId: intent.purchaseId,
    });
  }
  for (const compensation of states.outstandingCompensations) {
    keys.set(`stuck:compensation:${compensation.attemptId}`, {
      condition: 'outstandingCompensation',
      attemptId: compensation.attemptId,
      intentId: compensation.intentId,
    });
  }
  for (const attempt of states.refAwaitingAttempts) {
    keys.set(`stuck:refAwaiting:${attempt.attemptId}`, {
      condition: 'refAwaitingAttempt',
      attemptId: attempt.attemptId,
      intentId: attempt.intentId,
    });
  }
  return keys;
}

function previousActiveKeys(context: JobRunContext): string[] {
  const raw = context.previousFacts?.activeKeys;
  return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === 'string') : [];
}

async function stuckStatePass(db: Db, alerts: AlertEmitter, context: JobRunContext): Promise<JobRunResult> {
  const states = await findStuckPaymentStates({ db });
  const current = stuckStateKeys(states);
  const previous = new Set(previousActiveKeys(context));
  let raised = 0;
  let suppressed = 0;
  let cleared = 0;
  for (const [key, facts] of current) {
    const outcome = alerts.raise({ key, severity: 'critical', code: 'stuckPaymentState', facts });
    if (outcome === 'raised') raised += 1;
    else suppressed += 1;
  }
  for (const key of previous) {
    if (!current.has(key)) {
      // Durable knowledge from the previous run (any replica): emit the
      // all-clear even if THIS process never raised the key.
      alerts.clear(key, { known: true });
      cleared += 1;
    }
  }
  const activeKeys = [...current.keys()].sort();
  return {
    items: activeKeys.length,
    facts: {
      activeKeys,
      counts: {
        unprocessedGatewayEvents: states.unprocessedGatewayEvents.length,
        liveIntentsOnDeadHolds: states.liveIntentsOnDeadHolds.length,
        liveIntentsOnConcludedPurchases: states.liveIntentsOnConcludedPurchases.length,
        outstandingCompensations: states.outstandingCompensations.length,
        refAwaitingAttempts: states.refAwaitingAttempts.length,
      },
      raised,
      suppressed,
      cleared,
    },
  };
}

async function holdSweepPass(db: Db, context: JobRunContext): Promise<JobRunResult> {
  let rounds = 0;
  let scanned = 0;
  let expired = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (context.isStopping() && round > 0) break;
    rounds += 1;
    const summary = await sweepExpiredHolds({ db }, { limit: HOLD_SWEEP_LIMIT });
    scanned += summary.scanned;
    expired += summary.expired;
    if (summary.scanned < HOLD_SWEEP_LIMIT) break;
  }
  return { items: expired, facts: { rounds, scanned, expired } };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export function createScheduledJobs(deps: ScheduledJobsDeps, policy: ScheduledJobsPolicy): ScheduledJobsComposition {
  const intervalFor = (name: string): number =>
    policy.intervalOverridesMs[name] ?? DEFAULT_JOB_INTERVALS_MS[name] ?? 3_600_000;
  const candidates: Array<{ spec: ScheduledJobSpec } | { name: string; reason: string }> = [];

  if (deps.payment.kind === 'configured') {
    const provider = deps.payment.provider;
    candidates.push({
      spec: {
        name: SCHEDULED_JOB_NAMES.checkoutSweep,
        intervalMs: intervalFor(SCHEDULED_JOB_NAMES.checkoutSweep),
        run: (context) => checkoutSweepPass(deps.db, provider, context),
      },
    });
    candidates.push({
      spec: {
        name: SCHEDULED_JOB_NAMES.reconciliation,
        intervalMs: intervalFor(SCHEDULED_JOB_NAMES.reconciliation),
        run: () => reconciliationPass(deps.db, provider, deps.alerts),
      },
    });
  } else {
    const reason = `payment provider unavailable (${deps.payment.reason})`;
    candidates.push({ name: SCHEDULED_JOB_NAMES.checkoutSweep, reason });
    candidates.push({ name: SCHEDULED_JOB_NAMES.reconciliation, reason });
  }
  candidates.push({
    spec: {
      name: SCHEDULED_JOB_NAMES.stuckState,
      intervalMs: intervalFor(SCHEDULED_JOB_NAMES.stuckState),
      run: (context) => stuckStatePass(deps.db, deps.alerts, context),
    },
  });
  candidates.push({
    spec: {
      name: SCHEDULED_JOB_NAMES.holdSweep,
      intervalMs: intervalFor(SCHEDULED_JOB_NAMES.holdSweep),
      run: (context) => holdSweepPass(deps.db, context),
    },
  });
  candidates.push({
    spec: {
      name: SCHEDULED_JOB_NAMES.roleExpiry,
      intervalMs: intervalFor(SCHEDULED_JOB_NAMES.roleExpiry),
      run: async () => {
        const summary = await processExpiredAssignments({ db: deps.db });
        return { items: summary.expiredCount, facts: { expired: summary.expiredCount } };
      },
    },
  });
  candidates.push({
    spec: {
      name: SCHEDULED_JOB_NAMES.invitationExpiry,
      intervalMs: intervalFor(SCHEDULED_JOB_NAMES.invitationExpiry),
      run: async () => {
        const summary = await expireDueStaffInvitations({ db: deps.db });
        return { items: summary.expiredCount, facts: { expired: summary.expiredCount } };
      },
    },
  });

  const composition: ScheduledJobsComposition = { jobs: [], unavailable: [], disabled: [] };
  const disabled = new Set(policy.disabledJobs);
  for (const candidate of candidates) {
    if ('spec' in candidate) {
      if (disabled.has(candidate.spec.name)) composition.disabled.push(candidate.spec.name);
      else composition.jobs.push(candidate.spec);
    } else if (!disabled.has(candidate.name)) {
      composition.unavailable.push(candidate);
    } else {
      composition.disabled.push(candidate.name);
    }
  }
  return composition;
}
