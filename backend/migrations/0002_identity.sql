-- 0002_identity — Slice 2 (B2-1) identity and authorization schema foundation.
-- Authority: docs/26 §8 (as amended by A1), docs/24 §1/§10, docs/25 §6/§9.
-- Runs in one transaction (node-pg-migrate default). Reversible: the Down
-- migration below is the reviewed rollback, permitted outside production only
-- (docs/25 §9). No PostgreSQL-18-only features.
--
-- Deliberate absences (structural, tested): no password/credential columns,
-- no raw or hashed tokens, no refresh-token storage, no TOTP secrets, no
-- recovery-code secrets — credentials and token lifecycles are Cognito's
-- (docs/26 Amendment A1.1); Himma stores identities, sessions-of-record, and
-- authorization only. MFA mirror tables land with B2-6, not here.

-- Up Migration

------------------------------------------------------------------------------
-- 1. app_user — the authentication principal (docs/26 §8.1; "user" is reserved)
------------------------------------------------------------------------------

CREATE TABLE app_user (
  id            uuid        NOT NULL,
  status        text        NOT NULL DEFAULT 'active',
  locked_reason text,
  mfa_enrolled  boolean     NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_app_user PRIMARY KEY (id),
  CONSTRAINT ck_app_user_status CHECK (status IN ('active', 'locked', 'deleted')),
  CONSTRAINT ck_app_user_locked_reason CHECK (status = 'locked' OR locked_reason IS NULL),
  CONSTRAINT ck_app_user_version CHECK (version >= 1)
);
COMMENT ON TABLE app_user IS
  'Authentication principal (docs/24 §1.1). Pseudonymized on erasure (docs/24 §6.14); rows are never deleted by the application role.';

CREATE TRIGGER trg_app_user_updated_at
  BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_app_user_version
  BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION bump_row_version();

------------------------------------------------------------------------------
-- 2. auth_identity — provider identities (docs/26 §8.2, Amendment A1.1)
-- Matching is normalized issuer + subject; NEVER email. No credential
-- material of any kind is stored here.
------------------------------------------------------------------------------

CREATE TABLE auth_identity (
  id               uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  provider         text        NOT NULL,
  issuer           text        NOT NULL,
  subject          text        NOT NULL,
  email            text,
  email_verified   boolean     NOT NULL DEFAULT false,
  is_private_relay boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_auth_identity PRIMARY KEY (id),
  CONSTRAINT fk_auth_identity_user FOREIGN KEY (user_id) REFERENCES app_user (id),
  CONSTRAINT ck_auth_identity_provider CHECK (provider IN ('apple', 'google', 'email')),
  CONSTRAINT ck_auth_identity_status CHECK (status IN ('active', 'ended')),
  CONSTRAINT ck_auth_identity_version CHECK (version >= 1),
  -- One provider identity belongs to exactly one User, forever (docs/26 §3.1).
  CONSTRAINT uq_auth_identity_issuer_subject UNIQUE (issuer, subject),
  -- Redundant with the above but required as the composite-FK target that
  -- ties a login session's provider identity to the SAME user (§4 below).
  CONSTRAINT uq_auth_identity_user_issuer_subject UNIQUE (user_id, issuer, subject)
);
COMMENT ON TABLE auth_identity IS
  'Linked authentication identities (docs/24 §1.1). No password hashes, tokens, or secrets — credentials live in the managed provider (docs/26 A1.1). Apple private-relay emails are ordinary rows flagged is_private_relay; duplicate emails never merge users.';

-- One VERIFIED email belongs to at most one active identity (docs/26 §3.5);
-- unverified duplicates are allowed and never merge anything.
CREATE UNIQUE INDEX uq_auth_identity_verified_email
  ON auth_identity (lower(email))
  WHERE email_verified AND status = 'active';
CREATE INDEX ix_auth_identity_user ON auth_identity (user_id);

CREATE TRIGGER trg_auth_identity_updated_at
  BEFORE UPDATE ON auth_identity FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_auth_identity_version
  BEFORE UPDATE ON auth_identity FOR EACH ROW EXECUTE FUNCTION bump_row_version();

------------------------------------------------------------------------------
-- 3. customer_account + participant foundation (docs/26 §8.3; docs/24 §1.2)
-- Exactly one account per user; exactly one 'self' participant per account.
-- The full child-participant model (and counsel-pending legal fields) is
-- Slice 5 — only the structural foundation lands here. Participants are
-- NEVER principals: nothing links a participant to an auth identity.
------------------------------------------------------------------------------

CREATE TABLE customer_account (
  id            uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  display_name  text        NOT NULL,
  contact_email text,
  status        text        NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_customer_account PRIMARY KEY (id),
  CONSTRAINT fk_customer_account_user FOREIGN KEY (user_id) REFERENCES app_user (id),
  CONSTRAINT uq_customer_account_user UNIQUE (user_id),
  CONSTRAINT ck_customer_account_status
    CHECK (status IN ('active', 'suspended', 'deletion_requested', 'anonymized')),
  CONSTRAINT ck_customer_account_version CHECK (version >= 1)
);

CREATE TRIGGER trg_customer_account_updated_at
  BEFORE UPDATE ON customer_account FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_customer_account_version
  BEFORE UPDATE ON customer_account FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TABLE participant (
  id            uuid        NOT NULL,
  account_id    uuid        NOT NULL,
  kind          text        NOT NULL,
  first_name    text        NOT NULL,
  date_of_birth date,
  status        text        NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_participant PRIMARY KEY (id),
  CONSTRAINT fk_participant_account FOREIGN KEY (account_id) REFERENCES customer_account (id),
  CONSTRAINT ck_participant_kind CHECK (kind IN ('self', 'child')),
  CONSTRAINT ck_participant_status CHECK (status IN ('active', 'archived')),
  CONSTRAINT ck_participant_version CHECK (version >= 1)
);
COMMENT ON TABLE participant IS
  'Participant foundation (docs/24 §1.2). Slice 2 creates self participants only; the child model and counsel-pending legal fields arrive in Slice 5. Participants are never login principals.';

-- The approved one-self-participant invariant (docs/24 §1.2, docs/26 §8.3).
CREATE UNIQUE INDEX uq_participant_one_self
  ON participant (account_id)
  WHERE kind = 'self';
CREATE INDEX ix_participant_account ON participant (account_id);

CREATE TRIGGER trg_participant_updated_at
  BEFORE UPDATE ON participant FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_participant_version
  BEFORE UPDATE ON participant FOR EACH ROW EXECUTE FUNCTION bump_row_version();

------------------------------------------------------------------------------
-- 4. login_session — Himma session-of-record (docs/26 §8.4, Amendment A1.1)
-- Keyed to normalized provider session identifiers (issuer, subject,
-- origin_jti). Stores NO token material. The composite FK ties the session's
-- provider identity to the same user (ownership coherence).
------------------------------------------------------------------------------

CREATE TABLE login_session (
  id               uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  principal_kind   text        NOT NULL,
  client_kind      text        NOT NULL,
  provider_issuer  text        NOT NULL,
  provider_subject text        NOT NULL,
  origin_jti       text        NOT NULL,
  device_label     text,
  ip_digest        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoke_reason    text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_login_session PRIMARY KEY (id),
  CONSTRAINT fk_login_session_user FOREIGN KEY (user_id) REFERENCES app_user (id),
  CONSTRAINT fk_login_session_identity FOREIGN KEY (user_id, provider_issuer, provider_subject)
    REFERENCES auth_identity (user_id, issuer, subject),
  CONSTRAINT ck_login_session_principal_kind
    CHECK (principal_kind IN ('customer', 'admin', 'provider_staff')),
  CONSTRAINT ck_login_session_client_kind
    CHECK (client_kind IN ('customer_app', 'admin_portal', 'provider_portal')),
  CONSTRAINT ck_login_session_revoke_reason CHECK (revoked_at IS NOT NULL OR revoke_reason IS NULL),
  CONSTRAINT ck_login_session_version CHECK (version >= 1)
);
COMMENT ON TABLE login_session IS
  'Himma-owned session/device inventory (docs/26 §4, A1.1). No Cognito tokens — raw or hashed — are ever stored. Retention class: short-lived operational record; revoked/expired rows are swept by an elevated retention job after the configured window (docs/24 §6.14; window is configuration, not schema).';

-- One LIVE session per provider session identifier (liveness lookup key).
CREATE UNIQUE INDEX uq_login_session_origin_jti
  ON login_session (origin_jti)
  WHERE revoked_at IS NULL;
CREATE INDEX ix_login_session_user ON login_session (user_id, revoked_at);

CREATE TRIGGER trg_login_session_updated_at
  BEFORE UPDATE ON login_session FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_login_session_version
  BEFORE UPDATE ON login_session FOR EACH ROW EXECUTE FUNCTION bump_row_version();

------------------------------------------------------------------------------
-- 5. auth_challenge — provider-neutral challenge BOOKKEEPING (docs/26 §8.6)
-- Rate-limit anchoring, enumeration-safe sequencing, and audit only.
-- Code/token generation and validation are the provider's; no secret,
-- code, or token material exists here.
------------------------------------------------------------------------------

CREATE TABLE auth_challenge (
  id               uuid        NOT NULL,
  kind             text        NOT NULL,
  user_id          uuid,
  auth_identity_id uuid        NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz,
  attempt_count    integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_auth_challenge PRIMARY KEY (id),
  CONSTRAINT fk_auth_challenge_user FOREIGN KEY (user_id) REFERENCES app_user (id),
  CONSTRAINT fk_auth_challenge_identity FOREIGN KEY (auth_identity_id) REFERENCES auth_identity (id),
  CONSTRAINT ck_auth_challenge_kind CHECK (kind IN ('email_verification', 'password_reset')),
  CONSTRAINT ck_auth_challenge_attempts CHECK (attempt_count >= 0),
  CONSTRAINT ck_auth_challenge_version CHECK (version >= 1)
);
COMMENT ON TABLE auth_challenge IS
  'Challenge bookkeeping only (docs/26 §8.6, A1.1) — no codes, tokens, or secrets. Retention class: short-lived; completed/expired rows are swept by an elevated retention job (window is configuration).';
CREATE INDEX ix_auth_challenge_identity ON auth_challenge (auth_identity_id, kind, requested_at);

CREATE TRIGGER trg_auth_challenge_updated_at
  BEFORE UPDATE ON auth_challenge FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_auth_challenge_version
  BEFORE UPDATE ON auth_challenge FOR EACH ROW EXECUTE FUNCTION bump_row_version();

------------------------------------------------------------------------------
-- 6. admin_role_assignment — dual-controlled admin roles (docs/26 §7, §8.7)
-- Approval is modeled as fields on the assignment row (requested_by /
-- approved_by / denied_by) — the docs/26 §8.7 approved equivalent of a
-- separate approval table. There is deliberately NO super-admin role value.
-- Platform engineers hold no rows here at all (docs/26 §7.4): their
-- separation lives in infrastructure IAM; this schema does not fabricate
-- IAM authority.
------------------------------------------------------------------------------

CREATE TABLE admin_role_assignment (
  id           uuid        NOT NULL,
  user_id      uuid        NOT NULL,
  role         text        NOT NULL,
  state        text        NOT NULL DEFAULT 'requested',
  requested_by uuid        NOT NULL,
  approved_by  uuid,
  denied_by    uuid,
  revoked_by   uuid,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_admin_role_assignment PRIMARY KEY (id),
  CONSTRAINT fk_admin_role_assignment_user FOREIGN KEY (user_id) REFERENCES app_user (id),
  CONSTRAINT fk_admin_role_assignment_requested_by FOREIGN KEY (requested_by) REFERENCES app_user (id),
  CONSTRAINT fk_admin_role_assignment_approved_by FOREIGN KEY (approved_by) REFERENCES app_user (id),
  CONSTRAINT fk_admin_role_assignment_denied_by FOREIGN KEY (denied_by) REFERENCES app_user (id),
  CONSTRAINT fk_admin_role_assignment_revoked_by FOREIGN KEY (revoked_by) REFERENCES app_user (id),
  CONSTRAINT ck_admin_role_assignment_role
    CHECK (role IN ('operations', 'support', 'finance', 'access_admin', 'auditor')),
  CONSTRAINT ck_admin_role_assignment_state
    CHECK (state IN ('requested', 'active', 'denied', 'revoked', 'expired')),
  -- Dual control (docs/24 §6.5): the approver is never the requester.
  CONSTRAINT ck_admin_role_assignment_dual_control
    CHECK (approved_by IS NULL OR approved_by <> requested_by),
  -- Finance-capable roles may only be active with a recorded second approver.
  CONSTRAINT ck_admin_role_assignment_finance_approved
    CHECK (NOT (state = 'active' AND role IN ('finance', 'access_admin') AND approved_by IS NULL)),
  CONSTRAINT ck_admin_role_assignment_version CHECK (version >= 1)
);
CREATE UNIQUE INDEX uq_admin_role_assignment_active
  ON admin_role_assignment (user_id, role)
  WHERE state = 'active';
CREATE INDEX ix_admin_role_assignment_user ON admin_role_assignment (user_id, state);

CREATE TRIGGER trg_admin_role_assignment_updated_at
  BEFORE UPDATE ON admin_role_assignment FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_admin_role_assignment_version
  BEFORE UPDATE ON admin_role_assignment FOR EACH ROW EXECUTE FUNCTION bump_row_version();

-- D4 exclusivity (docs/26 §7.4, Amendment A1.4), enforced under concurrency:
-- the per-user advisory transaction lock serializes concurrent activations so
-- two sessions cannot activate conflicting roles simultaneously.
CREATE FUNCTION enforce_admin_role_exclusivity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conflict_roles text[];
  conflicting    text;
BEGIN
  IF NEW.state <> 'active' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin_role_assignment:' || NEW.user_id::text, 42));
  IF NEW.role = 'auditor' THEN
    conflict_roles := ARRAY['operations', 'support', 'finance', 'access_admin'];
  ELSIF NEW.role = 'access_admin' THEN
    conflict_roles := ARRAY['finance', 'auditor'];
  ELSIF NEW.role = 'finance' THEN
    conflict_roles := ARRAY['access_admin', 'auditor'];
  ELSE
    conflict_roles := ARRAY['auditor'];
  END IF;
  SELECT a.role INTO conflicting
    FROM admin_role_assignment a
    WHERE a.user_id = NEW.user_id
      AND a.state = 'active'
      AND a.role = ANY (conflict_roles)
      AND a.id <> NEW.id
    LIMIT 1;
  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION 'admin role exclusivity: % conflicts with active % for user %',
      NEW.role, conflicting, NEW.user_id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_admin_role_assignment_exclusivity
  BEFORE INSERT OR UPDATE ON admin_role_assignment
  FOR EACH ROW EXECUTE FUNCTION enforce_admin_role_exclusivity();

-- State-machine guard (docs/26 §7.3): only requested→active|denied and
-- active→revoked|expired are legal; everything else is rejected server-side.
CREATE FUNCTION enforce_admin_role_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  IF (OLD.state = 'requested' AND NEW.state IN ('active', 'denied'))
     OR (OLD.state = 'active' AND NEW.state IN ('revoked', 'expired')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid admin role transition: % -> %', OLD.state, NEW.state
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER trg_admin_role_assignment_transition
  BEFORE UPDATE ON admin_role_assignment
  FOR EACH ROW EXECUTE FUNCTION enforce_admin_role_transition();

------------------------------------------------------------------------------
-- 7. bootstrap_seal — permanent one-shot production bootstrap seal
-- (docs/26 §7.5, Amendment A1.3). Exactly one row can ever exist; the row
-- can never be updated or deleted. The B2-5 CLI writes it in the same
-- transaction as the two initial access_admin assignments and refuses
-- forever after; the schema alone guarantees single successful execution.
------------------------------------------------------------------------------

CREATE TABLE bootstrap_seal (
  singleton       boolean     NOT NULL DEFAULT true,
  sealed_at       timestamptz NOT NULL DEFAULT now(),
  manifest_digest text        NOT NULL,
  executed_by     text        NOT NULL,
  CONSTRAINT pk_bootstrap_seal PRIMARY KEY (singleton),
  CONSTRAINT ck_bootstrap_seal_singleton CHECK (singleton)
);
COMMENT ON TABLE bootstrap_seal IS
  'Permanent production-bootstrap seal (docs/26 §7.5). At most one row, append-only forever: successful bootstrap inserts it atomically with exactly two access_admin assignments; no code path unseals.';

CREATE TRIGGER trg_bootstrap_seal_append_only
  BEFORE UPDATE OR DELETE ON bootstrap_seal
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 8. Application-role grants (docs/25 §6; append-only posture via grants)
-- No DELETE anywhere: retention sweeps run under an elevated role.
-- bootstrap_seal: SELECT only — the bootstrap CLI runs elevated, never as
-- the application role.
------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON app_user TO himma_app;
GRANT SELECT, INSERT, UPDATE ON auth_identity TO himma_app;
GRANT SELECT, INSERT, UPDATE ON customer_account TO himma_app;
GRANT SELECT, INSERT, UPDATE ON participant TO himma_app;
GRANT SELECT, INSERT, UPDATE ON login_session TO himma_app;
GRANT SELECT, INSERT, UPDATE ON auth_challenge TO himma_app;
GRANT SELECT, INSERT, UPDATE ON admin_role_assignment TO himma_app;
GRANT SELECT ON bootstrap_seal TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops this migration's objects in dependency order; the
-- Slice 1 foundation (domains, shared trigger functions, himma_app role) is
-- untouched.

REVOKE ALL ON app_user, auth_identity, customer_account, participant,
  login_session, auth_challenge, admin_role_assignment, bootstrap_seal
  FROM himma_app;
DROP TABLE bootstrap_seal;
DROP TRIGGER trg_admin_role_assignment_transition ON admin_role_assignment;
DROP TRIGGER trg_admin_role_assignment_exclusivity ON admin_role_assignment;
DROP FUNCTION enforce_admin_role_transition();
DROP FUNCTION enforce_admin_role_exclusivity();
DROP TABLE admin_role_assignment;
DROP TABLE auth_challenge;
DROP TABLE login_session;
DROP TABLE participant;
DROP TABLE customer_account;
DROP TABLE auth_identity;
DROP TABLE app_user;
