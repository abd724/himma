-- 0021_rate_limit_window — W6-1: the shared production security rate-limit
-- store (docs/37 §9; docs/23 §10.7; docs/36 IN-07).
--
-- The certified identity/staff limiter port (`RateLimiterStore.consume`)
-- gains its production implementation: a PostgreSQL fixed-window counter
-- shared by every API replica and durable across restarts — the certified
-- S6-2 `redemption_lookup_attempt` window-upsert pattern, generalized.
--
-- Row shape: one row per (limiter key, epoch-aligned window bucket). The
-- window bucket is computed IN SQL from the database clock at consume time
-- (one clock for all replicas). `hits` is incremented by a single atomic
-- `INSERT … ON CONFLICT … DO UPDATE` — concurrent consumers serialize on
-- the row and no increment is ever lost.
--
-- Privacy: limiter keys are sha256 DIGESTS plus a route dimension
-- (`rateLimitDigest`) — never raw emails, bearer tokens, or IPs. The CHECKs
-- structurally refuse oversized/whitespace key material.
--
-- Lifecycle: superseded window rows are inert (queries only ever touch the
-- CURRENT bucket) and are removed by the W6-3 retention job under the
-- dedicated maintenance authority — himma_app deliberately gets NO DELETE
-- (the repository-wide rule stands).

-- Up Migration

CREATE TABLE rate_limit_window (
  limiter_key  text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  CONSTRAINT pk_rate_limit_window PRIMARY KEY (limiter_key, window_start),
  CONSTRAINT ck_rate_limit_window_hits CHECK (hits >= 0),
  CONSTRAINT ck_rate_limit_window_key_shape
    CHECK (char_length(limiter_key) BETWEEN 1 AND 128 AND limiter_key ~ '^[!-~]+$')
);

COMMENT ON TABLE rate_limit_window IS
  'W6-1 shared production security rate limiting (docs/37 §9): fixed epoch-aligned windows keyed by pre-digested limiter keys; increments are atomic upserts on the database clock; cleaned by the W6-3 maintenance authority (no himma_app DELETE, by rule).';

-- Grants — SELECT/INSERT/UPDATE only; no DELETE anywhere (repository rule).
GRANT SELECT, INSERT, UPDATE ON rate_limit_window TO himma_app;

-- W6-1 readiness (docs/37 §7): the restricted runtime logins must be able
-- to READ the migration journal to compare the applied head against the
-- head their build requires. Read-only; the journal tables stay owned and
-- written exclusively by the migration authority. (Both tables exist by
-- the time this migration runs: the runner creates its journal before
-- applying, and the checksum table is ensured by the wrapper.)
GRANT SELECT ON pgmigrations TO himma_app;
GRANT SELECT ON migration_checksum TO himma_app;

-- Down Migration

REVOKE SELECT ON migration_checksum FROM himma_app;
REVOKE SELECT ON pgmigrations FROM himma_app;
DROP TABLE rate_limit_window;
