# 39 — W6-4B Staging Bootstrap: Owner Runbook (exact steps to resume)

**Status: W6-4B BLOCKED AT THE EXTERNAL OWNER PREREQUISITE (2026-09-08).** Everything repository-side is prepared and proven (docs/38 W6-4B record). Nothing in AWS exists yet — no account, no state, no resource, no domain, no GitHub repository/remote. This runbook is the shortest path from "nothing" to "staging deployed"; every step is a concrete command or console action, and every value the engineering side needs is listed once in §2. Production is NOT part of this runbook.

Discovery facts that produced this runbook (non-secret): no `aws` configuration (`~/.aws` absent, no `AWS_*` variables, no SSO cache); the repository has **no git remote** (the GitHub CLI is signed in as `abd724`, but nothing has been pushed anywhere); the Terraform var files are still the `.example` templates.

## 1. What must exist before engineering can run anything

| # | Prerequisite | Who | Why |
|---|---|---|---|
| A | An **AWS Organization** with a **`himma-staging` workload account** (and, later, `himma-production`). No Himma workload ever runs in the management account. | owner | docs/36 IN-01 ruling; docs/38 §2 |
| B | An **engineering identity in the staging account** that is NOT root: IAM Identity Center (SSO) permission set `AdministratorAccess` assigned to the engineer, or an IAM role the engineer can assume. | owner | preflight refuses root; Terraform needs admin on first apply |
| C | The **company domain** (e.g. `himma.app`) and either its existing **Route 53 hosted zone id** or permission to create one and delegate the NS records at the registrar. | owner | ALB/ACM/CloudFront hostnames, cookies across portal/API |
| D | A **GitHub repository** for this code (`<org>/himma`, private) with two **environments**: `staging` (no reviewers) and `production` (required reviewers = owner). | owner | OIDC trust is scoped to `repo:<org>/himma:environment:<env>`; CI/CD |
| E | (Later, per gate — not needed to deploy staging) Stripe **TEST** credentials, an alert e-mail/destination, Apple/Google sign-in credentials. | owner | PA-02, OP-08, ID-05…07 stay open until supplied |

## 2. The exact values engineering needs from you

| Value | Where it goes | Example shape |
|---|---|---|
| Staging AWS account id (12 digits) | `infra/terraform/envs/staging/terraform.tfvars` → `expected_account_id`; `bootstrap … -var expected_account_id=`; GitHub variable `HIMMA_STAGING_ACCOUNT_ID` | `123456789012` |
| SSO start URL + region, or the role ARN to assume | `aws configure sso` (profile `himma-staging`) | `https://d-xxxxxxxxxx.awsapps.com/start` |
| Root domain | `terraform.tfvars` → `root_domain`; GitHub variable `HIMMA_ROOT_DOMAIN` | `himma.app` |
| Hosted zone id (if the zone already exists) | `terraform.tfvars` → `hosted_zone_id` (else `create_hosted_zone = true`, then delegate NS) | `Z0123456789ABCDEFGHIJ` |
| GitHub repository | `terraform.tfvars` → `github_repository` | `himma-co/himma` |
| Alert e-mail (optional now) | `terraform.tfvars` → `alert_email` | `ops@himma.app` |

Nothing above is a secret; the var file stays gitignored only because it carries account-specific values.

## 3. Owner console steps (once)

1. **Accounts:** AWS Organizations → create account `himma-staging` (e-mail alias you control). Do not use the management account for anything else. Note the 12-digit id.
2. **Identity:** IAM Identity Center → enable in `me-central-1` (or your home region) → create the engineer user → assign permission set `AdministratorAccess` to the `himma-staging` account. Root credentials stay in the owner's vault with MFA; they are never used for deployment.
3. **Domain:** if the domain is not yet in Route 53, decide: (a) create a hosted zone in the **staging** account (Terraform can do it with `create_hosted_zone = true`) and delegate the four NS records at the registrar, or (b) hand engineering the existing zone id. ACM validation and every hostname wait on this.
4. **GitHub:** create the private repository, then in Settings → Environments create `staging` and `production` (production: required reviewers = you). The first push happens in §4 step 2.

## 4. Engineering steps (run in this order; each refuses on any mismatch)

```bash
# 1. authenticate as the staging engineering identity (never root); region is pinned
aws configure sso --profile himma-staging      # SSO start URL, region, account himma-staging, role AdministratorAccess
export AWS_PROFILE=himma-staging AWS_REGION=me-central-1
aws sts get-caller-identity                     # must show the STAGING account id and an assumed-role ARN

# 2. put the repository on GitHub (owner-chosen org/name), push main
git remote add origin git@github.com:<org>/himma.git && git push -u origin main

# 3. non-secret configuration
cp infra/terraform/envs/staging/terraform.tfvars.example infra/terraform/envs/staging/terraform.tfvars
#    edit: expected_account_id, root_domain, hosted_zone_id (or create_hosted_zone = true), github_repository, alert_email

# 4. Terraform state bucket (staging account only)
terraform -chdir=infra/terraform/bootstrap init
terraform -chdir=infra/terraform/bootstrap apply -var environment=staging -var expected_account_id=<staging id>
#    copy the printed backend_hcl into infra/terraform/envs/staging/backend.hcl

# 5. hard preflight (account = expected, region = me-central-1, production refused)
infra/scripts/tf-preflight.sh staging

# 6. plan, review, apply (registry first so the first image can be pushed; then everything)
terraform -chdir=infra/terraform/stacks/himma init -backend-config=../../envs/staging/backend.hcl
terraform -chdir=infra/terraform/stacks/himma plan  -var-file=../../envs/staging/terraform.tfvars -out=staging.plan
#    review: no destroys, no public RDS/S3, only ALB 80/443 open, region/account, no production references, no live payments
terraform -chdir=infra/terraform/stacks/himma apply staging.plan

# 7. first immutable image → ECR (same build path as CI; tag = git SHA)
aws ecr get-login-password | docker login --username AWS --password-stdin "$(terraform -chdir=infra/terraform/stacks/himma output -raw ecr_repository_url | cut -d/ -f1)"
docker buildx build --platform linux/amd64 --push -f backend/Dockerfile -t "$(terraform -chdir=infra/terraform/stacks/himma output -raw ecr_repository_url):$(git rev-parse HEAD)" --build-arg HIMMA_GIT_SHA=$(git rev-parse HEAD) backend

# 8. runtime DB passwords straight into Secrets Manager (never printed); operator peppers likewise
infra/scripts/bootstrap-db-secrets.sh staging
#    peppers: aws secretsmanager put-secret-value --secret-id himma/staging/app/peppers --secret-string '{"HIMMA_STAFF_INVITATION_PEPPER":"<openssl rand -base64 48>","HIMMA_MFA_RECOVERY_PEPPER":"<openssl rand -base64 48>"}'

# 9. schema, verification, runtime roles — as ECS one-shots from the image (RDS is private)
ENVIRONMENT=staging IMAGE_TAG=$(git rev-parse HEAD) AWS_REGION=me-central-1 infra/scripts/ecs-deploy.sh migrate
ENVIRONMENT=staging IMAGE_TAG=$(git rev-parse HEAD) AWS_REGION=me-central-1 infra/scripts/ecs-deploy.sh provision

# 10. roll out api + worker, then scale both to 2 for the certification drills
ENVIRONMENT=staging IMAGE_TAG=$(git rev-parse HEAD) AWS_REGION=me-central-1 infra/scripts/ecs-deploy.sh rollout
aws ecs update-service --cluster himma-staging --service himma-staging-api    --desired-count 2
aws ecs update-service --cluster himma-staging --service himma-staging-worker --desired-count 2

# 11. certification transcript (API/identities/TLS/privileges/migration/maintenance/logs/RDS/security review)
AWS_REGION=me-central-1 infra/scripts/staging-certify.sh

# 12. static surfaces (public build config from terraform outputs; no secrets)
infra/scripts/static-deploy.sh staging portal
infra/scripts/static-deploy.sh staging admin

# 13. GitHub → Settings → Variables: HIMMA_STAGING_ACCOUNT_ID, HIMMA_STAGING_DEPLOY_ROLE_ARN, HIMMA_BUILD_ROLE_ARN,
#     HIMMA_ECR_REPOSITORY, HIMMA_ROOT_DOMAIN (values from `terraform output github_roles / ecr_repository_url`).
#     The next push to main then runs CI → image → migrate → rollout → smoke by itself (production stays dispatch + approval only).
```

Failure drills (§24 of the directive) after step 10: `aws ecs stop-task` on one api task and one worker task while two of each run; `staging-certify.sh` re-run must pass and the survivors must keep serving/scheduling.

## 5. What stays open even after staging is green

PA-02/PA-04 (Stripe TEST credentials), OP-08 (human alert destination), ID-05…07 (Apple/Google), VE-02 (content safety), every PRODUCTION-SMOKE-REQUIRED row, and everything that needs the production account. `productionChargingPossible` stays the literal `false`; there is no live mode to configure.
