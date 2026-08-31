# 36 — Launch Readiness & Production Gates (LR-0)

**Status: LR-0 delivered (2026-08-31 — this commit, awaiting owner review). DOCUMENTATION/RECONCILIATION ONLY: no application code changed, no migration, no production configuration or secret exists in this repository, no closed feature/domain reopened, `productionChargingPossible` untouched (literal `false`).**

This document is the **canonical, authoritative launch-readiness record** for Himma. From this commit forward, launch blockers live HERE — not distributed across HANDOFF paragraphs. HANDOFF points to this file; each future slice that closes a gate updates the matrix row in the same commit (the owning-slice pattern). The feature/domain record stays in docs/24–35; this document records only what still stands between the closed platform and real customers paying real money.

**Authority:** owner directive 2026-08-31 (LR-0 authorized at the RI-6/W1-RI closure `a063951`); docs/23 §10 (architecture requirements), §11/§11.1 (scale + correctness gates), §13 (security/privacy/legal), §14 (native validation), §15 (launch gates G1–G9), §16 (phasing), §18 (owner decisions), §19 (standing payment prohibition); docs/26 (identity §14.E′), docs/31 (W3 closure carried prerequisites), docs/32–33 (S5/W5 closures incl. D-W5-3/5/6/7), docs/34 (W1-RI closure + the RI-6 §32 release-readiness report), docs/35 (S6 closure deferrals), docs/09 (open decisions). Every code-behavior claim below was verified against source at `a063951` (file references inline).

**Reconciled baseline (all frozen at `a063951`):** RI-6 base `f573c27` · Customer App Jest 549/549 ×41 · Playwright 15/15 · backend 1259/1259 ×103 · `db:verify` 20/0 · portal 815/815 + contract 77/77 · admin 138/138 · iOS Simulator + Android Emulator certified · migration head `0020_membership_booking_and_multi_occurrence_attendance`.

---

## 1. What is CODE-COMPLETE (closed domains — NOT reopened by anything below)

These foundations are implemented and locally certified. A gate elsewhere in this matrix may require *configuring, composing, or smoking* them in a real environment — that is a production operational gate, never a reopening of the closed domain.

| # | Foundation | Evidence |
|---|---|---|
| CC-1 | Customer App (RI-1→RI-6): full journeys on real APIs, native hardening, production bundle hygiene, navigation-only `himma://` payment return, venue-timezone truth | docs/34; `a063951` |
| CC-2 | Backend platform S1–S6: identity/authz, catalogue/search, booking/capacity (DB-enforced, race-proven), fulfillment/entitlements/attendance | docs/26–28, 32, 35 |
| CC-3 | W5 payment core W5-0…W5-6: intent/attempt/ledger/gateway-event persistence, hosted-checkout orchestration, trusted webhook ingestion (raw-byte signature verify + rotation), confirmation/compensation saga, `sweepLapsedPaidCheckouts`, converged customer status vocabulary | docs/33 |
| CC-4 | D-W5-7 commission economics: org-bound bps terms, immutable per-intent snapshots, integer round-half-up, fail-closed without a term | docs/33 §14.1 |
| CC-5 | Real Stripe TEST-mode driver (`stripe-driver.ts`, stripe@22.5.0) incl. `stripe:smoke` script — **sandbox-only by construction** | `backend/src/modules/payment/stripe-driver.ts` |
| CC-6 | Real Cognito adapters: backend refresh/revoke clients + fail-closed `parseCognitoConfig`; app public-client gateway + fail-closed selection | docs/26 §14.E; `src/services/auth/` |
| CC-7 | MFA/step-up: TOTP enrollment, step-up challenge, recovery codes, deny-by-default route policy registry (`admin`/`adminStepUp`, D-W3-5 classified), provider MFA baseline | `backend/src/modules/identity/` |
| CC-8 | Evidence storage port + real S3 SigV4 driver (server-proxied bytes, SSE, no presigned URLs, no ACLs) | `backend/src/modules/provider/storage/s3-evidence-store.ts` |
| CC-9 | Provider Portal W2-0…W2-13 live on real APIs (fulfillment config, check-in, attendance) | docs/29–30; HANDOFF |
| CC-10 | Admin Portal W3-0…W3-9 (verification, moderation, taxonomy, feedback, oversight, audit explorer) | docs/31 |
| CC-11 | PostgreSQL-backed redemption anti-brute-force throttle (production-suitable by construction) | migration `0018`; `attendance-redemption.ts` |
| CC-12 | Fail-closed production refusals (all verified): production payment composition refuses every provider · non-TEST Stripe keys throw at construction · `contentSafetyReady=true` throws without a real scanner · in-memory rate-limit store refuses production boot · admin/provider surfaces refuse production registration without the four `AdminProductionReadiness` flags | `provider-composition.ts` · `stripe-driver.ts` · `build-app.ts` · `rate-limiter.ts` |

---

## 2. Classification legend

**Status (exactly one per gate):** `CODE-COMPLETE` · `CONFIGURATION-REQUIRED` (code exists; real environment/provider configuration missing) · `EXTERNAL-DEPENDENCY` (third-party account/credentials/signing/legal/provider action) · `OWNER-DECISION` (genuine product/business/legal decision outstanding) · `IMPLEMENTATION-REQUIRED` (known remaining code/operational automation) · `PRODUCTION-SMOKE-REQUIRED` (configuration may exist; real-environment certification outstanding) · `BLOCKED` (cannot proceed until a named gate closes).

**Priority:** `P0` = launch blocker (required for correctness/security/financial legality at the first real customer payment) · `P1` = launch hardening · `PL` = post-launch (register in §12).

**Milestones (targets, §6):** M1 infra · M2 auth · M3 payment test-mode · M4 operations · M5 native release candidate · M6 live financial activation · M7 public launch.

---

## 3. The canonical gate matrix

### 3.A Identity / customer auth (ID)

| ID | Gate | Status | Pri | Depends on | Mile | Owner | Evidence · closure proof |
|---|---|---|---|---|---|---|---|
| ID-01 | Production Cognito User Pool provisioned (region per IN-01) | EXTERNAL-DEPENDENCY | P0 | IN-01 | M2 | Owner/company (AWS) | docs/26 §1 (no pool exists, recorded not guessed). Proof: pool + issuer recorded in ops config inventory |
| ID-02 | App/portal client configuration: public mobile client, portal client ids, `COGNITO_REFRESH_CLIENT_ID`; app `EXPO_PUBLIC_COGNITO_ISSUER`/`_CLIENT_ID` | CONFIGURATION-REQUIRED | P0 | ID-01 | M2 | Ops + owner | `parseCognitoConfig` throws on partial/insecure values (`cognito/config.ts:36-76`); app selection fail-closed (docs/34 RI-6). Proof: config parses; app selects the REAL gateway |
| ID-03 | Real email/password production smoke (§14.E′): sign-up/sign-in/refresh/revoke + live-browser cookie inspection against the real pool | PRODUCTION-SMOKE-REQUIRED | P0 | ID-02 | M2 | Engineering | docs/26 §14.E′ (recorded operational work, "not claimed — no pool exists"). Proof: smoke transcript recorded in docs |
| ID-04 | Real-pool `SOFTWARE_TOKEN_MFA`/step-up smoke → the four `AdminProductionReadiness` flags truthfully set (`cognitoConfigured` · `mfaProviderValidated` · `realPoolSmokeVerified` · `productionConfigApproved`) — production admin/provider surfaces refuse registration without them | PRODUCTION-SMOKE-REQUIRED | P0 | ID-02 | M2 | Engineering + owner | `build-app.ts` startup gate (verified); docs/26 §14.E′ item 3. Proof: production boot with admin routes registered |
| ID-05 | Apple Sign-In: Developer Program capability, Services ID, credentials | EXTERNAL-DEPENDENCY | P1* | MR-02 | M5 | Owner/company | docs/34 §32. *P1 with a binding coupling: shipping Google login without Apple login is store-prohibited — ID-05/06/07 ship together or not at all; email/password-only launch is certified and viable (descope = owner decision) |
| ID-06 | Google Sign-In: OAuth clients, credentials | EXTERNAL-DEPENDENCY | P1* | MR-03 | M5 | Owner/company | docs/34 §32; same coupling as ID-05 |
| ID-07 | Social wiring: Cognito federation config + native modules (`expo-apple-authentication`, Google) + honest-flag flip (`EXPO_PUBLIC_*_SIGN_IN_ENABLED`) | IMPLEMENTATION-REQUIRED | P1* | ID-05, ID-06 | M5 | Engineering | App flags env-derived fail-closed false (docs/34). Proof: native-device login journey (MR-11) |
| ID-08 | Identity DR/backup posture (pool export limits, cross-region stance per docs/23 §10.11) | OWNER-DECISION | P1 | IN-01 | M4 | Owner + counsel | docs/26 §1. Proof: recorded ruling |

### 3.B API / infrastructure (IN)

| ID | Gate | Status | Pri | Depends on | Mile | Owner | Evidence · closure proof |
|---|---|---|---|---|---|---|---|
| IN-01 | Hosting region / data-residency ruling (docs/23 §18.3) | OWNER-DECISION | P0 | — | M1 | Owner + counsel | Blocks Cognito region, PG, S3, PDPL posture. Proof: recorded ruling |
| IN-02 | **Production service entrypoint + composition.** VERIFIED: no `start` script exists; `buildApp` is composed ONLY by `scripts/dev-server.ts` (which refuses `NODE_ENV=production`) and tests. A production entrypoint must compose: Stripe driver seam, S3 evidence store, Cognito adapters, distributed rate-limit store, readiness flags, logger | IMPLEMENTATION-REQUIRED | P0 | IN-01 | M1 | Engineering (W6) | `backend/package.json` (no start); `dev-server.ts:45-49`. Proof: production-mode boot in staging topology |
| IN-03 | Production API origin: DNS + TLS + the `himma.app` domain estate (also carries PA-05 bounce/universal links and LE-09 share-link resolution) | EXTERNAL-DEPENDENCY | P0 | IN-01 | M1 | Owner/company | App refuses production build without `EXPO_PUBLIC_API_URL` (docs/34). Proof: https origin serving `/internal/health` |
| IN-04 | Secret management: managed store delivering env vars (backend is env-only by design; `loadConfig` fail-closed — production refuses missing `DATABASE_URL`) | CONFIGURATION-REQUIRED | P0 | IN-01 | M1 | Ops | `config/env.ts:123-132`. Proof: secrets sourced from the managed store, none in code/images |
| IN-05 | Production PostgreSQL at the financial service class (docs/23 §10.11: RPO 0 committed transactions, quorum/PITR) | EXTERNAL-DEPENDENCY | P0 | IN-01 | M1 | Ops | Proof: provisioned instance + replication posture recorded |
| IN-06 | Production object storage bucket + IAM (the S3 driver is CODE-COMPLETE and never composed anywhere — verified: only caller is its test) | CONFIGURATION-REQUIRED | P0 | IN-01 | M1 | Ops | `s3-evidence-store.ts:63` callers. Proof: composed in IN-02; VE-01 smoke |
| IN-07 | **Distributed rate-limit store.** VERIFIED: the identity limiter is in-memory and `createRateLimiterStore` THROWS in production — production boot is refused with default wiring | IMPLEMENTATION-REQUIRED | P0 | IN-02 | M1 | Engineering (W6) | `identity/http/rate-limiter.ts:65-75`. Proof: approved distributed store passes the existing limiter contract tests |
| IN-08 | Rate limiting on search/booking + signup bot controls (docs/23 §10.7 — currently only auth/provider routes are limited) | IMPLEMENTATION-REQUIRED | P1 | IN-07 | M4 | Engineering | rate-limiter call sites (8, all auth/provider). Proof: limits on the §10.7 surfaces |
| IN-09 | Structured logging + request-id propagation. VERIFIED: logger defaults OFF (`build-app.ts` `logger?: boolean`), no `genReqId`/`x-request-id`, and `audit_event.request_id` is never populated by any caller | IMPLEMENTATION-REQUIRED | P0 | IN-02 | M1 | Engineering (W6) | `db/audit.ts:20,40` (writer exists, unwired). Proof: request ids end-to-end incl. audit rows |
| IN-10 | Observability: metrics, traces, error tracking (all three frontends + API), uptime checks, alerting. VERIFIED: none exists (no otel/sentry/prometheus anywhere; 9 runtime deps) | IMPLEMENTATION-REQUIRED | P0 | IN-02 | M4 | Engineering (W6) | docs/23 §10.10. Proof: G8 monitoring live with alert routing |
| IN-11 | CI/CD: typecheck/lint/unit/contract/E2E on merge, automated two-phase migrations, one-command deploy with **tested rollback** | IMPLEMENTATION-REQUIRED | P0 | — | M1 | Engineering (W6) | docs/23 §10.9 (today: local scripts only). Proof: rehearsed deploy+rollback in staging |
| IN-12 | Staging environment, config-identical topology, seeded deterministic data (dev seed graduates) | CONFIGURATION-REQUIRED | P0 | IN-01…06 | M1 | Ops | docs/23 §10.8. Proof: staging serving all three frontends |
| IN-13 | Backup/restore rehearsals per service class (financial class first) + region-failure runbook | PRODUCTION-SMOKE-REQUIRED | P0 | IN-05 | M4 | Ops | docs/23 §10.11. Proof: rehearsal records |
| IN-14 | §11.1 Tier-1 load/correctness gates in staging on production topology (final-seat concurrency, zero oversell, zero duplicate charges, webhook convergence, clean failover) — G5 | PRODUCTION-SMOKE-REQUIRED | P0 | IN-12, M3 | M7 | Engineering | docs/23 §11.1. Proof: pass/fail run records |
| IN-15 | CDN + image pipeline for catalogue media (docs/23 §10.6) | IMPLEMENTATION-REQUIRED | P1 | IN-06 | M5 | Engineering | Rides with PR-04. Proof: media served via CDN with resizing |

### 3.C Payments (PA)

| ID | Gate | Status | Pri | Depends on | Mile | Owner | Evidence · closure proof |
|---|---|---|---|---|---|---|---|
| PA-01 | Real Stripe account: UAE business/KYB verification, AED settlement account (D-W5-1: if UAE platform onboarding proves unavailable → STOP for owner reassessment, never a silent second gateway) | EXTERNAL-DEPENDENCY | P0 | LE-07 | M3 | Owner/company | docs/33 §14.1. Proof: activated Stripe account, test keys issued |
| PA-02 | Stripe TEST credentials + webhook signing secret(s) into managed config (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`[`_RETIRING`]) | CONFIGURATION-REQUIRED | P0 | PA-01, IN-04 | M3 | Ops | `config/env.ts:53-66`. Proof: `stripe:smoke` reaches the API |
| PA-03 | Public webhook ingress: https endpoint routing to `POST /payments/webhook/stripe` | CONFIGURATION-REQUIRED | P0 | IN-02, IN-03 | M3 | Ops | Route registered only when a provider is composed (docs/33 W5-3). Proof: signed Stripe test event → 200 |
| PA-04 | **D-W5-6 TEST-mode certification** (never faked, all OPEN): `npm run stripe:smoke` · real hosted checkout · webhook delivery · test payment → saga confirmation · late-success compensation · idempotent retry | PRODUCTION-SMOKE-REQUIRED | P0 | PA-02, PA-03 | M3 | Engineering | docs/33 (D-W5-6 recorded OPEN at every W5 closure). Proof: recorded smoke transcript per item |
| PA-05 | Production https payment-return infrastructure: bounce page / universal + app links on the owned domain → `himma://bookings/return` (Stripe rejects custom schemes as return URLs) | IMPLEMENTATION-REQUIRED | P0 | IN-03 | M5 | Engineering | docs/34 §32. Proof: MR-12 device journey through the real bounce |
| PA-06 | **Live-mode enablement slice.** VERIFIED structural blocks: `StripeDriver` constructor throws on non-TEST keys (`stripe-driver.ts:70,83`); `resolvePaymentProvider` returns `unconfigured` for production unconditionally (`provider-composition.ts:45-61`); `productionChargingPossible` is the literal TYPE `false` (§7). Flipping any of this is a future owner-approved implementation slice | BLOCKED | P0 | FI-01, FI-02, PA-04, OP-01/02/03, LE-06, explicit owner approval | M6 | Owner → Engineering | §7 below. Proof: the enablement slice's own certification |
| PA-07 | Controlled live pilot: first live charge, refund/compensation dual-control exercised with real money (G4) | PRODUCTION-SMOKE-REQUIRED | P0 | PA-06 | M6 | Owner + ops | docs/23 §15 G4. Proof: pilot record |
| PA-08 | Customer cancellation + general refund authority. VERIFIED GAP (recorded at S5/S6 closures): no certified customer cancellation path exists; only the W5-4 same-amount compensation reversal exists. Refund-with-dual-control (AD-10) needs a real refund authority | IMPLEMENTATION-REQUIRED | P0 | LE-04 | M4 | Owner → Engineering | docs/35 closure gaps; docs/31 AD-10. Proof: owner-approved slice certification |
| PA-09 | Reconciliation operations: schedule `reconcileLedgerAgainstProvider` (VERIFIED: pure read, invoked by tests only) + daily ops procedure + `reconciliation_event` persistence when authorized (explicitly deferred, no migration yet) | IMPLEMENTATION-REQUIRED | P0 | OP-01 | M4 | Engineering + ops | `payment-reconciliation.ts:61-63`. Proof: scheduled run + alert on divergence |
| PA-10 | Stuck-payment alerting: wire `findStuckPaymentStates` (hooks exist, no alert channel) to real alerting | IMPLEMENTATION-REQUIRED | P0 | IN-10, OP-01 | M4 | Engineering | docs/33 W5-6. Proof: synthetic stuck state alerts within minutes (docs/23 §12.10) |
| PA-11 | Apple Pay / Google Pay on hosted Checkout (Stripe config; Apple Pay domain registration) | CONFIGURATION-REQUIRED | P1 | PA-02, IN-03 | M5 | Ops | D-W5-1 target. Proof: wallets visible on the hosted page |

### 3.D Commercial / finance (FI)

| ID | Gate | Status | Pri | Depends on | Mile | Owner | Evidence · closure proof |
|---|---|---|---|---|---|---|---|
| FI-01 | UAE VAT ruling (D-W5-3; docs/09 §22.2 stands until then; Stripe Tax stays `notConfigured`) | OWNER-DECISION | P0 | LE counsel | M6 | Owner + counsel/accounting | docs/33 §14.1. Proof: recorded ruling + any authorized follow-up slice spec |
| FI-02 | Principal-vs-agent treatment + invoice responsibility | OWNER-DECISION | P0 | LE counsel | M6 | Owner + counsel | docs/33 D-W5-3. Proof: recorded ruling |
| FI-03 | Gateway-fee allocation (explicit future decision recorded at D-W5-7) | OWNER-DECISION | P1 | FI-02 | M6 | Owner | docs/33 §14.1. Proof: recorded ruling |
| FI-04 | Provider settlement/payout process. VERIFIED: settlement eligibility exists only as a projection; NO payout/Connect implementation. Decide manual payouts vs Stripe Connect; must be operational before providers accrue material balances | OWNER-DECISION | P1 | FI-02, FI-03 | M6 | Owner | docs/33 W5 closure ("Stripe Connect the preferred LATER direction"). Proof: recorded ruling + operational procedure |
| FI-05 | **Commission-term administration.** VERIFIED: `organization_commission_term` has NO HTTP mutation surface (dev/test fixtures only); D-W5-7 fails checkout closed without an active term — a production provider cannot take a paid booking until a term exists via a controlled capability (D-W3-5-classified Admin slice) or an owner-approved interim ops procedure | IMPLEMENTATION-REQUIRED | P0 | — | M3 | Owner → Engineering | docs/33 W5-4 closure (recorded launch prerequisite). Proof: slice certification incl. the D-W3-5 policy lock |
| FI-06 | Accounting/reconciliation finance procedure (books, commission accrual, VAT filing posture) | IMPLEMENTATION-REQUIRED | P1 | FI-01, PA-09 | M6 | Owner/finance | Proof: written procedure exercised once |
| FI-07 | Refund/compensation finance procedure (who approves, ledger→books flow) | IMPLEMENTATION-REQUIRED | P1 | PA-08 | M6 | Owner/finance | Proof: written procedure exercised in the PA-07 pilot |

### 3.E W6 operational runners (OP) — see the full runner inventory in §8

| ID | Gate | Status | Pri | Depends on | Mile | Owner | Evidence · closure proof |
|---|---|---|---|---|---|---|---|
| OP-01 | **Production scheduler/runner infrastructure.** VERIFIED: no scheduler, queue, worker, or `setInterval` exists anywhere in backend `src/`/`scripts/`; every job is a certified pure function awaiting a caller | IMPLEMENTATION-REQUIRED | P0 | IN-02 | M4 | Engineering (W6) | §8. Proof: runners deployed, idempotent-restart proven, alert on failure |
| OP-02 | Payment runner cadence: `sweepLapsedPaidCheckouts` + `processPendingGatewayEvents` + `processTrustedPaymentResults`. VERIFIED: today driven ONLY best-effort inside the webhook request handler — an outage stops convergence until the next webhook arrives. The W5-5 closure records the periodic runner as a **paid-production launch prerequisite** | IMPLEMENTATION-REQUIRED | P0 | OP-01 | M4 | Engineering | `payment-webhook-routes.ts:101-103`; docs/33 W5-5. Proof: cadence run + convergence within docs/23 §11.1 targets |
| OP-03 | Outbox relay + search-projection consumer. VERIFIED: outbox rows are appended and NEVER published (relay explicitly deferred, `outbox.ts:6`); `processSearchProjectionEvents` has "no standing relay worker" (`search-projection.ts:219-222`) — in production, provider publishes would never reach search | IMPLEMENTATION-REQUIRED | P0 | OP-01 | M4 | Engineering | Proof: publish → searchable p95 < 60 s (docs/23 §11.1) |
| OP-04 | Hold-expiry sweep cadence (`sweepExpiredHolds`). Correctness already holds without it — lapsed holds are reclaimed inline on the claim path and ignored by readers; the sweep is maintenance | IMPLEMENTATION-REQUIRED | P1 | OP-01 | M4 | Engineering | `booking-shared.ts:369`; `hold-lifecycle.ts:11-12` |
| OP-05 | Identity/staff sweeps (`processExpiredAssignments`, `expireDueStaffInvitations`) | IMPLEMENTATION-REQUIRED | P1 | OP-01 | M4 | Engineering | Both tests-only today |
| OP-06 | Retention jobs: redemption-attempt window cleanup (recorded "future W6 operational sweep", migration `0018:398`), audit/event retention. NOTE: the app DB role deliberately has no DELETE grant — retention needs a separately provisioned role | IMPLEMENTATION-REQUIRED | P1 | OP-01, VE-05 | M4 | Engineering | migrations 0001/0002/0004/0018 comments |
| OP-07 | Runner alerting + idempotent-restart certification (every runner already idempotent by design — restart behavior must be proven in the deployed mechanism) | IMPLEMENTATION-REQUIRED | P0 | OP-01, IN-10 | M4 | Engineering | §8 table. Proof: kill/restart drill |
| OP-08 | On-call rotation, §12 failure-drill runbooks, status page, support staffing (G8) | IMPLEMENTATION-REQUIRED | P0 | IN-10 | M7 | Owner/ops | docs/23 §13/§15 G8. Proof: staffed rotation + drill records |

### 3.F Verification / content safety (VE)

| ID | Gate | Status | Pri | Depends on | Mile | Owner | Evidence · closure proof |
|---|---|---|---|---|---|---|---|
| VE-01 | Evidence storage production composition (real S3 driver + bucket; today the only runnable server passes NO evidence storage → fail-closed 404) | CONFIGURATION-REQUIRED | P0 | IN-02, IN-06 | M4 | Ops | Verified caller analysis. Proof: upload/head/get smoke against the real bucket |
| VE-02 | **Content-safety/malware scanning.** VERIFIED: production `contentSafetyReady=true` THROWS at startup ("this build contains no evidence content-safety/scanning capability"); admin evidence retrieval is fail-closed `evidenceSafetyUnavailable` without it — provider verification cannot operate live, which blocks real onboarding (PR-02 → G2) | IMPLEMENTATION-REQUIRED | P0 | VE-01 | M4 | Engineering | `build-app.ts:370-376`; `evidence-storage.ts:301`; docs/31 carried prerequisite. Proof: genuine scanner integrated; flag truthfully true |
| VE-03 | Provider evidence-upload UX (the deferred W3-4-row deliverable; owner assignment pending, gated on D-W3-3) | IMPLEMENTATION-REQUIRED | P0 | VE-04 | M4 | Owner → Engineering | docs/31 closure. Proof: portal journey submitting real evidence |
| VE-04 | D-W3-3 launch evidence checklist (which documents Himma requires per provider) | OWNER-DECISION | P0 | LE counsel input | M4 | Owner | docs/31 (OPEN). Proof: recorded ruling |
| VE-05 | D-W3-6 evidence retention/secure-deletion policy | OWNER-DECISION | P1 | LE-02 | M4 | Owner + counsel | docs/31 (OPEN). Proof: recorded ruling + OP-06 job spec |
| VE-06 | Verification operational runbook (queue ownership, SLAs, escalation) | IMPLEMENTATION-REQUIRED | P1 | VE-02 | M7 | Ops | Proof: written runbook exercised on a pilot provider |

### 3.G Provider operations (PR)

| ID | Gate | Status | Pri | Depends on | Mile | Owner | Evidence · closure proof |
|---|---|---|---|---|---|---|---|
| PR-01 | §8.6 design-partner walkthrough sessions (EXTERNAL human gate, still PENDING — recorded at W2 closure; precedes provider-outreach certification) | EXTERNAL-DEPENDENCY | P0 | — | M7 | Owner | HANDOFF W2 row. Proof: session records + resulting corrections triaged |
| PR-02 | Real provider onboarding + launch catalogue through W2 (G2: real catalogue via onboarding, not seeds; taxonomy finalized) | EXTERNAL-DEPENDENCY | P0 | PR-01, VE-01…04, FI-05 | M7 | Owner/ops | docs/23 §15 G2. Proof: launch providers live end-to-end |
| PR-03 | Bulk-import live adapter (deferred by design at W2-12, structurally locked) | IMPLEMENTATION-REQUIRED | P1 | PR-01 | M7 | Engineering | HANDOFF W2-12. Proof: §8.5 batch-atomic import against the real API |
| PR-04 | Provider media authority: real listing imagery upload/serving/moderation + ASSET_ATTRIBUTION replacement (G2 imagery rights — incl. the Expo-logo iOS icon under MR-06) | IMPLEMENTATION-REQUIRED | P0 | IN-06, IN-15 | M5 | Owner → Engineering | RI-2 closure ("media = a separate later authority"); docs/23 G2. Proof: owner-approved slice certification |
| PR-05 | Moderation/check-in/support operating procedures + staffing (support tooling itself is CODE-COMPLETE in W3) | IMPLEMENTATION-REQUIRED | P1 | OP-08 | M7 | Ops | docs/31. Proof: written procedures + staffed queues |

### 3.H Mobile release (MR)

| ID | Gate | Status | Pri | Depends on | Mile | Owner | Evidence · closure proof |
|---|---|---|---|---|---|---|---|
| MR-01 | Final iOS bundle identifier + Android applicationId (today: dev placeholder `com.himma.dev`, deliberately unchanged) | OWNER-DECISION | P0 | — | M5 | Owner/company | docs/34 §32. Proof: recorded identifiers + prebuild config updated in the release slice |
| MR-02 | Apple Developer Program account | EXTERNAL-DEPENDENCY | P0 | — | M5 | Owner/company | Proof: account + team id available to the build pipeline |
| MR-03 | Google Play Console account | EXTERNAL-DEPENDENCY | P0 | — | M5 | Owner/company | Proof: account available |
| MR-04 | Signing credentials + EAS/build configuration (VERIFIED: no `eas.json` exists; `expo export` is the only release artifact path certified) | IMPLEMENTATION-REQUIRED | P0 | MR-01…03 | M5 | Engineering | docs/34 §32. Proof: signed store builds from CI |
| MR-05 | Store policy URLs: privacy policy, terms, support | BLOCKED | P0 | LE-01, LE-02 | M5 | Owner | Store listing cannot submit without them. Proof: live URLs |
| MR-06 | Final brand + store assets (icons — the Expo-logo iOS icon must be replaced; screenshots; metadata; bilingual type system per §18.6) | OWNER-DECISION | P0 | §18.6 brand engagement | M5 | Owner | docs/23 C7/G2. Proof: assets in the release build |
| MR-07 | Production app configuration: `EXPO_PUBLIC_API_URL` (+ Cognito public values) baked into release builds | CONFIGURATION-REQUIRED | P0 | IN-03, ID-02 | M5 | Engineering | App throws without it in production (verified RI-6). Proof: release build hits production API |
| MR-08 | **In-app account deletion flow.** VERIFIED GAP: docs/04 HMA-032 records deletion as a product requirement and Apple requires in-app account deletion for account-creating apps; no deletion flow exists in the app or a customer-facing API | IMPLEMENTATION-REQUIRED | P0 | LE-02 (retention rules) | M5 | Owner → Engineering | Store-review blocking. Proof: owner-approved slice certification |
| MR-09 | Physical-device iOS validation pass (§14 full pass: VoiceOver, Dynamic Type, performance profiling on production-scale seed) | EXTERNAL-DEPENDENCY | P0 | device procurement | M5 | Owner (device) + Engineering | docs/23 §14/G6; docs/34 (not claimed). Proof: recorded device pass |
| MR-10 | Physical-device Android validation pass (TalkBack etc.) | EXTERNAL-DEPENDENCY | P0 | device procurement | M5 | Owner + Engineering | Proof: recorded device pass |
| MR-11 | Native social-login device validation | BLOCKED | P1 | ID-05…07, MR-09/10 | M5 | Engineering | Proof: device journeys per provider |
| MR-12 | Real production payment-return validation: device → external browser → real https bounce/universal link → `himma://bookings/return` | PRODUCTION-SMOKE-REQUIRED | P0 | PA-05, MR-09/10 | M5 | Engineering | docs/34 §32. Proof: recorded device journey (TEST mode) |
| MR-13 | TestFlight/Play internal tracks, privacy manifests + data-safety forms, phased rollout config, G6 crash-free ≥ 99.8 % with zero checkout-path criticals, store review passed | PRODUCTION-SMOKE-REQUIRED | P0 | MR-04…08 | M7 | Engineering + owner | docs/23 §14.5/§15 G6. Proof: track metrics + store approval |
| MR-14 | Customer notification channels (push/email/SMS per §18.20) — nothing sends notifications today (outbox events exist, no sender) | OWNER-DECISION | P1 | OP-03 | M7 | Owner | docs/23 §18.20. Proof: recorded ruling + authorized slice |

### 3.I Security (SE)

| ID | Gate | Status | Pri | Depends on | Mile | Owner | Evidence · closure proof |
|---|---|---|---|---|---|---|---|
| SE-01 | Production secret inventory + rotation procedure (webhook retiring-secret rotation is CODE-COMPLETE; the procedure and inventory are not) | IMPLEMENTATION-REQUIRED | P0 | IN-04 | M1 | Ops | docs/23 §13. Proof: written inventory; one rehearsed rotation |
| SE-02 | Third-party penetration test + OWASP ASVS review, criticals/highs closed (G3) | EXTERNAL-DEPENDENCY | P0 | M1–M5 substantially complete | M7 | Owner/company | docs/23 §13/§15 G3. Proof: report + remediation record |
| SE-03 | Dependency/vulnerability + container scanning in CI (the docs/13 "tooling-only" acceptance EXPIRED at backend start per docs/23 C10) | IMPLEMENTATION-REQUIRED | P0 | IN-11 | M1 | Engineering (W6) | docs/23 §13/C10. Proof: CI gate active with a triage policy |
| SE-04 | PDPL compliance package: lawful basis, consent records, retention schedules, data-subject export/deletion, breach-notification runbook, data map | EXTERNAL-DEPENDENCY | P0 | LE-02, LE-05, IN-01 | M7 | Counsel + owner | docs/23 §13. Proof: counsel sign-off (G3) |
| SE-05 | Audit request-id wiring + audit-log retention (VERIFIED: `audit_event.request_id` never populated; no retention job — recorded W6 scope, not a closed-slice defect) | IMPLEMENTATION-REQUIRED | P1 | IN-09, OP-06 | M4 | Engineering | `db/audit.ts`. Proof: populated ids + retention job |
| SE-06 | Incident-response contacts, severity ladder, comms templates | IMPLEMENTATION-REQUIRED | P0 | OP-08 | M7 | Ops | docs/23 §13. Proof: documented + drilled |

### 3.J Legal / policy (LE)

*No speculative legal requirement below is asserted as fact; where the repository has no canonical ruling the item requires legal/business confirmation.*

| ID | Gate | Status | Pri | Depends on | Mile | Owner | Evidence · closure proof |
|---|---|---|---|---|---|---|---|
| LE-01 | Terms of Service (counsel-sourced; none exists) | EXTERNAL-DEPENDENCY | P0 | counsel engagement | M7 | Counsel | docs/23 §13. Proof: executed text rendered in-product per LE-06 |
| LE-02 | Privacy Policy (counsel-sourced; also MR-05 store URL) | EXTERNAL-DEPENDENCY | P0 | counsel | M7 | Counsel | Proof: live policy + in-product rendering |
| LE-03 | Provider agreement (12 % commission terms, liability, cancellation obligations) signed by launch providers | EXTERNAL-DEPENDENCY | P0 | LE-04, FI-01…03 | M7 | Counsel + owner | docs/23 G7. Proof: signed agreements |
| LE-04 | Cancellation/refund policy templates (docs/09 §7; docs/23 §18.14) — blocks PA-08 and the provider agreement | OWNER-DECISION | P0 | counsel | M4 | Owner + counsel | Proof: recorded templates |
| LE-05 | Child-data/safeguarding package: child-profile field set, guardian consent, waivers, health/emergency data, child imagery policy (docs/02 §5, docs/09 §22.8 — "a blocking legal workstream") | EXTERNAL-DEPENDENCY | P0 | counsel | M7 | Counsel | docs/23 §13. Proof: counsel sign-off (G3/G7) |
| LE-06 | Acceptance/consent UX per counsel (docs/09 §22.7: NO acceptance UI until authoritative text; docs/23 §19: no real payment without the acknowledgments) | BLOCKED | P0 | LE-01…05 | M6 | Engineering (after counsel) | Proof: acceptance flows live before PA-06 |
| LE-07 | UAE business documentation for KYB (trade license, bank, beneficial ownership — whatever Stripe requires) | EXTERNAL-DEPENDENCY | P0 | — | M3 | Owner/company | Proof: PA-01 passes KYB |
| LE-08 | Language-launch ruling (docs/23 §18.9: English-first vs bilingual — decides whether G9/W7 gates launch or fast-follow) | OWNER-DECISION | P1 | — | M5 | Owner | Proof: recorded ruling |
| LE-09 | Customer-web-at-launch ruling (docs/23 §18.8) + share-link resolution: `https://himma.app/...` placeholders must resolve to SOMETHING at launch; the same domain carries PA-05 universal links | OWNER-DECISION | P0 | IN-03 | M5 | Owner | docs/23 §18.8. Proof: recorded ruling + resolving links |

---

## 4. Tallies

**Open gates: 89** (plus the 12 CODE-COMPLETE foundations of §1 and the 10 post-launch register items of §12).

| Status | Count |
|---|---|
| IMPLEMENTATION-REQUIRED | 35 |
| EXTERNAL-DEPENDENCY | 19 |
| OWNER-DECISION | 14 |
| CONFIGURATION-REQUIRED | 9 |
| PRODUCTION-SMOKE-REQUIRED | 8 |
| BLOCKED | 4 |

| Priority | Count |
|---|---|
| P0 launch blockers | 67 |
| P1 launch hardening | 22 |
| Post-launch (register, §12) | 10 |

---

## 5. Dependency graphs (what blocks what)

**Payments/finance (the critical path to real money):**
LE-07 business/KYB docs → PA-01 Stripe account/KYB → PA-02 TEST credentials → [IN-02 entrypoint + IN-03 origin] → PA-03 webhook ingress → **PA-04 D-W5-6 TEST-mode certification** → (in parallel: FI-05 commission administration · OP-01/02 payment runners · PA-08 refund authority ← LE-04 · PA-09/10 reconciliation+alerting · LE-06 acknowledgments ← LE-01…05 · FI-01/02 VAT/agent rulings) → **PA-06 owner-approved live-enablement slice** → PA-07 first-live-charge pilot (G4) → §19 prohibition formally lifted.

**Cognito/social auth:**
IN-01 region ruling → ID-01 pool → ID-02 client config → ID-03 email/password smoke → ID-04 MFA smoke + readiness flags (unblocks production admin/provider surfaces). Social branch: MR-02/03 store accounts → ID-05/06 credentials → ID-07 federation + native modules → MR-11 device validation. Email/password-only launch requires only the first chain.

**W6 runners:**
IN-01 → IN-02 production entrypoint → OP-01 scheduler mechanism → {OP-02 payment cadence, OP-03 outbox/search relay, OP-04/05 maintenance sweeps, OP-06 retention (← VE-05 policy + a DELETE-capable role), PA-09 reconciliation} → OP-07 alerting/restart proofs (← IN-10 observability).

**Evidence/content safety → real providers:**
IN-06 bucket → VE-01 composition → VE-02 scanner (structural: production refuses `contentSafetyReady=true` without it) → live admin evidence review; VE-04 checklist (← counsel) → VE-03 provider upload UX → PR-01 design partners → PR-02 real onboarding → G2 catalogue.

**Mobile signing/store release:**
MR-01 identifiers + MR-02/03 accounts → MR-04 EAS/signing → (MR-05 ← LE-01/02 · MR-06 ← brand · MR-07 ← IN-03/ID-02 · MR-08 account deletion) → MR-13 tracks/store review. Payment return branch: IN-03 → PA-05 bounce/universal links → MR-12.

**Physical-device certification:**
Device procurement (external) → MR-09/10 full §14 passes → feeds MR-12 (payment return), MR-11 (social), MR-13 (G6 crash-free), G6 closure.

---

## 6. Milestones — "production deployable" vs "public launch ready"

| Milestone | Meaning | Required gates |
|---|---|---|
| **M1 — Production infrastructure ready** | The platform can BOOT in a production topology | IN-01…07, IN-09, IN-11, IN-12, IN-04/05/06, SE-01, SE-03 |
| **M2 — Production auth ready** | Real people can hold real accounts; admin/provider surfaces register | ID-01…04 |
| **M3 — Production payment TEST-mode ready** | D-W5-6 certified end-to-end with Stripe test money | PA-01…04, FI-05, LE-07 |
| **M4 — Operational runners/support ready** | The platform converges and is observable without a human driving it | OP-01…03, OP-07, PA-08…10, VE-01…04, IN-10, IN-13, LE-04, ID-08, (P1: IN-08, OP-04/05/06, SE-05, VE-05) |
| **M5 — Native release candidate ready** | Store-submittable signed builds on real devices against production config | MR-01…12, PA-05, PR-04, IN-15, LE-09, (P1: ID-05…07, MR-11, PA-11, LE-08) |
| **M6 — Live financial activation approved** | Every §19/G4 condition true; owner flips by approved slice | FI-01/02, LE-06, PA-06, PA-07, (P1: FI-03/04/06/07) |
| **M7 — Public launch ready** | G1–G9 all green | PR-01/02, IN-14, SE-02/04/06, OP-08, LE-01/02/03/05, MR-13, (P1: PR-03/05, VE-06, MR-14) |

"Production deployable" = M1–M4. "Public launch ready" = all of M1–M7. M1/M2 and the external halves of M3/M5 can run in parallel; M6 is strictly last-but-one.

---

## 7. `productionChargingPossible` — exact prerequisites (verified against code at `a063951`)

**Current structural truth (verified):** `productionChargingPossible` is declared as the **literal type `false`** on `PaymentCapabilityReport` (`backend/src/modules/payment/provider-composition.ts:111`), produced only by `paymentCapabilityReport()` (`:141`), consumed by no route or log (surfacing it on an operations/health surface is a recorded later item), and pinned by tests including a source-text lock. Independent structural blocks, each sufficient alone: (1) `resolvePaymentProvider` returns `unconfigured` for `nodeEnv === 'production'` **unconditionally, before reading any Stripe config** (`provider-composition.ts:45-61`); (2) the deterministic provider is refused in production even if injected (`:46-51`); (3) `StripeDriver`'s constructor **throws on any non-TEST-mode key** (`stripe-driver.ts:70,83`); (4) no production entrypoint exists — `buildApp` is composed only by `scripts/dev-server.ts` (refuses production) and tests; (5) the identity rate-limit store **refuses production boot** (`rate-limiter.ts:65-75`); (6) production admin/provider surfaces refuse registration without the four truthful readiness flags (`build-app.ts`). **LR-0 changes none of this.**

**ALL of the following must be true before an owner-approved implementation slice may flip it** (flipping is that slice's sole purpose; it never happens merely because Stripe keys exist):

1. Real Stripe LIVE configuration present and verified (account activated, live keys, live webhook signing secret) — PA-01/02 lineage at live grade.
2. Webhook trust proven in the live environment: signature verification over raw bytes, replay/dedup, ingress reachability — PA-03/04 lineage.
3. KYB/account readiness: Stripe account fully activated for AED charges and settlement — PA-01.
4. UAE VAT + principal-vs-agent + invoicing rulings recorded (D-W5-3 lifted by explicit approval) — FI-01/02.
5. Commission administration operational: an active `organization_commission_term` exists for every live provider via a controlled capability — FI-05 (checkout fails closed per provider without it, by design).
6. Compensation/refund operations live: the D-W5-4 compensation path plus the PA-08 refund authority and its dual-control procedure — PA-08, FI-07.
7. Reconciliation operations live: scheduled ledger-vs-provider reconciliation + stuck-state alerting — PA-09/10.
8. Required W6 runners scheduled and alerted: at minimum OP-01/02 (the W5-5-recorded paid-production prerequisite) and OP-03.
9. Production smoke certification complete: D-W5-6 TEST-mode certification (PA-04) plus the §11.1 staging gates relevant to payment paths (IN-14).
10. Counsel-sourced legal acknowledgments implemented and rendered (docs/23 §19 · docs/09 §22.7) — LE-06.
11. **Explicit owner approval of the enablement slice itself**, lifting docs/23 §19 as a recorded decision (G4).

The enablement slice must then: widen the literal type deliberately, replace the unconditional production refusal with the fail-closed live composition, accept live keys in the driver under an explicit mode, update the source-text and closeout locks by the owning-slice pattern, and re-certify — with PA-07 (controlled live pilot) as its exit proof.

---

## 8. W6 runner inventory (verified: every job exists as a certified function; NO scheduler of any kind exists)

No BullMQ/node-cron/queue/worker/`setInterval` exists in backend `src/` or `scripts/`; `package.json` has no worker dependency and no `start` script. Deployment mechanism for ALL rows: **absent** (OP-01). All runners below are idempotent by design (per-row CAS/locks; concurrent sweeps converge — certified in their owning slices); idempotent **restart under the real deployment mechanism** still needs OP-07 proof.

| Runner (module) | Domain function | Today invoked from | Desired cadence (proposal) | Failure/alert expectation | P0? |
|---|---|---|---|---|---|
| `sweepLapsedPaidCheckouts` (`checkout-orchestration.ts:804`) | Wind down capture-less lapsed paid checkouts (booking + purchase branches); never sweeps a captured intent | Best-effort inside the webhook handler only | Every 1–2 min | Alert if a pass fails twice consecutively | **Yes** — W5-5-recorded paid-launch prerequisite |
| `processPendingGatewayEvents` (`webhook-ingestion.ts:185`) | Catch-up over `received` gateway events (webhook-outage convergence) | Webhook handler only | Every 1 min | Backlog age alert (docs/23 §11.1: 100 % converged < 15 min post-recovery) | **Yes** |
| `processTrustedPaymentResults` (`payment-saga.ts:117`) | Drive verified success items → confirmation/compensation saga | Webhook handler only | Every 1 min | Stuck-item age alert | **Yes** |
| Outbox relay (absent) + `processSearchProjectionEvents` (`search-projection.ts:222`) | Publish outbox rows; consume into the search projection | **Nothing** (rows never published; consumer tests-only) | Relay: continuous/short poll; consumer: continuous | publish→searchable p95 < 60 s | **Yes** |
| `reconcileLedgerAgainstProvider` (`payment-reconciliation.ts:63`) | Read-only ledger-vs-provider divergence report | Tests only | Daily | Divergence alert → finance procedure | **Yes** (with PA-09) |
| `findStuckPaymentStates` (W5-6) | Aged in-flight payment detection | Tests only | Every 5 min | Page within minutes (docs/23 §12.10) | **Yes** (with PA-10) |
| `sweepExpiredHolds` (`hold-lifecycle.ts:165`) | Expire lapsed `active` holds (maintenance — correctness already inline: `expireLapsedHoldsForUnit` on the claim path; readers ignore lapsed holds) | Tests only | Every 5 min | Warn-level only | No (P1) |
| `processExpiredAssignments` (`admin-roles.ts:293`) | Admin role expiry → audit | Tests only | Hourly | Warn | No (P1) |
| `expireDueStaffInvitations` (`staff-invitations.ts:537`) | Finalize overdue invitations | Tests only | Hourly | Warn | No (P1) |
| Retention sweeps (absent): redemption-attempt window (`0018:398` "future W6 operational sweep"), audit/event retention (`0001/0002/0004` comments) | Bounded deletion per retention policy | **Nothing**; app role has NO DELETE grant — needs a provisioned retention role | Daily | Warn | No (P1; VE-05/SE-05 set the policies) |

Quote/checkout expiry needs **no runner** (enforced by `expires_at` predicates at read/claim time — verified). Entitlement expiry/exhaustion needs **no runner** (derived status; final-use event in-transaction — docs/35).

---

## 9. External information/actions required from owner/company (cannot be closed by coding)

1. Hosting-region/data-residency ruling + cloud account access (AWS assumed: Cognito, S3) — IN-01.
2. Production domain estate: API hostname; control of `himma.app` (share links, universal/app links, payment bounce) — IN-03/PA-05/LE-09.
3. Production Cognito pool provisioning (or access for engineering to provision) — ID-01.
4. Stripe account + UAE KYB package: trade license, settlement bank account, beneficial ownership — PA-01/LE-07.
5. Apple Developer Program membership — MR-02.
6. Google Play Console account — MR-03.
7. Final bundle/package identifier ruling — MR-01.
8. Brand engagement deliverables (final identity, bilingual type system, store assets) — MR-06.
9. Legal counsel engagement: ToS, privacy policy, provider agreement, cancellation/refund templates, child-data/consent package, PDPL, Arabic legal-text posture — LE-01…05, SE-04.
10. VAT / principal-vs-agent / invoicing rulings (counsel + accounting) — FI-01/02.
11. Physical iPhone + Android device for certification — MR-09/10.
12. Design-partner sessions (§8.6) + launch-provider pipeline and signed agreements — PR-01/02, LE-03.
13. Operational staffing decisions: on-call, support, moderation, verification review, finance reconciliation — OP-08, PR-05, VE-06, FI-06.
14. Rulings batch: cancellation/refund templates (LE-04), evidence checklist (VE-04), evidence retention (VE-05), language launch (LE-08), customer web (LE-09), settlement/payout model (FI-04), notification channels (MR-14), identity DR (ID-08).

---

## 10. Recommended execution order (parallel tracks)

| Track | Scope | First actionable slice after LR-0 |
|---|---|---|
| **A — Production Platform & Operations (W6)** | IN-02/07/09/10/11/12, OP-01…07, SE-03, VE-01, PA-09/10 wiring | **W6-0: Infrastructure & Operations workstream plan** (the docs/20–22 pattern — W6 has never activated and has no plan document; governance requires the owner-approved spec first) |
| **B — Payments & Finance** | PA-01…04, FI-05, FI-01/02 rulings | Owner: start Stripe/KYB + VAT counsel NOW (longest external lead times, zero code). First implementation slice: **commission-term administration** (D-W3-5-classified Admin capability, FI-05) |
| **C — Verification & Provider Readiness** | VE-02/03/04, PR-01, PR-04 | Owner: decide VE-04 evidence checklist + schedule §8.6 design-partner sessions. First implementation slice: **evidence content-safety + provider evidence-upload UX** (after VE-04) |
| **D — Mobile Release** | MR-01…13, PA-05, MR-08 | Owner: procure accounts/devices/identifiers/brand. First implementation slice: **release engineering** (EAS/signing config + https bounce/universal links + in-app account deletion) once MR-01…03 exist |
| **E — Legal & Policy** | LE-01…09, SE-04 | Owner: engage counsel with the docs/23 §13 scope list (no code) |

Tracks are independent until they converge at M4/M5; Track A blocks every production smoke in Tracks B/C, so it goes first among implementation tracks.

---

## 11. First recommended implementation slice after LR-0

**W6-0 — Infrastructure & Operations workstream plan** (planning slice, docs/20–22 pattern), immediately followed on approval by its first implementation slice (production entrypoint/composition + scheduler/runner mechanism + distributed rate-limit store + structured logging/request ids + CI baseline).

**Why first:** (1) VERIFIED hard dependency — there is no production entrypoint, no scheduler, and the rate-limit store refuses production boot, so **every** production smoke in every other track (Cognito §14.E′, D-W5-6, evidence, staging load gates) is blocked on Track A's M1; (2) it is the only P0 cluster requiring **zero external input** — no credentials, accounts, or counsel — so it parallelizes perfectly with the long-lead external items the owner starts now (Stripe/KYB, counsel, Apple/Google accounts); (3) the OP-02 payment-runner cadence is the **certified paid-production launch prerequisite** recorded at the W5-5 closure; (4) governance: W6 has never activated, and docs/23 requires an owner-approved workstream plan before implementation — so the plan is the first legal move.

The runner-up (FI-05 commission administration) is a bounded Admin slice that can run second or in parallel once authorized — it is P0 for M3 but does not unblock anything else.

---

## 12. Post-launch register (deliberately NOT launch gates)

| # | Item | Source |
|---|---|---|
| PL-01 | Recurring billing / membership auto-renew semantics | docs/09 §6; docs/23 §18.12 |
| PL-02 | Marketplace Credit classes + gifts/rewards/referrals product surfaces | docs/09 §§8–10; docs/23 §18.13 |
| PL-03 | Stripe Connect automated provider payouts (FI-04 decides the launch-time manual process) | docs/33 D-W5-1 |
| PL-04 | Waitlists | docs/09 §21.4; docs/23 §18.19 |
| PL-05 | Multi-participant booking | docs/09 §21.2; docs/23 §18.18 |
| PL-06 | Arabic/RTL (W7) — if LE-08 rules English-first, G9 gates the fast-follow, not launch | docs/23 §3.1/G9 |
| PL-07 | QR credential presentation (token authority is QR-ready) | docs/35 |
| PL-08 | Reviews/ratings | docs/09 §15 |
| PL-09 | Provider taxonomy requests (D-W3-4) | docs/31 |
| PL-10 | Native PaymentSheet/SDK payment (hosted Checkout stands at launch) | docs/33 D-W5-2 |

---

## 13. Reconciliation honesty notes

- **No closed feature/domain is reopened by this matrix.** Every IMPLEMENTATION-REQUIRED row is either explicitly recorded unfinished scope (deferred at a closure with a destination tag) or unstarted workstream scope (W6, release engineering) — never a defect in certified behavior.
- **No genuine code defect was found** during reconciliation. Three wiring gaps were verified and are recorded as W6/observability scope, not as corrections to closed slices, because their absence was documented at closure: the outbox relay is absent by recorded design (`outbox.ts`), the search-projection worker is absent by recorded design (`search-projection.ts`), and `audit_event.request_id` is written by no caller (IN-09/SE-05). No bounded launch-hardening correction is proposed.
- **Nothing external is marked complete from mocks:** every EXTERNAL-DEPENDENCY and PRODUCTION-SMOKE-REQUIRED row remains open regardless of how thoroughly its code path is certified locally (D-W5-6, §14.E′, and physical-device certification are the canonical examples).
- **Maintenance rule:** the slice that closes a gate updates its row (status → CODE-COMPLETE/closed with commit evidence) in the same commit. New gates discovered later are appended with the next free ID in their area. HANDOFF references this document instead of restating gates.
