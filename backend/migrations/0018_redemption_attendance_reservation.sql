-- 0018_redemption_attendance_reservation — W4 Slice 6 · S6-2
-- (docs/35 §7, §9, §10, §21 — owner-approved at S6-0 closure `3b7d770`;
-- S6-1 closed `0f44f98`; owner S6-2 directive items 3–8, 17–22, 25–26, 34).
--
-- The S6-2 structural foundation:
--
--  * entitlement_reservation — STRUCTURE ONLY (S6-3 owns operational
--    creation): the subtype binding exactly one Entitlement to exactly one
--    capacity Booking, ownership/lineage composite-FK-pinned. Commitment
--    liveness stays DERIVED (docs/35 §7) — no mutable status column.
--  * redemption_credential — the short-lived one-time check-in authority:
--    canonical secret = a ≥128-bit opaque token stored ONLY as a digest;
--    the 8-digit numeric code is a short-lived org-scoped ALIAS (digest
--    only); exactly one LIVE credential per fulfillment target; exactly
--    one of (entitlement | booking) as the target; lifecycle
--    live → used | superseded | expired with terminals frozen; effective
--    expiry (`expires_at <= now()`) is unusable regardless of lifecycle
--    cleanup — correctness never depends on a sweeper.
--  * attendance_record — append-only attendance truth: credential_id
--    UNIQUE is the structural single-use backstop; a BEFORE INSERT trigger
--    pins attendance ↔ credential ↔ reservation agreement and the finite
--    floor; one attendance per session-backed Booking occurrence
--    (deliberately PARTIAL — future camp/cohort occurrence-scoped
--    attendance stays representable, docs/35 §10 / owner item 21).
--  * redemption_lookup_attempt — the DURABLE anti-brute-force window
--    (owner item 25): PostgreSQL-backed fixed-window failure counting per
--    provider principal + organization — correct across horizontally
--    scaled instances by construction (the identity RateLimiterStore is
--    in-memory and production-refusing, so it cannot carry this).
--
-- Additive certified-table changes (the 0004/0015 pattern — pure FK
-- targets, no new row constraint): booking + entitlement each gain an
-- (id, account_id, participant_id) unique so credentials/reservations pin
-- ownership structurally.
--
-- Deliberately ABSENT: reservation creation/`availableToReserve`/calendar
-- (S6-3); no-show/penalty/correction workflows (deferred with the owner);
-- QR ingestion (the token authority is QR-ready; rendering arrives later);
-- any payment/commission linkage (attendance is fulfillment of an
-- already-purchased entitlement — commission occurred once at sale).

-- Up Migration

------------------------------------------------------------------------------
-- 0. Additive composite-FK targets on certified tables.
------------------------------------------------------------------------------

ALTER TABLE booking
  ADD CONSTRAINT uq_booking_id_account_participant UNIQUE (id, account_id, participant_id);
ALTER TABLE entitlement
  ADD CONSTRAINT uq_entitlement_id_account_participant UNIQUE (id, account_id, participant_id);

------------------------------------------------------------------------------
-- 1. entitlement_reservation — the reserved-use subtype (structure only).
------------------------------------------------------------------------------

CREATE TABLE entitlement_reservation (
  booking_id      uuid        NOT NULL,
  entitlement_id  uuid        NOT NULL,
  account_id      uuid        NOT NULL,
  participant_id  uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  program_id      uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_entitlement_reservation PRIMARY KEY (booking_id),
  -- The Booking is the occurrence/capacity lineage carrier (exactly-one
  -- unit by the certified CHECK) and must belong to the SAME account +
  -- participant as the entitlement (both composite FKs below).
  CONSTRAINT fk_entitlement_reservation_booking
    FOREIGN KEY (booking_id, account_id, participant_id)
    REFERENCES booking (id, account_id, participant_id),
  CONSTRAINT fk_entitlement_reservation_entitlement
    FOREIGN KEY (entitlement_id, account_id, participant_id, organization_id, program_id)
    REFERENCES entitlement (id, account_id, participant_id, organization_id, program_id),
  CONSTRAINT fk_entitlement_reservation_org FOREIGN KEY (organization_id)
    REFERENCES organization (id)
);
COMMENT ON TABLE entitlement_reservation IS
  'docs/35 §7 (S6-2 structure; S6-3 operation): a finite-entitlement unit temporarily allocated to ONE future capacity Booking. Commitment/fulfilled/released/no-show status is DERIVED from the Booking state + occurrence time + attendance — no mutable status column exists. Created operationally only by the S6-3 confirmEntitlementReservation authority (no route/command exists in S6-2; tests use a bounded fixture seam).';

CREATE INDEX ix_entitlement_reservation_entitlement
  ON entitlement_reservation (entitlement_id);

-- The Booking's org/program must equal the reservation's (and therefore
-- the entitlement's — the 5-column FK pins those).
CREATE FUNCTION enforce_entitlement_reservation_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b record;
BEGIN
  SELECT organization_id, program_id, state INTO b FROM booking WHERE id = NEW.booking_id;
  IF b IS NULL THEN
    RAISE EXCEPTION 'entitlement_reservation booking % not found', NEW.booking_id;
  END IF;
  IF b.organization_id <> NEW.organization_id OR b.program_id <> NEW.program_id THEN
    RAISE EXCEPTION 'entitlement_reservation lineage must equal its booking''s (%)',
      NEW.booking_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_entitlement_reservation_shape
  BEFORE INSERT ON entitlement_reservation
  FOR EACH ROW EXECUTE FUNCTION enforce_entitlement_reservation_shape();
CREATE TRIGGER trg_entitlement_reservation_append_only
  BEFORE UPDATE OR DELETE ON entitlement_reservation
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 2. redemption_credential — the one-time short-lived check-in authority.
------------------------------------------------------------------------------

CREATE TABLE redemption_credential (
  id             uuid        NOT NULL,
  -- sha256 digest of the ≥128-bit opaque canonical token (QR-ready). The
  -- raw token exists only in the issuance response — never at rest.
  token_digest   text        NOT NULL,
  -- sha256 digest of (organization_id || ':' || 8-digit alias): numeric
  -- lookup is org-scoped by construction; the raw alias is never stored.
  alias_digest   text        NOT NULL,
  entitlement_id uuid,
  booking_id     uuid,
  -- The canonical scheduled occurrence (Session) when booking-targeted.
  session_id     uuid,
  account_id     uuid        NOT NULL,
  participant_id uuid        NOT NULL,
  organization_id uuid       NOT NULL,
  branch_id      uuid,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  state          text        NOT NULL DEFAULT 'live',
  used_at        timestamptz,
  redeemed_by_staff_membership_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_redemption_credential PRIMARY KEY (id),
  -- One canonical secret maps to at most one credential, ever.
  CONSTRAINT uq_redemption_credential_token UNIQUE (token_digest),
  CONSTRAINT fk_redemption_credential_entitlement
    FOREIGN KEY (entitlement_id, account_id, participant_id)
    REFERENCES entitlement (id, account_id, participant_id),
  CONSTRAINT fk_redemption_credential_booking
    FOREIGN KEY (booking_id, account_id, participant_id)
    REFERENCES booking (id, account_id, participant_id),
  CONSTRAINT fk_redemption_credential_session FOREIGN KEY (session_id, organization_id)
    REFERENCES session (id, organization_id),
  CONSTRAINT fk_redemption_credential_account FOREIGN KEY (account_id)
    REFERENCES customer_account (id),
  CONSTRAINT fk_redemption_credential_participant
    FOREIGN KEY (participant_id, account_id) REFERENCES participant (id, account_id),
  CONSTRAINT fk_redemption_credential_org FOREIGN KEY (organization_id)
    REFERENCES organization (id),
  CONSTRAINT fk_redemption_credential_branch
    FOREIGN KEY (branch_id, organization_id) REFERENCES branch (id, organization_id),
  CONSTRAINT fk_redemption_credential_staff
    FOREIGN KEY (redeemed_by_staff_membership_id, organization_id)
    REFERENCES staff_membership (id, organization_id),
  -- Exactly ONE unambiguous fulfillment target (docs/35 §9): walk-in
  -- entitlement XOR (plain or reserved) Booking. No generic target JSON.
  CONSTRAINT ck_redemption_credential_one_target
    CHECK (num_nonnulls(entitlement_id, booking_id) = 1),
  -- Booking targets carry their occurrence; walk-ins carry none.
  CONSTRAINT ck_redemption_credential_occurrence
    CHECK ((booking_id IS NULL) = (session_id IS NULL)),
  CONSTRAINT ck_redemption_credential_state
    CHECK (state IN ('live', 'used', 'superseded', 'expired')),
  CONSTRAINT ck_redemption_credential_used_facts
    CHECK ((state = 'used') = (used_at IS NOT NULL)
           AND (state = 'used') = (redeemed_by_staff_membership_id IS NOT NULL)),
  CONSTRAINT ck_redemption_credential_ttl CHECK (expires_at > issued_at),
  CONSTRAINT ck_redemption_credential_version CHECK (version >= 1)
);
COMMENT ON TABLE redemption_credential IS
  'docs/35 §9: the customer-generated one-time short-lived check-in authority. The CANONICAL secret is the high-entropy opaque token (digest-stored; QR-ready without domain change); the 8-digit numeric code is a short-lived org-scoped human alias (digest-stored). Default TTL 10 min (service config). Issuing/expiry/supersession consume NOTHING; only successful provider redemption terminalizes to used. `expires_at <= now()` is unusable regardless of lifecycle cleanup — no sweeper is required for correctness.';

-- Exactly one LIVE credential per fulfillment target; alias collision
-- safety among an organization's live credentials.
CREATE UNIQUE INDEX uq_redemption_credential_live_entitlement
  ON redemption_credential (entitlement_id) WHERE state = 'live' AND entitlement_id IS NOT NULL;
CREATE UNIQUE INDEX uq_redemption_credential_live_booking
  ON redemption_credential (booking_id) WHERE state = 'live' AND booking_id IS NOT NULL;
CREATE UNIQUE INDEX uq_redemption_credential_live_alias
  ON redemption_credential (organization_id, alias_digest) WHERE state = 'live';
CREATE INDEX ix_redemption_credential_account ON redemption_credential (account_id, created_at);

-- Insert shape: live-only creation; target org/branch/occurrence must be
-- the target row's truth (a foreign org or wrong occurrence is refused at
-- the row level, whatever any service claims).
CREATE FUNCTION enforce_redemption_credential_shape() RETURNS trigger
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
CREATE TRIGGER trg_redemption_credential_shape
  BEFORE INSERT ON redemption_credential
  FOR EACH ROW EXECUTE FUNCTION enforce_redemption_credential_shape();

-- Lifecycle: identity/secrets frozen; live → used | superseded | expired;
-- terminals frozen; no DELETE.
CREATE FUNCTION enforce_redemption_credential_transition() RETURNS trigger
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
CREATE TRIGGER trg_redemption_credential_updated_at
  BEFORE UPDATE ON redemption_credential FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_redemption_credential_version
  BEFORE UPDATE ON redemption_credential FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_redemption_credential_transition
  BEFORE UPDATE ON redemption_credential
  FOR EACH ROW EXECUTE FUNCTION enforce_redemption_credential_transition();
CREATE TRIGGER trg_redemption_credential_no_delete
  BEFORE DELETE ON redemption_credential FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 3. attendance_record — append-only attendance truth.
------------------------------------------------------------------------------

CREATE TABLE attendance_record (
  id              uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  branch_id       uuid,
  account_id      uuid        NOT NULL,
  participant_id  uuid        NOT NULL,
  entitlement_id  uuid,
  booking_id      uuid,
  session_id      uuid,
  credential_id   uuid        NOT NULL,
  validated_by_staff_membership_id uuid NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  source          text        NOT NULL DEFAULT 'numericCode',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_attendance_record PRIMARY KEY (id),
  -- THE single-use structural backstop: one credential → at most one
  -- attendance, across every retry/instance/race.
  CONSTRAINT uq_attendance_record_credential UNIQUE (credential_id),
  CONSTRAINT fk_attendance_record_credential FOREIGN KEY (credential_id)
    REFERENCES redemption_credential (id),
  CONSTRAINT fk_attendance_record_org FOREIGN KEY (organization_id)
    REFERENCES organization (id),
  CONSTRAINT fk_attendance_record_branch
    FOREIGN KEY (branch_id, organization_id) REFERENCES branch (id, organization_id),
  CONSTRAINT fk_attendance_record_participant
    FOREIGN KEY (participant_id, account_id) REFERENCES participant (id, account_id),
  CONSTRAINT fk_attendance_record_entitlement
    FOREIGN KEY (entitlement_id, account_id, participant_id)
    REFERENCES entitlement (id, account_id, participant_id),
  CONSTRAINT fk_attendance_record_booking
    FOREIGN KEY (booking_id, account_id, participant_id)
    REFERENCES booking (id, account_id, participant_id),
  CONSTRAINT fk_attendance_record_session FOREIGN KEY (session_id, organization_id)
    REFERENCES session (id, organization_id),
  CONSTRAINT fk_attendance_record_staff
    FOREIGN KEY (validated_by_staff_membership_id, organization_id)
    REFERENCES staff_membership (id, organization_id),
  -- At least one fulfillment authority; both for reserved entitlement use.
  CONSTRAINT ck_attendance_record_target
    CHECK (num_nonnulls(entitlement_id, booking_id) >= 1),
  CONSTRAINT ck_attendance_record_source CHECK (source IN ('numericCode', 'qr'))
);
COMMENT ON TABLE attendance_record IS
  'docs/35 §10: append-only attendance truth — the ONLY V1 usage-consumption authority (no-show consumes nothing; corrections are future append-only reversals). credential_id UNIQUE = structural single-use. Finite usage derives from counting entitlement-consuming rows — never a mutable used-counter. One attendance per session-backed Booking occurrence (partial unique); camp/cohort occurrence-scoped attendance is S6-3 work and stays representable.';

-- One attendance per canonical session occurrence of a Booking. PARTIAL by
-- design (owner item 21): future camp/cohort bookings may legitimately
-- carry multiple occurrence-scoped attendances once S6-3 materializes
-- their occurrence identity.
CREATE UNIQUE INDEX uq_attendance_record_session_booking
  ON attendance_record (booking_id) WHERE booking_id IS NOT NULL AND session_id IS NOT NULL;
CREATE INDEX ix_attendance_record_entitlement
  ON attendance_record (entitlement_id) WHERE entitlement_id IS NOT NULL;
CREATE INDEX ix_attendance_record_org ON attendance_record (organization_id, occurred_at);

-- Attendance ↔ credential ↔ reservation agreement + the finite floor
-- backstop, at the row level.
CREATE FUNCTION enforce_attendance_record_shape() RETURNS trigger
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
CREATE TRIGGER trg_attendance_record_shape
  BEFORE INSERT ON attendance_record
  FOR EACH ROW EXECUTE FUNCTION enforce_attendance_record_shape();
CREATE TRIGGER trg_attendance_record_append_only
  BEFORE UPDATE OR DELETE ON attendance_record
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 4. redemption_lookup_attempt — durable brute-force windows (owner item
--    25): fixed-window failure counting per provider principal + org.
--    Operational counters, not commercial history.
------------------------------------------------------------------------------

CREATE TABLE redemption_lookup_attempt (
  principal_ref   text        NOT NULL,
  organization_id uuid        NOT NULL,
  window_start    timestamptz NOT NULL,
  failures        integer     NOT NULL DEFAULT 0,
  CONSTRAINT pk_redemption_lookup_attempt
    PRIMARY KEY (principal_ref, organization_id, window_start),
  CONSTRAINT fk_redemption_lookup_attempt_org FOREIGN KEY (organization_id)
    REFERENCES organization (id),
  CONSTRAINT ck_redemption_lookup_attempt_failures CHECK (failures >= 0)
);
COMMENT ON TABLE redemption_lookup_attempt IS
  'S6-2 durable anti-brute-force windows (docs/35 §16): failed org-scoped code lookups per provider principal per fixed window. Shared across application instances by construction (PostgreSQL-backed — the identity RateLimiterStore is in-memory and refuses production). Never stores attempted codes. Retention/cleanup is a future W6 operational sweep.';

------------------------------------------------------------------------------
-- 5. Grants — no DELETE anywhere; append-only surfaces INSERT-only.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON entitlement_reservation TO himma_app;
GRANT SELECT, INSERT, UPDATE ON redemption_credential TO himma_app;
GRANT SELECT, INSERT ON attendance_record TO himma_app;
GRANT SELECT, INSERT, UPDATE ON redemption_lookup_attempt TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). FAIL-CLOSED PREFLIGHT (the approved 0017 precedent):
-- refuse the downgrade BEFORE any destructive DDL whenever S6-2-native
-- durable state exists — credentials, attendance, or reservations must
-- never be silently destroyed. (redemption_lookup_attempt rows are
-- operational rate counters, not commercial history — like idempotency
-- rows, they do not block a rollback.)

DO $$
DECLARE
  credentials  bigint;
  attendances  bigint;
  reservations bigint;
BEGIN
  SELECT count(*) INTO credentials FROM redemption_credential;
  SELECT count(*) INTO attendances FROM attendance_record;
  SELECT count(*) INTO reservations FROM entitlement_reservation;
  IF credentials > 0 OR attendances > 0 OR reservations > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'Downgrade of 0018 refused: S6-2-native data exists and would be destroyed (redemption_credential=%s, attendance_record=%s, entitlement_reservation=%s). Attendance/credential/reservation truth is never silently discarded — roll forward instead (docs/25 §9; docs/35 §21).',
      credentials, attendances, reservations);
  END IF;
END $$;

DROP TABLE redemption_lookup_attempt;
DROP TABLE attendance_record;
DROP TABLE redemption_credential;
DROP TABLE entitlement_reservation;
DROP FUNCTION enforce_attendance_record_shape();
DROP FUNCTION enforce_redemption_credential_transition();
DROP FUNCTION enforce_redemption_credential_shape();
DROP FUNCTION enforce_entitlement_reservation_shape();
ALTER TABLE entitlement DROP CONSTRAINT uq_entitlement_id_account_participant;
ALTER TABLE booking DROP CONSTRAINT uq_booking_id_account_participant;
