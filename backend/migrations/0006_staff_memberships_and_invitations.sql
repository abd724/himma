-- 0006_staff_memberships_and_invitations — S3-2 (docs/27 §5, §6, §9, §12,
-- Amendment A1/D-S3-1; docs/24 §1.3, §5.2, §7.10). Staff memberships on the
-- canonical Himma User plus single-use, expiring, digest-stored staff
-- invitations. NO provider routes, principal middleware, admin lifecycle,
-- public storefront reads, or listing objects — those are S3-3/S3-4.
--
-- Security shape fixed here:
--   * provider staff are ordinary Himma users (app_user FK) — there is no
--     second identity system and no provider credential column anywhere;
--   * staff_invitation stores ONLY an HMAC digest of the one-time token
--     (B2-6B recovery-code boundary): no column can hold the raw token;
--   * memberships are append-only history — role/scope CHANGE = revoke +
--     new row; revoked rows are terminal and immutable;
--   * branch scope rows are composite-FK-bound to ONE organization, so a
--     membership can never be scoped to another organization's branch even
--     by direct SQL;
--   * the last ACTIVE Owner of a non-offboarded organization cannot be
--     revoked (advisory-lock-serialized guard; controlled organization
--     offboarding is the single sanctioned exception, docs/27 §5).
--
-- Runs in one transaction. No PostgreSQL-18-only features.

-- Up Migration

------------------------------------------------------------------------------
-- 1. staff_invitation — single-use, expiring invitation (docs/24 §5.2;
-- docs/27 §9): sent → accepted | revoked | expired. The raw token exists
-- only in service memory and the outgoing mail payload; PostgreSQL holds the
-- HMAC-SHA-256 digest plus the scheme/pepper-version metadata needed to
-- verify it. `email` is the NORMALIZED (lowercased) target address — the
-- D-S3-1 acceptance rule matches it against the accepting user's VERIFIED
-- normalized identity emails, never display names, never Cognito subjects.
-- Created before staff_membership so provenance FKs can point here.
------------------------------------------------------------------------------

CREATE TABLE staff_invitation (
  id                uuid        NOT NULL,
  organization_id   uuid        NOT NULL,
  email             text        NOT NULL,
  role              text        NOT NULL,
  branch_scope_kind text        NOT NULL DEFAULT 'all',
  branch_scope_ids  uuid[]      NOT NULL DEFAULT '{}',
  state             text        NOT NULL DEFAULT 'sent',
  invited_by        uuid        NOT NULL,
  token_digest      text        NOT NULL,
  digest_scheme     text        NOT NULL DEFAULT 'hmac_sha256',
  pepper_version    integer     NOT NULL,
  issued_at         timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  accepted_at       timestamptz,
  accepted_by       uuid,
  revoked_at        timestamptz,
  revoked_by        uuid,
  expired_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_staff_invitation PRIMARY KEY (id),
  CONSTRAINT fk_staff_invitation_organization
    FOREIGN KEY (organization_id) REFERENCES organization (id),
  CONSTRAINT fk_staff_invitation_invited_by
    FOREIGN KEY (invited_by) REFERENCES app_user (id),
  CONSTRAINT fk_staff_invitation_accepted_by
    FOREIGN KEY (accepted_by) REFERENCES app_user (id),
  CONSTRAINT fk_staff_invitation_revoked_by
    FOREIGN KEY (revoked_by) REFERENCES app_user (id),
  -- Composite target so a membership's provenance FK can never cite another
  -- organization's invitation.
  CONSTRAINT uq_staff_invitation_id_organization UNIQUE (id, organization_id),
  CONSTRAINT uq_staff_invitation_token_digest UNIQUE (token_digest),
  -- Normalized at rest: matching is always lower(email) = email.
  CONSTRAINT ck_staff_invitation_email_normalized
    CHECK (email = lower(email) AND position('@' IN email) > 1),
  -- Exactly the approved docs/23 §7 / docs/27 §6 provider role vocabulary.
  CONSTRAINT ck_staff_invitation_role CHECK (role IN
    ('owner', 'org_manager', 'branch_manager', 'listings_editor',
     'coach', 'front_desk', 'finance')),
  CONSTRAINT ck_staff_invitation_scope_kind
    CHECK (branch_scope_kind IN ('all', 'branches')),
  -- Org-wide-only roles can never be branch-scoped (docs/27 §5).
  CONSTRAINT ck_staff_invitation_org_wide_roles
    CHECK (role NOT IN ('owner', 'org_manager', 'finance')
           OR branch_scope_kind = 'all'),
  -- An empty selected-branch set can never masquerade as either scope shape:
  -- 'branches' requires ids, 'all' forbids them (docs/27 §5 unambiguity).
  CONSTRAINT ck_staff_invitation_scope_ids
    CHECK ((branch_scope_kind = 'branches') = (cardinality(branch_scope_ids) > 0)),
  CONSTRAINT ck_staff_invitation_state
    CHECK (state IN ('sent', 'accepted', 'revoked', 'expired')),
  CONSTRAINT ck_staff_invitation_digest_scheme CHECK (digest_scheme IN ('hmac_sha256')),
  CONSTRAINT ck_staff_invitation_pepper CHECK (pepper_version >= 1),
  CONSTRAINT ck_staff_invitation_window CHECK (expires_at > issued_at),
  CONSTRAINT ck_staff_invitation_accepted
    CHECK ((state = 'accepted') = (accepted_at IS NOT NULL)
       AND (state = 'accepted') = (accepted_by IS NOT NULL)),
  CONSTRAINT ck_staff_invitation_revoked
    CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)
       AND (revoked_by IS NULL OR state = 'revoked')),
  CONSTRAINT ck_staff_invitation_expired
    CHECK ((state = 'expired') = (expired_at IS NOT NULL)),
  CONSTRAINT ck_staff_invitation_version CHECK (version >= 1)
);
COMMENT ON TABLE staff_invitation IS
  'Single-use staff invitation (docs/24 §5.2; docs/27 §9). token_digest is HMAC-SHA-256 of a 256-bit CSPRNG token under the configured pepper (version recorded here, value only in configuration) — the raw token is never stored, logged, audited, or reconstructible. email is PII (retention class: pseudonymized on erasure per docs/24 §4.14) and NEVER appears in audit/outbox payloads. Acceptance (D-S3-1): verified normalized email match required; display names and Cognito subjects never participate. Resend = revoke + new row; tokens are never mutated.';
COMMENT ON COLUMN staff_invitation.branch_scope_ids IS
  'Intended branch scope carried until acceptance. Service-validated against the organization''s branches at issue time; at acceptance the ids become staff_membership_branch rows whose composite FKs structurally enforce same-organization ownership.';

-- At most one live invitation per organization + address: the approved
-- resend policy (docs/27 §9) is revoke-then-reissue, DB-backed here.
CREATE UNIQUE INDEX uq_staff_invitation_sent
  ON staff_invitation (organization_id, email) WHERE state = 'sent';
CREATE INDEX ix_staff_invitation_org
  ON staff_invitation (organization_id, state, expires_at);
-- Expiry sweep scan (B2-5 pattern).
CREATE INDEX ix_staff_invitation_due
  ON staff_invitation (expires_at) WHERE state = 'sent';

CREATE TRIGGER trg_staff_invitation_updated_at
  BEFORE UPDATE ON staff_invitation FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_staff_invitation_version
  BEFORE UPDATE ON staff_invitation FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_staff_invitation_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
     OR NEW.email <> OLD.email OR NEW.role <> OLD.role
     OR NEW.branch_scope_kind <> OLD.branch_scope_kind
     OR NEW.branch_scope_ids <> OLD.branch_scope_ids
     OR NEW.invited_by <> OLD.invited_by
     OR NEW.token_digest <> OLD.token_digest
     OR NEW.digest_scheme <> OLD.digest_scheme
     OR NEW.pepper_version <> OLD.pepper_version
     OR NEW.issued_at <> OLD.issued_at
     OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'staff_invitation identity/target/token columns are immutable (invitation %)', OLD.id;
  END IF;
  IF OLD.state <> 'sent' THEN
    RAISE EXCEPTION 'staff_invitation % is % and permanently immutable', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state
     AND NEW.state NOT IN ('accepted', 'revoked', 'expired') THEN
    RAISE EXCEPTION 'invalid staff_invitation transition % -> % (invitation %)',
      OLD.state, NEW.state, OLD.id;
  END IF;
  -- Time alone kills a token: an overdue invitation can never become
  -- accepted, even before the expiry sweep formally finalizes it.
  IF NEW.state = 'accepted' AND now() > OLD.expires_at THEN
    RAISE EXCEPTION 'staff_invitation % expired at %; it cannot be accepted', OLD.id, OLD.expires_at;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_staff_invitation_transition() IS
  'S3-2: sent → accepted | revoked | expired only; terminal rows frozen; target email, role, scope, token digest, and expiry immutable after insert; overdue invitations can never be accepted regardless of sweep timing.';

CREATE TRIGGER trg_staff_invitation_transition
  BEFORE UPDATE ON staff_invitation FOR EACH ROW
  EXECUTE FUNCTION enforce_staff_invitation_transition();

------------------------------------------------------------------------------
-- 2. staff_membership — provider staff on the canonical Himma User
-- (docs/24 §1.3; docs/27 §5): state active → revoked (terminal). One row =
-- one grant of one role; role/scope change is revoke + NEW row, so the full
-- assignment history is reconstructable from the rows themselves plus their
-- audit events — nothing is ever overwritten.
------------------------------------------------------------------------------

CREATE TABLE staff_membership (
  id                uuid        NOT NULL,
  user_id           uuid        NOT NULL,
  organization_id   uuid        NOT NULL,
  role              text        NOT NULL,
  branch_scope_kind text        NOT NULL DEFAULT 'all',
  state             text        NOT NULL DEFAULT 'active',
  invited_by        uuid,
  invitation_id     uuid,
  revoked_at        timestamptz,
  revoked_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_staff_membership PRIMARY KEY (id),
  CONSTRAINT fk_staff_membership_user FOREIGN KEY (user_id) REFERENCES app_user (id),
  CONSTRAINT fk_staff_membership_organization
    FOREIGN KEY (organization_id) REFERENCES organization (id),
  CONSTRAINT fk_staff_membership_invited_by
    FOREIGN KEY (invited_by) REFERENCES app_user (id),
  -- Provenance is org-bound: a membership can never cite another
  -- organization's invitation (MATCH SIMPLE skips the NULL founding case).
  CONSTRAINT fk_staff_membership_invitation
    FOREIGN KEY (invitation_id, organization_id)
    REFERENCES staff_invitation (id, organization_id),
  CONSTRAINT fk_staff_membership_revoked_by
    FOREIGN KEY (revoked_by) REFERENCES app_user (id),
  -- Composite target for the branch-scope join (same pattern as branch).
  CONSTRAINT uq_staff_membership_id_organization UNIQUE (id, organization_id),
  CONSTRAINT ck_staff_membership_role CHECK (role IN
    ('owner', 'org_manager', 'branch_manager', 'listings_editor',
     'coach', 'front_desk', 'finance')),
  CONSTRAINT ck_staff_membership_scope_kind
    CHECK (branch_scope_kind IN ('all', 'branches')),
  CONSTRAINT ck_staff_membership_org_wide_roles
    CHECK (role NOT IN ('owner', 'org_manager', 'finance')
           OR branch_scope_kind = 'all'),
  CONSTRAINT ck_staff_membership_state CHECK (state IN ('active', 'revoked')),
  CONSTRAINT ck_staff_membership_revoked
    CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)
       AND (revoked_by IS NULL OR state = 'revoked')),
  CONSTRAINT ck_staff_membership_version CHECK (version >= 1)
);
COMMENT ON TABLE staff_membership IS
  'Provider staff membership on the canonical Himma User (docs/24 §1.3; docs/27 §5) — never a second identity system. Append-only history: active → revoked is the only transition, revoked rows are terminal/immutable, and any role/scope change is revoke + new row (each audit-evented), so every past assignment stays reconstructable. invitation_id NULL only for the admin-created founding Owner membership (docs/27 §10). Provider authority resolves from ACTIVE rows here per request (S3-3) — never from Cognito claims.';
COMMENT ON COLUMN staff_membership.branch_scope_kind IS
  '''all'' = organization-wide within the role''s reach; ''branches'' = restricted to staff_membership_branch rows. A deferred constraint trigger refuses ''branches'' rows with an empty scope set, so an empty selection can never silently mean organization-wide access.';

-- One ACTIVE membership per user + organization (multi-organization
-- membership stays allowed: one row per organization, docs/24 §1.3).
CREATE UNIQUE INDEX uq_staff_membership_active
  ON staff_membership (user_id, organization_id) WHERE state = 'active';
CREATE INDEX ix_staff_membership_org ON staff_membership (organization_id, state);
CREATE INDEX ix_staff_membership_user ON staff_membership (user_id, state);

CREATE TRIGGER trg_staff_membership_updated_at
  BEFORE UPDATE ON staff_membership FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_staff_membership_version
  BEFORE UPDATE ON staff_membership FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_staff_membership_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.role <> OLD.role
     OR NEW.branch_scope_kind <> OLD.branch_scope_kind
     OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
     OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'staff_membership identity/role/provenance columns are immutable (membership %)', OLD.id;
  END IF;
  IF OLD.state = 'revoked' THEN
    RAISE EXCEPTION 'staff_membership % is revoked and permanently immutable', OLD.id;
  END IF;
  IF NEW.state <> OLD.state AND NEW.state <> 'revoked' THEN
    RAISE EXCEPTION 'invalid staff_membership transition % -> % (membership %)',
      OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_staff_membership_transition() IS
  'S3-2: memberships never move between users, organizations, or roles; active → revoked is the only transition; revoked rows are frozen (re-granting is a NEW row). With ck_staff_membership_revoked this makes the revocation columns write-once with the transition.';

CREATE TRIGGER trg_staff_membership_transition
  BEFORE UPDATE ON staff_membership FOR EACH ROW
  EXECUTE FUNCTION enforce_staff_membership_transition();

------------------------------------------------------------------------------
-- 3. Last-active-owner protection (docs/27 §5, §12.3): a non-offboarded
-- organization can never lose its final active Owner. Serialized per
-- organization with a transaction-scoped advisory lock (the B2-1/0003
-- release pattern) so two concurrent revocations of the last two Owners
-- cannot both slip through a read-then-write window. Controlled
-- organization offboarding (state = 'offboarded', terminal, S3-4 service)
-- is the single sanctioned way the final Owner may go.
------------------------------------------------------------------------------

CREATE FUNCTION enforce_last_active_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org_state        text;
  remaining_owners integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('staff_membership:owners:' || OLD.organization_id::text, 42));
  SELECT verification_state INTO org_state
  FROM organization WHERE id = OLD.organization_id;
  IF org_state = 'offboarded' THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO remaining_owners
  FROM staff_membership
  WHERE organization_id = OLD.organization_id
    AND role = 'owner' AND state = 'active' AND id <> OLD.id;
  IF remaining_owners = 0 THEN
    RAISE EXCEPTION
      'organization % must retain at least one active owner membership (last-owner protection, docs/27 §5)',
      OLD.organization_id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_last_active_owner() IS
  'S3-2: refuses revoking the final active Owner of a non-offboarded organization. Advisory-xact-lock serialization per organization makes concurrent Owner revocations queue, so the second of two racing revocations sees the committed first and is refused. Offboarded organizations are the sanctioned terminal exception.';

CREATE TRIGGER trg_staff_membership_last_owner
  BEFORE UPDATE ON staff_membership FOR EACH ROW
  WHEN (OLD.role = 'owner' AND OLD.state = 'active' AND NEW.state <> 'active')
  EXECUTE FUNCTION enforce_last_active_owner();

------------------------------------------------------------------------------
-- 4. staff_membership_branch — branch scope rows (docs/27 §5). Composite
-- FKs on BOTH sides carry organization_id, so a scope row is structurally
-- inside exactly one organization: cross-organization scoping is impossible
-- even by direct SQL. Rows are append-only facts of the membership they
-- scope; a membership retires by revocation (new row for new scope), and
-- deactivating a branch never rewrites or transfers scope rows.
------------------------------------------------------------------------------

CREATE TABLE staff_membership_branch (
  membership_id   uuid        NOT NULL,
  branch_id       uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_staff_membership_branch PRIMARY KEY (membership_id, branch_id),
  CONSTRAINT fk_staff_membership_branch_membership
    FOREIGN KEY (membership_id, organization_id)
    REFERENCES staff_membership (id, organization_id),
  CONSTRAINT fk_staff_membership_branch_branch
    FOREIGN KEY (branch_id, organization_id)
    REFERENCES branch (id, organization_id)
);
COMMENT ON TABLE staff_membership_branch IS
  'Branch scope of one ''branches''-scoped staff membership (docs/27 §5). Both composite FKs carry organization_id: membership and branch MUST belong to the same organization or the row is unrepresentable. Append-only (no UPDATE/DELETE, trigger + grants): scope changes are a new membership row with new scope rows.';

CREATE INDEX ix_staff_membership_branch_branch
  ON staff_membership_branch (branch_id);

CREATE TRIGGER trg_staff_membership_branch_append_only
  BEFORE UPDATE OR DELETE ON staff_membership_branch
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION enforce_staff_scope_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  scope_kind text;
BEGIN
  SELECT branch_scope_kind INTO scope_kind
  FROM staff_membership WHERE id = NEW.membership_id;
  IF scope_kind <> 'branches' THEN
    RAISE EXCEPTION
      'staff_membership % is organization-wide (%); branch scope rows are only valid for branch_scope_kind = ''branches''',
      NEW.membership_id, scope_kind;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_staff_scope_row() IS
  'S3-2: scope rows may only attach to ''branches''-scoped memberships — an org-wide membership can never accumulate a contradictory branch list.';

CREATE TRIGGER trg_staff_membership_branch_kind
  BEFORE INSERT ON staff_membership_branch
  FOR EACH ROW EXECUTE FUNCTION enforce_staff_scope_row();

-- 'branches' without rows is refused at COMMIT (deferred, so the service
-- transaction inserts membership + scope rows in any order): an EMPTY
-- selected-branch set can never exist, and therefore can never be misread
-- as organization-wide access (docs/27 §5 unambiguity rule).
CREATE FUNCTION enforce_staff_scope_completeness() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_scope_kind = 'branches'
     AND NOT EXISTS (SELECT 1 FROM staff_membership_branch
                     WHERE membership_id = NEW.id) THEN
    RAISE EXCEPTION
      'staff_membership % has branch_scope_kind ''branches'' but no scoped branches — an empty scope set is unrepresentable (docs/27 §5)',
      NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION enforce_staff_scope_completeness() IS
  'S3-2 (deferred to COMMIT): every ''branches''-scoped membership must hold at least one scope row, so the empty set can never silently mean organization-wide access.';

CREATE CONSTRAINT TRIGGER trg_staff_membership_scope_completeness
  AFTER INSERT OR UPDATE ON staff_membership
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_staff_scope_completeness();

------------------------------------------------------------------------------
-- 5. Application-role grants — Slice posture: read/insert/update only,
-- no DELETE anywhere. Scope rows are append-only facts: INSERT + SELECT
-- only (their retirement is the membership's revocation, and retention
-- actions run under the elevated role).
------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON staff_invitation TO himma_app;
GRANT SELECT, INSERT, UPDATE ON staff_membership TO himma_app;
GRANT SELECT, INSERT ON staff_membership_branch TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops every S3-2 object.

DROP TABLE staff_membership_branch;
DROP TABLE staff_membership;
DROP TABLE staff_invitation;
DROP FUNCTION enforce_staff_scope_completeness();
DROP FUNCTION enforce_staff_scope_row();
DROP FUNCTION enforce_last_active_owner();
DROP FUNCTION enforce_staff_membership_transition();
DROP FUNCTION enforce_staff_invitation_transition();
