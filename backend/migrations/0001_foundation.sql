-- 0001_foundation — Slice 1 database foundation.
-- Authority: docs/24 §6 (database invariants), §9 (outbox/inbox), §4.1
-- (audit); engineering rules docs/25. Runs inside one transaction
-- (node-pg-migrate default). Reversible: the Down migration below is the
-- reviewed rollback and is permitted outside production only (docs/25 §9).
-- PostgreSQL version note: uses no PostgreSQL-18-only features; every
-- construct below is available on PostgreSQL 14+.

-- Up Migration

------------------------------------------------------------------------------
-- 1. Money conventions (docs/24 §6.1)
------------------------------------------------------------------------------

CREATE DOMAIN money_fils AS bigint
  CONSTRAINT ck_money_fils_non_negative CHECK (VALUE >= 0);
COMMENT ON DOMAIN money_fils IS
  'Money as integer fils (docs/24 §6.1). Explicitly signed ledger columns use bigint directly with their own constraints.';

CREATE DOMAIN currency_code AS char(3)
  CONSTRAINT ck_currency_code_aed_only CHECK (VALUE = 'AED');
COMMENT ON DOMAIN currency_code IS
  'ISO currency; AED-only at launch (docs/24 §6.1). Widening is a reviewed ALTER DOMAIN migration, not a code change.';

------------------------------------------------------------------------------
-- 2. Convention trigger functions (docs/24 §6.11, §6.13; docs/25 §4)
------------------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION set_updated_at() IS
  'Row-update timestamp convention: attach BEFORE UPDATE on tables with updated_at.';

CREATE FUNCTION bump_row_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION bump_row_version() IS
  'Optimistic-concurrency convention (docs/24 §6.11): version increments on every UPDATE; application CAS writes use WHERE version = $expected and never set version themselves.';

CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table "%" forbids %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;
COMMENT ON FUNCTION forbid_mutation() IS
  'Append-only enforcement (docs/24 §6.8): attach BEFORE UPDATE OR DELETE; corrections are compensating inserts.';

------------------------------------------------------------------------------
-- 3. Application database role (docs/24 §6.8 grants model)
-- Cluster-level and idempotent: the role may already exist when several
-- databases (dev + per-run test databases) share one local cluster.
------------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'himma_app') THEN
    CREATE ROLE himma_app NOLOGIN;
  END IF;
END
$$;

------------------------------------------------------------------------------
-- 4. audit_event — append-only audit trail (docs/24 §4.1)
------------------------------------------------------------------------------

CREATE TABLE audit_event (
  id            uuid        NOT NULL,
  actor_type    text        NOT NULL,
  actor_id      uuid,
  principal_context text,
  action        text        NOT NULL,
  entity_type   text        NOT NULL,
  entity_id     text        NOT NULL,
  before_digest text,
  after_digest  text,
  request_id    text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_audit_event PRIMARY KEY (id),
  CONSTRAINT ck_audit_event_actor_type CHECK (actor_type IN ('user', 'system'))
);
CREATE INDEX ix_audit_event_entity ON audit_event (entity_type, entity_id, occurred_at);
CREATE INDEX ix_audit_event_occurred_at ON audit_event (occurred_at);

CREATE TRIGGER trg_audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 5. outbox_event — transactional outbox (docs/24 §9.1–9.2, §10.13)
-- Rows are written in the same transaction as the state change that caused
-- them. Per-aggregate ordering via sequence_no; publishing bookkeeping is the
-- only permitted mutation (column-restricted grant below). Retention pruning
-- of published rows is a future elevated-role job, never the app role.
------------------------------------------------------------------------------

CREATE TABLE outbox_event (
  id               uuid        NOT NULL,
  aggregate_type   text        NOT NULL,
  aggregate_id     text        NOT NULL,
  sequence_no      bigint      NOT NULL,
  event_type       text        NOT NULL,
  schema_version   integer     NOT NULL DEFAULT 1,
  payload          jsonb       NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  publish_attempts integer     NOT NULL DEFAULT 0,
  CONSTRAINT pk_outbox_event PRIMARY KEY (id),
  CONSTRAINT uq_outbox_event_aggregate_seq UNIQUE (aggregate_type, aggregate_id, sequence_no),
  CONSTRAINT ck_outbox_event_sequence_no CHECK (sequence_no > 0),
  CONSTRAINT ck_outbox_event_schema_version CHECK (schema_version > 0),
  CONSTRAINT ck_outbox_event_publish_attempts CHECK (publish_attempts >= 0)
);
CREATE INDEX ix_outbox_event_unpublished ON outbox_event (occurred_at)
  WHERE published_at IS NULL;

------------------------------------------------------------------------------
-- 6. inbox_event — consumer deduplication (docs/24 §9.3)
-- Insert-only for the app role: at-least-once delivery becomes exactly-once
-- effects by recording processed event ids inside the consumer's transaction.
------------------------------------------------------------------------------

CREATE TABLE inbox_event (
  consumer     text        NOT NULL,
  event_id     uuid        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_inbox_event PRIMARY KEY (consumer, event_id)
);

------------------------------------------------------------------------------
-- 7. idempotency_key — shared idempotency store (docs/24 §6.6)
-- Also the reference implementation of the updated_at + version conventions.
------------------------------------------------------------------------------

CREATE TABLE idempotency_key (
  id               uuid        NOT NULL,
  principal_ref    text        NOT NULL,
  endpoint_scope   text        NOT NULL,
  idempotency_key  text        NOT NULL,
  request_digest   text,
  response_snapshot jsonb,
  status           text        NOT NULL DEFAULT 'in_progress',
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_idempotency_key PRIMARY KEY (id),
  CONSTRAINT uq_idempotency_key_scope UNIQUE (principal_ref, endpoint_scope, idempotency_key),
  CONSTRAINT ck_idempotency_key_status CHECK (status IN ('in_progress', 'completed')),
  CONSTRAINT ck_idempotency_key_version CHECK (version >= 1)
);

CREATE TRIGGER trg_idempotency_key_updated_at
  BEFORE UPDATE ON idempotency_key
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_idempotency_key_version
  BEFORE UPDATE ON idempotency_key
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

------------------------------------------------------------------------------
-- 8. Application-role grants (docs/24 §6.8: append-only via missing grants;
-- DB-role tests in the slice suite prove the denials)
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON audit_event TO himma_app;
GRANT SELECT, INSERT ON inbox_event TO himma_app;
GRANT SELECT, INSERT ON outbox_event TO himma_app;
GRANT UPDATE (published_at, publish_attempts) ON outbox_event TO himma_app;
GRANT SELECT, INSERT, UPDATE ON idempotency_key TO himma_app;
-- Deliberately no DELETE grant on any table above.

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops this migration's objects. The cluster-level role
-- himma_app is intentionally NOT dropped: other databases in the same local
-- cluster may reference it; role removal is a manual operation.

REVOKE ALL ON audit_event, outbox_event, inbox_event, idempotency_key FROM himma_app;
DROP TABLE idempotency_key;
DROP TABLE inbox_event;
DROP TABLE outbox_event;
DROP TABLE audit_event;
DROP FUNCTION forbid_mutation();
DROP FUNCTION bump_row_version();
DROP FUNCTION set_updated_at();
DROP DOMAIN currency_code;
DROP DOMAIN money_fils;
