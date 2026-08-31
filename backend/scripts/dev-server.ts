/**
 * RI-1 — the bounded DEVELOPMENT runtime composition (docs/34 §4.6).
 *
 * The repository previously composed `buildApp` only from tests; this
 * script is the smallest runnable local server so the Customer App can
 * talk to a real backend. It is NOT production infrastructure:
 *
 * - REFUSES to start when NODE_ENV=production (the dev identity provider
 *   is structurally impossible there — `buildApp` enforces it too).
 * - Composes the certified app exactly as tests do: real PostgreSQL via
 *   the typed config, the certified identity/booking/payment surfaces,
 *   and the deterministic DEV identity provider (D-RI-3) standing in for
 *   the Cognito client flows. No fixture/live/unconfigured boundary is
 *   weakened: payment stays UNCONFIGURED unless explicitly composed
 *   (the certified fail-closed customer refusal), admin/provider
 *   surfaces stay off by default for the customer-facing dev server.
 * - CORS: the certified session-continuity origin allowlist is used
 *   (exact origins from DEV_CORS_ORIGINS; defaults cover the local Expo
 *   web dev server) — the API is never globally opened.
 *
 * Run: `npm run dev:server` (PORT, DEV_CORS_ORIGINS, DATABASE via the
 * standard PG* env / .env conventions).
 */
import { Pool } from 'pg';

import { buildApp } from '../src/app/build-app';
import { createDb } from '../src/db/kysely';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { DevPasswordIdentityProvider } from '../src/modules/identity/providers/dev/dev-password-identity';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import { registerDevCheckinActor } from './dev-checkin-actor';
import { registerDevHostedCheckout } from './dev-hosted-checkout';
import { cliConfig, fail } from './cli-env';

const DEFAULT_PORT = 3101;
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:19006',
];

async function main(): Promise<void> {
  const config = cliConfig();
  if (config.nodeEnv === 'production') {
    throw new Error(
      'dev-server is a development-only composition and refuses to start in production.',
    );
  }

  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    ...(config.database.password !== undefined ? { password: config.database.password } : {}),
  });
  const db = createDb(pool);

  const devIdentity = new DevPasswordIdentityProvider();
  // RI-3 — DEV payment composition (docs/33 §13.1; owner RI-3 §13): the
  // certified DETERMINISTIC provider stands in for Stripe so the certified
  // W5 customer checkout/webhook/saga machinery runs end-to-end locally.
  // Structurally impossible in production (provider-composition refuses the
  // deterministic provider there, and this script refuses production
  // outright); `productionChargingPossible` remains the literal false —
  // nothing here touches the W5 production gates.
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? '127.0.0.1';
  const paymentProvider = new DeterministicPaymentProvider({
    // Fixed injected clock (the provider never reads system time); its
    // webhook build/verify use the SAME instant, so signatures stay valid
    // for the process lifetime. Cosmetic only — no customer-wire effect.
    now: new Date(),
    webhookSecret: process.env.DEV_PAYMENT_WEBHOOK_SECRET ?? 'dt_whsec_fictional',
    // The hosted page is served by THIS dev server (the provider's own
    // page stand-in) so the full browser journey runs locally.
    hostedBaseUrl: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/dev/payments/hosted`,
  });
  const appOrigin = process.env.DEV_APP_ORIGIN ?? 'http://localhost:8081';
  const checkoutUrls = {
    successUrl: process.env.DEV_CHECKOUT_SUCCESS_URL ?? `${appOrigin}/bookings/return`,
    cancelUrl: process.env.DEV_CHECKOUT_CANCEL_URL ?? `${appOrigin}/bookings/return?outcome=cancel`,
  };
  const allowedOrigins =
    process.env.DEV_CORS_ORIGINS !== undefined && process.env.DEV_CORS_ORIGINS !== ''
      ? process.env.DEV_CORS_ORIGINS.split(',').map((origin) => origin.trim())
      : DEFAULT_CORS_ORIGINS;

  const app = buildApp({
    logger: true,
    identity: {
      db,
      accessTokenVerifier: devIdentity,
      idTokenAdapter: devIdentity,
      mailSender: new CaptureMailSender(),
      nodeEnv: config.nodeEnv,
      // Customer-facing dev server: admin/provider surfaces stay off.
      enableAdminRoutes: false,
      sessionContinuity: {
        cookieConfig: {
          secure: false,
          refreshCookieMaxAgeSeconds: 30 * 24 * 3600,
          allowedOrigins,
        },
        tokenRefresher: devIdentity,
      },
    },
    devIdentity: { provider: devIdentity },
    payment: { provider: paymentProvider, checkoutUrls },
  });

  // The dev-only hosted-checkout stand-in (the fake provider's own pages;
  // never part of buildApp, never composable in production).
  registerDevHostedCheckout(app, {
    provider: paymentProvider,
    checkoutUrls,
    webhookDelayMs: Number(process.env.DEV_PAYMENT_WEBHOOK_DELAY_MS ?? 900),
  });
  // RI-4 — the dev-only provider check-in ACTOR (real S6-2 services under
  // a real front-desk membership; Playwright's stand-in for the desk).
  registerDevCheckinActor(app, { db });

  await app.ready();
  await app.listen({ port, host });
   
  console.log(
    `Himma dev server listening on http://${host}:${port} (env=${config.nodeEnv}, db=${config.database.database})`,
  );
}

main().catch(fail);
