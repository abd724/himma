#!/usr/bin/env bash
# Himma — generate the three runtime DB login passwords straight INTO Secrets
# Manager (docs/38 §10): never printed, never on disk, never in Terraform
# state. Run once per environment after `terraform apply`, before the first
# migration/provisioning task. Re-run with ROTATE=yes to mint new values,
# then run the provisioning task to apply them (db:provision-roles is
# idempotent — ALTER ROLE … PASSWORD).
#
#   infra/scripts/bootstrap-db-secrets.sh staging
set -euo pipefail
ENV_NAME="${1:-}"
[[ "$ENV_NAME" == "staging" || "$ENV_NAME" == "production" ]] || { echo "usage: $0 <staging|production>" >&2; exit 2; }
command -v aws >/dev/null || { echo "aws CLI required" >&2; exit 4; }
for name in db/api db/worker db/maintenance; do
  secret_id="himma/$ENV_NAME/$name"
  if [[ "${ROTATE:-no}" != "yes" ]] && aws secretsmanager get-secret-value --secret-id "$secret_id" --query 'VersionId' --output text >/dev/null 2>&1; then
    echo "$secret_id already has a value (set ROTATE=yes to mint a new one)"
    continue
  fi
  # 32 URL-safe chars; the value goes to AWS directly via stdin, never to the terminal.
  password="$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-32)"
  printf '{"password":"%s"}' "$password" | aws secretsmanager put-secret-value --secret-id "$secret_id" --secret-string file:///dev/stdin --query 'VersionId' --output text >/dev/null
  unset password
  echo "wrote a new value to $secret_id"
done
echo "peppers, Stripe TEST, and evidence-key secrets are OWNER/OPS-supplied — see infra/README.md"
