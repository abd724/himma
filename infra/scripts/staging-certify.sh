#!/usr/bin/env bash
# Himma — W6-4B staging certification driver (owner directive W6-4B §9–§16,
# §23, §24, §27). Runs against the REAL deployed staging environment with the
# operator's authenticated staging identity (preflight first; refuses
# production). Every proof reads AWS state or the deployed API; nothing here
# creates or destroys infrastructure. Exit 0 = every proof passed; the
# transcript is the evidence to attach to docs/38 / docs/36.
#
#   AWS_REGION=me-central-1 infra/scripts/staging-certify.sh
#
# Requires: aws CLI (authenticated), terraform (for outputs), curl, openssl,
# python3. The database proofs run INSIDE the deployed image as one-shot ECS
# tasks (never a local psql against RDS — RDS is private).
set -euo pipefail
ENV_NAME="${ENVIRONMENT:-staging}"
[[ "$ENV_NAME" == "staging" ]] || { echo "this driver certifies STAGING only (production needs its own owner-approved run)" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STACK="$ROOT/infra/terraform/stacks/himma"
NAME="himma-$ENV_NAME"; CLUSTER="$NAME"; LOG_GROUP="/himma/$ENV_NAME/backend"

log() { printf '\n== %s\n' "$*"; }
fail() { printf 'CERTIFICATION FAILED: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok: %s\n' "$*"; }

"$HERE/tf-preflight.sh" "$ENV_NAME" >/dev/null
outputs="$(terraform -chdir="$STACK" output -json)"
out() { printf '%s' "$outputs" | python3 -c 'import json,sys; o={k: v["value"] for k, v in json.load(sys.stdin).items()}; print(eval(sys.argv[1]))' "$1"; }
API_URL="$(out "o['api_url']")"; ACCOUNT="$(out "o['account_id']")"
EXPECTED_HEAD="$(ls "$ROOT/backend/migrations" | sort | tail -1 | sed 's/\.sql$//')"

# One-shot probe INSIDE the deployed image: run a task definition family with a command override, wait, return exit code + log tail.
# probe <family> <json-command-array> → prints logs; returns the container exit code
probe() {
  local family="$1" command="$2" td net task subnets sg assign code
  td="$(aws ecs describe-task-definition --task-definition "$NAME-$family" --query 'taskDefinition.taskDefinitionArn' --output text)"
  net="$(aws ecs describe-services --cluster "$CLUSTER" --services "$NAME-worker" --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)"
  subnets="$(printf '%s' "$net" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["subnets"]))')"
  sg="$(printf '%s' "$net" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["securityGroups"]))')"
  assign="$(printf '%s' "$net" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("assignPublicIp","DISABLED"))')"
  task="$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$td" \
    --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=$assign}" \
    --overrides "{\"containerOverrides\":[{\"name\":\"backend\",\"command\":$command}]}" --query 'tasks[0].taskArn' --output text)"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task"
  code="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)"
  local task_id="${task##*/}"
  sleep 5
  aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "$family/backend/$task_id" --query 'events[].message' --output text 2>/dev/null | tail -20 || true
  [[ "$code" == "0" ]]
}
SESSION_JS='import("/app/src/config/runtime.ts").then(async ({loadRuntimeConfig}) => { const {createPool} = await import("/app/src/db/pool.ts"); const cfg = loadRuntimeConfig(); const pool = createPool(cfg); const r = await pool.query("SELECT current_user AS login, current_setting(\x27statement_timeout\x27) AS statement_timeout, current_setting(\x27TimeZone\x27) AS timezone, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl, (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls, (SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1) AS head, version() AS server"); console.log("SESSION " + JSON.stringify({ role: cfg.role, sslMode: cfg.database.ssl?.mode, ...r.rows[0] })); await pool.end(); })'

# ---- 1. API over HTTPS ---------------------------------------------------------
log "API: HTTPS, redirect, certificate, liveness/readiness, no dev identity, forged bearer, independent request ids"
host="${API_URL#https://}"
[[ "$API_URL" == https://* ]] || fail "api_url is not https: $API_URL"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://$host/internal/live")"; [[ "$code" == "301" || "$code" == "308" ]] || fail "HTTP did not redirect ($code)"
curl -fsS --max-time 10 "$API_URL/internal/live" >/dev/null || fail "live"
ready="$(curl -fsS --max-time 10 "$API_URL/internal/ready")"; [[ "$ready" == '{"status":"ready"}' ]] || fail "ready body: $ready"
echo "$ready" | grep -qiE 'password|secret|postgres://' && fail "readiness leaks internals"
openssl s_client -connect "$host:443" -servername "$host" </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates | sed 's/^/cert: /'
openssl s_client -connect "$host:443" -servername "$host" -verify_return_error </dev/null >/dev/null 2>&1 || fail "certificate chain does not verify"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/dev/identity/signin")" == "404" ]] || fail "dev identity surface exists"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer forged' "$API_URL/me")" == "401" ]] || fail "forged bearer accepted"
ids="$(for _ in 1 2 3 4 5 6; do curl -sSI "$API_URL/internal/live" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-request-id"{print $2}'; done | sort -u | wc -l | tr -d ' ')"
[[ "$ids" == "6" ]] || fail "request ids not independent ($ids distinct of 6)"
pass "API HTTPS/live/ready/404/401/request-ids"

# ---- 2. ECS topology ------------------------------------------------------------
log "ECS: api behind the ALB, worker with no load balancer, maintenance/migrate are NOT services"
services="$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns' --output text | tr '\t' '\n' | sed 's#.*/##' | sort | tr '\n' ' ')"
echo "services: $services"
[[ "$services" == "$NAME-api $NAME-worker " ]] || fail "unexpected service set"
[[ "$(aws ecs describe-services --cluster "$CLUSTER" --services "$NAME-worker" --query 'length(services[0].loadBalancers)' --output text)" == "0" ]] || fail "worker has a load balancer"
for svc in api worker; do
  aws ecs describe-services --cluster "$CLUSTER" --services "$NAME-$svc" --query 'services[0].{desired:desiredCount,running:runningCount,taskDef:taskDefinition}' --output json
done
api_running="$(aws ecs describe-services --cluster "$CLUSTER" --services "$NAME-api" --query 'services[0].runningCount' --output text)"
worker_running="$(aws ecs describe-services --cluster "$CLUSTER" --services "$NAME-worker" --query 'services[0].runningCount' --output text)"
[[ "$api_running" -ge 2 && "$worker_running" -ge 2 ]] || fail "scale api and worker to 2 before certifying (api=$api_running worker=$worker_running)"
healthy="$(aws elbv2 describe-target-health --target-group-arn "$(aws elbv2 describe-target-groups --names "$NAME-api" --query 'TargetGroups[0].TargetGroupArn' --output text)" --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])' --output text)"
[[ "$healthy" -ge 2 ]] || fail "fewer than 2 healthy ALB targets ($healthy)"
pass "topology (api ×$api_running healthy targets $healthy, worker ×$worker_running, no maintenance/migrate service)"

# ---- 3. Database identities/TLS/head from INSIDE the deployed image ----------------
log "DB sessions from inside the deployed image: identity, TLS verify-full, statement_timeout, UTC, head"
for spec in "api himma_api 15s" "worker himma_worker 1min" "maintenance himma_maintenance_runner 5min"; do
  set -- $spec
  line="$(probe "$1" "[\"-e\", $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$SESSION_JS")]" | grep '^SESSION ' || true)"
  echo "$line"
  [[ "$line" == *"\"login\":\"$2\""* && "$line" == *"\"statement_timeout\":\"$3\""* && "$line" == *'"ssl":true'* && "$line" == *'"sslMode":"verify-full"'* && "$line" == *"\"head\":\"$EXPECTED_HEAD\""* && "$line" == *'"timezone":"UTC"'* ]] || fail "session facts for $1"
done
pass "identities himma_api/himma_worker/himma_maintenance_runner over TLS verify-full at head $EXPECTED_HEAD"

log "privilege boundary from inside the image (api/worker: no DDL, no maintenance role; runner bounded)"
DENY_JS='import("/app/src/config/runtime.ts").then(async ({loadRuntimeConfig}) => { const {createPool} = await import("/app/src/db/pool.ts"); const pool = createPool(loadRuntimeConfig()); const out = {}; for (const [k, q] of Object.entries({create: "CREATE TABLE himma_probe(id int)", alter: "ALTER TABLE job_run ADD COLUMN probe int", setMaint: "SET ROLE himma_maintenance", setApp: "SET ROLE himma_app", del: "DELETE FROM rate_limit_window", pgm: "INSERT INTO pgmigrations(name, run_on) VALUES (\x279999_probe\x27, now())"})) { try { await pool.query(q); out[k] = "ALLOWED"; } catch (e) { out[k] = /permission denied|must be owner/.test(e.message) ? "denied" : e.message; } } console.log("DENIALS " + JSON.stringify(out)); await pool.end(); })'
for fam in api worker maintenance; do
  line="$(probe "$fam" "[\"-e\", $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$DENY_JS")]" | grep '^DENIALS ' || true)"
  echo "$fam $line"
  [[ "$line" == *'"create":"denied"'* && "$line" == *'"alter":"denied"'* && "$line" == *'"del":"denied"'* && "$line" == *'"pgm":"denied"'* ]] || fail "$fam privilege boundary"
  if [[ "$fam" == "maintenance" ]]; then [[ "$line" == *'"setApp":"denied"'* ]] || fail "runner can assume himma_app"; else [[ "$line" == *'"setMaint":"denied"'* ]] || fail "$fam can assume maintenance"; fi
done
pass "privilege boundary"

# ---- 4. Migration and maintenance one-shots ----------------------------------------
log "migration task at head is a safe no-op (schema authority only); db:verify passes"
probe migrate '["scripts/db-migrate.ts"]' | tail -3 || fail "db-migrate task failed"
probe migrate '["scripts/db-verify.ts"]' | grep -q 'Schema verification passed' || fail "db-verify task"
pass "migration job"
log "maintenance task: retention.all succeeds and exits; unknown job refuses (exit 2)"
probe maintenance '["scripts/start-maintenance.ts","retention.all"]' | grep -q '"role":"maintenance"' || fail "retention.all"
set +e; probe maintenance '["scripts/start-maintenance.ts","not.a.job"]' >/dev/null; code=$?; set -e
[[ $code -eq 2 ]] || fail "unknown maintenance job exit $code (expected 2)"
sched="$(aws scheduler list-schedules --query 'Schedules[].Name' --output text)"; echo "schedules: $sched"
aws scheduler get-schedule --name "$NAME-retention-all" --query 'Target.EcsParameters.TaskDefinitionArn' --output text | grep -q "$NAME-maintenance" || fail "retention schedule target"
aws scheduler get-schedule --name "$NAME-retention-all" --query 'Target.Input' --output text | grep -q 'retention.all' || fail "schedule does not run retention.all"
pass "maintenance + EventBridge retention.all only"

# ---- 5. Worker logs (CloudWatch ingestion, structure, no secrets) --------------------
log "CloudWatch: worker running line with loops, scheduler ticks, api listening; no secret-shaped strings"
since=$(( ($(date +%s) - 1800) * 1000 ))
wl="$(aws logs filter-log-events --log-group-name "$LOG_GROUP" --log-stream-name-prefix worker --start-time "$since" --filter-pattern '"himma worker running"' --query 'events[].message' --output text | tail -1)"
echo "$wl" | cut -c1-300; [[ "$wl" == *'"loops":["outbox","scheduler"]'* ]] || fail "worker running line"
[[ "$(aws logs filter-log-events --log-group-name "$LOG_GROUP" --log-stream-name-prefix worker --start-time "$since" --filter-pattern '"scheduled job run"' --query 'length(events)' --output text)" -ge 1 ]] || fail "no scheduled job runs logged"
[[ "$(aws logs filter-log-events --log-group-name "$LOG_GROUP" --start-time "$since" --filter-pattern '?"sk_live_" ?"sk_test_" ?"AKIA" ?"password"' --query 'length(events)' --output text)" == "0" ]] || fail "secret-shaped string in logs"
pass "logs"

# ---- 6. RDS actual state ---------------------------------------------------------------
log "RDS actual state"
aws rds describe-db-instances --db-instance-identifier "$NAME-postgres" --query 'DBInstances[0].{engine:EngineVersion,public:PubliclyAccessible,encrypted:StorageEncrypted,multiAz:MultiAZ,backupDays:BackupRetentionPeriod,storage:AllocatedStorage,type:StorageType,class:DBInstanceClass,deletionProtection:DeletionProtection,monitoring:MonitoringInterval,pi:PerformanceInsightsEnabled}' --output json
[[ "$(aws rds describe-db-instances --db-instance-identifier "$NAME-postgres" --query 'DBInstances[0].PubliclyAccessible' --output text)" == "False" ]] || fail "RDS is public"
[[ "$(aws rds describe-db-instances --db-instance-identifier "$NAME-postgres" --query 'DBInstances[0].StorageEncrypted' --output text)" == "True" ]] || fail "RDS not encrypted"
pg="$(aws rds describe-db-instances --db-instance-identifier "$NAME-postgres" --query 'DBInstances[0].DBParameterGroups[0].DBParameterGroupName' --output text)"
[[ "$(aws rds describe-db-parameters --db-parameter-group-name "$pg" --query "Parameters[?ParameterName=='rds.force_ssl'].ParameterValue" --output text)" == "1" ]] || fail "rds.force_ssl != 1"
pass "RDS private, encrypted, TLS forced"

# ---- 7. Buckets / IAM / security groups -------------------------------------------------
"$HERE/aws-security-review.sh" "$ENV_NAME"

log "STAGING CERTIFICATION PASSED"
