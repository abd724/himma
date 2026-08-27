-- 0019_membership_program_revision_kind — W2-13 owner-review correction
-- (docs/35 W2-13 record; owner-authorized migration).
--
-- The SINGLE structural widening required for the already-approved
-- `membership` commercial price kind (0017, D-S6-3) to be REPRESENTED
-- through the canonical ProgramRevision moderation path exactly like the
-- other commercial option kinds: 0008's ck_program_revision_option_kind
-- predates `membership`, so a review-gated (protected) listing could not
-- carry a membership option change through review — W2-13 fail-closed that
-- path with a typed refusal pending this migration.
--
-- Scope (deliberately nothing else):
--  * program_revision.option_kind may now be 'membership' — the same
--    vocabulary the live program_price_option and price_quote CHECKs
--    already carry since 0017.
--  * `membership` stays COMMERCIAL vocabulary only. NO fulfillment
--    semantics (finite/unlimited, uses, validity, walk-in/reservation,
--    branch, schedule terms) enter ProgramRevision — those live
--    exclusively on the immutable price_option_fulfillment_revision model
--    (docs/35 §3) and are administered under listings.manage.
--  * Booking/capacity/EntitlementPurchase/Entitlement/redemption/
--    attendance/payment/commission are untouched.

-- Up Migration

ALTER TABLE program_revision DROP CONSTRAINT ck_program_revision_option_kind;
ALTER TABLE program_revision ADD CONSTRAINT ck_program_revision_option_kind
  CHECK (option_kind IS NULL
    OR option_kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free',
                       'membership'));

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). FAIL-CLOSED PREFLIGHT (the approved 0017/0018
-- precedent): the pre-correction constraint cannot represent a persisted
-- `membership` revision, so the downgrade refuses BEFORE any DDL whenever
-- such rows exist — membership revision/review history is never silently
-- deleted, rewritten to another kind, or discarded. With no membership
-- revision state, the exact prior constraint is restored cleanly.

DO $$
DECLARE
  membership_revisions bigint;
BEGIN
  SELECT count(*) INTO membership_revisions
    FROM program_revision WHERE option_kind = 'membership';
  IF membership_revisions > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'Downgrade of 0019 refused: %s program_revision row(s) carry option_kind=''membership'', which the pre-0019 ck_program_revision_option_kind cannot represent. Review history is never silently destroyed or rewritten — roll forward instead (docs/25 §9; docs/35 W2-13 record).',
      membership_revisions);
  END IF;
END $$;

ALTER TABLE program_revision DROP CONSTRAINT ck_program_revision_option_kind;
ALTER TABLE program_revision ADD CONSTRAINT ck_program_revision_option_kind
  CHECK (option_kind IS NULL
    OR option_kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free'));
