-- 0022_outbox_delivery_state — W6-2: durable delivery state for the
-- transactional outbox relay (docs/37 §10/§21/§22; docs/36 OP-03).
--
-- The outbox already carries the relay scaffolding the W6-0 reconciliation
-- found (`published_at`, `publish_attempts`, the unpublished partial index,
-- and the column-restricted UPDATE grant). W6-2 activates the relay and
-- needs exactly three more facts per row, all ADDITIVE and NULL for every
-- existing row (zero rewrites):
--
--   next_attempt_at   — server-controlled retry timing: a failed dispatch
--                       sets a future instant (exponential backoff computed
--                       in SQL from the database clock); claims skip rows
--                       whose retry is not yet due. Without it a failing row
--                       would be re-claimed on every poll (a hot loop).
--   last_outcome_code — bounded machine code of the LAST dispatch outcome
--                       (delivered / unhandledEventType / failed:<code> /
--                       quarantined:<code>) — durable diagnosability with no
--                       payloads, messages, or secrets.
--   quarantined_at    — durable poison marker: after the attempt ceiling
--                       the row leaves the claimable set WITHOUT being
--                       published or deleted (nothing is ever silently
--                       discarded); un-quarantine is an explicit operator
--                       action (W6-3 command), never automatic.
--
-- Claim semantics (implemented in src/worker/outbox-dispatcher.ts):
--   SELECT … WHERE published_at IS NULL AND quarantined_at IS NULL
--            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
--   ORDER BY occurred_at, id  FOR UPDATE SKIP LOCKED
-- The existing partial index `ix_outbox_event_unpublished (occurred_at)
-- WHERE published_at IS NULL` already serves that scan (quarantined rows
-- are a small filtered subset) — no new index is required at Tier 1.
--
-- Grants: the app role's outbox UPDATE stays COLUMN-RESTRICTED — the three
-- new bookkeeping columns join `published_at`/`publish_attempts`; payload,
-- type, aggregate, and sequence remain immutable to the runtime. No DELETE
-- anywhere (repository rule; retention is W6-3 maintenance authority).

-- Up Migration

ALTER TABLE outbox_event
  ADD COLUMN next_attempt_at   timestamptz,
  ADD COLUMN last_outcome_code text,
  ADD COLUMN quarantined_at    timestamptz;

-- A row is quarantined XOR published — never both.
ALTER TABLE outbox_event
  ADD CONSTRAINT ck_outbox_event_quarantine_exclusive
    CHECK (quarantined_at IS NULL OR published_at IS NULL);

-- Outcome codes are bounded machine facts, never free text.
ALTER TABLE outbox_event
  ADD CONSTRAINT ck_outbox_event_outcome_code_shape
    CHECK (last_outcome_code IS NULL OR last_outcome_code ~ '^[A-Za-z0-9:_.-]{1,64}$');

COMMENT ON COLUMN outbox_event.next_attempt_at IS
  'W6-2 relay: earliest instant the row may be re-claimed after a failed dispatch (server-side exponential backoff).';
COMMENT ON COLUMN outbox_event.last_outcome_code IS
  'W6-2 relay: bounded machine code of the last dispatch outcome (delivered | unhandledEventType | failed:<code> | quarantined:<code>).';
COMMENT ON COLUMN outbox_event.quarantined_at IS
  'W6-2 relay: durable poison marker — the row left the claimable set after the attempt ceiling; explicit operator un-quarantine only (W6-3).';

GRANT UPDATE (next_attempt_at, last_outcome_code, quarantined_at) ON outbox_event TO himma_app;

-- Down Migration

REVOKE UPDATE (next_attempt_at, last_outcome_code, quarantined_at) ON outbox_event FROM himma_app;
ALTER TABLE outbox_event DROP CONSTRAINT ck_outbox_event_outcome_code_shape;
ALTER TABLE outbox_event DROP CONSTRAINT ck_outbox_event_quarantine_exclusive;
ALTER TABLE outbox_event
  DROP COLUMN quarantined_at,
  DROP COLUMN last_outcome_code,
  DROP COLUMN next_attempt_at;
