/**
 * W6-1 — the ONE canonical production runtime bootstrap (docs/37 §2/§3).
 *
 * The production API executable and the certification harness both compose
 * through here — there is no second production composition path. The
 * executable stays thin (scripts/start-api.ts); everything meaningful is
 * testable in-process.
 *
 * Composition rules (all fail-closed; docs/37 §6):
 * - canonical `createPool` (UTC session pin) with explicit lifecycle —
 *   the W6-0 finding that the dev server bypasses it never reaches
 *   production;
 * - the connected DB identity MUST match the runtime role's login
 *   (docs/37 §28): api → himma_api, worker → himma_worker; a mispasted
 *   credential (schema owner, migration owner, the wrong runtime login)
 *   refuses startup;
 * - identity: real Cognito adapters when COGNITO_* is configured
 *   (fail-closed parser), else the certified UNCONFIGURED refusal adapters
 *   — NEVER the dev identity provider (build-app refuses it in production
 *   anyway; this module does not even import it);
 * - payments: `resolvePaymentProvider` with the EXPLICIT mode only —
 *   `disabled` composes nothing (certified refusals), `test` composes the
 *   Stripe TEST driver; the deterministic provider is not imported here
 *   and `productionChargingPossible` remains the literal false;
 * - evidence storage: the real S3 driver when configured; absent = the
 *   certified fail-closed 404 surface; `contentSafetyReady` stays false
 *   (docs/36 VE-02 — untouched);
 * - rate limiting: the PostgreSQL store (docs/37 §9); the in-memory store
 *   cannot compose (its factory throws in production — unchanged).
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Pool } from 'pg';

import type { RuntimeConfig } from '../config/runtime';
import { EXPECTED_DB_LOGIN } from '../config/runtime';
import { createDb, type Db } from '../db/kysely';
import { expectedMigrationHead } from '../db/migrations';
import { createPool } from '../db/pool';
import { buildLoggerOptions } from '../observability/logging';
import { PgRateLimiterStore } from '../modules/identity/http/pg-rate-limiter-store';
import type { IdentityHttpOptions } from './build-app';
import { buildApp } from './build-app';
import { CognitoAccessTokenVerifier } from '../modules/identity/providers/cognito/cognito-access-token-verifier';
import { CognitoAuthProviderAdapter } from '../modules/identity/providers/cognito/cognito-adapter';
import { parseCognitoConfig } from '../modules/identity/providers/cognito/config';
import { createCognitoSessionContinuity } from '../modules/identity/providers/cognito/session-continuity-composition';
import {
  UnconfiguredAccessTokenVerifier,
  UnconfiguredAuthProviderAdapter,
  UnconfiguredMailSender,
} from '../modules/identity/providers/unconfigured/unconfigured-identity';
import { createS3EvidenceStore } from '../modules/provider/storage/s3-evidence-store';
import { resolvePaymentProvider } from '../modules/payment/provider-composition';

export class ProductionRuntimeError extends Error {}

export interface ProductionRuntime {
  app: FastifyInstance;
  pool: Pool;
  db: Db;
  drainSignal: { draining: boolean };
  /** The migration head this build requires (readiness compares against it). */
  requiredMigrationHead: string;
}

/** Startup identity assertion (docs/37 §6/§28): credential ↔ role, verified at the DB. */
export async function assertRuntimeDbIdentity(
  db: Db,
  role: 'api' | 'worker' | 'maintenance',
): Promise<string> {
  const expected = EXPECTED_DB_LOGIN[role];
  const result = await sql<{ identity: string }>`SELECT current_user AS identity`.execute(db);
  const identity = result.rows[0]?.identity;
  if (identity !== expected) {
    throw new ProductionRuntimeError(
      `RUNTIME_ROLE=${role} must connect as "${expected}" but the DATABASE_URL credential is "${identity ?? 'unknown'}" — refusing startup (docs/37 §28: role-specific credentials are never interchangeable).`,
    );
  }
  return identity;
}

export async function composeProductionRuntime(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProductionRuntime> {
  if (config.role !== 'api') {
    throw new ProductionRuntimeError(
      `composeProductionRuntime currently serves RUNTIME_ROLE=api only (W6-1); the worker/maintenance runtimes arrive with W6-2/W6-3 — received "${config.role}".`,
    );
  }
  const pool = createPool(config);
  const db = createDb(pool);
  try {
    await assertRuntimeDbIdentity(db, config.role);
  } catch (error) {
    await pool.end();
    throw error;
  }

  const drainSignal = { draining: false };
  const requiredMigrationHead = expectedMigrationHead();

  // Identity: real Cognito when configured (ID-02), else honest refusal.
  const cognito = parseCognitoConfig(env);
  const continuity = createCognitoSessionContinuity(config.nodeEnv, env);
  // The mail sender is constructed before the app exists; warnings route
  // to the app logger once it does (nothing sends mail during composition).
  const appHolder: { app?: FastifyInstance } = {};
  const warn = (line: string) => {
    appHolder.app?.log.warn(line);
  };
  const identity: IdentityHttpOptions = {
    db,
    accessTokenVerifier:
      cognito !== undefined
        ? new CognitoAccessTokenVerifier(cognito)
        : new UnconfiguredAccessTokenVerifier(),
    idTokenAdapter:
      cognito !== undefined
        ? new CognitoAuthProviderAdapter(cognito)
        : new UnconfiguredAuthProviderAdapter(),
    mailSender: new UnconfiguredMailSender(warn),
    nodeEnv: config.nodeEnv,
    rateLimiterStore: new PgRateLimiterStore(db),
    ...(continuity !== undefined
      ? { sessionContinuity: continuity.sessionContinuity, providerRevoker: continuity.providerRevoker }
      : {}),
    ...(config.evidenceStorage !== undefined
      ? {
          verificationEvidenceStorage: {
            store: createS3EvidenceStore(config.evidenceStorage),
            // docs/36 VE-02: no scanning capability exists — stays false;
            // production `true` still throws inside buildApp.
          },
        }
      : {}),
    // adminReadiness deliberately absent in W6-1: the four flags require
    // the real-pool smokes (docs/36 ID-03/ID-04) — production admin/
    // provider surfaces stay fail-closed absent until then.
  };

  const payment = resolvePaymentProvider(config.nodeEnv, {
    ...(config.stripe !== undefined ? { stripe: config.stripe } : {}),
    paymentsMode: config.paymentsMode,
  });

  const app = buildApp({
    logger: buildLoggerOptions({ role: config.role, level: config.logLevel }),
    runtime: {
      readiness: {
        db,
        expectedMigrationHead: requiredMigrationHead,
        expectedDbIdentity: EXPECTED_DB_LOGIN[config.role],
        drainSignal,
      },
    },
    identity,
    ...(payment.kind === 'configured' && config.checkoutUrls !== undefined
      ? { payment: { provider: payment.provider, checkoutUrls: config.checkoutUrls } }
      : payment.kind === 'configured'
        ? { payment: { provider: payment.provider } }
        : {}),
  });

  appHolder.app = app;
  return { app, pool, db, drainSignal, requiredMigrationHead };
}

export interface ShutdownController {
  /** Idempotent; resolves when drained and closed. */
  shutdown: () => Promise<void>;
  /** Immediate exit path for a second signal / exceeded budget. */
  forceExit: () => never;
}

/**
 * Graceful shutdown (docs/37 §8): readiness fails → listener closes with a
 * bounded in-flight drain → pool ends → clean exit. A second signal or an
 * exceeded drain budget force-exits non-zero.
 */
export function createShutdown(
  runtime: Pick<ProductionRuntime, 'app' | 'pool' | 'drainSignal'>,
  options: { drainMs: number; exit?: (code: number) => never },
): ShutdownController {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;
  const shutdown = async (): Promise<void> => {
    if (started) return;
    started = true;
    runtime.drainSignal.draining = true;
    const budget = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), options.drainMs).unref(),
    );
    // Keep-alive sockets whose LAST request finishes mid-drain would
    // otherwise hold close() open until their keep-alive timeout — sweep
    // newly idle connections while active requests finish.
    const idleSweep = setInterval(() => {
      runtime.app.server.closeIdleConnections();
    }, 250);
    idleSweep.unref();
    const closed = runtime.app.close().then(() => 'closed' as const);
    const outcome = await Promise.race([closed, budget]);
    clearInterval(idleSweep);
    if (outcome === 'timeout') {
      runtime.app.log.error('graceful shutdown exceeded the drain budget — forcing exit');
      await runtime.pool.end().catch(() => undefined);
      exit(1);
    }
    await runtime.pool.end();
  };
  return {
    shutdown,
    forceExit: () => exit(1),
  };
}
