-- 0011_verification_domain — W3-3 VerificationCase domain & evidence metadata foundation.
-- Authority: docs/31 §3/§4/§11 (W3-3); D-W3-1 (private evidence — metadata here,
-- binaries in W3-4's separate private store, never public URLs); D-W3-2
-- (three-layer decision feedback: internal note / machine reason code /
-- provider-safe message, structurally separated); docs/25 §9. Runs in one transaction.
--
-- Domain shape (docs/31 W3-3 record):
--   * verification_case          — ONE Himma verification review ROUND for an
--                                  organization. The organization keeps the
--                                  canonical business lifecycle; the case owns
--                                  only round-scoped review truth. Historical
--                                  rounds are immutable; at most one ACTIVE
--                                  round (open/in_review) exists per org.
--   * verification_case_requirement — the IMMUTABLE per-case snapshot of the
--                                  requirement policy that applied to THAT
--                                  round (D-W3-3 stays deferred: policy comes
--                                  from an injected provider, never schema).
--   * verification_evidence      — PRIVATE document METADATA (no binary, no
--                                  public URL — an opaque internal storage_ref
--                                  only). `stored` is reachable solely through
--                                  the trusted finalization boundary (W3-4).
--   * verification_decision      — append-only one-per-round outcome carrying
--                                  the three D-W3-2 layers in SEPARATE columns.
-- No DELETE is granted on any verification table: history is structural.

-- Up Migration

CREATE TABLE verification_case (
  id              uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  round           integer     NOT NULL,
  state           text        NOT NULL DEFAULT 'open',
  policy_version  text        NOT NULL,
  opened_by       uuid        NOT NULL,
  decided_at      timestamptz,
  superseded_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_verification_case PRIMARY KEY (id),
  CONSTRAINT fk_verification_case_organization
    FOREIGN KEY (organization_id) REFERENCES organization (id),
  CONSTRAINT fk_verification_case_opened_by
    FOREIGN KEY (opened_by) REFERENCES app_user (id),
  -- Composite target so child rows are organization-bound by construction
  -- (the branch/staff_membership pattern): cross-org children are
  -- structurally impossible, not merely checked in application code.
  CONSTRAINT uq_verification_case_id_organization UNIQUE (id, organization_id),
  -- One review round has ONE stable ordinal per organization.
  CONSTRAINT uq_verification_case_round UNIQUE (organization_id, round),
  -- The SMALLEST case state machine (docs/31 W3-3 §6): `open` = the round
  -- exists and evidence is being collected (readiness is COMPUTED, never a
  -- persisted state — see the readiness evaluator); `in_review` = a Himma
  -- reviewer owns the round; `decided` = the one final outcome is recorded
  -- (verification_decision row, same transaction); `superseded` = the round
  -- was closed WITHOUT a decision (e.g. org withdrawn/offboarded mid-round)
  -- so the active-round invariant can always be restored. No "ready" state
  -- exists on purpose — readiness is derived truth, not workflow state.
  CONSTRAINT ck_verification_case_state
    CHECK (state IN ('open', 'in_review', 'decided', 'superseded')),
  CONSTRAINT ck_verification_case_round CHECK (round >= 1),
  CONSTRAINT ck_verification_case_policy_version
    CHECK (char_length(policy_version) BETWEEN 1 AND 120),
  CONSTRAINT ck_verification_case_decided
    CHECK ((state = 'decided') = (decided_at IS NOT NULL)),
  CONSTRAINT ck_verification_case_superseded
    CHECK ((state = 'superseded') = (superseded_at IS NOT NULL)),
  CONSTRAINT ck_verification_case_version CHECK (version >= 1)
);
COMMENT ON TABLE verification_case IS
  'One authoritative Himma verification review ROUND for an organization (W3-3; docs/31). NOT a competing organization state machine: the organization row remains authoritative for the business lifecycle (draft…offboarded); the case owns round-scoped evidence/review truth only. Rounds are append-only history — a resubmission opens the NEXT round; prior rounds stay immutable. Readiness ("requirements satisfied enough for review") is COMPUTED from requirement snapshots + stored evidence and never persisted or equated with approval (readiness ≠ verified ≠ live).';
COMMENT ON COLUMN verification_case.policy_version IS
  'Reference of the requirement policy snapshotted into verification_case_requirement when the round opened (D-W3-3 deferred: policy is injected configuration, never schema). Later policy changes never rewrite historical rounds.';

-- At most ONE active (authoritative) round per organization — a database
-- invariant, not an application promise.
CREATE UNIQUE INDEX ux_verification_case_active
  ON verification_case (organization_id) WHERE state IN ('open', 'in_review');

CREATE INDEX ix_verification_case_org_round
  ON verification_case (organization_id, round DESC);

CREATE TRIGGER trg_verification_case_updated_at
  BEFORE UPDATE ON verification_case FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_verification_case_version
  BEFORE UPDATE ON verification_case FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_verification_case_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Terminal rounds are immutable history (audit substrate).
  IF OLD.state IN ('decided', 'superseded') THEN
    RAISE EXCEPTION 'verification_case % is % and immutable', OLD.id, OLD.state;
  END IF;
  -- Identity/snapshot columns never change after opening.
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
     OR NEW.round <> OLD.round OR NEW.policy_version <> OLD.policy_version
     OR NEW.opened_by <> OLD.opened_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'verification_case % identity/snapshot columns are immutable', OLD.id;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'open'      AND NEW.state IN ('in_review', 'superseded'))
           OR (OLD.state = 'in_review' AND NEW.state IN ('decided', 'superseded'))) THEN
    RAISE EXCEPTION 'illegal verification_case transition % -> % for %',
      OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_verification_case_transition
  BEFORE UPDATE ON verification_case FOR EACH ROW
  EXECUTE FUNCTION enforce_verification_case_transition();

CREATE TABLE verification_case_requirement (
  id              uuid        NOT NULL,
  case_id         uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  requirement_key text        NOT NULL,
  label_en        text        NOT NULL,
  description_en  text,
  required        boolean     NOT NULL,
  sort_hint       integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_verification_case_requirement PRIMARY KEY (id),
  -- Organization-bound through the case composite: a requirement can never
  -- cite another organization's case.
  CONSTRAINT fk_verification_case_requirement_case
    FOREIGN KEY (case_id, organization_id)
    REFERENCES verification_case (id, organization_id),
  -- Composite target for evidence: evidence can never cite a requirement
  -- from another case.
  CONSTRAINT uq_verification_case_requirement_id_case UNIQUE (id, case_id),
  CONSTRAINT uq_verification_case_requirement_key UNIQUE (case_id, requirement_key),
  CONSTRAINT ck_verification_case_requirement_key
    CHECK (requirement_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT ck_verification_case_requirement_label
    CHECK (char_length(label_en) BETWEEN 1 AND 200),
  CONSTRAINT ck_verification_case_requirement_description
    CHECK (description_en IS NULL OR char_length(description_en) <= 2000)
);
COMMENT ON TABLE verification_case_requirement IS
  'IMMUTABLE per-round snapshot of one evidence requirement as the policy defined it when the case opened (W3-3). Historical interpretation never depends on a mutable global label. Multiplicity ruling (docs/31 W3-3 §17): ONE current document per requirement — a policy genuinely needing several documents models them as separate requirement keys, never accidental duplicate rows.';

CREATE INDEX ix_verification_case_requirement_case
  ON verification_case_requirement (case_id, sort_hint, requirement_key);

CREATE FUNCTION enforce_verification_requirement_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'verification_case_requirement % is an immutable snapshot', OLD.id;
END $$;
CREATE TRIGGER trg_verification_case_requirement_immutable
  BEFORE UPDATE ON verification_case_requirement FOR EACH ROW
  EXECUTE FUNCTION enforce_verification_requirement_immutable();

CREATE TABLE verification_evidence (
  id                    uuid        NOT NULL,
  case_id               uuid        NOT NULL,
  requirement_id        uuid        NOT NULL,
  state                 text        NOT NULL DEFAULT 'pending_upload',
  original_filename     text        NOT NULL,
  declared_content_type text        NOT NULL,
  byte_size             bigint,
  sha256_digest         text,
  storage_ref           text,
  created_by            uuid        NOT NULL,
  stored_at             timestamptz,
  superseded_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_verification_evidence PRIMARY KEY (id),
  -- Case-bound requirement reference: evidence from another case (and via
  -- the case composite, another organization) is structurally impossible.
  CONSTRAINT fk_verification_evidence_requirement
    FOREIGN KEY (requirement_id, case_id)
    REFERENCES verification_case_requirement (id, case_id),
  CONSTRAINT fk_verification_evidence_created_by
    FOREIGN KEY (created_by) REFERENCES app_user (id),
  -- `pending_upload` = a registered metadata INTENT (W3-4 gives it a real
  -- upload path); `stored` = the trusted finalization boundary confirmed the
  -- complete private binary is safely stored (ONLY this state can satisfy
  -- readiness); `superseded` = replaced/retired, kept as auditable history
  -- (D-W3-6 retention stays deferred — nothing deletes).
  CONSTRAINT ck_verification_evidence_state
    CHECK (state IN ('pending_upload', 'stored', 'superseded')),
  CONSTRAINT ck_verification_evidence_filename
    CHECK (char_length(original_filename) BETWEEN 1 AND 300),
  CONSTRAINT ck_verification_evidence_content_type
    CHECK (declared_content_type ~ '^[a-z0-9!#$&^_.+-]{1,64}/[a-z0-9!#$&^_.+-]{1,128}$'),
  CONSTRAINT ck_verification_evidence_byte_size
    CHECK (byte_size IS NULL OR byte_size > 0),
  CONSTRAINT ck_verification_evidence_digest
    CHECK (sha256_digest IS NULL OR sha256_digest ~ '^[0-9a-f]{64}$'),
  -- An opaque INTERNAL locator only — never a browser-public URL (D-W3-1).
  CONSTRAINT ck_verification_evidence_storage_ref
    CHECK (storage_ref IS NULL OR (char_length(storage_ref) BETWEEN 1 AND 300
                                   AND storage_ref !~* '^https?://')),
  -- A row counts as stored ONLY with the full trusted storage metadata; a
  -- filename/content-type row alone can never satisfy a requirement.
  CONSTRAINT ck_verification_evidence_stored_complete
    CHECK (state <> 'stored'
           OR (byte_size IS NOT NULL AND sha256_digest IS NOT NULL
               AND storage_ref IS NOT NULL AND stored_at IS NOT NULL)),
  CONSTRAINT ck_verification_evidence_superseded
    CHECK ((state = 'superseded') = (superseded_at IS NOT NULL)),
  CONSTRAINT ck_verification_evidence_version CHECK (version >= 1)
);
COMMENT ON TABLE verification_evidence IS
  'PRIVATE verification document METADATA (W3-3; D-W3-1). No binary bytes and no public URL exist here or anywhere in PostgreSQL: storage_ref is an opaque internal key into the SEPARATE private store W3-4 implements, and every read path is server-mediated. Replacement is supersession, never overwrite — history stays auditable pending the deferred D-W3-6 retention ruling.';

-- The current/effective-evidence invariant: at most ONE non-superseded
-- evidence row per requirement — deterministic resolution by construction.
CREATE UNIQUE INDEX ux_verification_evidence_current
  ON verification_evidence (requirement_id) WHERE state <> 'superseded';

CREATE INDEX ix_verification_evidence_case
  ON verification_evidence (case_id, state);

CREATE TRIGGER trg_verification_evidence_updated_at
  BEFORE UPDATE ON verification_evidence FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_verification_evidence_version
  BEFORE UPDATE ON verification_evidence FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_verification_evidence_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'superseded' THEN
    RAISE EXCEPTION 'verification_evidence % is superseded and immutable', OLD.id;
  END IF;
  IF NEW.id <> OLD.id OR NEW.case_id <> OLD.case_id
     OR NEW.requirement_id <> OLD.requirement_id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.original_filename <> OLD.original_filename
     OR NEW.declared_content_type <> OLD.declared_content_type THEN
    RAISE EXCEPTION 'verification_evidence % identity/intent columns are immutable', OLD.id;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'pending_upload' AND NEW.state IN ('stored', 'superseded'))
           OR (OLD.state = 'stored'         AND NEW.state = 'superseded')) THEN
    RAISE EXCEPTION 'illegal verification_evidence transition % -> % for %',
      OLD.state, NEW.state, OLD.id;
  END IF;
  -- Trusted storage facts are write-once: set exactly when storing, then frozen.
  IF OLD.state = 'stored'
     AND (NEW.byte_size IS DISTINCT FROM OLD.byte_size
          OR NEW.sha256_digest IS DISTINCT FROM OLD.sha256_digest
          OR NEW.storage_ref IS DISTINCT FROM OLD.storage_ref
          OR NEW.stored_at IS DISTINCT FROM OLD.stored_at) THEN
    RAISE EXCEPTION 'verification_evidence % storage facts are immutable once stored', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_verification_evidence_transition
  BEFORE UPDATE ON verification_evidence FOR EACH ROW
  EXECUTE FUNCTION enforce_verification_evidence_transition();

CREATE TABLE verification_decision (
  id                    uuid        NOT NULL,
  case_id               uuid        NOT NULL,
  outcome               text        NOT NULL,
  reason_code           text,
  provider_safe_message text,
  internal_note         text,
  decided_by            uuid        NOT NULL,
  decided_at            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_verification_decision PRIMARY KEY (id),
  CONSTRAINT fk_verification_decision_case
    FOREIGN KEY (case_id) REFERENCES verification_case (id),
  CONSTRAINT fk_verification_decision_decided_by
    FOREIGN KEY (decided_by) REFERENCES app_user (id),
  -- One final outcome per round: a resubmission is the NEXT case, never a
  -- rewrite of this one.
  CONSTRAINT uq_verification_decision_case UNIQUE (case_id),
  -- Aligned with the organization machine's admin edges (in_review →
  -- verified | rejected): no parallel outcome vocabulary is invented.
  CONSTRAINT ck_verification_decision_outcome
    CHECK (outcome IN ('approved', 'rejected')),
  -- The MACHINE layer (D-W3-2): bounded slug, mandatory for rejections.
  CONSTRAINT ck_verification_decision_reason_code
    CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT ck_verification_decision_rejection_reason
    CHECK (outcome <> 'rejected' OR reason_code IS NOT NULL),
  CONSTRAINT ck_verification_decision_provider_safe_message
    CHECK (provider_safe_message IS NULL OR char_length(provider_safe_message) BETWEEN 1 AND 2000),
  CONSTRAINT ck_verification_decision_internal_note
    CHECK (internal_note IS NULL OR char_length(internal_note) <= 4000)
);
COMMENT ON TABLE verification_decision IS
  'Append-only verification outcome for one case/round (W3-3; D-W3-2). The three feedback layers live in NAMED separate columns so they can never be confused: reason_code (machine), provider_safe_message (the ONLY reviewer text ever intended for provider exposure — W3-8), internal_note (staff-only, structurally absent from every provider-safe projection, NEVER auto-exposed). Immutable: no UPDATE trigger path and no UPDATE/DELETE grant exist.';

CREATE INDEX ix_verification_decision_case ON verification_decision (case_id);

CREATE FUNCTION enforce_verification_decision_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'verification_decision % is append-only', OLD.id;
END $$;
CREATE TRIGGER trg_verification_decision_append_only
  BEFORE UPDATE ON verification_decision FOR EACH ROW
  EXECUTE FUNCTION enforce_verification_decision_append_only();

-- No DELETE on any verification table — history is structural, and the
-- deferred D-W3-6 retention ruling arrives as its own reviewed change.
GRANT SELECT, INSERT, UPDATE ON verification_case TO himma_app;
GRANT SELECT, INSERT ON verification_case_requirement TO himma_app;
GRANT SELECT, INSERT, UPDATE ON verification_evidence TO himma_app;
GRANT SELECT, INSERT ON verification_decision TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops every W3-3 object.

DROP TABLE verification_decision;
DROP TABLE verification_evidence;
DROP TABLE verification_case_requirement;
DROP TABLE verification_case;
DROP FUNCTION enforce_verification_decision_append_only();
DROP FUNCTION enforce_verification_evidence_transition();
DROP FUNCTION enforce_verification_requirement_immutable();
DROP FUNCTION enforce_verification_case_transition();
