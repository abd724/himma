#!/usr/bin/env bash
# Himma — build and deploy ONE static surface to its private S3 origin +
# CloudFront (infra/README.md §4 step 12; docs/38 §8). Runs under the
# operator's staging identity or the GitHub deploy role (which carries the
# static deploy policies). PUBLIC build-time configuration only — every value
# comes from `terraform output frontend_build_env`; no secret is ever read.
#
#   infra/scripts/static-deploy.sh staging portal
#   infra/scripts/static-deploy.sh staging admin
#   infra/scripts/static-deploy.sh staging web      # customer web/bounce/universal-link statics (web/ directory)
#
# Requires: aws CLI (authenticated; preflight first), terraform (for outputs),
# node/npm. Refuses production unless HIMMA_ALLOW_PRODUCTION_APPLY=yes.
set -euo pipefail
ENV_NAME="${1:-}"; SURFACE="${2:-}"
[[ "$ENV_NAME" == "staging" || "$ENV_NAME" == "production" ]] || { echo "usage: $0 <staging|production> <portal|admin|web>" >&2; exit 2; }
[[ "$SURFACE" == "portal" || "$SURFACE" == "admin" || "$SURFACE" == "web" ]] || { echo "usage: $0 <staging|production> <portal|admin|web>" >&2; exit 2; }
if [[ "$ENV_NAME" == "production" && "${HIMMA_ALLOW_PRODUCTION_APPLY:-}" != "yes" ]]; then
  echo "REFUSED: production static deploy is not authorized (staging certification + owner review first)" >&2; exit 6
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STACK="$ROOT/infra/terraform/stacks/himma"

"$HERE/tf-preflight.sh" "$ENV_NAME" >/dev/null

outputs="$(terraform -chdir="$STACK" output -json)"
jq_() { printf '%s' "$outputs" | python3 -c 'import json,sys; o=json.load(sys.stdin); print(eval(sys.argv[1], {"o": {k: v["value"] for k, v in o.items()}}))' "$1"; }
bucket="$(jq_ "o['static_sites']['$SURFACE']['bucket']")"
distribution="$(jq_ "o['static_sites']['$SURFACE']['distribution_id']")"
[[ -n "$bucket" && -n "$distribution" ]] || { echo "static_sites output missing for $SURFACE — apply the stack first" >&2; exit 3; }

case "$SURFACE" in
  portal|admin)
    dir="$ROOT/$SURFACE"
    # Public build-time configuration from the stack (no secrets exist here by construction).
    env_json="$(jq_ "json.dumps(o['frontend_build_env']['$SURFACE'])")"
    echo "building $SURFACE with: $(printf '%s' "$env_json" | python3 -c 'import json,sys; print(" ".join(f"{k}={v}" for k,v in json.load(sys.stdin).items()))')"
    ( cd "$dir" && npm ci --no-audit --no-fund >/dev/null && env $(printf '%s' "$env_json" | python3 -c 'import json,sys; print(" ".join(f"{k}={v}" for k,v in json.load(sys.stdin).items()))') npm run build >/dev/null )
    dist="$dir/dist"
    ;;
  web)
    # The customer-facing statics (universal/app links, the payment bounce page) — a plain directory, no build.
    dist="$ROOT/web"
    [[ -d "$dist" ]] || { echo "no web/ directory to deploy (the customer web/bounce surface is defined per docs/38; nothing to publish)" >&2; exit 3; }
    ;;
esac

# Never a secret in the bundle: refuse BEFORE anything is uploaded.
if grep -rIlE "sk_(live|test)_[0-9A-Za-z]{8,}|AKIA[0-9A-Z]{16}|whsec_[0-9A-Za-z]{8,}" "$dist" >/dev/null 2>&1; then
  echo "REFUSED: secret-shaped string in the built output — nothing uploaded; investigate" >&2; exit 7
fi
# Assets are content-hashed → immutable; index.html revalidates (CloudFront honours these headers).
aws s3 sync "$dist" "s3://$bucket" --delete --exclude index.html --cache-control "public, max-age=31536000, immutable" >/dev/null
[[ -f "$dist/index.html" ]] && aws s3 cp "$dist/index.html" "s3://$bucket/index.html" --cache-control "no-cache" >/dev/null
aws cloudfront create-invalidation --distribution-id "$distribution" --paths "/*" --query 'Invalidation.Id' --output text
echo "deployed $SURFACE → s3://$bucket (distribution $distribution)"
