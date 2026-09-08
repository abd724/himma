#!/usr/bin/env bash
# Himma — pipeline deployment steps (docs/38 §11; docs/37 §27). Runs under the
# GitHub OIDC deploy role of ONE workload account. Three sub-commands:
#   migrate  — register the `migrate` task definition at IMAGE_TAG, run it
#              (db:migrate), wait, refuse on non-zero, then run db:verify;
#   provision — run db:provision-runtime-roles on the CURRENT `migrate` task
#              definition (schema authority + the three runtime passwords the
#              task reads from Secrets Manager; cluster-wide lock inside);
#   rollout  — register api/worker task definitions at IMAGE_TAG and update
#              the services (ECS rolling deploy; circuit breaker rolls back a
#              rollout whose readiness never turns green);
#   smoke    — wait for both services to be stable, then probe the public
#              origin: /internal/live 200, /internal/ready 200, dev identity
#              404, forged bearer 401.
# Rollback = re-run with IMAGE_TAG set to a previous SHA (never a `db:down`).
set -euo pipefail

CMD="${1:-}"
: "${ENVIRONMENT:?}"; : "${IMAGE_TAG:?}"; : "${AWS_REGION:?}"
NAME="himma-$ENVIRONMENT"
CLUSTER="$NAME"

register() { # family → new task definition ARN with the image swapped to IMAGE_TAG
  local family="$1"
  local current image_repo new_def
  current="$(aws ecs describe-task-definition --task-definition "$family" --query 'taskDefinition' --output json)"
  image_repo="$(printf '%s' "$current" | python3 -c 'import json,sys; print(json.load(sys.stdin)["containerDefinitions"][0]["image"].rsplit(":",1)[0])')"
  new_def="$(printf '%s' "$current" | python3 -c '
import json,sys
td=json.load(sys.stdin)
repo=sys.argv[1]; tag=sys.argv[2]
for c in td["containerDefinitions"]:
    c["image"]=f"{repo}:{tag}"
keep=["family","taskRoleArn","executionRoleArn","networkMode","containerDefinitions","volumes","placementConstraints","requiresCompatibilities","cpu","memory","runtimePlatform","ephemeralStorage"]
print(json.dumps({k:td[k] for k in keep if k in td}))' "$image_repo" "$IMAGE_TAG")"
  aws ecs register-task-definition --cli-input-json "$new_def" --query 'taskDefinition.taskDefinitionArn' --output text
}

jobs_network() {
  # The compute module records subnets/SG for run-task in the service's own network configuration (same placement).
  aws ecs describe-services --cluster "$CLUSTER" --services "$NAME-worker" \
    --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json
}

run_task() { # task-def-arn, container command override (JSON array) → waits; fails on non-zero exit
  local td="$1" command="$2" net task
  net="$(jobs_network)"
  local subnets sg assign
  subnets="$(printf '%s' "$net" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["subnets"]))')"
  sg="$(printf '%s' "$net" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["securityGroups"]))')"
  assign="$(printf '%s' "$net" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("assignPublicIp","DISABLED"))')"
  task="$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$td" \
    --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=$assign}" \
    --overrides "{\"containerOverrides\":[{\"name\":\"backend\",\"command\":$command}]}" \
    --query 'tasks[0].taskArn' --output text)"
  echo "started $task"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task"
  local code
  code="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)"
  echo "exit code: $code"
  [[ "$code" == "0" ]]
}

case "$CMD" in
  migrate)
    td="$(register "$NAME-migrate")"
    echo "migration task definition: $td"
    run_task "$td" '["scripts/db-migrate.ts"]'
    run_task "$td" '["scripts/db-verify.ts"]'
    ;;
  provision)
    td="$(aws ecs describe-task-definition --task-definition "$NAME-migrate" --query 'taskDefinition.taskDefinitionArn' --output text)"
    echo "provisioning runtime roles with $td"
    run_task "$td" '["scripts/db-provision-runtime-roles.ts"]'
    ;;
  rollout)
    api_td="$(register "$NAME-api")"
    worker_td="$(register "$NAME-worker")"
    # Keep the maintenance definition on the same image so the scheduler runs the deployed code.
    register "$NAME-maintenance" >/dev/null
    aws ecs update-service --cluster "$CLUSTER" --service "$NAME-api" --task-definition "$api_td" >/dev/null
    aws ecs update-service --cluster "$CLUSTER" --service "$NAME-worker" --task-definition "$worker_td" >/dev/null
    echo "rollout requested: api=$api_td worker=$worker_td"
    ;;
  smoke)
    : "${API_URL:?}"
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$NAME-api" "$NAME-worker"
    for path in /internal/live /internal/ready; do
      code="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL$path")"
      echo "$path → $code"; [[ "$code" == "200" ]]
    done
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/dev/identity/signin")"; echo "dev identity → $code"; [[ "$code" == "404" ]]
    code="$(curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer forged' "$API_URL/me")"; echo "forged bearer → $code"; [[ "$code" == "401" ]]
    echo "smoke OK"
    ;;
  *)
    echo "usage: $0 migrate|provision|rollout|smoke" >&2; exit 2 ;;
esac
