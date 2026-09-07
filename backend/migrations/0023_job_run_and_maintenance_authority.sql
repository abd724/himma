-- 0023_job_run_and_maintenance_authority — W6-3: scheduler run bookkeeping
-- + the bounded maintenance (retention/repair) authority (docs/37 §18/§19/
-- §20/§28; docs/36 OP-01/OP-06).
--
-- Two concerns, both ADDITIVE, zero rewrites of existing rows:
--
-- 1. `job_run` — one row per scheduler/maintenance job execution: identity,
--    attempted start, completion, bounded outcome, bounded error code, item
--    count, machine facts, duration, and the background OPERATION run id.
--    `run_id` is worker/maintenance correlation ONLY — it is deliberately a
--    column of THIS table and never `audit_event.request_id` (the W6-2 owner
--    invariant: that column is request-origin correlation). Due-ness is
--    computed from `started_at` on the DATABASE clock (docs/37 §20): a run
--    that a process never finished (crash) stays `running` until the next
--    lock holder marks it `abandoned`.
--
-- 2. Maintenance authority — `himma_maintenance` is a NOLOGIN privilege role
--    (the 0001 `himma_app` precedent: cluster-global, grant-target only, no
--    secret) reached exclusively through the `himma_maintenance_runner`
--    LOGIN provisioned by the password-injected `db:provision-roles`
--    boundary (never a migration — logins carry secrets). It holds NO direct
--    DELETE on any table: every destructive retention statement is a
--    SECURITY DEFINER function whose predicate, horizon FLOOR, and batch
--    bound live in the database — the runner can invoke exactly the
--    enumerated bounded deletions and nothing else. `himma_api` and
--    `himma_worker` (members of `himma_app` only) cannot execute them
--    (EXECUTE revoked from PUBLIC), cannot SET ROLE into the role, and keep
--    DELETE on zero tables.
--
-- Retention scope here is ENGINEERING-ONLY (docs/37 §18): superseded
-- rate-limit windows, redemption-lookup windows, completed idempotency keys
-- past a long horizon, published outbox rows (+ their inbox dedup rows), and
-- finished job runs. Policy-gated data (audit_event, identity/staff security
-- records, verification evidence) has NO function and NO grant here —
-- docs/36 SE-05/VE-05 rule first (their owning slices add them).
--
-- Repair commands: `rebuild-search` (recompute the derived projection from
-- live truth) needs enumerated READ grants on the catalogue tables the
-- certified refresh joins plus INSERT/UPDATE on `program_search_document`
-- (a derived, non-authoritative projection; never DELETE). `unquarantine`
-- is a bounded function over the W6-2 relay columns only.

-- Up Migration

-------------------------------------------------------------------------------
-- 1. job_run — scheduler/maintenance execution record (docs/37 §20/§25)
-------------------------------------------------------------------------------

CREATE TABLE job_run (
  id            uuid        NOT NULL,
  job_name      text        NOT NULL,
  runtime_role  text        NOT NULL,
  run_id        uuid        NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  outcome       text        NOT NULL DEFAULT 'running',
  error_code    text,
  items         integer     NOT NULL DEFAULT 0,
  facts         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  duration_ms   integer,
  CONSTRAINT pk_job_run PRIMARY KEY (id),
  CONSTRAINT ck_job_run_name_shape
    CHECK (char_length(job_name) BETWEEN 1 AND 64 AND job_name ~ '^[a-z][a-z0-9.-]*$'),
  CONSTRAINT ck_job_run_runtime_role CHECK (runtime_role IN ('worker', 'maintenance')),
  CONSTRAINT ck_job_run_outcome
    CHECK (outcome IN ('running', 'succeeded', 'failed', 'abandoned')),
  CONSTRAINT ck_job_run_finished
    CHECK ((outcome = 'running') = (finished_at IS NULL)),
  CONSTRAINT ck_job_run_error_code_shape
    CHECK (error_code IS NULL OR error_code ~ '^[A-Za-z0-9:_.-]{1,64}$'),
  CONSTRAINT ck_job_run_items CHECK (items >= 0),
  CONSTRAINT ck_job_run_duration CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX ix_job_run_job_started ON job_run (job_name, started_at DESC);

COMMENT ON TABLE job_run IS
  'W6-3 scheduler/maintenance execution record (docs/37 §20): one row per attempted job run; due-ness derives from started_at on the database clock; a row left `running` by a dead process is marked `abandoned` by the next advisory-lock holder. run_id is background operation correlation ONLY — never audit_event.request_id.';
COMMENT ON COLUMN job_run.run_id IS
  'Background OPERATION run id (log correlation). Deliberately not audit_event.request_id.';
COMMENT ON COLUMN job_run.facts IS
  'Bounded machine facts (counts, ids, alert keys) — never payloads, messages, or secrets.';

-- The resident worker records its runs; it can never delete them (retention
-- is maintenance authority). UPDATE is column-restricted to the completion
-- fields — identity/start/role are immutable to the runtime.
GRANT SELECT, INSERT ON job_run TO himma_app;
GRANT UPDATE (finished_at, outcome, error_code, items, facts, duration_ms) ON job_run TO himma_app;

-------------------------------------------------------------------------------
-- 2. himma_maintenance — NOLOGIN bounded privilege role (docs/37 §19/§28)
-------------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'himma_maintenance') THEN
    CREATE ROLE himma_maintenance NOLOGIN;
  END IF;
END
$$;

-- Bookkeeping: the maintenance mode records its own runs (same shape).
GRANT SELECT, INSERT ON job_run TO himma_maintenance;
GRANT UPDATE (finished_at, outcome, error_code, items, facts, duration_ms) ON job_run TO himma_maintenance;

-- Startup migration-head assertion (docs/37 §6): read-only journal access.
GRANT SELECT ON pgmigrations TO himma_maintenance;
GRANT SELECT ON migration_checksum TO himma_maintenance;

-- Diagnostics only: the retention targets are READABLE for counting/
-- reporting; every deletion goes through the bounded functions below.
GRANT SELECT ON rate_limit_window TO himma_maintenance;
GRANT SELECT ON redemption_lookup_attempt TO himma_maintenance;
GRANT SELECT ON idempotency_key TO himma_maintenance;
GRANT SELECT ON outbox_event TO himma_maintenance;
GRANT SELECT ON inbox_event TO himma_maintenance;

-------------------------------------------------------------------------------
-- 3. Bounded retention functions — SECURITY DEFINER, EXECUTE only for the
--    maintenance role. Each: explicit predicate, horizon FLOOR (a shorter
--    horizon is REFUSED in the database, not merely in code), bounded batch,
--    oldest-first, SKIP LOCKED (never waits on live rows), returns the count
--    deleted. One call = one statement = one transaction: an interrupted
--    invocation loses nothing and resumes on the next call.
-------------------------------------------------------------------------------

CREATE FUNCTION maintenance_prune_rate_limit_windows(p_horizon interval, p_batch integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_horizon IS NULL OR p_horizon < interval '1 day' THEN
    RAISE EXCEPTION 'retention horizon for rate_limit_window must be at least 1 day'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'retention batch must be between 1 and 10000' USING ERRCODE = 'check_violation';
  END IF;
  WITH doomed AS (
    SELECT limiter_key, window_start FROM rate_limit_window
    WHERE window_start < now() - p_horizon
    ORDER BY window_start
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM rate_limit_window w
  USING doomed d
  WHERE w.limiter_key = d.limiter_key AND w.window_start = d.window_start;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

CREATE FUNCTION maintenance_prune_redemption_lookup_attempts(p_horizon interval, p_batch integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_horizon IS NULL OR p_horizon < interval '1 day' THEN
    RAISE EXCEPTION 'retention horizon for redemption_lookup_attempt must be at least 1 day'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'retention batch must be between 1 and 10000' USING ERRCODE = 'check_violation';
  END IF;
  WITH doomed AS (
    SELECT principal_ref, organization_id, window_start FROM redemption_lookup_attempt
    WHERE window_start < now() - p_horizon
    ORDER BY window_start
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM redemption_lookup_attempt a
  USING doomed d
  WHERE a.principal_ref = d.principal_ref
    AND a.organization_id = d.organization_id
    AND a.window_start = d.window_start;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Deleting a key re-enables execution of that request, so the horizon must
-- exceed any legitimate client retry window: FLOOR 30 days (docs/37 §18).
-- Only COMPLETED rows past the horizon; a row whose expires_at lies in the
-- future is kept regardless (the column is honored if ever set).
CREATE FUNCTION maintenance_prune_idempotency_keys(p_horizon interval, p_batch integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_horizon IS NULL OR p_horizon < interval '30 days' THEN
    RAISE EXCEPTION 'retention horizon for idempotency_key must be at least 30 days'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'retention batch must be between 1 and 10000' USING ERRCODE = 'check_violation';
  END IF;
  WITH doomed AS (
    SELECT id FROM idempotency_key
    WHERE status = 'completed'
      AND created_at < now() - p_horizon
      AND (expires_at IS NULL OR expires_at <= now())
    ORDER BY created_at
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM idempotency_key k
  USING doomed d
  WHERE k.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Published (delivered/unhandled) outbox rows past the horizon, together
-- with their inbox dedup rows (every consumer). Unpublished and quarantined
-- rows are NEVER touched — quarantine is durable visibility, never deletion.
CREATE FUNCTION maintenance_prune_published_outbox(p_horizon interval, p_batch integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_horizon IS NULL OR p_horizon < interval '7 days' THEN
    RAISE EXCEPTION 'retention horizon for published outbox_event must be at least 7 days'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'retention batch must be between 1 and 10000' USING ERRCODE = 'check_violation';
  END IF;
  -- One statement: the doomed set is materialized once; the inbox dedup
  -- rows and the outbox rows of exactly that set go together.
  WITH doomed AS (
    SELECT id FROM outbox_event
    WHERE published_at IS NOT NULL
      AND quarantined_at IS NULL
      AND published_at < now() - p_horizon
    ORDER BY published_at
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  ), gone_inbox AS (
    DELETE FROM inbox_event i
    USING doomed d
    WHERE i.event_id = d.id
  )
  DELETE FROM outbox_event o
  USING doomed d
  WHERE o.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Finished job runs past the horizon. The MOST RECENT run of every job is
-- always kept (due-ness, missed-run alerting, and the stuck-state alert
-- dedup read it); `running` rows are never pruned.
CREATE FUNCTION maintenance_prune_job_runs(p_horizon interval, p_batch integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_horizon IS NULL OR p_horizon < interval '7 days' THEN
    RAISE EXCEPTION 'retention horizon for job_run must be at least 7 days'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'retention batch must be between 1 and 10000' USING ERRCODE = 'check_violation';
  END IF;
  WITH latest AS (
    SELECT DISTINCT ON (job_name) id FROM job_run ORDER BY job_name, started_at DESC
  ), doomed AS (
    SELECT r.id FROM job_run r
    WHERE r.finished_at IS NOT NULL
      AND r.started_at < now() - p_horizon
      AND r.id NOT IN (SELECT id FROM latest)
    ORDER BY r.started_at
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM job_run j
  USING doomed d
  WHERE j.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Operator repair (docs/37 §22): return ONE quarantined row to the claimable
-- set after the cause is fixed. Attempts restart from zero so the row gets
-- the full backoff schedule again; the outcome code records the action.
CREATE FUNCTION maintenance_unquarantine_outbox(p_event_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'an outbox event id is required' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE outbox_event
  SET quarantined_at = NULL,
      next_attempt_at = NULL,
      publish_attempts = 0,
      last_outcome_code = 'unquarantined'
  WHERE id = p_event_id AND quarantined_at IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- EXECUTE is PUBLIC by default on new functions — revoke first, then grant
-- to the maintenance role ONLY. Neither himma_app nor any runtime login
-- can call these (proven live in the W6-3 suites).
REVOKE EXECUTE ON FUNCTION maintenance_prune_rate_limit_windows(interval, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION maintenance_prune_redemption_lookup_attempts(interval, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION maintenance_prune_idempotency_keys(interval, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION maintenance_prune_published_outbox(interval, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION maintenance_prune_job_runs(interval, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION maintenance_unquarantine_outbox(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION maintenance_prune_rate_limit_windows(interval, integer) TO himma_maintenance;
GRANT EXECUTE ON FUNCTION maintenance_prune_redemption_lookup_attempts(interval, integer) TO himma_maintenance;
GRANT EXECUTE ON FUNCTION maintenance_prune_idempotency_keys(interval, integer) TO himma_maintenance;
GRANT EXECUTE ON FUNCTION maintenance_prune_published_outbox(interval, integer) TO himma_maintenance;
GRANT EXECUTE ON FUNCTION maintenance_prune_job_runs(interval, integer) TO himma_maintenance;
GRANT EXECUTE ON FUNCTION maintenance_unquarantine_outbox(uuid) TO himma_maintenance;

-------------------------------------------------------------------------------
-- 4. Repair: rebuild-search — the certified recompute-from-live-truth
--    refresh (search-projection.ts) reads exactly these tables and upserts
--    the derived projection. Read-only on truth; INSERT/UPDATE on the
--    projection only (never DELETE — the 0010 himma_app shape).
-------------------------------------------------------------------------------

GRANT SELECT ON program, organization, organization_public_profile, activity_type, category,
                program_branch, branch, program_price_option, offer, program_search_document
  TO himma_maintenance;
GRANT INSERT, UPDATE ON program_search_document TO himma_maintenance;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9). himma_maintenance
-- is intentionally NOT dropped (cluster-global; the 0001 himma_app precedent);
-- every per-database grant it received here is revoked.

REVOKE INSERT, UPDATE ON program_search_document FROM himma_maintenance;
REVOKE SELECT ON program, organization, organization_public_profile, activity_type, category,
                 program_branch, branch, program_price_option, offer, program_search_document
  FROM himma_maintenance;

DROP FUNCTION maintenance_unquarantine_outbox(uuid);
DROP FUNCTION maintenance_prune_job_runs(interval, integer);
DROP FUNCTION maintenance_prune_published_outbox(interval, integer);
DROP FUNCTION maintenance_prune_idempotency_keys(interval, integer);
DROP FUNCTION maintenance_prune_redemption_lookup_attempts(interval, integer);
DROP FUNCTION maintenance_prune_rate_limit_windows(interval, integer);

REVOKE SELECT ON inbox_event FROM himma_maintenance;
REVOKE SELECT ON outbox_event FROM himma_maintenance;
REVOKE SELECT ON idempotency_key FROM himma_maintenance;
REVOKE SELECT ON redemption_lookup_attempt FROM himma_maintenance;
REVOKE SELECT ON rate_limit_window FROM himma_maintenance;
REVOKE SELECT ON migration_checksum FROM himma_maintenance;
REVOKE SELECT ON pgmigrations FROM himma_maintenance;
REVOKE ALL ON job_run FROM himma_maintenance;

REVOKE ALL ON job_run FROM himma_app;
DROP TABLE job_run;
