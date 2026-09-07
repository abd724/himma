#!/usr/bin/env bash
# Himma — local production-like container harness driver (docs/37 §36).
#
# Requires: docker (compose v2), openssl, curl. No AWS. Proves the ONE backend
# image end to end: TLS PostgreSQL → migrate/verify → role provisioning →
# api ×2 → worker ×2 → maintenance → identities → readiness → graceful
# shutdown. Everything generated lands in gitignored paths.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml" --env-file "$HERE/.harness.env")
CERTS="$HERE/certs/generated"

log() { printf '\n== %s\n' "$*"; }
fail() { printf 'HARNESS FAILED: %s\n' "$*" >&2; exit 1; }

gen_secret() { openssl rand -base64 30 | tr -d '/+=' | cut -c1-32; }

# ---- 1. certificates + passwords (never committed) -------------------------
log "generating harness CA/server certificates and passwords"
"$HERE/certs/generate-certs.sh"
if [[ ! -f "$HERE/.harness.env" ]]; then
  cat > "$HERE/.harness.env" <<EOF
HARNESS_OWNER_PASSWORD=$(gen_secret)
HARNESS_API_PASSWORD=$(gen_secret)
HARNESS_WORKER_PASSWORD=$(gen_secret)
HARNESS_MAINTENANCE_PASSWORD=$(gen_secret)
EOF
  chmod 600 "$HERE/.harness.env"
fi
# shellcheck disable=SC1090
source "$HERE/.harness.env"

cleanup() {
  log "tearing down"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---- 2. build + bring up ----------------------------------------------------
log "building the backend image"
"${COMPOSE[@]}" build api
log "starting postgres → migrate → verify → provision-roles → api ×2 → worker ×2"
"${COMPOSE[@]}" up -d --scale api=2 --scale worker=2 --wait --wait-timeout 180 api worker

psql_owner() { "${COMPOSE[@]}" exec -T postgres psql -U himma_owner -d himma -Atc "$1"; }

# ---- 3. checks --------------------------------------------------------------
log "migration head"
HEAD="$(psql_owner "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1")"
EXPECTED="$(ls "$HERE/../../backend/migrations" | sort | tail -1 | sed 's/\.sql$//')"
[[ "$HEAD" == "$EXPECTED" ]] || fail "migration head $HEAD != $EXPECTED"
echo "head OK: $HEAD"

log "TLS: every application backend is an SSL session"
PLAIN="$(psql_owner "SELECT count(*) FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid=a.pid WHERE a.usename IN ('himma_api','himma_worker') AND NOT s.ssl")"
[[ "$PLAIN" == "0" ]] || fail "$PLAIN application backends without TLS"
echo "TLS OK"

log "DB identities: api tasks are himma_api, worker tasks are himma_worker; maintenance/owner absent from resident processes"
psql_owner "SELECT usename, count(*) FROM pg_stat_activity WHERE usename LIKE 'himma_%' GROUP BY usename ORDER BY usename"
API_N="$(psql_owner "SELECT count(DISTINCT client_addr) FROM pg_stat_activity WHERE usename='himma_api'")"
WORKER_N="$(psql_owner "SELECT count(DISTINCT client_addr) FROM pg_stat_activity WHERE usename='himma_worker'")"
[[ "$API_N" -ge 2 ]] || fail "expected 2 api replicas connected, saw $API_N"
[[ "$WORKER_N" -ge 2 ]] || fail "expected 2 worker replicas connected, saw $WORKER_N"
MAINT_RESIDENT="$(psql_owner "SELECT count(*) FROM pg_stat_activity WHERE usename='himma_maintenance_runner'")"
[[ "$MAINT_RESIDENT" == "0" ]] || fail "maintenance identity must not be resident"

log "readiness/liveness on both api replicas"
for port in 8080 8081; do
  curl -fsS "http://127.0.0.1:$port/internal/live" >/dev/null || fail "live $port"
  curl -fsS "http://127.0.0.1:$port/internal/ready" | grep -q '"status":"ready"' || fail "ready $port"
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$port/dev/identity/signin" | grep -q '^404$' || fail "dev identity surface must not exist"
  curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer forged' "http://127.0.0.1:$port/me" | grep -q '^401$' || fail "forged bearer must be refused"
done
echo "readiness OK"

log "scheduler: job_run rows accumulate across both workers, never overlapping per job"
sleep 12
RUNS="$(psql_owner "SELECT count(*) FROM job_run WHERE outcome='succeeded' AND runtime_role='worker'")"
[[ "$RUNS" -ge 4 ]] || fail "expected scheduled runs, saw $RUNS"
OVERLAP="$(psql_owner "SELECT count(*) FROM job_run x JOIN job_run y ON x.id<y.id AND x.job_name=y.job_name WHERE x.outcome<>'abandoned' AND y.outcome<>'abandoned' AND x.started_at < coalesce(y.finished_at, now()) AND y.started_at < coalesce(x.finished_at, now())")"
[[ "$OVERLAP" == "0" ]] || fail "overlapping job runs: $OVERLAP"
echo "scheduler OK ($RUNS runs, 0 overlaps)"

log "maintenance: short-lived retention.all as himma_maintenance_runner"
"${COMPOSE[@]}" run --rm maintenance scripts/start-maintenance.ts retention.all | grep -q '"role":"maintenance"' || fail "maintenance did not run"
MAINT_RUNS="$(psql_owner "SELECT count(*) FROM job_run WHERE runtime_role='maintenance' AND outcome='succeeded'")"
[[ "$MAINT_RUNS" -ge 5 ]] || fail "expected 5 maintenance runs, saw $MAINT_RUNS"
echo "maintenance OK"

log "privilege boundary from inside the containers (exact runtime identities)"
"${COMPOSE[@]}" exec -T postgres psql "postgres://himma_api:${HARNESS_API_PASSWORD}@localhost:5432/himma?sslmode=require" -Atc "DELETE FROM rate_limit_window" 2>&1 | grep -q 'permission denied' || fail "api must not DELETE"
"${COMPOSE[@]}" exec -T postgres psql "postgres://himma_worker:${HARNESS_WORKER_PASSWORD}@localhost:5432/himma?sslmode=require" -Atc "SET ROLE himma_maintenance" 2>&1 | grep -q 'permission denied' || fail "worker must not assume maintenance"
echo "privileges OK"

log "graceful shutdown: SIGTERM one api replica → exit 0 while the other stays ready"
API_ONE="$("${COMPOSE[@]}" ps -q api | head -1)"
docker kill --signal=SIGTERM "$API_ONE" >/dev/null
for _ in $(seq 1 30); do
  STATE="$(docker inspect -f '{{.State.Running}} {{.State.ExitCode}}' "$API_ONE")"
  [[ "$STATE" == "false 0" ]] && break
  sleep 1
done
[[ "$STATE" == "false 0" ]] || fail "api replica did not exit 0 on SIGTERM: $STATE"
curl -fsS "http://127.0.0.1:8081/internal/ready" >/dev/null || curl -fsS "http://127.0.0.1:8080/internal/ready" >/dev/null || fail "surviving replica not ready"
echo "shutdown OK"

log "HARNESS PASSED"
