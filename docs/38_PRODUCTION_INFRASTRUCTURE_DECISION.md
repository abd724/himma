# 38 — Production Infrastructure Decision & W6-4 Readiness Package (post-W6)

**Status: OWNER-APPROVED (2026-09-07, recorded at the W6-4A bookkeeping commit): AWS · primary region `me-central-1` · separate Staging and Production workload accounts under AWS Organizations (no Himma workloads in the management account) · Cognito User Pools, ECS/Fargate and RDS PostgreSQL Multi-AZ/PITR confirmed available in the region · RDS PostgreSQL Multi-AZ is the production database direction · the closed W6 application architecture is unchanged · docs/36 IN-01 CLOSED by this ruling · W6-4 infrastructure work is UNBLOCKED (W6-4A = repository-side foundation; W6-4B = staging apply/certification). Originally: DECISION PACKAGE, awaiting the owner's provider/region approval. ANALYSIS/PLANNING ONLY: no cloud account, resource, IaC, pipeline, domain, credential, Cognito configuration, or product behavior was created or changed; `productionChargingPossible` stays the literal `false`; migration head stays `0023_job_run_and_maintenance_authority`.**

**Authority:** owner direction 2026-09-07 (post-W6 infrastructure decision slice, issued at the W6-3 closure `d5ef107`); docs/23 §10 (architecture requirements), §11/§11.1 (Tier-1 targets and correctness gates), §13 (security/privacy), §18.3 (hosting/data-residency decision — OPEN), §19 (standing payment prohibition); docs/36 (the authoritative gate matrix — every gate id below refers to it); docs/37 (W6 runtime architecture: §3 deployment neutrality, §4 topology, §6 config contract, §19/§28 identities, §27 migrations, §31 deployment artifacts, §32 secrets, §36 harness); docs/26 (Cognito adapter boundary, region/DR OPEN). Every requirement in §2 was derived from source at `d5ef107` (file references inline). Provider facts in §3–§7 are current-knowledge statements about managed services and list prices and are marked **verify-at-provisioning** where W6-4 must confirm them against the live account before relying on them.

---

## 1. Current project and launch-gate state (docs/36 at `d5ef107`)

| Measure | Value |
|---|---|
| Launch gates in the matrix | 89 (LR-0 baseline) |
| Closed / CODE-COMPLETE since LR-0 | **9** — IN-02, IN-07, IN-09 (W6-1); OP-03 (W6-2); OP-01, OP-02, OP-04, OP-05, OP-07 (W6-3) |
| **Open gates** | **80** |
| Open P0 | **60** |
| Open P1 | **20** |
| Post-launch register (§12) | 10 (unchanged) |
| CODE-COMPLETE foundations (§1) | 12 (unchanged) |

Classification of the 80 open gates: **IMPLEMENTATION-REQUIRED 26 · EXTERNAL-DEPENDENCY 19 · OWNER-DECISION 14 · CONFIGURATION-REQUIRED 9 · PRODUCTION-SMOKE-REQUIRED 8 · BLOCKED 4.**

W6 delivered the whole local production-capable runtime: `start:api`, `start:worker` (durable loops + scheduler), `start:maintenance`, the four-login database identity model, the migration job boundary, fail-closed config, structured logging, liveness/readiness, graceful shutdown, alert seam — all certified on real PostgreSQL with spawned multi-process proofs. **Nothing is deployed anywhere.** docs/37 §31 remains literally true: no Dockerfile, compose file, CI workflow, `.github/`, process-manager unit, Procfile, PaaS config, IaC, or `eas.json` exists in the repository (re-verified at `d5ef107`).

### 1.1 Gates blocked by the absence of selected/deployed infrastructure

Every row below is open only because no provider/region is ruled (IN-01) or because nothing is deployed. Grouped as the owner directed:

| Group | Gates (docs/36) | Status today | Why infrastructure blocks it |
|---|---|---|---|
| **Hosting / runtime** | IN-01 (ruling), IN-02 deployment half (code-complete, undeployed), IN-12 (staging) | OWNER-DECISION · CODE-COMPLETE · CONFIGURATION-REQUIRED | No compute target exists for `start:api`/`start:worker`/`start:maintenance` |
| **Database** | IN-05 (production PostgreSQL, financial class), IN-13 (backup/restore rehearsals) | EXTERNAL-DEPENDENCY · PRODUCTION-SMOKE-REQUIRED | No managed PostgreSQL; RPO 0 / PITR / Multi-AZ posture cannot be recorded |
| **Networking / domain / TLS** | IN-03 (API origin + `himma.app`), PA-05 (payment bounce/universal links), LE-09 (share links), MR-07 (app/portal production config) | EXTERNAL-DEPENDENCY · IMPLEMENTATION-REQUIRED · OWNER-DECISION · CONFIGURATION-REQUIRED | No https origin; the app refuses a production build without `EXPO_PUBLIC_API_URL` |
| **Secrets / configuration** | IN-04 (managed secret store), SE-01 (secret inventory + rotation) | CONFIGURATION-REQUIRED · IMPLEMENTATION-REQUIRED | The backend is env-only by design; the store that injects the ~40 variables in §2.8 does not exist |
| **Authentication / Cognito** | ID-01 (production pool, "region per IN-01"), ID-02 (client config), ID-03/ID-04 (real-pool smokes → the four `AdminProductionReadiness` flags), ID-08 (identity DR ruling) | EXTERNAL-DEPENDENCY · CONFIGURATION-REQUIRED · PRODUCTION-SMOKE-REQUIRED ×2 · OWNER-DECISION | The pool's region is the residency decision; no pool exists |
| **Object storage** | IN-06 (bucket + IAM), VE-01 (real-bucket smoke) | CONFIGURATION-REQUIRED ×2 | The S3 driver is composed by W6-1 only when `EVIDENCE_S3_*` exists; no bucket exists. (VE-02 content-safety stays a separate, binding gate — storage existing does NOT open evidence retrieval) |
| **Monitoring / alerting** | IN-10 (telemetry vendor), OP-08 (on-call/status page — staffing) | IMPLEMENTATION-REQUIRED ×2 | The W6 alert seam has a log destination only; the collector/alert router is a platform choice |
| **CI/CD** | IN-11 (pipeline + tested rollback), SE-03 (dependency/container scanning) | IMPLEMENTATION-REQUIRED ×2 | No pipeline, no registry, no deploy target |
| **Staging** | IN-12, IN-14 (Tier-1 load/correctness gates on production topology) | CONFIGURATION-REQUIRED · PRODUCTION-SMOKE-REQUIRED | No topology to run against |
| **Payment TEST certification** | PA-02 (TEST credentials into managed config), PA-03 (public webhook ingress), PA-04 (D-W5-6 TEST certification), PA-11 | CONFIGURATION-REQUIRED ×2 · PRODUCTION-SMOKE-REQUIRED · CONFIGURATION-REQUIRED | Needs a reachable https origin + secret store; PA-01 (Stripe account/KYB) is the parallel external half |
| **Mobile / backend environment config** | MR-07 (production config values), MR-04 (EAS/signing — build pipeline), MR-12/MR-13 (device/store smokes against production config) | CONFIGURATION-REQUIRED · IMPLEMENTATION-REQUIRED · PRODUCTION-SMOKE-REQUIRED ×2 | `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_COGNITO_*`, `VITE_API_BASE_URL`, `VITE_COGNITO_*` have no production values |

**Count:** 30 of the 80 open gates are directly infrastructure-blocked (all of M1, all of M2, the configuration half of M3, IN-10/IN-13/IN-14 of M4/M7, and the config/smoke rows of M5). The single ruling **IN-01** is upstream of 19 of them.

---

## 2. Himma's actual infrastructure requirements (derived from source)

### 2.1 API — `npm run start:api` (`backend/scripts/start-api.ts` → `src/app/production-runtime.ts`)
- Long-running Node **24.x** process (`backend/package.json` engines `>=24.0.0 <25`; the executable is `tsx scripts/start-api.ts`, `tsx` is a runtime dependency). Stateless; **horizontal replicas are safe by construction** (idempotency keys, PG rate-limit store, no session affinity — docs/23 §10.3; W6-1 two-replica proof).
- Mandatory env: `NODE_ENV=production`, `RUNTIME_ROLE=api`, `DATABASE_URL` (the `himma_api` credential), `HOST` (explicit bind, `0.0.0.0` in a container), `PORT`. Optional/conditional: `LOG_LEVEL`, `SHUTDOWN_DRAIN_MS`, `PAYMENTS_MODE=disabled|test` (+ `STRIPE_*`), `PAYMENT_CHECKOUT_*_URL` (https, non-local), `COGNITO_*`, `PORTAL_ALLOWED_ORIGINS`, `AUTH_COOKIE_DOMAIN`/`AUTH_COOKIE_SECURE`, `AUTH_REFRESH_COOKIE_MAX_AGE_SECONDS`, `HIMMA_STAFF_INVITATION_PEPPER`, `HIMMA_MFA_RECOVERY_PEPPER`, `EVIDENCE_S3_*`.
- **Ingress:** HTTPS termination in front (the process serves plain HTTP on `HOST:PORT`); `GET /internal/live` (static) and `GET /internal/ready` (DB probe + identity + migration head + drain flag) exist for the platform; `/internal/health` aliases liveness. Webhook ingress `POST /payments/webhook/stripe` registers only when a provider composes (docs/33 W5-3).
- **Shutdown:** SIGTERM/SIGINT → readiness fails → bounded drain (`SHUTDOWN_DRAIN_MS`, default 15 s) → pool end → exit 0; second signal/overrun → non-zero. The platform must send SIGTERM and allow ≥ the drain budget before SIGKILL.
- **Outbound:** PostgreSQL; Stripe API (`stripe` SDK, only when composed); Cognito (`InitiateAuth`/refresh/revoke over https to the pool's regional endpoint; JWKS fetch); S3-compatible object storage over https (SigV4, `fetch`). No other egress.
- **Browser CORS/cookies:** the portals authenticate with credentialed cookies scoped to `/auth`, `SameSite=Strict`, `Secure` mandatory in production, optional `Domain` attribute (`AUTH_COOKIE_DOMAIN`) — the portals and the API must share a registrable domain (same-site) in production.

### 2.2 Worker — `npm run start:worker` (`src/worker/worker-runtime.ts`)
- Long-running Node 24 process, `RUNTIME_ROLE=worker`, `DATABASE_URL` = the `himma_worker` credential. Refuses startup on identity mismatch or migration-head mismatch (docs/37 §15 contract) — the platform's restart policy must tolerate fail-fast exits and must **not** route traffic to it.
- **No public ingress.** Optional `WORKER_STATUS_PORT` liveness listener for the platform only.
- **Multiple replicas are safe** (SKIP LOCKED claiming, advisory-lock scheduler; two-process proofs in W6-2/W6-3); docs/37 §4 minimum is `worker ×1` with `×2` tolerated at all times (deploy overlap).
- Outbound: PostgreSQL; Stripe (only when `PAYMENTS_MODE=test` + TEST key). Never Cognito, never object storage.

### 2.3 Scheduler — inside every worker replica (`src/worker/scheduler.ts`)
- **No dedicated cron process is authoritative.** Due-ness is evaluated on the PostgreSQL clock; `pg_try_advisory_lock` on a dedicated session provides distributed exclusion; `job_run` (migration 0023) records every attempt. Infrastructure must therefore only guarantee that ≥ 1 worker replica is running; it must never assume exactly one.
- The platform clock is irrelevant to correctness (docs/37 §20); what matters is the PostgreSQL server clock — one database, one clock.

### 2.4 Maintenance — `npm run start:maintenance -- <job>` (`src/maintenance/maintenance-runtime.ts`)
- **Short-lived, same artifact**, `RUNTIME_ROLE=maintenance`, `DATABASE_URL` = the `himma_maintenance_runner` credential (a fourth, separate secret — never the API/worker credential; startup asserts `current_user`). Exit 0/1/2. SIGTERM stops at a batch boundary.
- Needs an **on-demand and scheduled command runner** that can start the container image with a different command and a different secret: a daily `retention.all`, and operator-invoked `repair.rebuild-search` / `repair.unquarantine-outbox --event-id=…`. Concurrent invocations are safe (advisory lock; W6-3 proofs) but pointless — the scheduler should not overlap runs.

### 2.5 Migration job — `npm run db:migrate` + `npm run db:verify` (`src/db/migrations.ts`)
- Separate controlled execution under the **schema/migration owner** credential; advisory-locked; checksum-immutable; production down-migrations refused by the runner (`runMigrationsDown` throws in production). Also `npm run db:provision-roles` (cluster-global LOGIN provisioning, password-injected) under an admin-capable credential — run once per environment and on rotation.
- **The API never migrates** (source-locked); new API/worker builds refuse readiness/startup while the applied head differs from the shipped head, so the migration job must complete before a rollout proceeds (docs/37 §27).

### 2.6 PostgreSQL (the only stateful system of record)
- Features actually used (verified in `backend/migrations/*.sql` and `src/`): PostgreSQL **≥ 15** semantics in use (the harness runs 18.4); extensions **`btree_gist`** (exclusion constraints, 0003) and **`pg_trgm`** (search, 0010); `gen_random_uuid()` (core since PG 13); `SECURITY DEFINER` PL/pgSQL functions (0023); session and transaction advisory locks (`hashtextextended`); `FOR UPDATE SKIP LOCKED`; `jsonb`; triggers everywhere; `CREATE ROLE` for `himma_app`/`himma_maintenance` inside migrations (NOLOGIN, `IF NOT EXISTS`) and `CREATE ROLE … LOGIN` from the provisioning boundary. **The managed service must permit the migration credential to create roles and grant memberships** (standard on RDS/Aurora/Azure Flexible Server master users; verify-at-provisioning).
- **Five identities** (docs/37 §28): schema owner (DDL, migrations, provisioning), `himma_api`, `himma_worker`, `himma_maintenance_runner` (LOGIN), `himma_maintenance` (NOLOGIN). TLS in transit required (docs/23 §13); the pool factory passes no `ssl` option today — **W6-4 must add TLS enforcement on the connection (`sslmode=verify-full` via `DATABASE_URL` or an explicit `ssl` option) as part of the runtime config**, a bounded config change, not an architecture change.
- **Connection budget:** `createPool` uses pg defaults (`max` 10 per process) with no explicit `statement_timeout`/timeouts (docs/37 §2 item 2 asked for explicit values — W6-4 config work). Initial topology `api ×2` + `worker ×2` + maintenance + migration ≈ **≤ 60 connections**; a `db.t4g.medium`-class instance (≈ 400 max connections) is ample; a pooler (RDS Proxy/PgBouncer) is **not** required at Tier 1 and would interfere with session-level advisory locks unless in session mode — avoid it.
- **Service class (docs/23 §10.11):** financial class → RPO 0 for committed transactions (synchronous standby / Multi-AZ), PITR backstop, RTO ≤ 1 h; automated backups retained ≥ 7 days (35 preferred); restore rehearsals recorded (IN-13).

### 2.7 Object storage (evidence seam)
- `createS3EvidenceStore` (`src/modules/provider/storage/s3-evidence-store.ts`): **any SigV4 S3-compatible endpoint** (AWS S3, MinIO, R2…), server-proxied bytes, SSE, no presigned URLs, no ACLs; config `EVIDENCE_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY[/KEY_PREFIX]` (all-or-none). Composed by the API only. **Binding W3 constraint:** `contentSafetyReady` stays `false` (production `true` throws without a genuine scanner — docs/36 VE-02); a bucket existing lets the upload/head/get smoke (VE-01) run — it does not open admin evidence retrieval. Private bucket, versioning, no public access, IAM/key scoped to one prefix.

### 2.8 Secrets and configuration (docs/37 §32; `.env.example`)
Secrets (never in repo/image/migration/CI logs): `DATABASE_URL` ×4 credentials (api, worker, maintenance-runner, migration owner), `HIMMA_API_DB_PASSWORD`/`HIMMA_WORKER_DB_PASSWORD`/`HIMMA_MAINTENANCE_DB_PASSWORD` (provisioning time only), `STRIPE_SECRET_KEY` (TEST), `STRIPE_WEBHOOK_SECRET[_RETIRING]`, `EVIDENCE_S3_ACCESS_KEY_ID/SECRET_ACCESS_KEY`, `HIMMA_STAFF_INVITATION_PEPPER`, `HIMMA_MFA_RECOVERY_PEPPER`, `HIMMA_BOOTSTRAP_SECRET`/`_CONFIRMATION` (admin bootstrap, one-time). Public config: `HOST/PORT`, `COGNITO_ISSUER/CLIENT_IDS/REFRESH_CLIENT_ID[/JWKS_URI]`, `PORTAL_ALLOWED_ORIGINS`, `AUTH_COOKIE_DOMAIN`, `PAYMENT_CHECKOUT_*_URL`, `EVIDENCE_S3_ENDPOINT/REGION/BUCKET`. Operational policy: `LOG_LEVEL`, `SHUTDOWN_DRAIN_MS`, `WORKER_*`, `SCHEDULER_*`, `MAINTENANCE_*`, `RETENTION_*`. Everything is fail-closed and variable-naming (W6-1/W6-3 proofs) — a managed store that injects env vars at task start is sufficient; no SDK integration is required in code.

### 2.9 Authentication — Cognito (docs/26 D1; `src/modules/identity/providers/cognito/*`, `src/services/auth/cognito-identity-gateway.ts`, portal/admin `VITE_COGNITO_*`)
- The customer app calls the Cognito **regional endpoint directly** (`InitiateAuth` USER_PASSWORD_AUTH, `SignUp`, REFRESH_TOKEN_AUTH via `x-amz-target` JSON — no Amplify/SDK); the backend verifies JWTs via the issuer's JWKS and mediates refresh/revoke/MFA through the adapter. The pool is therefore **an AWS resource in some AWS region regardless of where compute runs** — Cognito exists nowhere else.
- **Materiality:** Cognito does not force compute onto AWS (it is reached over the public internet from any cloud), but (a) identity PII residency follows the pool's region (docs/26 §2 recorded this as the "second residency problem"); (b) the pool is provisioned per IN-01 ("region per IN-01"); (c) running compute on a second cloud means two accounts, two IAM models, two billing relationships, and two consoles for a founder-sized team. **Cognito is not a reason to replace anything** — the adapter boundary (docs/26 §3) keeps it replaceable — but it is a real weight on the scale for AWS as the compute home. Verify-at-provisioning: Cognito User Pools availability in the chosen region (AWS lists Cognito in **me-central-1 (UAE)**; W6-4 confirms in the account before ID-01 proceeds; if absent, the fallback is a UAE-adjacent AWS region for the pool only, recorded as an ID-08/IN-01 residency exception).

### 2.10 Stripe (TEST only)
- `PAYMENTS_MODE=test` + TEST key → Stripe TEST driver; live keys refused; deterministic refused in production; `productionChargingPossible` literal `false`. Infrastructure needs: outbound https to `api.stripe.com`, an https ingress route to `/payments/webhook/stripe` with raw-body passthrough (the route verifies the signature over exact bytes — the load balancer must not rewrite bodies), and `PAYMENT_CHECKOUT_SUCCESS_URL/CANCEL_URL` as https non-local origins (PA-05 bounce page on `himma.app`). None of this authorizes LIVE activation (docs/36 PA-06).

### 2.11 Frontends
- **Customer App** (Expo SDK 57 / RN 0.86): native store binaries; **no backend hosting requirement**. Build-time public config `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_COGNITO_ISSUER`, `EXPO_PUBLIC_COGNITO_CLIENT_ID`, `EXPO_PUBLIC_APPLE/GOOGLE_SIGN_IN_ENABLED` (fail-closed). Distribution = EAS/signing (MR-04, separate release slice), universal/app links + payment bounce page on `himma.app` (PA-05/LE-09) — a **static https page** on the owned domain, the only web-hosting need the app creates.
- **Provider Portal / Admin Portal** (Vite + React, Node ≥ 22 build): **static assets** (`dist/`) served over https on their own hostnames with SPA fallback; runtime config via `VITE_API_BASE_URL`, `VITE_COGNITO_ISSUER`, `VITE_COGNITO_CLIENT_ID`, `VITE_PORTAL_AUTH_MODE`/`VITE_ADMIN_AUTH_MODE` (build-time). They call the API cross-origin with credentialed cookies → `PORTAL_ALLOWED_ORIGINS` on the API and a shared registrable domain (`AUTH_COOKIE_DOMAIN`). Any static host + CDN satisfies them; no server-side rendering.

### 2.12 Scale (docs/23 §11 Tier 1)
500 peak concurrent app sessions, 300 searches/min, 200 checkouts/h, 500 webhooks/h, 100 GB objects. Two small API replicas and one or two small worker replicas on a modest PostgreSQL instance are comfortably above this; the architecture must reach Tier 2 without redesign (horizontal API, PG vertical + read headroom, PG FTS acceptable) — satisfied by any of the managed platforms below.

---

## 3. AWS assessment — region **me-central-1 (UAE)**

**Regional fit.** AWS operates a full region in the UAE (`me-central-1`, launched 2022) — data residency inside the country, which is the strictest reasonable reading of docs/23 §18.3 and the posture counsel will most easily sign off under PDPL (SE-04). `me-south-1` (Bahrain) is the in-GCC fallback for any service gap.

**Service mapping (verify-at-provisioning for me-central-1 availability):**

| Need (§2) | AWS service | Notes |
|---|---|---|
| API / worker compute | **ECS on Fargate** (one task definition per role, same image, `RUNTIME_ROLE` env) | Rolling deploys with health checks; SIGTERM + `stopTimeout` (set ≥ drain budget); auto-scaling on CPU/requests later; no cluster to manage |
| Maintenance | **ECS Fargate run-task** (on-demand) + **EventBridge Scheduler** (daily `retention.all`) | Same image, different command + different secret; scheduler in the same region |
| Migration job | ECS Fargate run-task with the migration-owner secret, executed by the pipeline before rollout | Advisory-locked runner tolerates a double invocation |
| PostgreSQL | **RDS for PostgreSQL 16/17, Multi-AZ** (synchronous standby → RPO 0), automated backups 35 d + PITR, encrypted (KMS), TLS enforced (`rds.force_ssl`) | `db.t4g.medium` (2 vCPU/4 GB) at launch; `btree_gist`/`pg_trgm` are standard RDS extensions; master user can create roles. Aurora PostgreSQL is the Tier-2/3 step-up, not required now |
| Secrets | **AWS Secrets Manager** (ECS injects as env vars at task start) | Rotation of DB passwords via `db:provision-roles` + secret update; audit in CloudTrail |
| Ingress / TLS | **Application Load Balancer** + **ACM** certificates + **Route 53** (`api.himma.app`, `portal.himma.app`, `admin.himma.app`, `himma.app`) | Health check → `/internal/ready`; raw body passthrough for the webhook |
| Object storage | **S3** private bucket (versioning, SSE-KMS, block public access), IAM user/role scoped to the evidence prefix | The driver already speaks SigV4 |
| Static frontends + bounce page | **S3 + CloudFront** (OAC) for portal/admin `dist/` and `himma.app` universal-link/bounce statics | Global edge; certificate via ACM (us-east-1 for CloudFront — a known quirk) |
| Logs / metrics / alerts | **CloudWatch Logs** (stdout JSON from pino), **CloudWatch metrics + alarms**, **SNS** → email/Slack/PagerDuty | Structured-log alert lines become metric filters → alarms; the W6 alert seam's destination |
| Registry / CI | **ECR** + **GitHub Actions** with OIDC role assumption (no long-lived cloud keys in CI) | Scanning: ECR basic scanning + `npm audit` in CI (SE-03) |
| Identity | **Cognito User Pools** in the same region | ID-01…04 (verify availability) |
| Private networking | VPC: RDS in private subnets; Fargate tasks in private subnets with a **NAT gateway** (egress to Stripe/Cognito/S3) or, to avoid NAT cost at Tier 1, public subnets with public IPs and strict security groups + S3 gateway endpoint | Either is defensible; NAT is cleaner and is the assumed baseline below |

**Strengths for Himma:** in-country region; the identity provider is native; RDS Multi-AZ + PITR meets the financial-class RPO/RTO exactly; Fargate gives long-running workers, on-demand tasks, and scheduled tasks from one image with no cluster; Secrets Manager → ECS env injection needs zero code; everything is scriptable for W6-4 IaC and operable by one engineer.
**Weaknesses:** AWS console/IAM breadth is real complexity for a founder team; me-central-1 list prices run roughly 10–20 % above US regions; NAT gateway is a fixed cost; CloudFront certificate quirk.

## 4. Azure assessment — regions **UAE North (Dubai)** / **UAE Central (Abu Dhabi)**

**Regional fit.** Azure has two UAE regions; UAE North is the primary full-service region (UAE Central is smaller and often service-gated). In-country residency is equally achievable.

**Service mapping:** Azure Container Apps (API/worker; scale-to-N, revisions, SIGTERM with `terminationGracePeriod`) + **Container Apps Jobs** (on-demand + cron) for maintenance/migrations; **Azure Database for PostgreSQL Flexible Server** (zone-redundant HA = synchronous standby, PITR up to 35 d, `btree_gist`/`pg_trgm` allow-listed extensions, TLS enforced); **Key Vault** with Container Apps secret references; **Azure Front Door** or Application Gateway + managed certificates + Azure DNS; **Blob Storage** (S3 API is *not* native — the evidence driver is S3-only, so W3's driver would need an Azure Blob driver or an S3-compatible gateway — a code change in a closed slice, or a third-party S3 façade); **Static Web Apps** for the portals; **Azure Monitor/Log Analytics + Application Insights** for logs/alerts; **ACR** + GitHub Actions (OIDC federation available).

**Strengths:** UAE residency; Container Apps Jobs are a very natural fit for the maintenance/migration model; Flexible Server HA/PITR is financial-class; Microsoft's UAE enterprise/government presence can matter later for B2B.
**Weaknesses (decisive for Himma today):** (1) **Cognito stays on AWS anyway** → two clouds, two IAM models, two bills, two consoles for identity + everything else — the exact "unnecessary vendor complexity" criterion; (2) **object storage is not S3-compatible** — the certified evidence driver would need a new driver or gateway (reopening a closed W3 slice for a platform reason); (3) UAE Central's service gating makes Abu Dhabi-proper residency less certain than UAE North (Dubai) — both are in-country, so this is minor; (4) Container Apps' ingress/health model is slightly more opaque than an ALB target group for the readiness contract W6-1 built.

## 5. Google Cloud and other options

**GCP — rejected on regional grounds.** Google Cloud has **no UAE region**: its Middle-East regions are `me-central1` (Doha, Qatar), `me-central2` (Dammam, Saudi Arabia) and `me-west1` (Tel Aviv). Hosting a UAE consumer marketplace's PII and financial records in Qatar or Saudi Arabia is a materially worse residency/compliance posture than an in-country region, would still require AWS for Cognito, and Cloud Storage's S3 interoperability is partial. Cloud Run + Cloud SQL would otherwise be a fine technical fit; the region decides it.

**Simpler managed platforms (Fly.io, Render, Railway, Heroku).** Considered and rejected for production: none offers a UAE region with a managed PostgreSQL meeting the financial-class posture (synchronous replication + PITR + in-country residency); several run PostgreSQL as a convenience add-on rather than a financial-grade service; secrets/IAM and audit are thinner; and they still leave Cognito on AWS. They are acceptable for **nothing in the launch path**; the local harness already covers "easy to run".

**Self-managed Kubernetes (EKS/AKS).** Rejected as unnecessary at Tier 1–2: docs/37 §4's two-role process model needs no orchestrator features beyond rolling deploys, health checks, scheduled/on-demand tasks — Fargate/Container Apps provide those without a cluster to operate. Revisit only if a future workload genuinely needs it.

---

## 6. Comparison matrix (viable options: AWS me-central-1 vs Azure UAE North)

Scores 1–5 (5 = best for Himma's actual needs). GCP omitted (rejected in §5).

| # | Criterion | AWS me-central-1 | Azure UAE North | Note |
|---|---|---|---|---|
| 1 | UAE data residency / regional availability | 5 | 5 | Both in-country; AWS region is single but complete; Azure has two |
| 2 | PostgreSQL quality, managed backup/PITR, financial class | 5 | 5 | RDS Multi-AZ vs Flexible Server zone-redundant HA; both PITR 35 d, both allow the two extensions |
| 3 | Node API deployment | 5 | 4 | Fargate + ALB target-group readiness maps 1:1 onto `/internal/ready`; Container Apps fine |
| 4 | Long-running worker deployment | 5 | 4 | Fargate service with desired count; Container Apps needs min-replicas ≥ 1 and no ingress — supported |
| 5 | Scheduled / on-demand maintenance execution | 4 | 5 | Container Apps Jobs are a slightly better fit than run-task + EventBridge Scheduler |
| 6 | Controlled migration job | 5 | 5 | Both: one-off task with its own secret before rollout |
| 7 | Private networking | 5 | 4 | VPC + security groups vs VNet integration (Container Apps VNet is workable but more moving parts) |
| 8 | Secret management | 5 | 5 | Secrets Manager → task env; Key Vault → secret refs |
| 9 | Load balancing / TLS | 5 | 4 | ALB + ACM + Route 53 is simpler than Front Door/App Gateway |
| 10 | Monitoring / logging / alerts | 4 | 4 | CloudWatch vs Monitor; both adequate for IN-10 M4 minimum; vendor APM optional later |
| 11 | CI/CD integration | 5 | 5 | GitHub Actions OIDC to both |
| 12 | **Cognito integration complexity** | **5** | **2** | Native vs cross-cloud identity (two accounts/bills/IAM) |
| 13 | **Object storage (S3-compatible driver)** | **5** | **2** | Native vs new driver/gateway in a closed slice |
| 14 | Stripe / webhook compatibility | 5 | 5 | Plain https ingress with raw body either way |
| 15 | Operational complexity | 3 | 3 | AWS breadth vs Azure portal sprawl; comparable |
| 16 | Security posture | 5 | 5 | Equivalent primitives; single-cloud IAM story favors AWS here |
| 17 | Scalability to Tier 2/3 | 5 | 5 | Both |
| 18 | Cost at launch scale | 4 | 4 | Similar within ±20 % (§7) |
| 19 | One senior engineer / founder team can operate it | 4 | 3 | One cloud, one identity, one bill vs two |
| 20 | Avoidance of unnecessary vendor complexity | 5 | 2 | Cognito + S3-driver facts decide this row |
| | **Total** | **95 / 100** | **81 / 100** | |

The gap is not "AWS is a better cloud"; it is that **Himma's certified code already has two AWS-shaped seams (Cognito, SigV4 S3)**, and the cheapest correct decision is to put compute where those seams live, in the UAE region.

---

## 7. Cost model (list prices; me-central-1 vs UAE North; USD/month; estimates — verify against the live pricing calculator at provisioning; prices in Gulf regions run ~10–20 % above US regions)

### 7.1 Initial production (Tier-1 launch: `api ×2`, `worker ×2`, PG Multi-AZ)

| Component | AWS me-central-1 | Azure UAE North | Scales with traffic? |
|---|---|---|---|
| API compute (2 × 0.5 vCPU / 1 GB Fargate; Container Apps equivalent) | 40–70 | 40–70 | Yes (replicas/CPU) |
| Worker compute (2 × 0.25–0.5 vCPU) | 20–40 | 20–40 | Slowly |
| Managed PostgreSQL (t4g.medium-class Multi-AZ/zone-redundant, 50–100 GB, backups 35 d) | 160–260 | 170–280 | Storage/IOPS slowly; instance class at Tier 2 |
| Load balancer / ingress (ALB + LCUs; Front Door standard) | 30–50 | 40–80 | Yes (LCU/requests) |
| NAT gateway / VNet egress (optional baseline) | 40–70 | 20–50 | Yes (GB processed) |
| Logs / metrics / alarms (≈ 10–30 GB logs) | 15–50 | 15–50 | Yes (log volume) |
| Secrets (≈ 12 secrets + API calls) | 5–10 | 1–5 | No |
| Object storage (≤ 100 GB, low egress; versioning) | 5–15 | 5–15 | Slowly |
| Static frontends + CDN (portal, admin, bounce page) | 5–15 | 10–20 | Slowly |
| DNS + certificates | 2–5 | 1–5 | No |
| Container registry, scheduler, misc. data transfer | 10–30 | 10–30 | Yes (egress) |
| **Total, initial production** | **≈ 330–615** | **≈ 330–645** | |

**Plus Cognito on either option:** free tier covers the first 50 000 monthly active users at launch — effectively $0–10 at Tier 1. Plus the Stripe account (no infra cost). Plus staffing/on-call/telemetry vendor if chosen later (IN-10/OP-08 — not infrastructure).

### 7.2 Staging (single-AZ small PG, `api ×1`, `worker ×1`, shared ingress, no NAT)

| Component | AWS | Azure |
|---|---|---|
| Compute (1 API + 1 worker, small) | 25–45 | 25–45 |
| PostgreSQL (t4g.micro/small, single-AZ, 7 d backups) | 25–60 | 30–70 |
| Ingress + DNS + certs | 25–40 | 30–60 |
| Logs/secrets/storage/registry | 15–35 | 15–35 |
| **Total, staging** | **≈ 90–180** | **≈ 100–210** |

Staging can be **scheduled off overnight** (compute + PG stop) to roughly halve it; W6-4 records whether the owner wants that.

**What scales materially:** API/worker replicas, PG instance class (the first real step-up, ≈ 2× at Tier 2), ALB/LCU and NAT data, log volume. Nothing at Tier 1 justifies Aurora, RDS Proxy, or a dedicated search engine (docs/37 §30).

---

## 8. Recommended target architecture — AWS me-central-1 (provider-neutral shape → concrete services)

```
Customer App (native)  ──https──▶  api.himma.app   (Route 53 → ALB + ACM)
Provider Portal (static, portal.himma.app via CloudFront+S3) ──https/cookies──▶ ALB
Admin Portal    (static, admin.himma.app  via CloudFront+S3) ──https/cookies──▶ ALB
himma.app (static bounce/universal-link/share pages, CloudFront+S3)
Stripe webhooks ──https──▶ ALB ──▶ /payments/webhook/stripe (raw body)

ALB ──▶ ECS Fargate service "api"  (RUNTIME_ROLE=api,   ×2, target group health = /internal/ready,
                                     secrets from Secrets Manager: DATABASE_URL[himma_api], peppers, Stripe TEST, Cognito public config)
       ECS Fargate service "worker" (RUNTIME_ROLE=worker, ×1–2, no ingress, container health = /internal/live on WORKER_STATUS_PORT,
                                     secrets: DATABASE_URL[himma_worker], Stripe TEST)
       ECS run-task "maintenance"   (RUNTIME_ROLE=maintenance, EventBridge Scheduler daily `retention.all` + operator on-demand,
                                     secret: DATABASE_URL[himma_maintenance_runner])
       ECS run-task "migrate"       (db:migrate + db:verify, pipeline-invoked before rollout,
                                     secret: DATABASE_URL[schema owner]; db:provision-roles on first setup/rotation)

RDS for PostgreSQL 16/17 Multi-AZ (private subnets, TLS forced, KMS, 35 d PITR)  ◀── api / worker / maintenance / migrate
S3 evidence bucket (private, versioned, SSE-KMS, prefix-scoped IAM)             ◀── api only (EVIDENCE_S3_*), when IN-06/VE-01 enable it
Cognito User Pool (me-central-1)                                                  ◀── app (direct), api (JWKS/refresh/revoke), portals (VITE_COGNITO_*)
CloudWatch Logs (stdout JSON) → metric filters on the W6 alert lines → alarms → SNS (email now; Slack/PagerDuty per OP-08)
ECR (one image: backend; tags = git SHA) ◀── GitHub Actions (OIDC role, no static keys)
```

One artifact, four runtime invocations, one database, one region. Nothing in this shape changes application code: every box maps to an existing executable, config variable, or documented seam.

---

## 9. Environment model

| Environment | Where | Separate PG database | Separate Cognito pool | Separate Stripe config | Separate bucket | Separate secrets | Separate API hostname | Frontend env config |
|---|---|---|---|---|---|---|---|---|
| **Local development** | developer machine (existing `dev:server`/`dev:seed`/`himma_test_*` harness) | yes (`himma_backend_dev`, `himma_test_*`) | dev/non-production pool (docs/26 §14.E′) or the fake adapter | deterministic provider or personal TEST key | none / local MinIO | `.env` (gitignored) | `localhost` | dev values |
| **Staging** | **separate AWS account** (recommended: AWS Organizations, `himma-staging`) in me-central-1 | **yes** — its own RDS instance (single-AZ acceptable) | **yes** — its own pool (real Cognito, non-production users) | **yes** — Stripe **TEST** keys/webhook secret dedicated to staging | **yes** — its own bucket | **yes** — its own Secrets Manager entries | `api.staging.himma.app` (+ `portal.staging…`, `admin.staging…`) | staging `EXPO_PUBLIC_*`/`VITE_*` builds |
| **Production** | separate AWS account (`himma-production`) in me-central-1 | yes — Multi-AZ | yes — the production pool | Stripe TEST **until PA-06**; the LIVE configuration never exists in staging | yes | yes | `api.himma.app` | production builds |

**Binding rules:** production data never enters lower environments (docs/23 §10.8); staging is **config-identical topology** (same image, same task definitions, same roles) with the deterministic seed graduated into it; separate AWS accounts give hard blast-radius and billing separation for one engineer at near-zero extra cost; **financial/auth state can never be shared** because the database, pool, Stripe configuration, and secrets are physically distinct per environment.

---

## 10. Database / security / secrets model (mapping the approved identities)

| Identity (docs/37 §28) | Where it lives | Who holds the credential | How it is used |
|---|---|---|---|
| Schema/migration owner (RDS master or a dedicated `himma_migrator` with CREATEROLE + ownership) | Secrets Manager `himma/<env>/db/migrator` | the migration task role and the operator on `db:provision-roles`; **never** api/worker/maintenance tasks | `db:migrate`, `db:verify`, `db:provision-roles`; runs BEFORE rollout |
| `himma_api` (LOGIN, member of `himma_app`) | `himma/<env>/db/api` | the `api` task role only | `DATABASE_URL` of the API service |
| `himma_worker` (LOGIN, member of `himma_app`) | `himma/<env>/db/worker` | the `worker` task role only | `DATABASE_URL` of the worker service |
| `himma_maintenance_runner` (LOGIN, sole member of `himma_maintenance`) | `himma/<env>/db/maintenance` | the `maintenance` task role only | `DATABASE_URL` of maintenance run-tasks |
| `himma_maintenance` (NOLOGIN) / `himma_app` (NOLOGIN) | created by migrations (0001/0023) | nobody — grant targets only | privilege sets |

**Storage and injection:** each secret is a Secrets Manager entry; the ECS task definition references it (`valueFrom`), so the value reaches the process as an env var at start and appears in no image layer, no task definition JSON, no CloudTrail body, no CI log (CI never reads secret values — it only triggers tasks). IAM: each ECS task role may read exactly its own secret(s). Passwords are generated at provisioning by `db:provision-roles` from values injected once from the store (or generated into the store first, then injected) — never typed into a repository file, never committed, never printed (the script prints role names only). **Rotation:** new value into the store → `db:provision-roles` (ALTER ROLE … PASSWORD, idempotent) → new task deployment picks up the new value; SE-01 documents the procedure.

**TLS:** `rds.force_ssl=1` on the instance; `DATABASE_URL` carries `sslmode=verify-full` with the RDS CA bundle baked into the image (a public certificate, not a secret) — W6-4 adds the `ssl` option to `createPool` from config (bounded change).

**Migrations during deployment (docs/37 §27):** pipeline builds image `sha` → runs the **migration task** (`db:migrate && db:verify`) with the migrator secret against the target environment → only on success does it roll the `api`/`worker` services to image `sha`; new tasks refuse readiness/startup while the head mismatches, so an out-of-order rollout self-fails safely. Production down-migrations stay refused by the runner; rollback of schema = roll forward or restore (docs/37 §27), rollback of application = redeploy the previous image tag (all migrations additive/two-phase). `db:provision-roles` is a one-time/rotation task, not a per-deploy step.

**Role separation is not weakened anywhere**: the API/worker task roles cannot read the maintenance or migrator secrets (IAM), and the database itself refuses the maintenance authority to those logins (W6-3 proofs). Two independent walls.

---

## 11. CI/CD recommendation (GitHub Actions + OIDC → AWS; not implemented here)

```
push / PR ──▶ 1. checks: backend tsc+lint+Jest (real PostgreSQL service container), app tsc+lint+Jest,
              portal/admin tsc+lint+Jest+contract, Playwright (app; portal/admin E2E), npm audit policy (SE-03)
         ──▶ 2. build: backend image (Node 24 base, `npm ci --omit=dev`… — note `tsx` is a runtime dep by W6-1 design),
              tag = git SHA; push to ECR; ECR scan (SE-03); portal/admin `dist/` artifacts
main merge ──▶ 3. deploy-staging: migration task (db:migrate + db:verify) ──▶ roll api/worker to SHA ──▶ wait for
              target-group healthy + `/internal/ready` 200 on every task + worker "himma worker running" log line
              ──▶ smoke: public search, forged-bearer 401, dev-identity 404, `/internal/live`, signed Stripe TEST
              webhook → 200, one scheduled job_run row appears
manual approval ──▶ 4. deploy-production: identical steps against the production account; PAYMENTS_MODE and
              Stripe secrets come from the production store (TEST until PA-06 — never a pipeline input)
rollback ──▶ re-run step 3/4 with the previous SHA (application); schema never auto-downgrades
```

Rules: no destructive down migrations in any pipeline path; no `PAYMENTS_MODE=live` exists to select; secrets are never pipeline inputs; the production deploy requires a human approval; a failed migration task halts the rollout with the previous tasks still serving (readiness contract). Frontend deploys (portal/admin statics to S3 + CloudFront invalidation) ride the same pipeline; native builds (EAS) are the MR-04 release slice, not this pipeline's concern.

---

## 12. Staging certification plan (what staging must prove before production) — mapped to docs/36

| Proof | Mechanism | Gates |
|---|---|---|
| Production runtime boots in the cloud topology as `himma_api` ×2; readiness/liveness wired to the platform; SIGTERM drain observed during a rolling deploy with zero failed requests | ALB target group + deploy | IN-02 (deployed half), IN-12 |
| Worker ×2 as `himma_worker`; outbox → search convergence; payment loops idle-safe without a provider; scheduler runs every job on cadence; no overlapping `job_run` per job; SIGKILL/restart drill | worker service + `job_run` inspection | OP-01/OP-02/OP-03/OP-07 deployed half, IN-12 |
| Maintenance: scheduled `retention.all` runs as `himma_maintenance_runner`; operator `repair.*` on demand; API/worker task roles cannot read its secret | EventBridge + run-task | OP-06 (mechanism), SE-01 |
| PostgreSQL: roles provisioned by `db:provision-roles`; negative privilege matrix re-run against the managed instance; TLS forced; Multi-AZ failover during load; PITR restore to a point in time rehearsed and recorded; backup retention verified | RDS console + scripts | IN-05, IN-13, (IN-14 failover row) |
| Migration workflow: pipeline runs migrate+verify before rollout; a deliberately stale image refuses readiness; roll-forward rehearsal | pipeline | IN-11 |
| Cognito: real staging pool; sign-up/sign-in/refresh/revoke smoke (docs/26 §14.E′); TOTP/step-up smoke → the four `AdminProductionReadiness` flags truthfully set in staging config | app + portal + admin against staging | ID-02, ID-03, ID-04 (staging rehearsal; production repeats) |
| Stripe TEST: keys in the store; signed TEST webhook through the ALB → 200; hosted checkout journey; late-success compensation drill; `stripe:smoke` | staging Stripe TEST config | PA-02, PA-03, PA-04 (D-W5-6 certification runs HERE), PA-11 |
| Object storage: real-bucket upload/head/get smoke with the evidence driver — **content safety stays fail-closed** (VE-02 untouched) | S3 + API | IN-06, VE-01 |
| Customer app: staging build (`EXPO_PUBLIC_API_URL`/Cognito) on iOS Simulator + Android emulator against staging; physical-device pass when devices exist | EAS/dev build | MR-07 (values), MR-09/10/12 (with devices) |
| Provider Portal and Admin Portal: static deploys on staging hostnames; credentialed cookies across the shared domain; CORS via `PORTAL_ALLOWED_ORIGINS` | CloudFront + ALB | IN-12, MR-07 |
| Logging: pino JSON in CloudWatch with `role`, request ids, run ids; never-log check on real logs (secret-shaped canaries absent) | CloudWatch Insights | IN-09 (deployed), IN-10 (minimum) |
| Alerts: a forced scheduler failure raises `scheduledJobFailingConsecutively`; a held lock raises `scheduledJobMissed`; readiness failure > 2 min pages; all through metric filters → alarm → SNS | CloudWatch alarms | IN-10, OP-07 (deployed half), PA-10 (destination) |
| Backups/restore: full PITR restore of staging into a scratch instance, `db:verify` 23/0 on the restore, row counts reconciled | RDS | IN-13 |
| Multi-process behavior: the docs/37 §38 W6-1/2/3 concurrency drills repeated against the cloud topology (two API tasks share the PG rate limit; two workers share the outbox; scheduler double-fire) | scripted drills | IN-14 mechanics precursor |
| Tier-1 load/correctness gates (docs/23 §11.1) on the staging topology | load tool + DB invariants | IN-14 (after M3) |

Staging certification closes nothing by itself that requires production; it converts CONFIGURATION-REQUIRED and PRODUCTION-SMOKE-REQUIRED rows into rehearsed procedures whose production repeat is then mechanical.

---

## 13. Recommendation

**Recommended production platform: AWS (ECS Fargate + RDS for PostgreSQL Multi-AZ + Secrets Manager + ALB/ACM/Route 53 + S3/CloudFront + CloudWatch + Cognito), two AWS accounts (staging, production) under one organization.**

**Recommended region: `me-central-1` (UAE)** — in-country data residency for PostgreSQL, object storage, logs, secrets, and (verify-at-provisioning) the Cognito pool; `me-south-1` (Bahrain) only as a documented fallback for a specific service gap, recorded under IN-01/ID-08.

**Estimated initial monthly staging cost: ≈ USD 90–180** (less if scheduled off overnight).

**Estimated initial monthly production cost: ≈ USD 330–615** at Tier 1 (`api ×2`, `worker ×2`, Multi-AZ PostgreSQL, NAT, logs), excluding staffing and any telemetry vendor.

**Main reason:** Himma's certified code already carries two AWS-shaped seams — Cognito is the authentication provider (reached directly by the mobile app and mediated by the backend) and the evidence store is a SigV4 S3 driver — so AWS in the UAE region gives in-country residency, a single cloud/IAM/bill for a founder-sized team, a financial-class managed PostgreSQL, and a one-image/four-invocation deployment that maps onto the W6 runtime with **zero application-code changes** (only the TLS pool option and explicit pool timeouts, both bounded config work).

**Second place: Azure UAE North.** Technically sufficient (Container Apps + Jobs, Flexible Server HA, Key Vault) and equally in-country, it loses because it would leave identity on AWS anyway (two clouds to operate and pay for) and its object storage is not S3-compatible (the closed W3 evidence driver would need an Azure driver or a gateway). Those two facts are architecture consequences of already-approved slices, not preferences. **GCP is rejected** outright: no UAE region.

---

## 14. Owner decisions required (minimized)

1. **APPROVE** the recommendation — AWS, `me-central-1`, two accounts (staging + production) — **or choose the alternate** (Azure UAE North, accepting the two-cloud identity posture and an evidence-storage driver change). This is the docs/23 §18.3 / docs/36 **IN-01** ruling; counsel should be told the ruling for SE-04.
2. **Company AWS account ownership** — the accounts must be created under the company's legal entity and root credentials held by the owner (engineering receives IAM roles). Nobody else can do this; it is the only external action W6-4 needs on day one.
3. **Domain control** — confirm `himma.app` (or the final domain) is owned by the company and that DNS can be delegated to Route 53 (IN-03/LE-09/PA-05 ride on it). If the domain is not yet purchased, that purchase is an owner action recorded under IN-03.
4. *(Not blocking W6-4, but in parallel per docs/36 §9)*: Stripe UAE account/KYB (PA-01), Apple/Google developer accounts (MR-02/03), counsel engagement (LE-*), physical devices (MR-09/10).

No other engineering question needs the owner: cadences, instance classes, subnet layout, log retention, staging schedules, and pipeline shape are engineering-owned within the bounds above and will be recorded in the W6-4 plan.

---

## 15. Proposed next slice — **W6-4 · Production Infrastructure, Staging & CI/CD Foundation** (preparation for authorization; NOT started)

**Precondition:** owner approval of §13/§14 items 1–3.

**WILL implement (deployment-neutral code first, AWS-specific second):**
1. **Container definition** for the backend: one Dockerfile (Node 24 base, `npm ci` with runtime deps incl. `tsx`, non-root user, `HEALTHCHECK` not relied upon — ALB/ECS health), `.dockerignore`; the three commands (`start:api`, `start:worker`, `start:maintenance -- <job>`) and the migration command from the same image; local `docker compose` topology = the docs/37 §36 harness (PostgreSQL + migrate + api ×2 + worker ×2 + maintenance) proving the image itself.
2. **Bounded runtime config additions:** TLS enforcement for the pool (`ssl`/`sslmode=verify-full` + CA bundle path), explicit pool `max`/`connectionTimeoutMillis`/`idleTimeoutMillis`/`statement_timeout` per role (docs/37 §2 item 2 debt) — fail-closed, tested; nothing else in application code.
3. **IaC (Terraform, provider-specific module set, one repo directory)** for staging and production accounts: VPC/subnets/NAT/security groups; RDS Multi-AZ (single-AZ in staging) with `rds.force_ssl`, KMS, 35-day backups, parameter group; Secrets Manager entries (empty shells — values entered by the operator, never by code); ECR; ECS cluster + task definitions (api, worker, maintenance, migrate) + services (api, worker) + EventBridge Scheduler (daily `retention.all`); ALB + ACM + Route 53 records; S3 evidence bucket + prefix-scoped IAM; S3 + CloudFront for portal/admin/bounce statics; CloudWatch log groups, metric filters for the W6 alert lines, alarms, SNS topic; GitHub OIDC role. Staging first, production by the same modules.
4. **CI/CD (GitHub Actions):** the §11 pipeline — checks (backend Jest against a PostgreSQL service container, app/portal/admin suites, Playwright), image build + ECR push + scan, staging deploy with migration task → rollout → readiness/smoke, manual-approval production deploy, previous-SHA rollback job; `npm audit` policy gate (SE-03).
5. **Staging bring-up and certification** per §12 rows that need no external input: runtime/worker/scheduler/maintenance/roles/migration/logging/alerts/backups-restore/multi-process drills, portal/admin static deploys, app staging build against the Simulator/emulator.
6. **Documentation:** docs/36 rows updated by evidence; a production runbook skeleton (deploy, rollback, rotate a DB password, run a maintenance job, restore from PITR) — the SE-01/IN-13 procedures in written form; `.env.example` unchanged in spirit (placeholders only).

**WILL NOT implement:** LIVE payments or any `live` mode (`productionChargingPossible` stays literal `false`); Stripe credential creation (PA-01/PA-02 are owner/ops inputs — the pipeline only consumes the store); production Cognito pool user data or social federation (ID-05…07); content-safety scanning (VE-02); telemetry vendor selection beyond CloudWatch (IN-10 vendor half); on-call staffing (OP-08); EAS/native signing (MR-04 release slice); customer web (LE-09 ruling); Arabic; any product behavior, schema semantics, commission, VAT, refund, or booking rule; policy-gated retention (SE-05/VE-05); a second cloud.

**Expected docs/36 gate effects (evidence-driven, recorded in the W6-4 commit only where true):** IN-01 recorded (owner ruling) · IN-11 CODE-COMPLETE (pipeline + rehearsed rollback in staging) · IN-12 CLOSED for staging (production topology from the same modules) · IN-04 CLOSED (managed store delivering env) · IN-05/IN-06 CLOSED once provisioned and recorded · IN-02 deployed half closed · SE-03 CODE-COMPLETE (scanning gate active) · SE-01 advanced (inventory + one rehearsed rotation) · IN-13 advanced (staging restore rehearsal; production rehearsal after production exists) · IN-10 advanced (CloudWatch minimum; vendor open) · IN-03/PA-03/PA-05 groundwork (origin + ingress exist; PA-05 bounce page is its own small slice) · ID-01…04, PA-02/PA-04, VE-01, MR-07 become **executable** (they still need the owner's accounts/credentials and the recorded smokes). Tallies are reported before/after in that commit, never guessed here.

**Migrations:** none expected. If the TLS/pool work needs no schema (it does not), the head stays `0023`.

**Secrets boundary:** §10 verbatim — Secrets Manager shells created by IaC, values entered by the operator; four DB credentials + peppers + Stripe TEST + S3 key; IAM scoping per task role; CI holds no secret values (OIDC role only).

**Deployment architecture:** §8 verbatim; staging then production from identical modules; separate accounts.

**Staging certification:** §12 rows 1–5, 9–13 within W6-4; rows 6–8 (Cognito, Stripe TEST, S3 smoke) as soon as the owner's accounts/credentials exist — recorded per gate when they run.

**Rollback:** application = redeploy previous image SHA (pipeline job); schema = roll forward or PITR restore (production down stays refused); rehearsed in staging before production exists (IN-11 proof).

**Verification requirements:** the docker-compose harness runs the existing W6 spawned-process suites' scenarios against the image; Terraform `plan` reviewed and applied by the owner-approved operator (never by an unattended pipeline for production); staging drills recorded with commands and outputs; all existing suites stay green (backend 1392/121, app 549/41, Playwright 15, portal 815 + 77, admin 138 + 15) with the pool-config change covered by new fail-closed config tests; `productionChargingPossible === false` and the production source locks re-pinned; clean tree; STOP for owner review.

---

## 16. Remaining external dependencies after this decision (unchanged by infrastructure)

Stripe UAE account + KYB (PA-01/LE-07) · Apple Developer Program + Google Play Console + bundle identifiers (MR-01…03) · counsel: ToS, privacy, provider agreement, cancellation/refund templates, child-data package, PDPL (LE-01…05, SE-04, LE-04, VE-04/05) · VAT / principal-vs-agent rulings (FI-01/02) · commission-term administration slice (FI-05) · refund authority slice (PA-08) · content-safety scanner (VE-02) + evidence-upload UX (VE-03) · brand deliverables (MR-06) · physical devices (MR-09/10) · design-partner sessions + launch providers (PR-01/02) · staffing: on-call, support, verification review, finance (OP-08, PR-05, VE-06, FI-06) · telemetry vendor (IN-10 vendor half) · penetration test (SE-02) · live enablement (PA-06/PA-07 — last, owner-approved, after the whole chain).

---

## 17. Confirmation

No implementation, no cloud resource, no IaC, no pipeline, no domain, no account, no credential, no Cognito change, and no product/schema/payment change was made by this slice. `productionChargingPossible` = literal `false`. Migration head = `0023_job_run_and_maintenance_authority`. This document and the W6-3 closure bookkeeping are the only changes in the commit.
