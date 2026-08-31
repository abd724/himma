-- 0020_membership_booking_and_multi_occurrence_attendance — S6-3 Final
-- Correction (docs/35 §25–§33; owner-approved correction plan `2b04c81`;
-- rulings D-S6-5 + D-S6-6 V1-required). Completes Backend Slice 6.
--
-- Exactly the two owner-ruled structural blockers, nothing else:
--
--  1. MEMBERSHIP RESERVATION BOOKING (D-S6-5): 0013's
--     `ck_booking_option_kind` predates the 0017 `membership` commercial
--     kind, so the reservation Booking row (whose option_kind copies the
--     reservation quote's) was unrepresentable. The CHECK is redefined in
--     place (the exact 0019 pattern). CHECK-only widening is sufficient
--     (docs/35 §25): `capacityPurchase` quotes structurally exclude
--     `membership` (ck_price_quote_shape), membership ACQUISITION quotes
--     are unit-less and therefore unholdable/unbookable, reservation
--     quotes are zero-total and can never gain a PaymentIntent
--     (enforce_payment_intent_amount), and every Booking-creating service
--     dispatches by quote shape — the only legal creator of a
--     membership-kind Booking is confirmEntitlementReservation.
--
--  2. CANONICAL MULTI-OCCURRENCE ATTENDANCE (D-S6-6): CampWeek and
--     EnrolmentCohort Bookings gain a durable canonical occurrence binding
--     on `redemption_credential` + `attendance_record`:
--     `occurrence_date` + `occurrence_start_time` (Asia/Dubai civil
--     identity — CampWeek: every span date × the single daily window;
--     Cohort: schedule-derived date+time, because two schedules may meet
--     the same civil date at different times, so date-only identity is
--     forbidden). The pair identifies the SCHEDULED occurrence; it is
--     never the actual redemption timestamp (`occurred_at`/`used_at`
--     remain that) and is immutable once written — an issued credential
--     freezes its occurrence for its lifetime (owner ruling: later
--     schedule edits retarget nothing). Session Bookings are UNCHANGED:
--     `session_id` stays their canonical occurrence and their partial
--     attendance unique is untouched.
--
-- Deliberately untouched: payment_intent, entitlement_purchase,
-- economics/commission, capacity units/counters, entitlement semantics,
-- entitlement_reservation, and every certified Session attendance
-- behavior. All existing rows are session- or walk-in-shaped (camp/cohort
-- issuance was fail-closed), so every redefined CHECK/index validates the
-- live data with ZERO rewrites.

-- Up Migration

------------------------------------------------------------------------------
-- 1. Membership reservation Booking widening (D-S6-5; the 0019 pattern).
------------------------------------------------------------------------------

ALTER TABLE booking DROP CONSTRAINT ck_booking_option_kind;
ALTER TABLE booking ADD CONSTRAINT ck_booking_option_kind
  CHECK (option_kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free',
                         'membership'));

------------------------------------------------------------------------------
-- 2. Canonical occurrence binding on redemption_credential.
------------------------------------------------------------------------------

-- The SCHEDULED occurrence this credential admits (never the redemption
-- instant): CampWeek = a span civil date + the camp's daily start time;
-- Cohort = a canonical schedule meeting's civil date + start time. NULL on
-- session-backed and walk-in credentials.
ALTER TABLE redemption_credential ADD COLUMN occurrence_date date;
ALTER TABLE redemption_credential ADD COLUMN occurrence_start_time time;

-- Four target forms, never half-populated occurrence identity:
--   walk-in entitlement  → session NULL, occurrence pair NULL;
--   session Booking      → session NOT NULL, occurrence pair NULL;
--   camp/cohort Booking  → session NULL, occurrence pair NOT NULL.
ALTER TABLE redemption_credential DROP CONSTRAINT ck_redemption_credential_occurrence;
ALTER TABLE redemption_credential ADD CONSTRAINT ck_redemption_credential_occurrence
  CHECK (
    ((occurrence_date IS NULL) = (occurrence_start_time IS NULL))
    AND ((booking_id IS NOT NULL AND num_nonnulls(session_id, occurrence_date) = 1)
         OR (booking_id IS NULL AND session_id IS NULL AND occurrence_date IS NULL))
  );

-- One LIVE credential per fulfillment target, occurrence-scoped for
-- multi-occurrence Bookings (adjacent cohort occurrences' ±60-minute
-- windows may legally overlap, so different-occurrence credentials must be
-- able to coexist; a broad one-live-per-Booking unique would be wrong).
DROP INDEX uq_redemption_credential_live_booking;
CREATE UNIQUE INDEX uq_redemption_credential_live_session_booking
  ON redemption_credential (booking_id)
  WHERE state = 'live' AND booking_id IS NOT NULL AND session_id IS NOT NULL;
CREATE UNIQUE INDEX uq_redemption_credential_live_occurrence
  ON redemption_credential (booking_id, occurrence_date, occurrence_start_time)
  WHERE state = 'live' AND occurrence_date IS NOT NULL;

-- Insert shape: live-only creation; target org/branch/occurrence must be
-- the target row's CANONICAL truth at issuance — a foreign org, an
-- out-of-span camp date, a wrong daily time, a non-pattern cohort meeting,
-- or an exception date is refused at the row level, whatever any service
-- claims. (The service validates first; this is the structural backstop.)
CREATE OR REPLACE FUNCTION enforce_redemption_credential_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b record;
  t record;
  cohort_occurrence_ok boolean;
BEGIN
  IF NEW.state <> 'live' THEN
    RAISE EXCEPTION 'redemption_credential must be created live (%)', NEW.state;
  END IF;
  IF NEW.booking_id IS NOT NULL THEN
    SELECT bk.organization_id, bk.session_id, bk.camp_week_id, bk.cohort_id,
           s.branch_id AS session_branch_id,
           cw.branch_id AS camp_branch_id, cw.start_date AS camp_start,
           cw.end_date AS camp_end, cw.daily_start_time AS camp_daily_start,
           ec.branch_id AS cohort_branch_id, ec.effective_start AS cohort_start,
           ec.effective_end AS cohort_end
      INTO b
      FROM booking bk
      LEFT JOIN session s ON s.id = bk.session_id
      LEFT JOIN camp_week cw ON cw.id = bk.camp_week_id
      LEFT JOIN enrolment_cohort ec ON ec.id = bk.cohort_id
     WHERE bk.id = NEW.booking_id;
    IF b IS NULL THEN
      RAISE EXCEPTION 'redemption_credential booking % not found', NEW.booking_id;
    END IF;
    IF b.organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'credential org/occurrence/branch must equal the booking''s (%)',
        NEW.booking_id;
    END IF;
    IF b.session_id IS NOT NULL THEN
      -- Session Booking: the Session IS the canonical occurrence
      -- (unchanged S6-2 semantics; no occurrence pair may ride along).
      IF NEW.session_id IS DISTINCT FROM b.session_id
         OR NEW.occurrence_date IS NOT NULL OR NEW.occurrence_start_time IS NOT NULL
         OR b.session_branch_id IS DISTINCT FROM NEW.branch_id THEN
        RAISE EXCEPTION 'credential org/occurrence/branch must equal the booking''s (%)',
          NEW.booking_id;
      END IF;
    ELSIF b.camp_week_id IS NOT NULL THEN
      -- CampWeek: every span civil date is a running occurrence at the
      -- camp's single daily window (docs/35 §26 — no closure semantics
      -- exist in V1 and none are invented here).
      IF NEW.session_id IS NOT NULL
         OR NEW.occurrence_date IS NULL OR NEW.occurrence_start_time IS NULL
         OR NEW.occurrence_date < b.camp_start OR NEW.occurrence_date > b.camp_end
         OR NEW.occurrence_start_time <> b.camp_daily_start
         OR b.camp_branch_id IS DISTINCT FROM NEW.branch_id THEN
        RAISE EXCEPTION 'credential occurrence must be a canonical camp day of the booking''s span (%)',
          NEW.booking_id;
      END IF;
    ELSE
      -- Cohort: the occurrence pair must be generated by the CURRENT
      -- canonical meeting model (active association → active schedule ∩
      -- windows, weekday match, minus exceptions — docs/35 §27). Once the
      -- row exists the pair is frozen (transition trigger): later
      -- schedule edits never retarget an issued credential.
      IF NEW.session_id IS NOT NULL
         OR NEW.occurrence_date IS NULL OR NEW.occurrence_start_time IS NULL
         OR b.cohort_branch_id IS DISTINCT FROM NEW.branch_id
         OR NEW.occurrence_date < b.cohort_start OR NEW.occurrence_date > b.cohort_end THEN
        RAISE EXCEPTION 'credential occurrence must be a canonical cohort meeting of the booking''s cohort (%)',
          NEW.booking_id;
      END IF;
      SELECT EXISTS (
        SELECT 1
          FROM enrolment_cohort_schedule ecs
          JOIN recurring_schedule rs ON rs.id = ecs.schedule_id
         WHERE ecs.cohort_id = b.cohort_id
           AND ecs.active = true AND rs.state = 'active'
           AND rs.start_time = NEW.occurrence_start_time
           AND EXTRACT(DOW FROM NEW.occurrence_date)::smallint = ANY (rs.weekdays)
           AND NEW.occurrence_date >= rs.effective_start
           AND (rs.effective_end IS NULL OR NEW.occurrence_date <= rs.effective_end)
           AND NOT (NEW.occurrence_date = ANY (rs.exception_dates))
      ) INTO cohort_occurrence_ok;
      IF NOT cohort_occurrence_ok THEN
        RAISE EXCEPTION 'credential occurrence must be a canonical cohort meeting of the booking''s cohort (%)',
          NEW.booking_id;
      END IF;
    END IF;
  ELSE
    SELECT organization_id, branch_id INTO t FROM entitlement WHERE id = NEW.entitlement_id;
    IF t.organization_id <> NEW.organization_id
       OR t.branch_id IS DISTINCT FROM NEW.branch_id THEN
      RAISE EXCEPTION 'credential org/branch must equal the entitlement''s (%)',
        NEW.entitlement_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Lifecycle: the occurrence pair joins the frozen identity columns — an
-- issued credential's occurrence can never be retargeted.
CREATE OR REPLACE FUNCTION enforce_redemption_credential_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.token_digest <> OLD.token_digest
     OR NEW.alias_digest <> OLD.alias_digest
     OR NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.occurrence_date IS DISTINCT FROM OLD.occurrence_date
     OR NEW.occurrence_start_time IS DISTINCT FROM OLD.occurrence_start_time
     OR NEW.account_id <> OLD.account_id OR NEW.participant_id <> OLD.participant_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'redemption_credential identity columns are immutable (%)', OLD.id;
  END IF;
  IF OLD.state <> 'live' THEN
    RAISE EXCEPTION 'redemption_credential % is terminal (%) and immutable', OLD.id, OLD.state;
  END IF;
  IF NEW.state = OLD.state THEN
    RAISE EXCEPTION 'redemption_credential % permits state transitions only', OLD.id;
  END IF;
  RETURN NEW;
END $$;

------------------------------------------------------------------------------
-- 3. Canonical occurrence binding on attendance_record.
------------------------------------------------------------------------------

-- The SCHEDULED occurrence this attendance fulfilled — copied from (and
-- trigger-proven equal to) the consumed credential's frozen pair.
-- `occurred_at` remains the actual redemption instant: a redemption at
-- Sunday 23:50 inside Monday 00:30's −60 window stays bound to MONDAY's
-- occurrence (docs/35 §28 — occurrence identity is never derived from the
-- redemption timestamp).
ALTER TABLE attendance_record ADD COLUMN occurrence_date date;
ALTER TABLE attendance_record ADD COLUMN occurrence_start_time time;

ALTER TABLE attendance_record ADD CONSTRAINT ck_attendance_record_occurrence
  CHECK (
    ((occurrence_date IS NULL) = (occurrence_start_time IS NULL))
    AND (occurrence_date IS NULL OR (booking_id IS NOT NULL AND session_id IS NULL))
  );

-- One attendance per participant/Booking/canonical occurrence (one
-- participant per Booking is certified D-2): the same camp day or the same
-- cohort meeting can never be attended twice, while every OTHER valid
-- occurrence of the same Booking stays separately attendable. The time
-- component is load-bearing for cohorts (two legitimate meetings may share
-- a civil date); the session-backed partial unique is untouched.
CREATE UNIQUE INDEX uq_attendance_record_occurrence_booking
  ON attendance_record (booking_id, occurrence_date, occurrence_start_time)
  WHERE occurrence_date IS NOT NULL;

-- Attendance ↔ credential agreement extends to the occurrence pair: the
-- recorded occurrence is provably the CREDENTIAL's frozen occurrence —
-- neither provider nor client can substitute another occurrence at redeem.
CREATE OR REPLACE FUNCTION enforce_attendance_record_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  reservation_entitlement uuid;
  finite_total integer;
  consumed bigint;
BEGIN
  SELECT state, entitlement_id, booking_id, session_id, occurrence_date,
         occurrence_start_time, account_id, participant_id, organization_id
    INTO c FROM redemption_credential WHERE id = NEW.credential_id;
  IF c IS NULL THEN
    RAISE EXCEPTION 'attendance credential % not found', NEW.credential_id;
  END IF;
  IF c.state <> 'used' THEN
    RAISE EXCEPTION 'attendance requires a consumed credential (% is %)',
      NEW.credential_id, c.state;
  END IF;
  IF c.account_id <> NEW.account_id OR c.participant_id <> NEW.participant_id
     OR c.organization_id <> NEW.organization_id
     OR c.booking_id IS DISTINCT FROM NEW.booking_id
     OR c.session_id IS DISTINCT FROM NEW.session_id
     OR c.occurrence_date IS DISTINCT FROM NEW.occurrence_date
     OR c.occurrence_start_time IS DISTINCT FROM NEW.occurrence_start_time THEN
    RAISE EXCEPTION 'attendance identity must equal its credential''s (%)', NEW.credential_id;
  END IF;
  -- Entitlement linkage: walk-in = the credential's entitlement; a
  -- reserved-use Booking = the reservation's entitlement; plain Booking =
  -- none.
  IF NEW.booking_id IS NOT NULL THEN
    SELECT entitlement_id INTO reservation_entitlement
      FROM entitlement_reservation WHERE booking_id = NEW.booking_id;
    IF reservation_entitlement IS DISTINCT FROM NEW.entitlement_id THEN
      RAISE EXCEPTION 'attendance entitlement must equal the booking reservation''s (%)',
        NEW.booking_id;
    END IF;
  ELSIF c.entitlement_id IS DISTINCT FROM NEW.entitlement_id THEN
    RAISE EXCEPTION 'attendance entitlement must equal its credential''s (%)',
      NEW.credential_id;
  END IF;
  -- Finite floor backstop: consuming rows can never exceed uses_total
  -- (the service proves availability under the entitlement lock; this is
  -- the final structural authority, like the capacity CHECK).
  IF NEW.entitlement_id IS NOT NULL THEN
    SELECT uses_total INTO finite_total FROM entitlement WHERE id = NEW.entitlement_id;
    IF finite_total IS NOT NULL THEN
      SELECT count(*) INTO consumed FROM attendance_record
        WHERE entitlement_id = NEW.entitlement_id;
      IF consumed >= finite_total THEN
        RAISE EXCEPTION 'finite entitlement % has no remaining uses', NEW.entitlement_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). FAIL-CLOSED PREFLIGHT (the 0017/0018/0019 discipline —
-- the FIRST down statement, before any destructive DDL): refuse whenever
-- the database is not representable by the pre-0020 schema — a
-- membership-kind Booking (the restored CHECK cannot hold it) or any
-- occurrence-stamped credential/attendance row (the dropped columns carry
-- canonical fulfillment history). Commercial and attendance truth is never
-- silently deleted or transformed.

DO $$
DECLARE
  membership_bookings     bigint;
  occurrence_credentials  bigint;
  occurrence_attendance   bigint;
BEGIN
  SELECT count(*) INTO membership_bookings
    FROM booking WHERE option_kind = 'membership';
  SELECT count(*) INTO occurrence_credentials
    FROM redemption_credential WHERE occurrence_date IS NOT NULL;
  SELECT count(*) INTO occurrence_attendance
    FROM attendance_record WHERE occurrence_date IS NOT NULL;
  IF membership_bookings > 0 OR occurrence_credentials > 0 OR occurrence_attendance > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'Downgrade of 0020 refused: 0020-native data exists that the pre-0020 schema cannot represent (membership bookings=%s, occurrence-stamped credentials=%s, occurrence-stamped attendance=%s). Commercial/attendance truth is never silently destroyed — roll forward instead (docs/25 §9; docs/35 §32).',
      membership_bookings, occurrence_credentials, occurrence_attendance);
  END IF;
END $$;

ALTER TABLE booking DROP CONSTRAINT ck_booking_option_kind;
ALTER TABLE booking ADD CONSTRAINT ck_booking_option_kind
  CHECK (option_kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free'));

DROP INDEX uq_attendance_record_occurrence_booking;
DROP INDEX uq_redemption_credential_live_occurrence;
DROP INDEX uq_redemption_credential_live_session_booking;
CREATE UNIQUE INDEX uq_redemption_credential_live_booking
  ON redemption_credential (booking_id) WHERE state = 'live' AND booking_id IS NOT NULL;

-- Restore the exact 0018 trigger functions (no occurrence references)
-- BEFORE dropping the columns they would otherwise mention.
CREATE OR REPLACE FUNCTION enforce_redemption_credential_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t record;
BEGIN
  IF NEW.state <> 'live' THEN
    RAISE EXCEPTION 'redemption_credential must be created live (%)', NEW.state;
  END IF;
  IF NEW.booking_id IS NOT NULL THEN
    SELECT b.organization_id, b.session_id, s.branch_id
      INTO t FROM booking b LEFT JOIN session s ON s.id = b.session_id
      WHERE b.id = NEW.booking_id;
    IF t.session_id IS NULL THEN
      RAISE EXCEPTION 'booking-target credentials require a Session occurrence (%)',
        NEW.booking_id;
    END IF;
    IF t.organization_id <> NEW.organization_id OR t.session_id <> NEW.session_id
       OR t.branch_id IS DISTINCT FROM NEW.branch_id THEN
      RAISE EXCEPTION 'credential org/occurrence/branch must equal the booking''s (%)',
        NEW.booking_id;
    END IF;
  ELSE
    SELECT organization_id, branch_id INTO t FROM entitlement WHERE id = NEW.entitlement_id;
    IF t.organization_id <> NEW.organization_id
       OR t.branch_id IS DISTINCT FROM NEW.branch_id THEN
      RAISE EXCEPTION 'credential org/branch must equal the entitlement''s (%)',
        NEW.entitlement_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_redemption_credential_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.token_digest <> OLD.token_digest
     OR NEW.alias_digest <> OLD.alias_digest
     OR NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.account_id <> OLD.account_id OR NEW.participant_id <> OLD.participant_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'redemption_credential identity columns are immutable (%)', OLD.id;
  END IF;
  IF OLD.state <> 'live' THEN
    RAISE EXCEPTION 'redemption_credential % is terminal (%) and immutable', OLD.id, OLD.state;
  END IF;
  IF NEW.state = OLD.state THEN
    RAISE EXCEPTION 'redemption_credential % permits state transitions only', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_attendance_record_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  reservation_entitlement uuid;
  finite_total integer;
  consumed bigint;
BEGIN
  SELECT state, entitlement_id, booking_id, session_id, account_id, participant_id,
         organization_id
    INTO c FROM redemption_credential WHERE id = NEW.credential_id;
  IF c IS NULL THEN
    RAISE EXCEPTION 'attendance credential % not found', NEW.credential_id;
  END IF;
  IF c.state <> 'used' THEN
    RAISE EXCEPTION 'attendance requires a consumed credential (% is %)',
      NEW.credential_id, c.state;
  END IF;
  IF c.account_id <> NEW.account_id OR c.participant_id <> NEW.participant_id
     OR c.organization_id <> NEW.organization_id
     OR c.booking_id IS DISTINCT FROM NEW.booking_id
     OR c.session_id IS DISTINCT FROM NEW.session_id THEN
    RAISE EXCEPTION 'attendance identity must equal its credential''s (%)', NEW.credential_id;
  END IF;
  IF NEW.booking_id IS NOT NULL THEN
    SELECT entitlement_id INTO reservation_entitlement
      FROM entitlement_reservation WHERE booking_id = NEW.booking_id;
    IF reservation_entitlement IS DISTINCT FROM NEW.entitlement_id THEN
      RAISE EXCEPTION 'attendance entitlement must equal the booking reservation''s (%)',
        NEW.booking_id;
    END IF;
  ELSIF c.entitlement_id IS DISTINCT FROM NEW.entitlement_id THEN
    RAISE EXCEPTION 'attendance entitlement must equal its credential''s (%)',
      NEW.credential_id;
  END IF;
  IF NEW.entitlement_id IS NOT NULL THEN
    SELECT uses_total INTO finite_total FROM entitlement WHERE id = NEW.entitlement_id;
    IF finite_total IS NOT NULL THEN
      SELECT count(*) INTO consumed FROM attendance_record
        WHERE entitlement_id = NEW.entitlement_id;
      IF consumed >= finite_total THEN
        RAISE EXCEPTION 'finite entitlement % has no remaining uses', NEW.entitlement_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE attendance_record DROP CONSTRAINT ck_attendance_record_occurrence;
ALTER TABLE attendance_record DROP COLUMN occurrence_start_time;
ALTER TABLE attendance_record DROP COLUMN occurrence_date;

ALTER TABLE redemption_credential DROP CONSTRAINT ck_redemption_credential_occurrence;
ALTER TABLE redemption_credential ADD CONSTRAINT ck_redemption_credential_occurrence
  CHECK ((booking_id IS NULL) = (session_id IS NULL));
ALTER TABLE redemption_credential DROP COLUMN occurrence_start_time;
ALTER TABLE redemption_credential DROP COLUMN occurrence_date;
