-- 0004_mfa_and_step_up_foundation — B2-6A (docs/26 §5.8, §5.9, §8.8,
-- Amendment A1.1; docs/25 §9). Schema foundation ONLY: Cognito remains
-- authoritative for TOTP secrets and provider-side MFA configuration
-- (Amendment A1.1 supersedes the §5.8 pre-amendment secret-storage wording);
-- Himma PostgreSQL stores the minimum bookkeeping needed for business
-- enforcement, auditing, recovery, and session assurance. NO column in this
-- migration can hold a TOTP secret, QR contents, a raw recovery code, a
-- Cognito session token, access/refresh token material, a challenge secret,
-- or an encryption/hash key. Service flows, Cognito mediation, and routes
-- are B2-6B/B2-6C — none are implemented here.
--
-- Assurance semantics (binding for later sub-tasks): app_user.mfa_enrolled
-- and every row below are bookkeeping, NEVER proof that a request recently
-- completed MFA. Recent-MFA assurance is a runtime/session concern resolved
-- per request (B2-6B/C): a live session plus an unexpired, uninvalidated
-- grant/challenge outcome created by the verified service flow.
-- Runs in one transaction. No PostgreSQL-18-only features.

-- Up Migration

------------------------------------------------------------------------------
-- 0. login_session composite key target — lets MFA/step-up rows FK
--    (session, user) so a row can never bind another user's session.
------------------------------------------------------------------------------

ALTER TABLE login_session
  ADD CONSTRAINT uq_login_session_id_user UNIQUE (id, user_id);

------------------------------------------------------------------------------
-- 1. mfa_method — Cognito-managed TOTP enrollment mirror (docs/26 §8.8).
-- provider_managed is CHECK-forced true: a Himma-managed method would imply
-- secret storage, which is structurally forbidden in this slice. Lifecycle:
-- pending (expiring enrollment window) → active (verified at the provider)
-- → disabled | superseded (terminal). Activation is a single UPDATE, so the
-- future service can commit it atomically with Cognito verification success.
------------------------------------------------------------------------------

CREATE TABLE mfa_method (
  id                    uuid        NOT NULL,
  user_id               uuid        NOT NULL,
  kind                  text        NOT NULL,
  provider_managed      boolean     NOT NULL DEFAULT true,
  state                 text        NOT NULL DEFAULT 'pending',
  enrollment_expires_at timestamptz,
  confirmed_at          timestamptz,
  ended_at              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_mfa_method PRIMARY KEY (id),
  CONSTRAINT fk_mfa_method_user FOREIGN KEY (user_id) REFERENCES app_user (id),
  CONSTRAINT ck_mfa_method_kind CHECK (kind = 'totp'),
  CONSTRAINT ck_mfa_method_provider_managed CHECK (provider_managed),
  CONSTRAINT ck_mfa_method_state
    CHECK (state IN ('pending', 'active', 'disabled', 'superseded')),
  CONSTRAINT ck_mfa_method_pending_expiry
    CHECK (state <> 'pending' OR enrollment_expires_at IS NOT NULL),
  CONSTRAINT ck_mfa_method_pending_unconfirmed
    CHECK (state <> 'pending' OR confirmed_at IS NULL),
  CONSTRAINT ck_mfa_method_active_confirmed
    CHECK (state <> 'active' OR confirmed_at IS NOT NULL),
  CONSTRAINT ck_mfa_method_ended
    CHECK ((state IN ('disabled', 'superseded')) = (ended_at IS NOT NULL)),
  CONSTRAINT ck_mfa_method_version CHECK (version >= 1)
);
COMMENT ON TABLE mfa_method IS
  'Cognito-managed TOTP enrollment mirror (docs/26 §8.8, A1.1) — status bookkeeping only; the TOTP secret, QR contents, and provider MFA configuration live in Cognito and are NEVER stored. Never by itself proof of recent MFA. Retention: follows the account lifecycle; pseudonymization-ready (no PII beyond the user FK).';

CREATE UNIQUE INDEX uq_mfa_method_active ON mfa_method (user_id) WHERE state = 'active';
CREATE UNIQUE INDEX uq_mfa_method_pending ON mfa_method (user_id) WHERE state = 'pending';
CREATE INDEX ix_mfa_method_user ON mfa_method (user_id, state);

CREATE TRIGGER trg_mfa_method_updated_at
  BEFORE UPDATE ON mfa_method FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_mfa_method_version
  BEFORE UPDATE ON mfa_method FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_mfa_method_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind
     OR NEW.provider_managed <> OLD.provider_managed
     OR NEW.created_at <> OLD.created_at
     OR NEW.enrollment_expires_at IS DISTINCT FROM OLD.enrollment_expires_at THEN
    RAISE EXCEPTION 'mfa_method identity/provenance columns are immutable (method %)', OLD.id;
  END IF;
  IF OLD.state IN ('disabled', 'superseded') THEN
    RAISE EXCEPTION 'mfa_method % is % and permanently immutable', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'pending' AND NEW.state IN ('active', 'disabled', 'superseded'))
           OR (OLD.state = 'active' AND NEW.state IN ('disabled', 'superseded'))) THEN
    RAISE EXCEPTION 'invalid mfa_method transition % -> % (method %)',
      OLD.state, NEW.state, OLD.id;
  END IF;
  IF OLD.state = 'pending' AND NEW.state = 'active'
     AND now() > OLD.enrollment_expires_at THEN
    RAISE EXCEPTION 'mfa_method % enrollment window expired; activation refused', OLD.id;
  END IF;
  IF OLD.confirmed_at IS NOT NULL
     AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION 'mfa_method.confirmed_at is write-once (method %)', OLD.id;
  END IF;
  IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL
     AND NOT (OLD.state = 'pending' AND NEW.state = 'active') THEN
    RAISE EXCEPTION 'mfa_method.confirmed_at may only be set by the pending -> active transition (method %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_mfa_method_transition() IS
  'B2-6A: immutable provenance, pending→active|disabled|superseded and active→disabled|superseded only, terminal states frozen, no activation past the enrollment window, write-once confirmation.';

CREATE TRIGGER trg_mfa_method_transition
  BEFORE UPDATE ON mfa_method FOR EACH ROW
  EXECUTE FUNCTION enforce_mfa_method_transition();

------------------------------------------------------------------------------
-- 2. app_user.mfa_enrolled mirror — trigger-maintained BOTH ways so neither
--    service omission nor direct writes can desynchronize it (docs/26 §8.1):
--    every mfa_method change recomputes it, and app_user refuses any value
--    that disagrees with the active-method truth.
------------------------------------------------------------------------------

CREATE FUNCTION maintain_mfa_enrolled_mirror() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  enrolled boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM mfa_method WHERE user_id = NEW.user_id AND state = 'active'
  ) INTO enrolled;
  UPDATE app_user SET mfa_enrolled = enrolled
  WHERE id = NEW.user_id AND mfa_enrolled IS DISTINCT FROM enrolled;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION maintain_mfa_enrolled_mirror() IS
  'B2-6A: app_user.mfa_enrolled always equals "user has an active mfa_method". Enrollment bookkeeping only — never proof of recent MFA (that is runtime session assurance, B2-6B/C).';

CREATE TRIGGER trg_mfa_method_mirror
  AFTER INSERT OR UPDATE ON mfa_method FOR EACH ROW
  EXECUTE FUNCTION maintain_mfa_enrolled_mirror();

CREATE FUNCTION enforce_mfa_enrolled_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  enrolled boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM mfa_method WHERE user_id = NEW.id AND state = 'active'
  ) INTO enrolled;
  IF NEW.mfa_enrolled IS DISTINCT FROM enrolled THEN
    RAISE EXCEPTION
      'app_user.mfa_enrolled mirrors active mfa_method rows and cannot be set directly (user %)',
      NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_mfa_enrolled_consistency() IS
  'B2-6A: refuses any direct write that would make the mfa_enrolled mirror disagree with the active-method truth.';

CREATE TRIGGER trg_app_user_mfa_enrolled_consistency
  BEFORE INSERT OR UPDATE OF mfa_enrolled ON app_user FOR EACH ROW
  EXECUTE FUNCTION enforce_mfa_enrolled_consistency();

------------------------------------------------------------------------------
-- 3. mfa_recovery_code_batch — Himma-held recovery-code batches (docs/26
--    §5.9, §8.8 ★). Codes are generated and shown once by the FUTURE service
--    task; the database holds only versioned digests. digest_scheme +
--    pepper_version record HOW digests were produced; the pepper itself
--    lives in the secret store and is never persisted here.
------------------------------------------------------------------------------

CREATE TABLE mfa_recovery_code_batch (
  id             uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  state          text        NOT NULL DEFAULT 'active',
  code_count     integer     NOT NULL,
  digest_scheme  text        NOT NULL,
  pepper_version integer     NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_mfa_recovery_code_batch PRIMARY KEY (id),
  CONSTRAINT fk_mfa_recovery_code_batch_user FOREIGN KEY (user_id) REFERENCES app_user (id),
  CONSTRAINT uq_mfa_recovery_code_batch_id_user UNIQUE (id, user_id),
  CONSTRAINT ck_mfa_recovery_code_batch_state
    CHECK (state IN ('active', 'superseded', 'invalidated')),
  CONSTRAINT ck_mfa_recovery_code_batch_count CHECK (code_count > 0),
  CONSTRAINT ck_mfa_recovery_code_batch_scheme CHECK (digest_scheme IN ('hmac_sha256')),
  CONSTRAINT ck_mfa_recovery_code_batch_pepper CHECK (pepper_version >= 1),
  CONSTRAINT ck_mfa_recovery_code_batch_ended
    CHECK ((state = 'active') = (ended_at IS NULL)),
  CONSTRAINT ck_mfa_recovery_code_batch_version CHECK (version >= 1)
);
COMMENT ON TABLE mfa_recovery_code_batch IS
  'One issuance of single-use recovery codes (docs/26 §5.9; count is configuration, docs/26 §14.C). Digest scheme + pepper VERSION only — the pepper/key value lives in the secret store, never in PostgreSQL. Retention: follows the account lifecycle; contains no PII beyond the user FK.';

CREATE UNIQUE INDEX uq_mfa_recovery_code_batch_active
  ON mfa_recovery_code_batch (user_id) WHERE state = 'active';

CREATE TRIGGER trg_mfa_recovery_code_batch_updated_at
  BEFORE UPDATE ON mfa_recovery_code_batch FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_mfa_recovery_code_batch_version
  BEFORE UPDATE ON mfa_recovery_code_batch FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_mfa_recovery_batch_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
     OR NEW.code_count <> OLD.code_count
     OR NEW.digest_scheme <> OLD.digest_scheme
     OR NEW.pepper_version <> OLD.pepper_version
     OR NEW.issued_at <> OLD.issued_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'mfa_recovery_code_batch identity/digest metadata is immutable (batch %)', OLD.id;
  END IF;
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'mfa_recovery_code_batch % is % and permanently immutable', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state AND NEW.state NOT IN ('superseded', 'invalidated') THEN
    RAISE EXCEPTION 'invalid mfa_recovery_code_batch transition % -> % (batch %)',
      OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_mfa_recovery_batch_transition() IS
  'B2-6A: batch metadata immutable; active → superseded | invalidated only; terminal batches frozen (no reactivation).';

CREATE TRIGGER trg_mfa_recovery_code_batch_transition
  BEFORE UPDATE ON mfa_recovery_code_batch FOR EACH ROW
  EXECUTE FUNCTION enforce_mfa_recovery_batch_transition();

------------------------------------------------------------------------------
-- 4. mfa_recovery_code — individually digested codes; single-use by CAS +
--    write-once triggers; the original code is unrecoverable from the digest.
------------------------------------------------------------------------------

CREATE TABLE mfa_recovery_code (
  id             uuid        NOT NULL,
  batch_id       uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  code_hash      text        NOT NULL,
  consumed_at    timestamptz,
  invalidated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_mfa_recovery_code PRIMARY KEY (id),
  CONSTRAINT fk_mfa_recovery_code_batch FOREIGN KEY (batch_id, user_id)
    REFERENCES mfa_recovery_code_batch (id, user_id),
  CONSTRAINT uq_mfa_recovery_code_hash UNIQUE (code_hash),
  CONSTRAINT ck_mfa_recovery_code_single_outcome
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL),
  CONSTRAINT ck_mfa_recovery_code_version CHECK (version >= 1)
);
COMMENT ON TABLE mfa_recovery_code IS
  'Versioned digest of ONE single-use recovery code (docs/26 §8.8 ★). The raw code exists only transiently in the future issuing service and is never stored, logged, or reconstructible. Consumption is CAS on consumed_at; either outcome (consumed/invalidated) is final and exclusive.';

CREATE INDEX ix_mfa_recovery_code_batch ON mfa_recovery_code (batch_id);

CREATE TRIGGER trg_mfa_recovery_code_updated_at
  BEFORE UPDATE ON mfa_recovery_code FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_mfa_recovery_code_version
  BEFORE UPDATE ON mfa_recovery_code FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_mfa_recovery_code_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.batch_id <> OLD.batch_id
     OR NEW.user_id <> OLD.user_id
     OR NEW.code_hash <> OLD.code_hash
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'mfa_recovery_code identity and digest are immutable (code %)', OLD.id;
  END IF;
  IF OLD.consumed_at IS NOT NULL
     AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'mfa_recovery_code.consumed_at is write-once; consumed codes cannot be restored or re-consumed (code %)', OLD.id;
  END IF;
  IF OLD.invalidated_at IS NOT NULL
     AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at THEN
    RAISE EXCEPTION 'mfa_recovery_code.invalidated_at is write-once; invalidated codes cannot be restored (code %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_mfa_recovery_code_transition() IS
  'B2-6A: digest and ownership immutable; consumed_at/invalidated_at write-once (with the single-outcome CHECK this makes every code single-use and unrestorable).';

CREATE TRIGGER trg_mfa_recovery_code_transition
  BEFORE UPDATE ON mfa_recovery_code FOR EACH ROW
  EXECUTE FUNCTION enforce_mfa_recovery_code_transition();

CREATE FUNCTION cascade_recovery_batch_invalidation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mfa_recovery_code SET invalidated_at = now()
  WHERE batch_id = NEW.id AND consumed_at IS NULL AND invalidated_at IS NULL;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION cascade_recovery_batch_invalidation() IS
  'B2-6A: when a batch leaves active (regeneration/invalidation), every remaining unconsumed code is invalidated in the same transaction — service omission cannot leave stale usable codes.';

CREATE TRIGGER trg_mfa_recovery_code_batch_cascade
  AFTER UPDATE ON mfa_recovery_code_batch FOR EACH ROW
  WHEN (OLD.state = 'active' AND NEW.state <> 'active')
  EXECUTE FUNCTION cascade_recovery_batch_invalidation();

------------------------------------------------------------------------------
-- 5. mfa_challenge — MFA challenge lifecycle bookkeeping (docs/26 §8.6
--    pattern, extended for MFA): rate-limit anchoring, single-use
--    sequencing, and audit. NO provider challenge material is stored —
--    Cognito's challenge session travels client↔adapter only (B2-6B).
--    Login-purpose challenges precede any Himma session (mfaRequired
--    continuation), so the session binding is required only for step-up.
------------------------------------------------------------------------------

CREATE TABLE mfa_challenge (
  id               uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  login_session_id uuid,
  purpose          text        NOT NULL,
  state            text        NOT NULL DEFAULT 'pending',
  attempt_count    integer     NOT NULL DEFAULT 0,
  expires_at       timestamptz NOT NULL,
  passed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_mfa_challenge PRIMARY KEY (id),
  CONSTRAINT fk_mfa_challenge_user FOREIGN KEY (user_id) REFERENCES app_user (id),
  CONSTRAINT fk_mfa_challenge_session FOREIGN KEY (login_session_id, user_id)
    REFERENCES login_session (id, user_id),
  CONSTRAINT ck_mfa_challenge_purpose CHECK (purpose IN ('login', 'step_up')),
  CONSTRAINT ck_mfa_challenge_state
    CHECK (state IN ('pending', 'passed', 'failed', 'expired', 'invalidated')),
  CONSTRAINT ck_mfa_challenge_step_up_session
    CHECK (purpose <> 'step_up' OR login_session_id IS NOT NULL),
  CONSTRAINT ck_mfa_challenge_attempts CHECK (attempt_count >= 0),
  CONSTRAINT ck_mfa_challenge_passed
    CHECK ((state = 'passed') = (passed_at IS NOT NULL)),
  CONSTRAINT ck_mfa_challenge_version CHECK (version >= 1)
);
COMMENT ON TABLE mfa_challenge IS
  'MFA challenge bookkeeping (docs/26 §8.6 pattern, A1.1) — throttling, single-use sequencing, audit anchoring. No TOTP codes, no Cognito challenge/session material, no secrets. Retention class: short-lived operational record; finalized rows are swept by the elevated retention job after the configured window.';

CREATE INDEX ix_mfa_challenge_user ON mfa_challenge (user_id, state, created_at);
CREATE INDEX ix_mfa_challenge_session
  ON mfa_challenge (login_session_id) WHERE login_session_id IS NOT NULL;

CREATE TRIGGER trg_mfa_challenge_updated_at
  BEFORE UPDATE ON mfa_challenge FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_mfa_challenge_version
  BEFORE UPDATE ON mfa_challenge FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_mfa_challenge_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
     OR NEW.login_session_id IS DISTINCT FROM OLD.login_session_id
     OR NEW.purpose <> OLD.purpose
     OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'mfa_challenge identity/binding columns are immutable (challenge %)', OLD.id;
  END IF;
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'mfa_challenge % is % and cannot be reused or altered', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state
     AND NEW.state NOT IN ('passed', 'failed', 'expired', 'invalidated') THEN
    RAISE EXCEPTION 'invalid mfa_challenge transition % -> % (challenge %)',
      OLD.state, NEW.state, OLD.id;
  END IF;
  IF NEW.state = 'passed' AND now() > OLD.expires_at THEN
    RAISE EXCEPTION 'mfa_challenge % expired at %; it cannot pass', OLD.id, OLD.expires_at;
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'mfa_challenge.attempt_count can never decrease (challenge %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_mfa_challenge_transition() IS
  'B2-6A: challenges are single-use — pending → passed|failed|expired|invalidated only, terminal rows frozen, expired challenges can never pass, attempt counts are monotonic.';

CREATE TRIGGER trg_mfa_challenge_transition
  BEFORE UPDATE ON mfa_challenge FOR EACH ROW
  EXECUTE FUNCTION enforce_mfa_challenge_transition();

------------------------------------------------------------------------------
-- 6. step_up_grant — recent-reauthentication bookkeeping (docs/26 §3.10,
--    §6 PrincipalContext.stepUpAt). A grant row is assurance evidence ONLY
--    when created by the future verified service flow (B2-6B); runtime
--    assurance additionally requires the bound session to be live and the
--    grant unexpired and uninvalidated — the row alone proves nothing.
------------------------------------------------------------------------------

CREATE TABLE step_up_grant (
  id               uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  login_session_id uuid        NOT NULL,
  method           text        NOT NULL,
  granted_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  invalidated_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_step_up_grant PRIMARY KEY (id),
  CONSTRAINT fk_step_up_grant_user FOREIGN KEY (user_id) REFERENCES app_user (id),
  CONSTRAINT fk_step_up_grant_session FOREIGN KEY (login_session_id, user_id)
    REFERENCES login_session (id, user_id),
  CONSTRAINT ck_step_up_grant_method
    CHECK (method IN ('totp', 'recovery_code', 'password', 'oidc')),
  CONSTRAINT ck_step_up_grant_window CHECK (expires_at > granted_at),
  CONSTRAINT ck_step_up_grant_version CHECK (version >= 1)
);
COMMENT ON TABLE step_up_grant IS
  'Step-up reauthentication grant (docs/26 §3.10) bound to one user + login session with a bounded window (max-age is configuration, §14.C). Bookkeeping only: assurance requires the verified B2-6B flow, a live session, and an unexpired uninvalidated grant. Retention class: short-lived operational record, swept by the elevated retention job.';

CREATE INDEX ix_step_up_grant_session ON step_up_grant (login_session_id, expires_at);

CREATE TRIGGER trg_step_up_grant_updated_at
  BEFORE UPDATE ON step_up_grant FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_step_up_grant_version
  BEFORE UPDATE ON step_up_grant FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_step_up_grant_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
     OR NEW.login_session_id <> OLD.login_session_id
     OR NEW.method <> OLD.method
     OR NEW.granted_at <> OLD.granted_at
     OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'step_up_grant columns are immutable (grant %)', OLD.id;
  END IF;
  IF OLD.invalidated_at IS NOT NULL
     AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at THEN
    RAISE EXCEPTION 'step_up_grant.invalidated_at is write-once (grant %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_step_up_grant_transition() IS
  'B2-6A: grants are immutable after creation except one-time invalidation (MFA reset / forced revocation).';

CREATE TRIGGER trg_step_up_grant_transition
  BEFORE UPDATE ON step_up_grant FOR EACH ROW
  EXECUTE FUNCTION enforce_step_up_grant_transition();

------------------------------------------------------------------------------
-- 7. Application-role grants — same posture as 0002: read/insert/update
--    only; consumption, supersession, and invalidation are UPDATEs; no
--    DELETE anywhere (retention sweeps run under the elevated role).
------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON mfa_method TO himma_app;
GRANT SELECT, INSERT, UPDATE ON mfa_recovery_code_batch TO himma_app;
GRANT SELECT, INSERT, UPDATE ON mfa_recovery_code TO himma_app;
GRANT SELECT, INSERT, UPDATE ON mfa_challenge TO himma_app;
GRANT SELECT, INSERT, UPDATE ON step_up_grant TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops every B2-6A object; app_user.mfa_enrolled (0002)
-- keeps its last mirrored value once the maintaining triggers are gone.

DROP TRIGGER trg_app_user_mfa_enrolled_consistency ON app_user;
DROP TABLE step_up_grant;
DROP TABLE mfa_challenge;
DROP TABLE mfa_recovery_code;
DROP TABLE mfa_recovery_code_batch;
DROP TABLE mfa_method;
DROP FUNCTION enforce_step_up_grant_transition();
DROP FUNCTION enforce_mfa_challenge_transition();
DROP FUNCTION cascade_recovery_batch_invalidation();
DROP FUNCTION enforce_mfa_recovery_code_transition();
DROP FUNCTION enforce_mfa_recovery_batch_transition();
DROP FUNCTION enforce_mfa_enrolled_consistency();
DROP FUNCTION maintain_mfa_enrolled_mirror();
DROP FUNCTION enforce_mfa_method_transition();
ALTER TABLE login_session DROP CONSTRAINT uq_login_session_id_user;
