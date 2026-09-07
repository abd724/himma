#!/usr/bin/env bash
# Himma — Terraform apply preflight (docs/38; owner directive §23/§24).
# Prints ONLY non-secret identity facts and REFUSES unless:
#   environment ∈ {staging, production}; region == me-central-1;
#   the authenticated account == expected_account_id from the env tfvars;
#   environment == production ONLY with HIMMA_ALLOW_PRODUCTION_APPLY=yes
#   (W6-4A never applies production; W6-4B requires owner review first).
set -euo pipefail
ENV_NAME="${1:-}"
[[ "$ENV_NAME" == "staging" || "$ENV_NAME" == "production" ]] || { echo "usage: $0 <staging|production>" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TFVARS="$HERE/../terraform/envs/$ENV_NAME/terraform.tfvars"
[[ -f "$TFVARS" ]] || { echo "missing $TFVARS (copy terraform.tfvars.example and fill the NON-secret values)" >&2; exit 2; }
expected_account="$(sed -n 's/^expected_account_id[[:space:]]*=[[:space:]]*"\([0-9]\{12\}\)".*/\1/p' "$TFVARS")"
expected_region="$(sed -n 's/^region[[:space:]]*=[[:space:]]*"\([a-z0-9-]*\)".*/\1/p' "$TFVARS")"
[[ -n "$expected_account" ]] || { echo "expected_account_id not set in $TFVARS" >&2; exit 2; }
[[ "$expected_region" == "me-central-1" ]] || { echo "region must be me-central-1 (owner ruling docs/36 IN-01); tfvars says '$expected_region'" >&2; exit 3; }
command -v aws >/dev/null || { echo "aws CLI not found — no authenticated access available; nothing will be applied" >&2; exit 4; }
identity="$(aws sts get-caller-identity --output json 2>/dev/null)" || { echo "no authenticated AWS session — nothing will be applied" >&2; exit 4; }
account="$(printf '%s' "$identity" | sed -n 's/.*"Account": *"\([0-9]*\)".*/\1/p')"
region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
echo "environment : $ENV_NAME"
echo "account id  : $account"
echo "region      : ${region:-<unset>}"
[[ "$account" == "$expected_account" ]] || { echo "REFUSED: authenticated account $account != expected $expected_account for $ENV_NAME" >&2; exit 5; }
[[ "$region" == "me-central-1" ]] || { echo "REFUSED: AWS_REGION must be me-central-1" >&2; exit 5; }
if [[ "$ENV_NAME" == "production" && "${HIMMA_ALLOW_PRODUCTION_APPLY:-}" != "yes" ]]; then
  echo "REFUSED: production apply is not authorized (W6-4A never applies production; W6-4B requires staging certification + owner review)" >&2
  exit 6
fi
echo "preflight OK — you may run: terraform -chdir=infra/terraform/stacks/himma plan -var-file=../../envs/$ENV_NAME/terraform.tfvars"
