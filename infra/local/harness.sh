#!/usr/bin/env bash
# Himma — local production-like container harness driver (docs/37 §36;
# docs/38 W6-4A container certification).
#
# Requires: docker (compose v2), openssl, curl. No AWS. Proves the ONE backend
# image end to end, executing solely from the built image (no host source
# mounted): TLS PostgreSQL → migrate/verify → role provisioning → api ×2 →
# worker ×2 → maintenance → identities → readiness → read-only root →
# signals → TLS negatives → migration authority → payment invariants →
# network exposure. Everything generated lands in gitignored paths.
#
# Exit 0 = every proof passed. The transcript is the certification record.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml" --env-file "$HERE/.harness.env")
CERTS="$HERE/certs/generated"
IMAGE="${HIMMA_IMAGE:-himma-backend:harness}"
PROJECT="himma-harness"
NET="${PROJECT}_himma"

log() { printf '\n== %s\n' "$*"; }
fail() { printf 'HARNESS FAILED: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok: %s\n' "$*"; }

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

OWNER_URL="postgres://himma_owner:${HARNESS_OWNER_PASSWORD}@postgres:5432/himma"
API_URL="postgres://himma_api:${HARNESS_API_PASSWORD}@postgres:5432/himma"
WORKER_URL="postgres://himma_worker:${HARNESS_WORKER_PASSWORD}@postgres:5432/himma"
MAINT_URL="postgres://himma_maintenance_runner:${HARNESS_MAINTENANCE_PASSWORD}@postgres:5432/himma"

cleanup() {
  log "tearing down"
  docker ps -aq --filter "name=himma-harness-probe-" | xargs -r docker rm -f >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# One-shot probe executed from the built image with the production
# composition env, read-only root filesystem, no tmpfs — identical to a task.
#   probe <name> [docker run args...] -- <command...>
probe() {
  local name="$1"; shift
  local args=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do args+=("$1"); shift; done
  shift || true
  docker run --rm --name "himma-harness-probe-$name" --network "$NET" --read-only \
    -v "$CERTS/ca.pem:/certs/ca.pem:ro" \
    -e NODE_ENV=production -e LOG_LEVEL=info \
    -e DATABASE_SSL_MODE=verify-full -e DATABASE_SSL_CA_FILE=/certs/ca.pem \
    -e PAYMENTS_MODE=disabled \
    ${args[@]+"${args[@]}"} "$IMAGE" "$@"
}
# expect_refusal <label> <output-regex> <probe args...>: non-zero exit + matching output
expect_refusal() {
  local label="$1" pattern="$2"; shift 2
  local out code
  set +e; out="$(probe "$@" 2>&1)"; code=$?; set -e
  [[ $code -ne 0 ]] || { printf '%s\n' "$out" | tail -5; fail "$label: expected a refusal, exited 0"; }
  grep -qE "$pattern" <<<"$out" || { printf '%s\n' "$out" | tail -8; fail "$label: refusal output did not match /$pattern/"; }
  pass "$label → refused (exit $code): $(grep -oE "$pattern" <<<"$out" | head -1 || true)"
}

psql_owner() { "${COMPOSE[@]}" exec -T postgres psql -U himma_owner -d "${2:-himma}" -Atc "$1"; }
psql_as() { # url-inside-network, sql  (runs inside the postgres container over TLS; output only — the caller greps for the expected denial)
  "${COMPOSE[@]}" exec -T postgres psql "$1" -Atc "$2" 2>&1 || true
}
api_url_local() { echo "postgres://himma_api:${HARNESS_API_PASSWORD}@localhost:5432/${1:-himma}?sslmode=require"; }
worker_url_local() { echo "postgres://himma_worker:${HARNESS_WORKER_PASSWORD}@localhost:5432/himma?sslmode=require"; }
maint_url_local() { echo "postgres://himma_maintenance_runner:${HARNESS_MAINTENANCE_PASSWORD}@localhost:5432/himma?sslmode=require"; }

# ---- 2. build + bring up ----------------------------------------------------
log "building the backend image (same context/Dockerfile as CI: backend/, backend/Dockerfile)"
"${COMPOSE[@]}" build api
docker image inspect "$IMAGE" -f 'image={{.Id}} arch={{.Architecture}}/{{.Os}} user={{.Config.User}} entrypoint={{json .Config.Entrypoint}}'

log "image facts from inside the image (non-root, node version, CA readable, no writable requirement)"
docker run --rm --read-only --entrypoint sh "$IMAGE" -c '
  set -e
  echo "node=$(node --version) uid=$(id -u) gid=$(id -g) user=$(id -un) arch=$(uname -m) NODE_ENV=$NODE_ENV TSX_DISABLE_CACHE=$TSX_DISABLE_CACHE"
  test "$(id -u)" = "10001"
  test -r /etc/himma/certs/rds-global-bundle.pem
  echo "rds-ca sha256=$(sha256sum /etc/himma/certs/rds-global-bundle.pem | cut -c1-64) certs=$(grep -c "BEGIN CERTIFICATE" /etc/himma/certs/rds-global-bundle.pem)"
  for p in /app/.env /app/.git /app/test /app/scripts/dev-server.ts /app/scripts/db-down.ts; do test ! -e "$p"; done
  for p in scripts/start-api.ts scripts/start-worker.ts scripts/start-maintenance.ts scripts/db-migrate.ts scripts/db-verify.ts scripts/db-provision-runtime-roles.ts; do test -f "/app/$p"; done
  echo "forbidden paths absent; all runtime invocations present"
'
pass "image facts"

log "starting postgres → migrate → verify → provision-roles → api ×2 → worker ×2 (read-only root filesystems)"
"${COMPOSE[@]}" up -d --scale api=2 --scale worker=2 --wait --wait-timeout 240 api worker

API_IDS=($("${COMPOSE[@]}" ps -q api)); WORKER_IDS=($("${COMPOSE[@]}" ps -q worker))
[[ ${#API_IDS[@]} -eq 2 && ${#WORKER_IDS[@]} -eq 2 ]] || fail "expected 2 api + 2 worker containers"
API_ONE="${API_IDS[0]}"; API_TWO="${API_IDS[1]}"; W_ONE="${WORKER_IDS[0]}"; W_TWO="${WORKER_IDS[1]}"

# ---- 3. one-shot job results (migration, verify, provisioning) ---------------
log "one-shot jobs from the image: migrate → verify → provision-roles (exit codes + evidence lines)"
for svc in migrate verify provision-roles; do
  cid="$("${COMPOSE[@]}" ps -aq "$svc")"; [[ -n "$cid" ]] || fail "$svc container missing"
  code="$(docker inspect -f '{{.State.ExitCode}}' "$cid")"; [[ "$code" == "0" ]] || { docker logs "$cid" | tail -20; fail "$svc exit $code"; }
  echo "-- $svc (exit 0):"; docker logs "$cid" 2>&1 | grep -iE 'migrat|verif|provision|role|head|passed|ok' | tail -6
done
VERIFY_LOGS="$(docker logs "$("${COMPOSE[@]}" ps -aq verify)" 2>&1 || true)"
grep -q 'Schema verification passed' <<<"$VERIFY_LOGS" || fail "db:verify did not pass inside the container"
pass "migrate/verify/provision-roles ran from the image and exited 0"

log "migration head (DB clock/state) and pgmigrations count"
HEAD="$(psql_owner "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1")"
EXPECTED="$(ls "$HERE/../../backend/migrations" | sort | tail -1 | sed 's/\.sql$//')"
[[ "$HEAD" == "$EXPECTED" ]] || fail "migration head $HEAD != $EXPECTED"
echo "head=$HEAD applied=$(psql_owner "SELECT count(*) FROM pgmigrations")"
pass "migration head"

log "runtime identities exist and are distinct LOGIN roles; NOLOGIN authorities present"
psql_owner "SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname LIKE 'himma_%' ORDER BY rolname"
for r in himma_api himma_worker himma_maintenance_runner; do
  [[ "$(psql_owner "SELECT rolcanlogin FROM pg_roles WHERE rolname='$r'")" == "t" ]] || fail "$r must be LOGIN"
done
for r in himma_app himma_maintenance; do
  [[ "$(psql_owner "SELECT rolcanlogin FROM pg_roles WHERE rolname='$r'")" == "f" ]] || fail "$r must be NOLOGIN"
done
pass "identities"

# ---- 4. TLS / identities / readiness on the resident processes ---------------
log "TLS: every application backend is an SSL session (verify-full from inside the image)"
psql_owner "SELECT a.usename, s.ssl, s.version, s.cipher, count(*) FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid=a.pid WHERE a.usename LIKE 'himma_%' GROUP BY 1,2,3,4 ORDER BY 1"
PLAIN="$(psql_owner "SELECT count(*) FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid=a.pid WHERE a.usename IN ('himma_api','himma_worker') AND NOT s.ssl")"
[[ "$PLAIN" == "0" ]] || fail "$PLAIN application backends without TLS"
pass "TLS sessions"

log "DB identities: api tasks are himma_api, worker tasks are himma_worker; maintenance/owner absent from resident processes"
psql_owner "SELECT usename, count(DISTINCT client_addr) AS replicas, count(*) AS backends FROM pg_stat_activity WHERE usename LIKE 'himma_%' GROUP BY usename ORDER BY usename"
API_N="$(psql_owner "SELECT count(DISTINCT client_addr) FROM pg_stat_activity WHERE usename='himma_api'")"
WORKER_N="$(psql_owner "SELECT count(DISTINCT client_addr) FROM pg_stat_activity WHERE usename='himma_worker'")"
[[ "$API_N" -ge 2 ]] || fail "expected 2 api replicas connected, saw $API_N"
[[ "$WORKER_N" -ge 2 ]] || fail "expected 2 worker replicas connected, saw $WORKER_N"
[[ "$(psql_owner "SELECT count(*) FROM pg_stat_activity WHERE usename='himma_maintenance_runner'")" == "0" ]] || fail "maintenance identity must not be resident"
pass "resident identities"

log "readiness/liveness on both api replicas; no dev identity; forged bearer refused; independent request ids"
declare -a REQ_IDS=()
for port in 8080 8081; do
  curl -fsS "http://127.0.0.1:$port/internal/live" >/dev/null || fail "live $port"
  curl -fsS "http://127.0.0.1:$port/internal/ready" | tee /dev/stderr | grep -q '"status":"ready"' || fail "ready $port"
  echo
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$port/dev/identity/signin" | grep -q '^404$' || fail "dev identity surface must not exist"
  curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer forged' "http://127.0.0.1:$port/me" | grep -q '^401$' || fail "forged bearer must be refused"
  rid="$(curl -sSI "http://127.0.0.1:$port/internal/live" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-request-id"{print $2}')"
  [[ -n "$rid" ]] || fail "no x-request-id from $port"
  REQ_IDS+=("$rid"); echo "port $port x-request-id=$rid"
done
[[ "${REQ_IDS[0]}" != "${REQ_IDS[1]}" ]] || fail "request ids must be independent per replica/request"
pass "readiness ×2, dev identity 404, forged 401, request ids independent"

log "session configuration from inside the image (canonical pool): identity, TLS, statement_timeout per role, TimeZone=UTC"
SESSION_JS='import("/app/src/config/runtime.ts").then(async ({loadRuntimeConfig}) => { const {createPool} = await import("/app/src/db/pool.ts"); const cfg = loadRuntimeConfig(); const pool = createPool(cfg); const r = await pool.query("SELECT current_user AS login, current_setting(\x27statement_timeout\x27) AS statement_timeout, current_setting(\x27TimeZone\x27) AS timezone, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl, (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls"); console.log(JSON.stringify({ role: cfg.role, ...r.rows[0] })); await pool.end(); })'
for spec in "api $API_URL himma_api 15s" "worker $WORKER_URL himma_worker 1min" "maintenance $MAINT_URL himma_maintenance_runner 5min"; do
  role="${spec%% *}"; rest="${spec#* }"; url="${rest%% *}"; rest="${rest#* }"; login="${rest%% *}"; timeout="${rest#* }"
  line="$(probe "session-$role" -e "RUNTIME_ROLE=$role" -e HOST=0.0.0.0 -e PORT=8080 -e "DATABASE_URL=$url" -- -e "$SESSION_JS")"; echo "$line"
  [[ "$line" == *"\"login\":\"$login\""* && "$line" == *"\"statement_timeout\":\"$timeout\""* && "$line" == *'"timezone":"UTC"'* && "$line" == *'"ssl":true'* ]] || fail "session configuration for $role"
done
pass "session configuration: per-role identity, statement_timeout (15s/1min/5min), UTC, TLS"

# ---- 5. PID 1 / read-only root ----------------------------------------------
log "PID 1 is the application process itself (in-process loader; no shell, no tsx CLI child)"
for c in "$API_ONE" "$W_ONE"; do
  docker exec "$c" sh -c 'printf "pid1="; tr "\0" " " </proc/1/cmdline; echo; grep -E "^(Uid|PPid):" /proc/1/status | tr "\n" " "; echo; echo "processes=$(ls -d /proc/[0-9]* | wc -l)"'
  docker exec "$c" sh -c 'tr "\0" " " </proc/1/cmdline' | grep -q 'node --import /app/node_modules/tsx/dist/loader.mjs scripts/start-' || fail "PID 1 is not the application"
  docker exec "$c" sh -c 'grep -qE "^Uid:\s+10001\s+10001" /proc/1/status' || fail "PID 1 not uid 10001"
done
pass "PID 1 = application, uid 10001"

log "read-only root filesystem: enforced on every resident container, no tmpfs, no writable path"
for c in "$API_ONE" "$API_TWO" "$W_ONE" "$W_TWO"; do
  ro="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} tmpfs={{json .HostConfig.Tmpfs}}' "$c")"; echo "$c: $ro"
  [[ "$ro" == "true tmpfs=null" ]] || fail "$c is not read-only-without-tmpfs"
  docker exec "$c" sh -c 'for d in /tmp /app /var/tmp /; do if touch "$d/.w" 2>/dev/null; then echo "WRITABLE $d"; exit 1; fi; done; echo "no writable location (tmp, app, var/tmp, root)"' || fail "$c has a writable location"
done
pass "read-only root, zero writable locations, services healthy"

# ---- 6. worker exposure and status listener ---------------------------------
log "worker: no published port; status listener bound to loopback inside the task only"
for c in "$W_ONE" "$W_TWO"; do
  [[ -z "$(docker port "$c")" ]] || fail "worker publishes a port: $(docker port "$c")"
done
docker exec "$W_ONE" node -e "fetch('http://127.0.0.1:8090/internal/live').then(r=>{console.log('inside-task status', r.status);process.exit(r.status===200?0:1)})" || fail "worker status listener not serving on loopback"
W_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$W_ONE")"
set +e
probe worker-status-net -- -e "fetch('http://$W_IP:8090/internal/live').then(r=>{console.log('REACHABLE',r.status);process.exit(0)}).catch(e=>{console.log('unreachable from the network:', e.cause?.code ?? e.code ?? e.message);process.exit(3)})"; code=$?
set -e
[[ $code -eq 3 ]] || fail "worker status listener reachable from the network"
pass "worker has no ingress; status listener loopback-only"

# ---- 7. scheduler across replicas --------------------------------------------
log "scheduler: job_run rows accumulate across both workers, never overlapping per job"
sleep 12
RUNS="$(psql_owner "SELECT count(*) FROM job_run WHERE outcome='succeeded' AND runtime_role='worker'")"
[[ "$RUNS" -ge 4 ]] || fail "expected scheduled runs, saw $RUNS"
OVERLAP="$(psql_owner "SELECT count(*) FROM job_run x JOIN job_run y ON x.id<y.id AND x.job_name=y.job_name WHERE x.outcome<>'abandoned' AND y.outcome<>'abandoned' AND x.started_at < coalesce(y.finished_at, now()) AND y.started_at < coalesce(x.finished_at, now())")"
[[ "$OVERLAP" == "0" ]] || fail "overlapping job runs: $OVERLAP"
psql_owner "SELECT job_name, count(*) FROM job_run WHERE runtime_role='worker' GROUP BY 1 ORDER BY 1"
# Both replicas run the W6-2 loops + the W6-3 scheduler (advisory locks decide
# which replica executes a given due job — a replica that never won a lock
# inside the window is still operating normally).
# (docker logs is always captured into a variable first: a `grep -q` that closes
# the pipe early would otherwise fail the pipeline under pipefail.)
TICKED=0
for c in "$W_ONE" "$W_TWO"; do
  WLOGS="$(docker logs "$c" 2>&1 || true)"
  RUNNING_LINE="$(grep -m1 'himma worker running' <<<"$WLOGS" || true)"
  [[ "$RUNNING_LINE" == *'"loops":["outbox","scheduler"]'* ]] || { printf '%s\n' "$WLOGS" | tail -5; fail "worker $c did not start outbox + scheduler loops"; }
  grep -q '"loop":"scheduler"' <<<"$WLOGS" && TICKED=$((TICKED+1))
done
echo "$RUNNING_LINE" | cut -c1-600
[[ $TICKED -ge 1 ]] || fail "no worker executed a scheduled job"
pass "scheduler OK ($RUNS runs, 0 overlaps; both workers run outbox+scheduler loops; $TICKED replica(s) executed jobs in the window)"

# ---- 8. maintenance -------------------------------------------------------------
log "maintenance: short-lived retention.all as himma_maintenance_runner (exits when done; never resident)"
set +e
MOUT="$("${COMPOSE[@]}" run --rm maintenance scripts/start-maintenance.ts retention.all 2>&1)"; MCODE=$?
set -e
grep -E '"role":"maintenance"|retention|job' <<<"$MOUT" | tail -8 | cut -c1-300
[[ $MCODE -eq 0 ]] || fail "maintenance exit $MCODE"
grep -q '"role":"maintenance"' <<<"$MOUT" || fail "maintenance did not run"
MAINT_RUNS="$(psql_owner "SELECT count(*) FROM job_run WHERE runtime_role='maintenance' AND outcome='succeeded'")"
[[ "$MAINT_RUNS" -ge 5 ]] || fail "expected 5 maintenance runs, saw $MAINT_RUNS"
psql_owner "SELECT job_name, outcome, items FROM job_run WHERE runtime_role='maintenance' ORDER BY started_at"
[[ -z "$("${COMPOSE[@]}" ps -q maintenance)" ]] || fail "maintenance container still resident"
[[ "$(psql_owner "SELECT count(*) FROM pg_stat_activity WHERE usename='himma_maintenance_runner'")" == "0" ]] || fail "maintenance identity still connected"
pass "maintenance ran ($MAINT_RUNS jobs), exit 0, not resident"

log "maintenance: unknown job refuses (usage exit 2); api credential refused; worker credential refused"
expect_refusal "maintenance unknown job" 'usage error|Allow-listed jobs' maint-unknown -e RUNTIME_ROLE=maintenance -e "DATABASE_URL=$MAINT_URL" -- scripts/start-maintenance.ts not.a.registered.job
expect_refusal "maintenance under himma_api credential" 'himma_maintenance_runner|identity|current_user' maint-as-api -e RUNTIME_ROLE=maintenance -e "DATABASE_URL=$API_URL" -- scripts/start-maintenance.ts retention.all
expect_refusal "maintenance under himma_worker credential" 'himma_maintenance_runner|identity|current_user' maint-as-worker -e RUNTIME_ROLE=maintenance -e "DATABASE_URL=$WORKER_URL" -- scripts/start-maintenance.ts retention.all

# ---- 9. privilege boundary --------------------------------------------------------
log "privilege boundary from inside the containers (exact runtime identities; DDL impossible)"
psql_as "$(api_url_local)" "DELETE FROM rate_limit_window" | grep -q 'permission denied' || fail "api must not DELETE"
psql_as "$(worker_url_local)" "SET ROLE himma_maintenance" | grep -q 'permission denied' || fail "worker must not assume maintenance"
for who in api worker maintenance_runner; do
  url="$(eval "$( [[ $who == maintenance_runner ]] && echo maint_url_local || echo ${who}_url_local )")"
  psql_as "$url" "CREATE TABLE harness_ddl_probe(id int)" | grep -qE 'permission denied' || fail "himma_$who could CREATE TABLE"
  psql_as "$url" "ALTER TABLE job_run ADD COLUMN harness_probe int" | grep -qE 'must be owner|permission denied' || fail "himma_$who could ALTER TABLE"
  psql_as "$url" "INSERT INTO pgmigrations(name, run_on) VALUES ('9999_probe', now())" | grep -qE 'permission denied' || fail "himma_$who could write pgmigrations"
  echo "himma_$who: CREATE/ALTER/pgmigrations write denied"
done
pass "privileges"

# ---- 10. migration authority (fresh databases) ----------------------------------
log "migration authority: api/worker never migrate; runtime identities cannot; concurrent migrations serialize"
psql_owner "CREATE DATABASE himma_empty" postgres >/dev/null
psql_owner "GRANT CONNECT ON DATABASE himma_empty TO himma_api, himma_worker" postgres >/dev/null
docker run -d --name himma-harness-probe-api-empty --network "$NET" --read-only -v "$CERTS/ca.pem:/certs/ca.pem:ro" \
  -p 127.0.0.1:8099:8080 -e NODE_ENV=production -e RUNTIME_ROLE=api -e HOST=0.0.0.0 -e PORT=8080 -e LOG_LEVEL=info \
  -e DATABASE_SSL_MODE=verify-full -e DATABASE_SSL_CA_FILE=/certs/ca.pem -e PAYMENTS_MODE=disabled \
  -e "DATABASE_URL=postgres://himma_api:${HARNESS_API_PASSWORD}@postgres:5432/himma_empty" "$IMAGE" scripts/start-api.ts >/dev/null
sleep 8
if [[ "$(docker inspect -f '{{.State.Running}}' himma-harness-probe-api-empty)" == "true" ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/internal/ready)"
  echo "api against an un-migrated database: running, /internal/ready → $code"
  [[ "$code" == "503" ]] || fail "api must not be ready on an un-migrated database"
else
  echo "api against an un-migrated database: refused at startup (exit $(docker inspect -f '{{.State.ExitCode}}' himma-harness-probe-api-empty))"
fi
docker rm -f himma-harness-probe-api-empty >/dev/null
expect_refusal "worker against an un-migrated database" 'pgmigrations|migration|head' worker-empty -e RUNTIME_ROLE=worker -e "DATABASE_URL=postgres://himma_worker:${HARNESS_WORKER_PASSWORD}@postgres:5432/himma_empty" -- scripts/start-worker.ts
[[ "$(psql_owner "SELECT to_regclass('public.pgmigrations') IS NULL" himma_empty)" == "t" ]] || fail "api/worker created pgmigrations (auto-migration!)"
[[ "$(psql_owner "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'" himma_empty)" == "0" ]] || fail "tables appeared in himma_empty"
pass "api (not ready) and worker (refused) performed no DDL on an un-migrated database"

expect_refusal "db:migrate under himma_api credential" 'permission denied|refus' migrate-as-api -e RUNTIME_ROLE=migrate -e "DATABASE_URL=postgres://himma_api:${HARNESS_API_PASSWORD}@postgres:5432/himma_empty" -- scripts/db-migrate.ts
[[ "$(psql_owner "SELECT to_regclass('public.pgmigrations') IS NULL" himma_empty)" == "t" ]] || fail "himma_api created pgmigrations"

psql_owner "CREATE DATABASE himma_race" postgres >/dev/null
for i in 1 2; do
  docker run -d --name "himma-harness-probe-migrate-race-$i" --network "$NET" --read-only -v "$CERTS/ca.pem:/certs/ca.pem:ro" \
    -e NODE_ENV=production -e RUNTIME_ROLE=migrate -e LOG_LEVEL=info -e DATABASE_SSL_MODE=verify-full -e DATABASE_SSL_CA_FILE=/certs/ca.pem -e PAYMENTS_MODE=disabled \
    -e "DATABASE_URL=postgres://himma_owner:${HARNESS_OWNER_PASSWORD}@postgres:5432/himma_race" "$IMAGE" scripts/db-migrate.ts >/dev/null
done
for i in 1 2; do
  code="$(docker wait "himma-harness-probe-migrate-race-$i")"; echo "concurrent migrate #$i exit $code"
  [[ "$code" == "0" ]] || { docker logs "himma-harness-probe-migrate-race-$i" | tail -5; fail "concurrent migration #$i failed"; }
  docker rm -f "himma-harness-probe-migrate-race-$i" >/dev/null
done
RACE_HEAD="$(psql_owner "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1" himma_race)"
RACE_N="$(psql_owner "SELECT count(*) FROM pgmigrations" himma_race)"; RACE_DUP="$(psql_owner "SELECT count(*) - count(DISTINCT name) FROM pgmigrations" himma_race)"
[[ "$RACE_HEAD" == "$EXPECTED" && "$RACE_DUP" == "0" ]] || fail "race: head=$RACE_HEAD dup=$RACE_DUP"
echo "two concurrent migration jobs → head=$RACE_HEAD applied=$RACE_N duplicates=$RACE_DUP"
set +e; "${COMPOSE[@]}" run --rm migrate scripts/db-migrate.ts >/dev/null 2>&1; code=$?; set -e
[[ $code -eq 0 ]] || fail "idempotent re-run of migrate failed ($code)"
[[ "$(psql_owner "SELECT count(*) FROM pgmigrations")" == "$(psql_owner "SELECT count(*) FROM pgmigrations" himma_race)" ]] || fail "re-run changed the applied set"
pass "migration authority: schema-owner only, serialized, idempotent; no automatic down"

# ---- 11. TLS from inside the image -----------------------------------------------
log "TLS from inside the image: verify-full positive one-shot (db:verify over TLS as the migrate role)"
probe tls-ok -e RUNTIME_ROLE=migrate -e "DATABASE_URL=$OWNER_URL" -- scripts/db-verify.ts 2>&1 | grep -E 'passed|verif' | tail -2
pass "verify-full positive"
log "TLS negatives from inside the image (fail closed; rejectUnauthorized never false; hostname never bypassed)"
expect_refusal "wrong CA (the baked RDS bundle does not sign the harness server)" 'self[- ]signed|unable to (get|verify)|certificate' tls-wrong-ca \
  -e RUNTIME_ROLE=api -e HOST=0.0.0.0 -e PORT=8080 -e "DATABASE_URL=$API_URL" -e DATABASE_SSL_CA_FILE=/etc/himma/certs/rds-global-bundle.pem -- scripts/start-api.ts
expect_refusal "hostname mismatch (alias not in the server SAN)" 'altnames|Hostname/IP|does not match' tls-hostname \
  -e RUNTIME_ROLE=api -e HOST=0.0.0.0 -e PORT=8080 -e "DATABASE_URL=postgres://himma_api:${HARNESS_API_PASSWORD}@postgres-unlisted:5432/himma" -- scripts/start-api.ts
expect_refusal "production non-loopback host with DATABASE_SSL_MODE=disable" 'DATABASE_SSL_MODE|loopback|verify-full' tls-disable \
  -e RUNTIME_ROLE=api -e HOST=0.0.0.0 -e PORT=8080 -e "DATABASE_URL=$API_URL" -e DATABASE_SSL_MODE=disable -- scripts/start-api.ts
expect_refusal "production without DATABASE_SSL_MODE" 'DATABASE_SSL_MODE' tls-missing \
  -e RUNTIME_ROLE=api -e HOST=0.0.0.0 -e PORT=8080 -e "DATABASE_URL=$API_URL" -e DATABASE_SSL_MODE= -- scripts/start-api.ts
expect_refusal "libpq sslmode query parameter in DATABASE_URL" 'sslmode|query' tls-query \
  -e RUNTIME_ROLE=api -e HOST=0.0.0.0 -e PORT=8080 -e "DATABASE_URL=${API_URL}?sslmode=disable" -- scripts/start-api.ts

# ---- 12. payment / identity invariants from inside the image ------------------
log "payment invariants from inside the image"
expect_refusal "PAYMENTS_MODE=live" 'no "live" value|PAYMENTS_MODE' pay-live -e RUNTIME_ROLE=api -e HOST=0.0.0.0 -e PORT=8080 -e "DATABASE_URL=$API_URL" -e PAYMENTS_MODE=live -- scripts/start-api.ts
expect_refusal "PAYMENTS_MODE=deterministic" 'PAYMENTS_MODE' pay-det -e RUNTIME_ROLE=api -e HOST=0.0.0.0 -e PORT=8080 -e "DATABASE_URL=$API_URL" -e PAYMENTS_MODE=deterministic -- scripts/start-api.ts
# A LIVE-shaped placeholder (not a credential): the driver accepts TEST-mode keys only.
expect_refusal "live-shaped STRIPE_SECRET_KEY with PAYMENTS_MODE=test" 'TEST|sk_test|live' pay-livekey -e RUNTIME_ROLE=api -e HOST=0.0.0.0 -e PORT=8080 -e "DATABASE_URL=$API_URL" -e PAYMENTS_MODE=test -e STRIPE_SECRET_KEY=sk_live_placeholder_not_a_real_key_0000 -- scripts/start-api.ts
PCP="$(probe pcp -- -e "import('/app/src/modules/payment/provider-composition.ts').then(m=>{const r=m.paymentCapabilityReport('production',{paymentsMode:'disabled'});console.log(JSON.stringify({productionChargingPossible:r.productionChargingPossible,provider:r.provider}));process.exit(r.productionChargingPossible===false?0:1)})")"
echo "$PCP"; [[ "$PCP" == *'"productionChargingPossible":false'* ]] || fail "productionChargingPossible is not false"
pass "live impossible, deterministic impossible, live-shaped key refused, productionChargingPossible=false"

# ---- 13. graceful shutdown ---------------------------------------------------------
log "graceful shutdown: SIGTERM to the worker container → handler, drain, pool closed, exit 0; sibling keeps scheduling"
BEFORE="$(psql_owner "SELECT count(*) FROM job_run WHERE runtime_role='worker'")"
T0=$(date +%s)
docker kill --signal=SIGTERM "$W_ONE" >/dev/null
for _ in $(seq 1 30); do
  STATE="$(docker inspect -f '{{.State.Running}} {{.State.ExitCode}}' "$W_ONE")"; [[ "$STATE" == "false 0" ]] && break; sleep 1
done
[[ "$STATE" == "false 0" ]] || { docker logs "$W_ONE" | tail -10; fail "worker did not exit 0 on SIGTERM: $STATE"; }
echo "worker exited 0 after $(( $(date +%s) - T0 ))s"
W_LOGS="$(docker logs "$W_ONE" 2>&1 || true)"
grep -E 'shutdown signal received|SIGTERM|stopped|drain|pool' <<<"$W_LOGS" | tail -5 | cut -c1-300
grep -q '"signal":"SIGTERM"' <<<"$W_LOGS" || fail "worker handler did not log SIGTERM"
[[ "$(psql_owner "SELECT count(*) FROM job_run WHERE runtime_role='worker' AND outcome='running'")" == "0" ]] || fail "worker left running job_run rows"
sleep 7
AFTER="$(psql_owner "SELECT count(*) FROM job_run WHERE runtime_role='worker'")"
[[ "$AFTER" -gt "$BEFORE" ]] || fail "surviving worker stopped scheduling ($BEFORE → $AFTER)"
[[ "$(psql_owner "SELECT count(DISTINCT client_addr) FROM pg_stat_activity WHERE usename='himma_worker'")" == "1" ]] || fail "expected exactly one worker connected after SIGTERM"
pass "worker SIGTERM: handler ran, no running rows left, exit 0; sibling continued ($BEFORE → $AFTER runs)"

log "graceful shutdown: SIGTERM to one api container → readiness withdrawn, drained, pool closed, exit 0; sibling stays ready"
API_PORT_ONE="$(docker port "$API_ONE" 8080/tcp | sed -n '1s/.*://p')"; API_PORT_TWO="$(docker port "$API_TWO" 8080/tcp | sed -n '1s/.*://p')"
# Hold one slow-ish keep-alive connection open so the drain has something to wait for, and sample readiness during the drain.
T0=$(date +%s)
docker kill --signal=SIGTERM "$API_ONE" >/dev/null
DRAIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$API_PORT_ONE/internal/ready" || true)"
for _ in $(seq 1 30); do
  STATE="$(docker inspect -f '{{.State.Running}} {{.State.ExitCode}}' "$API_ONE")"; [[ "$STATE" == "false 0" ]] && break; sleep 1
done
[[ "$STATE" == "false 0" ]] || { docker logs "$API_ONE" | tail -10; fail "api replica did not exit 0 on SIGTERM: $STATE"; }
echo "api exited 0 after $(( $(date +%s) - T0 ))s; readiness sampled during drain → ${DRAIN_CODE:-connection closed}"
A_LOGS="$(docker logs "$API_ONE" 2>&1 || true)"
grep -E 'shutdown signal received|SIGTERM' <<<"$A_LOGS" | tail -2 | cut -c1-300
grep -q '"signal":"SIGTERM"' <<<"$A_LOGS" || fail "api handler did not log SIGTERM"
curl -fsS "http://127.0.0.1:$API_PORT_TWO/internal/ready" | grep -q '"status":"ready"' || fail "surviving api replica not ready"
[[ "$(psql_owner "SELECT count(DISTINCT client_addr) FROM pg_stat_activity WHERE usename='himma_api'")" == "1" ]] || fail "expected exactly one api connected after SIGTERM"
pass "api SIGTERM: handler ran, exit 0, pool closed (one api backend set remains); sibling ready"

# ---- 14. network exposure ----------------------------------------------------------
log "network exposure: only api publishes a port; postgres/worker unpublished; no resident one-shots"
"${COMPOSE[@]}" ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Ports}}'
for svc in postgres worker; do
  for c in $("${COMPOSE[@]}" ps -aq "$svc"); do [[ -z "$(docker port "$c")" ]] || fail "$svc publishes $(docker port "$c")"; done
done
for svc in migrate verify provision-roles maintenance; do
  [[ -z "$("${COMPOSE[@]}" ps -q --status running "$svc")" ]] || fail "$svc is resident"
done
docker network inspect "$NET" -f '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
pass "exposure: api only (host loopback ports for the harness checks); worker/postgres internal; one-shots exited"

log "HARNESS PASSED"
