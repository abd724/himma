-- 0012_listing_moderation_feedback — W3-8 provider-facing correction/reason integration.
-- Authority: docs/31 §5/§11 (W3-8); D-W3-2 (three-layer decision feedback —
-- for LISTING request-changes the machine reason code and the provider-safe
-- message are both optional; internal reviewer notes DO NOT EXIST in this
-- domain and no column for them is created, so the table is provider-safe
-- BY CONSTRUCTION); docs/25 §9. Runs in one transaction.
--
-- Shape: one append-only row per catalogue-moderation `request_changes`
-- decision (the docs/28 listing machine's only provider-correction edge).
-- Before W3-8 the reason code lived ONLY in audit/outbox payloads — nothing
-- provider-readable existed (docs/31 §2.2 "no storage, no contract, no
-- read"). Approval/start-review write nothing here: their outcome is fully
-- carried by listing_state itself. History is structural (no UPDATE/DELETE
-- path); the provider projection reads the latest row per program.

-- Up Migration

CREATE TABLE listing_moderation_feedback (
  id                    uuid        NOT NULL,
  program_id            uuid        NOT NULL,
  reason_code           text,
  provider_safe_message text,
  decided_at            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_listing_moderation_feedback PRIMARY KEY (id),
  CONSTRAINT fk_listing_moderation_feedback_program
    FOREIGN KEY (program_id) REFERENCES program (id),
  -- The same machine vocabulary the moderation routes accept.
  CONSTRAINT ck_listing_moderation_feedback_reason_code
    CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9_]{1,64}$'),
  -- The same provider-safe text bound as verification_decision (D-W3-2).
  CONSTRAINT ck_listing_moderation_feedback_message
    CHECK (provider_safe_message IS NULL OR char_length(provider_safe_message) BETWEEN 1 AND 2000)
);

COMMENT ON TABLE listing_moderation_feedback IS
  'Append-only provider-facing feedback for one catalogue-moderation request_changes decision (W3-8; D-W3-2). Carries ONLY the two provider-visible layers (machine reason_code + reviewer-authored provider_safe_message, both optional on request-changes per D-W3-2) — no internal-note column exists, so provider projections are safe by construction. Written in the SAME transaction as the listing state edge; the provider-safe message never enters audit/outbox payloads. Immutable history: no UPDATE trigger path and no UPDATE/DELETE grant exist (retention stays D-W3-6).';

-- Latest-row lookup per program (deterministic tiebreak on id).
CREATE INDEX ix_listing_moderation_feedback_program
  ON listing_moderation_feedback (program_id, decided_at DESC, id DESC);

CREATE FUNCTION enforce_listing_moderation_feedback_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'listing_moderation_feedback % is append-only', OLD.id;
END $$;
CREATE TRIGGER trg_listing_moderation_feedback_append_only
  BEFORE UPDATE ON listing_moderation_feedback FOR EACH ROW
  EXECUTE FUNCTION enforce_listing_moderation_feedback_append_only();

-- No UPDATE/DELETE — history is structural (D-W3-6 retention deferred).
GRANT SELECT, INSERT ON listing_moderation_feedback TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops every W3-8 object.

DROP TABLE listing_moderation_feedback;
DROP FUNCTION enforce_listing_moderation_feedback_append_only();
