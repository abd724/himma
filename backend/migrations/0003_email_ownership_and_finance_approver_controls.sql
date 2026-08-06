-- 0003_email_ownership_and_finance_approver_controls — B2-1 correction
-- (owner directive 2026-08-06): (1) verified-email ownership is per USER, not
-- per identity row — one user may link multiple identities that legitimately
-- verify the same email, while two users can never both actively verify one
-- email; (2) finance-capable role activation requires distinct requesting and
-- approving users who BOTH hold currently active, unexpired access_admin
-- assignments, enforced in PostgreSQL under concurrency, with the docs/26
-- §7.5/§9.9 bootstrap preserved and no bypass for finance-capable grants.
-- Authority: docs/26 §3.5, §7.2, §7.4–7.5, §8.2, §8.7, §9.9; docs/25 §9.
-- Runs in one transaction. No PostgreSQL-18-only features.

-- Up Migration

------------------------------------------------------------------------------
-- 1. Verified-email ownership (guarantee 1)
--
-- The 0002 global partial unique index keyed ownership to the identity ROW,
-- wrongly preventing one user from linking two identities (e.g. Apple and
-- Google) that both report the same verified email. Replace it with an
-- exclusion constraint keyed to the USER: rows conflict only when the
-- normalized email matches AND the owning user differs. Enforced by the
-- index machinery itself, so concurrent cross-user claims admit exactly one
-- owner with no trigger or advisory lock. Unverified or ended rows stay
-- outside the predicate: duplicate claims coexist and never merge anything,
-- and identity matching remains issuer + subject (0002 constraints, untouched).
-- btree_gist supplies the gist opclasses (=, <>) for text/uuid; it is a
-- trusted core extension.
------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;

DROP INDEX uq_auth_identity_verified_email;

ALTER TABLE auth_identity
  ADD CONSTRAINT excl_auth_identity_verified_email_owner
  EXCLUDE USING gist ((lower(email)) WITH =, user_id WITH <>)
  WHERE (email_verified AND status = 'active');

COMMENT ON CONSTRAINT excl_auth_identity_verified_email_owner ON auth_identity IS
  'One normalized verified email belongs to at most one user (docs/26 §3.5): a user may hold several active identities verifying the same email; two users may not. Unverified/ended duplicates coexist and never merge accounts.';

------------------------------------------------------------------------------
-- 2. Finance-capable approver qualifications (guarantee 2)
--
-- Activation of a finance-capable role ('finance', 'access_admin') is valid
-- only when requested_by and approved_by are distinct users who each hold a
-- currently active, unexpired access_admin assignment. Enforced by a
-- DEFERRED constraint trigger (checked at commit) so the one-time bootstrap
-- transaction — seal plus two cross-witnessed access_admin rows (docs/26
-- §9.9) — validates itself with NO special-case bypass:
--
--   * qualifying assignments must PREDATE the activating transaction
--     (age(xmin) > 0), so two conspirators cannot self-qualify by inserting
--     a cross-referenced pair in one transaction;
--   * the single exception is the transaction that inserts the
--     bootstrap_seal row: there, same-transaction access_admin rows qualify
--     each other. The seal admits exactly one row ever (singleton PK +
--     forbid_mutation, 0002) and himma_app can only SELECT it, so this path
--     exists once, for the elevated bootstrap CLI, and can never recur;
--   * the exception applies only to rows whose own role is 'access_admin' —
--     the bootstrap structurally cannot create a finance role.
--
-- Concurrency: the check takes the same per-user advisory xact locks used by
-- the 0002 exclusivity trigger, and any transition of an access_admin row
-- out of 'active' takes that user's lock first (trigger below). A finance
-- activation committing after a concurrent revocation of its requester or
-- approver therefore re-reads the revoked state and fails; the reverse order
-- commits the grant before the revocation exists. Exactly one serial order.
------------------------------------------------------------------------------

CREATE FUNCTION serialize_access_admin_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'access_admin' AND OLD.state = 'active' AND NEW.state <> 'active' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('admin_role_assignment:' || OLD.user_id::text, 42));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_admin_role_assignment_release_lock
  BEFORE UPDATE ON admin_role_assignment
  FOR EACH ROW EXECUTE FUNCTION serialize_access_admin_release();

-- Post-activation rewriting (changing role, target, or recorded witnesses on
-- an existing row) would sidestep the activation-time checks entirely, so
-- the columns the checks reason about are immutable once written.
CREATE FUNCTION enforce_admin_role_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role
     OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION
      'admin_role_assignment user_id, role, and requested_by are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF (OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     OR (OLD.denied_by IS NOT NULL AND NEW.denied_by IS DISTINCT FROM OLD.denied_by)
     OR (OLD.revoked_by IS NOT NULL AND NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION
      'recorded admin_role_assignment witnesses (approved_by, denied_by, revoked_by) are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF OLD.state <> 'requested' AND NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION
      'admin_role_assignment expires_at may only change while the assignment is requested'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_admin_role_assignment_immutability
  BEFORE UPDATE ON admin_role_assignment
  FOR EACH ROW EXECUTE FUNCTION enforce_admin_role_immutability();

CREATE FUNCTION enforce_finance_activation_controls() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  assignment    admin_role_assignment%ROWTYPE;
  bootstrap_txn boolean;
  first_lock    uuid;
  second_lock   uuid;
  requester_ok  boolean;
  approver_ok   boolean;
BEGIN
  -- Deferred to commit: re-read the row's end-of-transaction state.
  SELECT * INTO assignment FROM admin_role_assignment a WHERE a.id = NEW.id;
  IF NOT FOUND OR assignment.state <> 'active'
     OR assignment.role NOT IN ('finance', 'access_admin') THEN
    RETURN NULL;
  END IF;
  IF assignment.approved_by IS NULL
     OR assignment.approved_by = assignment.requested_by THEN
    RAISE EXCEPTION
      'finance-capable activation requires distinct requesting and approving users (assignment %)',
      assignment.id
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Serialize against concurrent access_admin revocation/expiry: same
  -- per-user lock keys as the release trigger above, deterministic order.
  IF assignment.requested_by <= assignment.approved_by THEN
    first_lock := assignment.requested_by;
    second_lock := assignment.approved_by;
  ELSE
    first_lock := assignment.approved_by;
    second_lock := assignment.requested_by;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin_role_assignment:' || first_lock::text, 42));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin_role_assignment:' || second_lock::text, 42));

  bootstrap_txn := assignment.role = 'access_admin'
    AND EXISTS (SELECT 1 FROM bootstrap_seal s WHERE age(s.xmin) <= 0);

  SELECT EXISTS (
    SELECT 1 FROM admin_role_assignment a
    WHERE a.user_id = assignment.requested_by
      AND a.role = 'access_admin'
      AND a.state = 'active'
      AND (a.expires_at IS NULL OR a.expires_at > now())
      AND (bootstrap_txn OR age(a.xmin) > 0)
  ) INTO requester_ok;
  IF NOT requester_ok THEN
    RAISE EXCEPTION
      'finance-capable activation refused: requested_by % holds no active, unexpired access_admin assignment (assignment %)',
      assignment.requested_by, assignment.id
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM admin_role_assignment a
    WHERE a.user_id = assignment.approved_by
      AND a.role = 'access_admin'
      AND a.state = 'active'
      AND (a.expires_at IS NULL OR a.expires_at > now())
      AND (bootstrap_txn OR age(a.xmin) > 0)
  ) INTO approver_ok;
  IF NOT approver_ok THEN
    RAISE EXCEPTION
      'finance-capable activation refused: approved_by % holds no active, unexpired access_admin assignment (assignment %)',
      assignment.approved_by, assignment.id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_admin_role_assignment_finance_controls
  AFTER INSERT OR UPDATE ON admin_role_assignment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.state = 'active' AND NEW.role IN ('finance', 'access_admin'))
  EXECUTE FUNCTION enforce_finance_activation_controls();

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Restores the 0002 row-keyed verified-email index; that
-- recreate fails if a user has since linked two active identities sharing
-- one verified email — resolve such dev/test rows manually before rolling
-- back.

DROP TRIGGER trg_admin_role_assignment_finance_controls ON admin_role_assignment;
DROP TRIGGER trg_admin_role_assignment_immutability ON admin_role_assignment;
DROP TRIGGER trg_admin_role_assignment_release_lock ON admin_role_assignment;
DROP FUNCTION enforce_finance_activation_controls();
DROP FUNCTION enforce_admin_role_immutability();
DROP FUNCTION serialize_access_admin_release();
ALTER TABLE auth_identity DROP CONSTRAINT excl_auth_identity_verified_email_owner;
CREATE UNIQUE INDEX uq_auth_identity_verified_email
  ON auth_identity (lower(email))
  WHERE email_verified AND status = 'active';
DROP EXTENSION btree_gist;
