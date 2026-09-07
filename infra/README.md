# Himma — production infrastructure (W6-4A foundation)

Owner ruling (docs/36 IN-01, docs/38): **AWS · `me-central-1` (UAE) · separate Staging and Production workload accounts under AWS Organizations · no Himma workloads in the management account.** This directory is the repository-side foundation: the ONE backend image, a local production-like container harness, Terraform for both environments, the GitHub OIDC pipeline, and the operating procedures. docs/36 stays the only launch checklist; this file is the deployment/runbook record it points to.

`productionChargingPossible = false` is untouched. Nothing here can select a live payments mode: the application has no such value and Terraform refuses anything but `disabled | test`.

## 1. Layout

| Path | What |
|---|---|
| `backend/Dockerfile`, `backend/.dockerignore` | The one production artifact (Node 24, multi-stage, non-root, node as PID 1, RDS CA bundle baked in). Commands: `scripts/start-api.ts` · `scripts/start-worker.ts` · `scripts/start-maintenance.ts <job>` · `scripts/db-migrate.ts` · `scripts/db-verify.ts` · `scripts/db-provision-runtime-roles.ts` |
| `infra/local/` | Container harness: TLS PostgreSQL → migrate/verify → provision roles → api ×2 → worker ×2 → maintenance; `harness.sh` drives and checks it |
| `infra/terraform/bootstrap/` | Remote-state bucket per workload account (local state, applied once) |
| `infra/terraform/modules/*` | network · database · secrets · registry · compute · ingress · static_site · evidence_bucket · cognito · observability · github_oidc |
| `infra/terraform/stacks/himma/` | The one root stack; applied per environment with `envs/<env>/terraform.tfvars` + `envs/<env>/backend.hcl` |
| `infra/terraform/envs/{staging,production}/` | `terraform.tfvars.example`, `backend.hcl.example` (copies are gitignored; they hold account ids/domains — never secrets) |
| `infra/scripts/tf-preflight.sh` | Prints account/region/environment and REFUSES a mismatch; production apply refused without `HIMMA_ALLOW_PRODUCTION_APPLY=yes` (W6-4A never applies production) |
| `infra/scripts/bootstrap-db-secrets.sh` | Mints the three runtime DB passwords straight into Secrets Manager (never printed) |
| `infra/scripts/ecs-deploy.sh` | Pipeline steps: `migrate` (run-task db:migrate + db:verify) · `rollout` (register task definitions at the SHA, update services) · `smoke` |
| `.github/workflows/ci.yml` | Tests/typecheck/lint for backend + three frontends + contract suites, audit policy, production image build + invariants + Trivy scan, Terraform fmt/validate |
| `.github/workflows/deploy.yml` | OIDC deploy; **deploy-disabled until the account variables exist**; staging on `main`, production only by dispatch + environment approval |

## 2. Account and environment topology

```
AWS Organization (management account — NO Himma workloads; owner-held root; only Organizations/billing)
├── himma-staging     (workload account, me-central-1)  ← Terraform stack, env = staging
└── himma-production  (workload account, me-central-1)  ← Terraform stack, env = production
```

Each workload account holds its own VPC, RDS instance, Secrets Manager entries, ECR (staging builds; production promotes the same immutable image), ECS cluster, ALB, Cognito user pool, evidence bucket, static sites, CloudWatch/SNS, Terraform state bucket, and GitHub OIDC roles. **Financial, authentication, and business state can never be shared across environments**: the database, pool, Stripe configuration, buckets, and secrets are different resources in different accounts.

| | Staging (`envs/staging`) | Production (`envs/production`) |
|---|---|---|
| API / worker tasks | 1 / 1 (scale to 2/2 for the certification drills) | 2 / 2 |
| Task placement | public subnets + public IPs, **no NAT** (cost mode; SGs still admit only ALB→api) | private subnets, NAT per AZ, interface endpoints (ECR, Secrets Manager, Logs) + S3 gateway |
| RDS | `db.t4g.small`, single-AZ, 7-day backups, deletion protection ON, final snapshot ON | `db.t4g.medium`, Multi-AZ, 35-day backups/PITR, deletion protection ON, final snapshot ON |
| Cognito | own pool, deletion protection OFF | own pool, deletion protection ON |
| Hostnames | `api.staging.<root>`, `portal.staging.<root>`, `admin.staging.<root>`, `staging.<root>` | `api.<root>`, `portal.<root>`, `admin.<root>`, `<root>` |
| Payments | `disabled` until genuine Stripe TEST credentials exist; then `test` | `disabled` (TEST only after PA-02/PA-04; live does not exist) |
| Logs | 14 days | 30 days |

## 3. Network and egress model

VPC `10.40.0.0/16`, two AZs. Public subnets: ALB (+ NAT in production). App subnets: ECS tasks (production). Database subnets: RDS, **no default route at all**. Security groups: internet → ALB (80/443 only); ALB → api (8080 only); api/worker/jobs → RDS (5432 only) and → internet 443 (Stripe, Cognito, AWS APIs); worker and jobs have **no ingress rule**. Egress that must leave AWS: Stripe and Cognito (HTTPS). In production that goes through NAT (one per AZ, ~USD 70–110/month incl. data at Tier 1); AWS-native calls (ECR pulls, secrets, logs, S3) use VPC endpoints (~USD 25–35/month for the three interface endpoints) so they never traverse NAT. Staging avoids NAT entirely by giving tasks public IPs behind the same strict security groups.

## 4. Bootstrap sequence (W6-4B, per environment — staging first)

Prerequisites (owner): the two workload accounts exist under the Organization; an engineering IAM identity (SSO/role, no root) with administrator access in the WORKLOAD account; the company domain and, if it already exists, its Route 53 hosted zone id.

1. **State bucket** (once per account): `cd infra/terraform/bootstrap && terraform init && terraform apply -var environment=staging -var expected_account_id=<id>` → copy the printed `backend_hcl` into `infra/terraform/envs/staging/backend.hcl`.
2. **Var file**: copy `envs/staging/terraform.tfvars.example` → `terraform.tfvars`; set `expected_account_id`, `root_domain`, `github_repository`, `hosted_zone_id` (or `create_hosted_zone = true`, then delegate NS at the registrar).
3. **Preflight**: `infra/scripts/tf-preflight.sh staging` — prints account/region/environment, refuses any mismatch.
4. **First apply, registry only**: `terraform -chdir=infra/terraform/stacks/himma init -backend-config=../../envs/staging/backend.hcl && terraform … apply -var-file=../../envs/staging/terraform.tfvars -target=module.registry`.
5. **First image**: push `main` — the `deploy` workflow's build job needs `vars.HIMMA_BUILD_ROLE_ARN`; until the OIDC role exists (step 6), build locally or via CI with the role after step 6. Order-of-operations note: apply the whole stack with `image_tag = "bootstrap"` first if you prefer; the api/worker services will simply wait (circuit breaker) until a real image tag is rolled out.
6. **Full apply**: `terraform … apply -var-file=…` (the plan creates VPC, RDS, secrets containers, ECS, ALB, ACM, Cognito, buckets, CloudWatch, OIDC roles). ACM validation waits on DNS — the hosted zone must be delegated first.
7. **Runtime DB passwords**: `infra/scripts/bootstrap-db-secrets.sh staging` (writes `himma/staging/db/{api,worker,maintenance}` — never printed).
8. **Operator-supplied secrets** (see §6): `app/peppers`; later `stripe/test`, `evidence/s3`, `auth/bootstrap`.
9. **Migrations + roles**: run the `migrate` task definition twice by command — `scripts/db-migrate.ts`, then `scripts/db-verify.ts`; then `scripts/db-provision-runtime-roles.ts` (reads the three runtime passwords + the RDS-managed master secret; creates `himma_api`, `himma_worker`, `himma_maintenance_runner`). The pipeline's `ecs-deploy.sh migrate` does the first two on every deploy; provisioning is a bootstrap/rotation action.
10. **GitHub variables** (repository → Settings → Variables): `HIMMA_STAGING_ACCOUNT_ID`, `HIMMA_STAGING_DEPLOY_ROLE_ARN`, `HIMMA_BUILD_ROLE_ARN`, `HIMMA_ECR_REPOSITORY`, `HIMMA_ROOT_DOMAIN`; create the `staging` and `production` GitHub environments (production with required reviewers). Until these exist the deploy workflow reports itself DISABLED and does nothing.
11. **First rollout**: push to `main` (or dispatch) → image → migrate task → rollout → smoke.
12. **Frontends**: build the portals with the `frontend_build_env` outputs and sync `dist/` to the static-site buckets (`aws s3 sync … && aws cloudfront create-invalidation`); the customer web/bounce statics likewise. The customer app takes `EXPO_PUBLIC_*` at build time (MR-04 release slice).

Production repeats 1–12 in the production account with `HIMMA_ALLOW_PRODUCTION_APPLY=yes` — only after staging certification and owner review (W6-4B), never in W6-4A.

## 5. Terraform state

One S3 bucket per workload account (`himma-<env>-tfstate-<account>`): versioned, AES-256 encrypted, public access blocked, TLS-only policy, `prevent_destroy`, non-current versions kept 365 days; S3-native locking (`use_lockfile = true`, Terraform ≥ 1.10). Staging and production state are in different accounts by construction. `.tfstate`, `.terraform/`, filled var files and backend configs are gitignored.

## 6. Secret ownership matrix (Secrets Manager `himma/<env>/…`)

| Secret | Contents | Generated by | Read by (execution role) | Rotation |
|---|---|---|---|---|
| RDS master (RDS-managed, `rds!…`) | schema-owner password | **RDS** (no plaintext in state) | `migrate` task only | RDS rotation (`manage_master_user_password`) |
| `db/api` | `{"password"}` for `himma_api` | `bootstrap-db-secrets.sh` | `api` task; `migrate` task (provisioning) | `ROTATE=yes bootstrap-db-secrets.sh` → run provisioning task → redeploy |
| `db/worker` | `{"password"}` for `himma_worker` | same | `worker`; `migrate` (provisioning) | same |
| `db/maintenance` | `{"password"}` for `himma_maintenance_runner` | same | `maintenance`; `migrate` (provisioning) | same |
| `app/peppers` | `HIMMA_STAFF_INVITATION_PEPPER`, `HIMMA_MFA_RECOVERY_PEPPER` (≥32 chars) | **operator** (`openssl rand -base64 48`) | `api` | new version → redeploy (versioned digests keep old tokens valid per the application's pepper-version model) |
| `stripe/test` | `STRIPE_SECRET_KEY` (TEST only), `STRIPE_WEBHOOK_SECRET[_RETIRING]` | **owner/ops from the Stripe dashboard** (PA-02) | `api`, `worker` when `payments_mode = "test"` | retiring-secret rotation (W5-3) |
| `evidence/s3` | access key id/secret for the evidence bucket | **ops** (IAM user scoped to the bucket policy, or replace with task-role credentials — recorded follow-up) | `api` | IAM key rotation |
| `auth/bootstrap` | `HIMMA_BOOTSTRAP_SECRET`, `HIMMA_BOOTSTRAP_CONFIRMATION` | **owner** (one-time admin bootstrap) | `migrate` task (operator-run `bootstrap:admins`) | cleared after use |

Non-secret configuration (COGNITO_*, PORTAL_ALLOWED_ORIGINS, AUTH_COOKIE_DOMAIN, PAYMENT_CHECKOUT_*_URL, LOG_LEVEL, cadences) is derived by the stack from the pool/hostnames and lives in the task definitions as plain environment. Passwords never appear in the repository, images, task definition JSON (only ARNs), CI logs, or Terraform state (the runtime passwords are written by a script directly into Secrets Manager; the master password is RDS-managed).

## 7. Database identities in AWS

| Identity | Created by | Credential lives in | Used by |
|---|---|---|---|
| `himma_owner` (RDS master = schema/migration owner) | RDS | RDS-managed secret | `migrate` task (db:migrate, db:verify, db:provision-roles, bootstrap:admins) |
| `himma_app`, `himma_maintenance` (NOLOGIN) | migrations 0001 / 0023 | — | grant targets |
| `himma_api` | `db:provision-roles` | `db/api` | `api` service |
| `himma_worker` | `db:provision-roles` | `db/worker` | `worker` service |
| `himma_maintenance_runner` | `db:provision-roles` | `db/maintenance` | `maintenance` run-tasks (EventBridge daily `retention.all`; operator repairs) |

TLS: the RDS parameter group forces SSL; every process runs `DATABASE_SSL_MODE=verify-full` with the baked-in RDS global CA bundle (chain + hostname verification); plain TCP is refused by the application for any non-loopback host. Pool policy: `DB_POOL_MAX` 10 per process, connect 5 s, idle 30 s, `statement_timeout` api 15 s / worker 60 s / maintenance 300 s / migrate none.

## 8. Deploy, rollback, and migrations

- **Deploy** (`deploy.yml` → `ecs-deploy.sh`): build once, tag = git SHA (ECR tags are immutable) → `migrate` run-task (db:migrate then db:verify, schema-owner credential) must exit 0 → register api/worker/maintenance task definitions at the SHA → `UpdateService` (rolling; `deployment_circuit_breaker` rolls back automatically if readiness never turns green) → `services-stable` → smoke (`/internal/live`, `/internal/ready`, dev identity 404, forged bearer 401).
- **Application rollback**: dispatch `deploy.yml` with `image_tag = <previous SHA>` (or `aws ecs update-service --task-definition <previous revision>`). New tasks refuse readiness/startup when the applied migration head differs from what their build ships, so an image incompatible with a newer schema cannot serve (docs/37 §27); roll forward with a new migration if that happens.
- **Schema**: production down-migrations stay refused by the runner; the pipeline never runs `db:down`. Migrations are additive/two-phase by repository policy. Disaster recovery = PITR restore (§9), never routine rollback.
- **Production**: never from a push — `workflow_dispatch` with `target = production` and the GitHub `production` environment's required reviewers.

## 9. Backups and disaster recovery (docs/23 §10.11 outline; IN-13 rehearsals in W6-4B)

- Financial class (bookings, payments, holds, ledger, audit — all in the one PostgreSQL): RPO 0 for committed transactions via **Multi-AZ synchronous standby**; **PITR** to any second within the 35-day window; automated snapshots; deletion protection; final snapshot on destroy; `delete_automated_backups = false`.
- **Restore rehearsal** (staging, recorded per IN-13): `aws rds restore-db-instance-to-point-in-time` into a scratch identifier → point a temporary `migrate` task at it → `db:verify` 23/0 → reconcile row counts → destroy the scratch instance. Production rehearsal after production exists.
- **Region failure**: single-region by ruling; documented posture = restore from snapshot copies (cross-region snapshot copy to `me-south-1` is a recorded follow-up, not enabled here). Search projection and caches are rebuildable (`repair.rebuild-search`).
- Evidence bucket: versioned; no lifecycle expiry (VE-05 unruled). Static sites: rebuilt from source.

## 10. Observability and alerting

ECS stdout (pino JSON, redaction proven at runtime) → CloudWatch Logs `/himma/<env>/backend` (bounded retention) → metric filters on the W6 alert lines (`stuckPaymentState`, `reconciliationDiscrepancy`, `scheduledJobFailingConsecutively`, `scheduledJobMissed`) and on startup refusals → alarms → SNS `himma-<env>-alerts`. Infrastructure alarms: ALB target 5xx, unhealthy targets ≥ 2 min, RDS CPU/free storage/connections, ECS running tasks below desired (worker heartbeat) for 5 min. The human destination is an owner/ops input (`alert_email` today; Slack/PagerDuty per docs/36 OP-08/IN-10) — nothing is fabricated.

## 11. Local container harness

```
infra/local/harness.sh
```
Requires Docker (compose v2), openssl, curl. Generates a harness CA + a PostgreSQL server certificate (CN/SAN `postgres`), random passwords into gitignored `infra/local/.harness.env`, builds the image, brings up TLS PostgreSQL → migrate → verify → provision-roles → api ×2 → worker ×2, then proves: migration head, every application backend on TLS, DB identities (two `himma_api` and two `himma_worker` peers, no resident maintenance identity), readiness/liveness on both API replicas, dev identity 404 / forged bearer 401, scheduler runs with zero overlapping `job_run`s, a short-lived `retention.all` as `himma_maintenance_runner`, privilege refusals from inside the containers, and SIGTERM → exit 0 on one API replica while the other stays ready.

The machine that authored W6-4A had no container runtime, so the harness is recorded as **authored and syntax-checked, not executed**; the same proofs run natively (no Docker) in `backend/test/db-tls.test.ts` (real TLS PostgreSQL, spawned production API over verify-full) and the W6-1…W6-3 spawned-process suites. CI builds the image and checks its invariants on every push.

## 12. Cost (list prices, me-central-1; verify in the account)

| | Staging | Production |
|---|---|---|
| Compute (api/worker Fargate) | 25–45 | 60–110 |
| RDS | 25–60 (t4g.small single-AZ) | 160–260 (t4g.medium Multi-AZ, 35 d) |
| ALB | 25–40 | 30–50 |
| NAT + egress | 0 (public tasks) + 5–10 egress | 70–110 (2× NAT + data) |
| VPC interface endpoints | 0 | 25–35 |
| Logs/metrics/alarms | 5–20 | 15–50 |
| Secrets, ECR, S3, CloudFront, DNS | 10–25 | 25–50 |
| **Total / month** | **≈ 95–200** | **≈ 385–665** |

Plus Cognito (free at Tier-1 volumes). Staging can be scheduled off overnight (RDS stop + desired counts 0) to roughly halve its line.
