-- 0013_booking_capacity_foundation — W4 Slice 5 · S5-1 schema + capacity-unit
-- foundation. Authority: docs/32 (S5-0 OWNER-APPROVED at f1cd898; owner
-- rulings D-1…D-9 RESOLVED 2026-08-20) implementing docs/24 §2.3–§2.4,
-- §3.1–3.4, §5.4–5.6, §6 (incl. both capacity invariants) and the §7
-- transaction boundaries' STRUCTURAL prerequisites; docs/23 §6.3–6.5, §10.1;
-- docs/25 §9. Runs in one transaction.
--
-- SCOPE (S5-1): persistence + database invariants ONLY. No hold-claim
-- service, no expiry worker, no confirmation service, no routes — the
-- row-locking/atomic-transition ALGORITHM is S5-2; this migration ships the
-- database AUTHORITY it will run against:
--   * the three capacity units (session · camp_week · enrolment_cohort —
--     Amendment A1.1) with ONE shared counter/invariant model:
--     CHECK booked_count + held_count <= capacity (overselling structurally
--     impossible; the SAME check symmetrically rejects any capacity UPDATE
--     below the committed floor) and non-negative counts everywhere;
--   * recurring_schedule (purely temporal — NEVER owns inventory, A1.1) with
--     the D-9 cutoff-rule defaults and idempotent-generation identity;
--   * capacity_hold with the §5.5 machine states, TTL, exactly-one unit
--     target (three org-bound composite FKs + num_nonnulls CHECK — target
--     integrity is NOT left to route code), quantity CHECK (= 1) per D-2
--     (widening later = relaxing one CHECK, never rewriting rows), and the
--     one-live-hold-per-(account, participant, unit) partial uniques;
--   * booking with the §5.6 machine (payment_failed representable now,
--     reachable only when the payments slice exists), purchaser/participant
--     DISTINCT (D-2: account_id is the purchaser; participant_id is org-bound
--     to that account by composite FK — a parent books for a child; nothing
--     assumes purchaser = participant), hold↔booking unit-match bound by
--     composite FKs, live double-booking partial uniques (incl. D-4's one
--     participant per cohort enrolment), and write-once confirmation facts
--     (reference_code, policy snapshot);
--   * price_quote (+ lines): the immutable commercial snapshot — base
--     components now, tax_treatment typed with 'notConfigured' (§18 #11
--     VAT confirmed NON-blocking), deferred-trigger total==Σ(lines);
--     quotes never reserve capacity;
--   * cancellation_policy_template: the FAIL-CLOSED snapshot seam ONLY
--     (D-8) — NO template/legal content is seeded or invented here;
--   * enrolment (D-4: PARTICIPATION in a cohort — deliberately NO payment-
--     provider identifiers, no recurring-billing fields; renewal_policy is a
--     valueless column until docs/09 §6 / §18 #12) and package_entitlement
--     (structure only; package PURCHASE stays deferred pending the owner's
--     redemption rules, docs/09 §21.7 — recorded in docs/32's S5-1 record).
--
-- Certified-table change (reported, additive-only, 0004 precedent —
-- uq_login_session_id_user): participant gains UNIQUE (id, account_id) as
-- the composite target that makes "a booking's participant belongs to the
-- booking's account" (docs/24 §6.9) structural. No existing column, row,
-- constraint, or behavior changes.

-- Up Migration

------------------------------------------------------------------------------
-- 0. Composite-FK target on the certified participant table (additive).
------------------------------------------------------------------------------

ALTER TABLE participant
  ADD CONSTRAINT uq_participant_id_account UNIQUE (id, account_id);

------------------------------------------------------------------------------
-- 1. recurring_schedule — the purely temporal pattern (docs/24 §2.3; A1.1:
--    it NEVER owns inventory; session generation is a later idempotent job
--    whose identity target ships here).
------------------------------------------------------------------------------

CREATE TABLE recurring_schedule (
  id                          uuid        NOT NULL,
  program_id                  uuid        NOT NULL,
  organization_id             uuid        NOT NULL,
  weekdays                    smallint[]  NOT NULL,
  start_time                  time        NOT NULL,
  end_time                    time        NOT NULL,
  timezone                    text        NOT NULL DEFAULT 'Asia/Dubai',
  effective_start             date        NOT NULL,
  effective_end               date,
  exception_dates             date[]      NOT NULL DEFAULT '{}',
  -- D-9: cutoff derivation is CONFIGURABLE; default at Session start.
  registration_cutoff_kind    text        NOT NULL DEFAULT 'at_start',
  registration_cutoff_minutes integer,
  instructor_staff_id         uuid,
  state                       text        NOT NULL DEFAULT 'active',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  version                     integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_recurring_schedule PRIMARY KEY (id),
  CONSTRAINT uq_recurring_schedule_id_program UNIQUE (id, program_id),
  CONSTRAINT uq_recurring_schedule_id_organization UNIQUE (id, organization_id),
  CONSTRAINT fk_recurring_schedule_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT fk_recurring_schedule_instructor
    FOREIGN KEY (instructor_staff_id, organization_id)
    REFERENCES staff_membership (id, organization_id),
  CONSTRAINT ck_recurring_schedule_weekdays
    CHECK (cardinality(weekdays) >= 1 AND weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  CONSTRAINT ck_recurring_schedule_times CHECK (end_time > start_time),
  CONSTRAINT ck_recurring_schedule_timezone CHECK (timezone = 'Asia/Dubai'),
  CONSTRAINT ck_recurring_schedule_range
    CHECK (effective_end IS NULL OR effective_end >= effective_start),
  CONSTRAINT ck_recurring_schedule_cutoff_kind
    CHECK (registration_cutoff_kind IN ('at_start', 'minutes_before')),
  CONSTRAINT ck_recurring_schedule_cutoff_minutes
    CHECK ((registration_cutoff_kind = 'minutes_before')
           = (registration_cutoff_minutes IS NOT NULL)
           AND (registration_cutoff_minutes IS NULL OR registration_cutoff_minutes > 0)),
  CONSTRAINT ck_recurring_schedule_state CHECK (state IN ('active', 'ended')),
  CONSTRAINT ck_recurring_schedule_version CHECK (version >= 1)
);
COMMENT ON TABLE recurring_schedule IS
  'Purely temporal scheduling rule (docs/24 §2.3, Amendment A1.1): defines WHEN sessions occur, never how many may join — no capacity/counter column exists here by design. Session generation (a later S5-4 idempotent job) materializes sessions with UNIQUE (schedule_id, occurrence_date) identity. D-9: generated sessions open registration by default; cutoff defaults to the session start, configurable via the cutoff rule columns.';

CREATE TRIGGER trg_recurring_schedule_updated_at
  BEFORE UPDATE ON recurring_schedule FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_recurring_schedule_version
  BEFORE UPDATE ON recurring_schedule FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_recurring_schedule_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.program_id <> OLD.program_id
     OR NEW.organization_id <> OLD.organization_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'recurring_schedule identity/ownership columns are immutable (%)', OLD.id;
  END IF;
  IF OLD.state = 'ended' THEN
    RAISE EXCEPTION 'recurring_schedule % is ended and immutable', OLD.id;
  END IF;
  IF NEW.state <> OLD.state AND NOT (OLD.state = 'active' AND NEW.state = 'ended') THEN
    RAISE EXCEPTION 'invalid recurring_schedule transition % -> % (%)', OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_recurring_schedule_transition
  BEFORE UPDATE ON recurring_schedule FOR EACH ROW
  EXECUTE FUNCTION enforce_recurring_schedule_immutability();

------------------------------------------------------------------------------
-- 2. The THREE capacity units (docs/24 §2.3–§2.4) — one shared counter and
--    state model (docs/24 §5.4; the cohort mirrors it). The capacity CHECK is
--    the FINAL overselling/floor authority (docs/23 §10.1): it holds under
--    application bugs; the S5-2 row-locking algorithm serializes contenders,
--    but even without it no committed row can ever violate
--    booked_count + held_count <= capacity, and no capacity UPDATE below the
--    committed floor can commit.
------------------------------------------------------------------------------

CREATE FUNCTION enforce_capacity_unit_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.program_id <> OLD.program_id
     OR NEW.organization_id <> OLD.organization_id OR NEW.branch_id <> OLD.branch_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION '% identity/ownership columns are immutable (%)', TG_TABLE_NAME, OLD.id;
  END IF;
  IF OLD.state IN ('completed', 'cancelled_by_provider') THEN
    RAISE EXCEPTION '% row % is terminal (%) and immutable', TG_TABLE_NAME, OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'scheduled' AND NEW.state = 'open')
           OR (OLD.state = 'open'      AND NEW.state = 'full')
           OR (OLD.state = 'full'      AND NEW.state = 'open')
           OR (OLD.state IN ('open', 'full') AND NEW.state = 'closed')
           OR (OLD.state IN ('scheduled', 'open', 'full')
               AND NEW.state = 'cancelled_by_provider')
           OR (OLD.state = 'closed' AND NEW.state = 'completed')) THEN
    RAISE EXCEPTION 'invalid % transition % -> % (%)', TG_TABLE_NAME, OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION enforce_capacity_unit_transition() IS
  'The ONE docs/24 §5.4 machine shared by session, camp_week, and enrolment_cohort — divergent per-unit counter/state semantics are structurally impossible. cancelled_by_provider is reachable ONLY through the later controlled-disruption workflow (D-5: latest-confirmed-first is a candidate-SELECTION default, never an automatic cancellation mechanism — no trigger cancels or mutates bookings here).';

CREATE TABLE session (
  id                          uuid        NOT NULL,
  program_id                  uuid        NOT NULL,
  organization_id             uuid        NOT NULL,
  branch_id                   uuid        NOT NULL,
  schedule_id                 uuid,
  occurrence_date             date,
  start_at                    timestamptz NOT NULL,
  end_at                      timestamptz NOT NULL,
  capacity                    integer     NOT NULL,
  booked_count                integer     NOT NULL DEFAULT 0,
  held_count                  integer     NOT NULL DEFAULT 0,
  -- D-9: generated/eligible sessions open registration by default;
  -- 'scheduled' stays representable for deliberately future-gated sessions.
  state                       text        NOT NULL DEFAULT 'open',
  registration_cutoff_at      timestamptz NOT NULL,
  override_min_age            integer,
  override_max_age            integer,
  override_all_ages           boolean,
  override_gender_eligibility text,
  override_skill_level        text,
  instructor_staff_id         uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  version                     integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_session PRIMARY KEY (id),
  CONSTRAINT uq_session_id_organization UNIQUE (id, organization_id),
  CONSTRAINT fk_session_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT fk_session_branch
    FOREIGN KEY (branch_id, organization_id) REFERENCES branch (id, organization_id),
  CONSTRAINT fk_session_schedule
    FOREIGN KEY (schedule_id, program_id) REFERENCES recurring_schedule (id, program_id),
  CONSTRAINT fk_session_instructor
    FOREIGN KEY (instructor_staff_id, organization_id)
    REFERENCES staff_membership (id, organization_id),
  CONSTRAINT ck_session_times CHECK (end_at > start_at),
  CONSTRAINT ck_session_capacity
    CHECK (capacity >= 0 AND booked_count >= 0 AND held_count >= 0
           AND booked_count + held_count <= capacity),
  CONSTRAINT ck_session_state
    CHECK (state IN ('scheduled', 'open', 'full', 'closed', 'completed', 'cancelled_by_provider')),
  CONSTRAINT ck_session_generation_identity
    CHECK (schedule_id IS NULL OR occurrence_date IS NOT NULL),
  CONSTRAINT ck_session_override_ages
    CHECK ((override_min_age IS NULL OR override_min_age >= 0)
           AND (override_max_age IS NULL OR override_max_age >= 0)
           AND (override_min_age IS NULL OR override_max_age IS NULL
                OR override_min_age <= override_max_age)),
  CONSTRAINT ck_session_override_gender
    CHECK (override_gender_eligibility IS NULL
           OR override_gender_eligibility IN ('women', 'men', 'girls', 'boys', 'mixed')),
  CONSTRAINT ck_session_version CHECK (version >= 1)
);
COMMENT ON TABLE session IS
  'One dated occurrence — capacity truth lives HERE (docs/24 §2.3), guarded by ck_session_capacity: booked_count + held_count <= capacity is the database''s final overselling authority AND, symmetrically, the capacity floor (an UPDATE lowering capacity below commitments violates the same CHECK — docs/23 §10.1, docs/24 §3.7). Counters change only inside the §7 transaction boundaries (S5-2+). Eligibility overrides are nullable mirrors of the program vocabulary (null = inherit, docs/24 §2.5). NB: the Slice-2 AUTH table is login_session; this is the booking-domain Session.';

CREATE UNIQUE INDEX uq_session_generation
  ON session (schedule_id, occurrence_date) WHERE schedule_id IS NOT NULL;
CREATE INDEX ix_session_program_start ON session (program_id, start_at);
CREATE INDEX ix_session_branch_start ON session (branch_id, start_at);

CREATE TRIGGER trg_session_updated_at
  BEFORE UPDATE ON session FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_session_version
  BEFORE UPDATE ON session FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_session_transition
  BEFORE UPDATE ON session FOR EACH ROW EXECUTE FUNCTION enforce_capacity_unit_transition();

CREATE TABLE camp_week (
  id                     uuid        NOT NULL,
  program_id             uuid        NOT NULL,
  organization_id        uuid        NOT NULL,
  branch_id              uuid        NOT NULL,
  start_date             date        NOT NULL,
  end_date               date        NOT NULL,
  daily_start_time       time        NOT NULL,
  daily_end_time         time        NOT NULL,
  capacity               integer     NOT NULL,
  booked_count           integer     NOT NULL DEFAULT 0,
  held_count             integer     NOT NULL DEFAULT 0,
  state                  text        NOT NULL DEFAULT 'open',
  registration_cutoff_at timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_camp_week PRIMARY KEY (id),
  CONSTRAINT uq_camp_week_id_organization UNIQUE (id, organization_id),
  CONSTRAINT fk_camp_week_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT fk_camp_week_branch
    FOREIGN KEY (branch_id, organization_id) REFERENCES branch (id, organization_id),
  CONSTRAINT ck_camp_week_dates CHECK (end_date >= start_date),
  CONSTRAINT ck_camp_week_times CHECK (daily_end_time > daily_start_time),
  CONSTRAINT ck_camp_week_capacity
    CHECK (capacity >= 0 AND booked_count >= 0 AND held_count >= 0
           AND booked_count + held_count <= capacity),
  CONSTRAINT ck_camp_week_state
    CHECK (state IN ('scheduled', 'open', 'full', 'closed', 'completed', 'cancelled_by_provider')),
  CONSTRAINT ck_camp_week_version CHECK (version >= 1)
);
COMMENT ON TABLE camp_week IS
  'Week-granularity bookable unit (docs/24 §2.3; docs/09 §21.7 — camps book at week granularity). Identical capacity machinery to session: same CHECK authority, same shared §5.4 machine.';

CREATE INDEX ix_camp_week_program_start ON camp_week (program_id, start_date);

CREATE TRIGGER trg_camp_week_updated_at
  BEFORE UPDATE ON camp_week FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_camp_week_version
  BEFORE UPDATE ON camp_week FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_camp_week_transition
  BEFORE UPDATE ON camp_week FOR EACH ROW EXECUTE FUNCTION enforce_capacity_unit_transition();

CREATE TABLE enrolment_cohort (
  id                  uuid        NOT NULL,
  program_id          uuid        NOT NULL,
  organization_id     uuid        NOT NULL,
  branch_id           uuid        NOT NULL,
  effective_start     date        NOT NULL,
  effective_end       date        NOT NULL,
  capacity            integer     NOT NULL,
  booked_count        integer     NOT NULL DEFAULT 0,
  held_count          integer     NOT NULL DEFAULT 0,
  state               text        NOT NULL DEFAULT 'open',
  enrolment_cutoff_at timestamptz NOT NULL,
  price_option_id     uuid,
  policy_template_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_enrolment_cohort PRIMARY KEY (id),
  CONSTRAINT uq_enrolment_cohort_id_organization UNIQUE (id, organization_id),
  CONSTRAINT uq_enrolment_cohort_id_program UNIQUE (id, program_id),
  CONSTRAINT fk_enrolment_cohort_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT fk_enrolment_cohort_branch
    FOREIGN KEY (branch_id, organization_id) REFERENCES branch (id, organization_id),
  CONSTRAINT fk_enrolment_cohort_price_option
    FOREIGN KEY (price_option_id, program_id) REFERENCES program_price_option (id, program_id),
  CONSTRAINT ck_enrolment_cohort_dates CHECK (effective_end >= effective_start),
  CONSTRAINT ck_enrolment_cohort_capacity
    CHECK (capacity >= 0 AND booked_count >= 0 AND held_count >= 0
           AND booked_count + held_count <= capacity),
  CONSTRAINT ck_enrolment_cohort_state
    CHECK (state IN ('scheduled', 'open', 'full', 'closed', 'completed', 'cancelled_by_provider')),
  CONSTRAINT ck_enrolment_cohort_version CHECK (version >= 1)
);
COMMENT ON TABLE enrolment_cohort IS
  'The canonical bookable inventory unit for monthly/term enrolments (Amendment A1.1; D-4): one term, month, intake, or cohort. Capacity truth lives here under the SAME shared invariants and §5.4 machine as session/camp_week — the referenced schedules (enrolment_cohort_schedule) define when the cohort meets, never how many may join. price_option_id/policy_template_id are cohort-level overrides (defaults: the booked option / the program''s policy).';

CREATE INDEX ix_enrolment_cohort_program_start ON enrolment_cohort (program_id, effective_start);

CREATE TRIGGER trg_enrolment_cohort_updated_at
  BEFORE UPDATE ON enrolment_cohort FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_enrolment_cohort_version
  BEFORE UPDATE ON enrolment_cohort FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_enrolment_cohort_transition
  BEFORE UPDATE ON enrolment_cohort FOR EACH ROW EXECUTE FUNCTION enforce_capacity_unit_transition();

CREATE TABLE enrolment_cohort_schedule (
  cohort_id   uuid        NOT NULL,
  schedule_id uuid        NOT NULL,
  program_id  uuid        NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_enrolment_cohort_schedule PRIMARY KEY (cohort_id, schedule_id),
  CONSTRAINT fk_ecs_cohort
    FOREIGN KEY (cohort_id, program_id) REFERENCES enrolment_cohort (id, program_id),
  CONSTRAINT fk_ecs_schedule
    FOREIGN KEY (schedule_id, program_id) REFERENCES recurring_schedule (id, program_id),
  CONSTRAINT ck_ecs_version CHECK (version >= 1)
);
COMMENT ON TABLE enrolment_cohort_schedule IS
  'Cohort ⇄ schedule meeting-pattern association (docs/24 §2.3: >= 1 ref per cohort — the lower bound is service-enforced at cohort activation, S5-4). program_id rides every row so BOTH composite FKs pin cohort and schedule to the SAME program (cross-program association structurally impossible). Deactivation over deletion, the program_branch pattern.';

CREATE TRIGGER trg_ecs_updated_at
  BEFORE UPDATE ON enrolment_cohort_schedule FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_ecs_version
  BEFORE UPDATE ON enrolment_cohort_schedule FOR EACH ROW EXECUTE FUNCTION bump_row_version();

------------------------------------------------------------------------------
-- 3. cancellation_policy_template — the FAIL-CLOSED snapshot seam (D-8).
--    NO template/legal content ships here or may be invented (docs/09 §7,
--    §18 #14 stay owner-open); the later confirmation service fails closed
--    when no ACTIVE owner-approved template exists.
------------------------------------------------------------------------------

CREATE TABLE cancellation_policy_template (
  id               uuid        NOT NULL,
  template_version integer     NOT NULL,
  title_en         text        NOT NULL,
  title_ar         text,
  summary_lines    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  rules            jsonb       NOT NULL,
  state            text        NOT NULL DEFAULT 'draft',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_cancellation_policy_template PRIMARY KEY (id),
  CONSTRAINT ck_policy_template_version CHECK (template_version >= 1),
  CONSTRAINT ck_policy_template_state CHECK (state IN ('draft', 'active', 'retired')),
  CONSTRAINT ck_policy_template_row_version CHECK (version >= 1)
);
COMMENT ON TABLE cancellation_policy_template IS
  'Platform-versioned cancellation-policy record (docs/24 §2.7). One row = one immutable (template, version): CONTENT never changes after creation — only the lifecycle state moves (draft -> active -> retired), so a booking''s policy_template_id reference is a complete, permanent snapshot. Launch template CONTENT is an open owner decision (docs/09 §7, §18 #14): D-8 rules the seam FAIL-CLOSED — no content is seeded here and none may be invented.';

CREATE TRIGGER trg_policy_template_updated_at
  BEFORE UPDATE ON cancellation_policy_template FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_policy_template_version
  BEFORE UPDATE ON cancellation_policy_template FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_policy_template_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.template_version <> OLD.template_version
     OR NEW.title_en <> OLD.title_en OR NEW.title_ar IS DISTINCT FROM OLD.title_ar
     OR NEW.summary_lines <> OLD.summary_lines OR NEW.rules <> OLD.rules
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'cancellation_policy_template content is immutable (%)— publish a new version', OLD.id;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'draft' AND NEW.state = 'active')
           OR (OLD.state = 'active' AND NEW.state = 'retired')) THEN
    RAISE EXCEPTION 'invalid cancellation_policy_template transition % -> % (%)',
      OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_policy_template_transition
  BEFORE UPDATE ON cancellation_policy_template FOR EACH ROW
  EXECUTE FUNCTION enforce_policy_template_transition();

ALTER TABLE enrolment_cohort
  ADD CONSTRAINT fk_enrolment_cohort_policy_template
  FOREIGN KEY (policy_template_id) REFERENCES cancellation_policy_template (id);

------------------------------------------------------------------------------
-- 4. price_quote (+ lines) — the immutable commercial snapshot (docs/24
--    §3.2/§4.1). Base components now; tax_treatment carries the full typed
--    vocabulary with 'notConfigured' as the only value the platform emits
--    until the owner's VAT/fee decisions exist (§18 #11 — confirmed
--    NON-blocking). A quote NEVER reserves capacity. NO tax calculation.
------------------------------------------------------------------------------

CREATE TABLE price_quote (
  id              uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  program_id      uuid        NOT NULL,
  account_id      uuid        NOT NULL,
  participant_id  uuid        NOT NULL,
  option_kind     text        NOT NULL,
  price_option_id uuid,
  offer_id        uuid,
  session_id      uuid,
  camp_week_id    uuid,
  cohort_id       uuid,
  total_fils      bigint      NOT NULL,
  currency        char(3)     NOT NULL DEFAULT 'AED',
  price_kind      text        NOT NULL,
  tax_treatment   text        NOT NULL DEFAULT 'notConfigured',
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_price_quote PRIMARY KEY (id),
  CONSTRAINT fk_price_quote_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT fk_price_quote_account FOREIGN KEY (account_id) REFERENCES customer_account (id),
  CONSTRAINT fk_price_quote_participant
    FOREIGN KEY (participant_id, account_id) REFERENCES participant (id, account_id),
  CONSTRAINT fk_price_quote_price_option
    FOREIGN KEY (price_option_id, program_id) REFERENCES program_price_option (id, program_id),
  CONSTRAINT fk_price_quote_offer FOREIGN KEY (offer_id) REFERENCES offer (id),
  CONSTRAINT fk_price_quote_session FOREIGN KEY (session_id) REFERENCES session (id),
  CONSTRAINT fk_price_quote_camp_week FOREIGN KEY (camp_week_id) REFERENCES camp_week (id),
  CONSTRAINT fk_price_quote_cohort FOREIGN KEY (cohort_id) REFERENCES enrolment_cohort (id),
  CONSTRAINT ck_price_quote_one_unit
    CHECK (num_nonnulls(session_id, camp_week_id, cohort_id) = 1),
  CONSTRAINT ck_price_quote_option_kind
    CHECK (option_kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free')),
  CONSTRAINT ck_price_quote_total CHECK (total_fils >= 0),
  CONSTRAINT ck_price_quote_currency CHECK (currency = 'AED'),
  CONSTRAINT ck_price_quote_price_kind CHECK (price_kind IN ('oneOff', 'cadence', 'free')),
  CONSTRAINT ck_price_quote_tax_treatment
    CHECK (tax_treatment IN ('notConfigured', 'includedInPrice', 'addedAtCheckout', 'providerSpecific'))
);
COMMENT ON TABLE price_quote IS
  'Server-computed commercial snapshot (docs/24 §4.1): what was offered, to whom, for which unit, until when. IMMUTABLE after creation (append-only guards + INSERT-only grants) — re-pricing is a NEW quote. total_fils must equal the line sum (deferred constraint trigger). tax_treatment stays ''notConfigured'' until the §18 #11 VAT decision (structure complete, config empty); D-7: a trial quote references the active freeTrial offer (offer_id) and rides the ordinary path. Quote validity never reserves capacity.';

CREATE INDEX ix_price_quote_account ON price_quote (account_id, created_at);

CREATE TRIGGER trg_price_quote_append_only
  BEFORE UPDATE OR DELETE ON price_quote FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE price_quote_line (
  id          uuid    NOT NULL,
  quote_id    uuid    NOT NULL,
  line_no     integer NOT NULL,
  kind        text    NOT NULL,
  label_en    text    NOT NULL,
  amount_fils bigint  NOT NULL,
  CONSTRAINT pk_price_quote_line PRIMARY KEY (id),
  CONSTRAINT uq_price_quote_line_no UNIQUE (quote_id, line_no),
  CONSTRAINT fk_price_quote_line_quote FOREIGN KEY (quote_id) REFERENCES price_quote (id),
  CONSTRAINT ck_price_quote_line_kind
    CHECK (kind IN ('base', 'discount', 'fee', 'tax', 'credit')),
  CONSTRAINT ck_price_quote_line_sign
    CHECK ((kind IN ('base', 'fee', 'tax') AND amount_fils >= 0)
           OR (kind IN ('discount', 'credit') AND amount_fils <= 0))
);
COMMENT ON TABLE price_quote_line IS
  'Structured quote components (docs/24 §4.1 line kinds; only ''base'' is emitted until the owner''s VAT/fee/discount decisions exist). Append-only at quote creation; the deferred trigger below makes a quote whose lines do not sum to total_fils uncommittable.';

CREATE TRIGGER trg_price_quote_line_append_only
  BEFORE UPDATE OR DELETE ON price_quote_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION check_price_quote_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  quote_ids uuid[];
  bad uuid;
BEGIN
  IF TG_TABLE_NAME = 'price_quote' THEN
    quote_ids := ARRAY[NEW.id];
  ELSE
    quote_ids := ARRAY[NEW.quote_id];
  END IF;
  SELECT q.id INTO bad
  FROM price_quote q
  WHERE q.id = ANY (quote_ids)
    AND q.total_fils <> COALESCE(
      (SELECT sum(l.amount_fils) FROM price_quote_line l WHERE l.quote_id = q.id), 0);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'price_quote % total_fils does not equal its line sum (docs/24 §6.3)', bad;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_price_quote_total
  AFTER INSERT ON price_quote DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_price_quote_total();
CREATE CONSTRAINT TRIGGER trg_price_quote_line_total
  AFTER INSERT ON price_quote_line DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_price_quote_total();

------------------------------------------------------------------------------
-- 5. capacity_hold — docs/24 §3.3/§5.5. Exactly ONE org-bound unit target;
--    quantity CHECK (= 1) per D-2 (one seat per booking at launch — widening
--    is a future CHECK relaxation, never a row rewrite); D-6 TTL lives in
--    expires_at (10-minute default is service configuration, not schema).
--    State transitions here are STRUCTURE; the atomic claim algorithm
--    (row-lock, counter increment, insert in one transaction) is S5-2.
------------------------------------------------------------------------------

CREATE TABLE capacity_hold (
  id                     uuid        NOT NULL,
  organization_id        uuid        NOT NULL,
  session_id             uuid,
  camp_week_id           uuid,
  cohort_id              uuid,
  account_id             uuid        NOT NULL,
  participant_id         uuid        NOT NULL,
  quantity               integer     NOT NULL DEFAULT 1,
  quote_id               uuid        NOT NULL,
  state                  text        NOT NULL DEFAULT 'active',
  expires_at             timestamptz NOT NULL,
  consumed_by_booking_id uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_capacity_hold PRIMARY KEY (id),
  CONSTRAINT uq_capacity_hold_id_session UNIQUE (id, session_id),
  CONSTRAINT uq_capacity_hold_id_camp_week UNIQUE (id, camp_week_id),
  CONSTRAINT uq_capacity_hold_id_cohort UNIQUE (id, cohort_id),
  CONSTRAINT fk_capacity_hold_session
    FOREIGN KEY (session_id, organization_id) REFERENCES session (id, organization_id),
  CONSTRAINT fk_capacity_hold_camp_week
    FOREIGN KEY (camp_week_id, organization_id) REFERENCES camp_week (id, organization_id),
  CONSTRAINT fk_capacity_hold_cohort
    FOREIGN KEY (cohort_id, organization_id) REFERENCES enrolment_cohort (id, organization_id),
  CONSTRAINT fk_capacity_hold_account FOREIGN KEY (account_id) REFERENCES customer_account (id),
  CONSTRAINT fk_capacity_hold_participant
    FOREIGN KEY (participant_id, account_id) REFERENCES participant (id, account_id),
  CONSTRAINT fk_capacity_hold_quote FOREIGN KEY (quote_id) REFERENCES price_quote (id),
  CONSTRAINT ck_capacity_hold_one_unit
    CHECK (num_nonnulls(session_id, camp_week_id, cohort_id) = 1),
  CONSTRAINT ck_capacity_hold_quantity CHECK (quantity = 1),
  CONSTRAINT ck_capacity_hold_state
    CHECK (state IN ('active', 'consumed', 'expired', 'released')),
  CONSTRAINT ck_capacity_hold_consumed_pairing
    CHECK ((state = 'consumed') = (consumed_by_booking_id IS NOT NULL)),
  CONSTRAINT ck_capacity_hold_version CHECK (version >= 1)
);
COMMENT ON TABLE capacity_hold IS
  'The server-side InventoryReservation (docs/24 §3.3, §5.5): created ONLY as ''active'' with capacity already claimed in the same transaction (no pre-state, no committed intermediate — the S5-2 claim algorithm); active -> consumed | expired | released only, trigger-enforced; terminal rows immutable. Exactly one org-bound unit target (three composite FKs + CHECK — target integrity is structural, never route code). D-2: quantity = 1 at launch (ck_capacity_hold_quantity); purchaser (account_id) and participant are distinct, with the participant composite-bound to the purchasing account.';

CREATE INDEX ix_capacity_hold_active_expiry
  ON capacity_hold (expires_at) WHERE state = 'active';
CREATE UNIQUE INDEX uq_capacity_hold_live_session
  ON capacity_hold (account_id, participant_id, session_id)
  WHERE state = 'active' AND session_id IS NOT NULL;
CREATE UNIQUE INDEX uq_capacity_hold_live_camp_week
  ON capacity_hold (account_id, participant_id, camp_week_id)
  WHERE state = 'active' AND camp_week_id IS NOT NULL;
CREATE UNIQUE INDEX uq_capacity_hold_live_cohort
  ON capacity_hold (account_id, participant_id, cohort_id)
  WHERE state = 'active' AND cohort_id IS NOT NULL;

CREATE TRIGGER trg_capacity_hold_updated_at
  BEFORE UPDATE ON capacity_hold FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_capacity_hold_version
  BEFORE UPDATE ON capacity_hold FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_capacity_hold_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.camp_week_id IS DISTINCT FROM OLD.camp_week_id
     OR NEW.cohort_id IS DISTINCT FROM OLD.cohort_id
     OR NEW.account_id <> OLD.account_id
     OR NEW.participant_id <> OLD.participant_id
     OR NEW.quantity <> OLD.quantity
     OR NEW.quote_id <> OLD.quote_id
     OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'capacity_hold identity columns are immutable (%)', OLD.id;
  END IF;
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'capacity_hold % is terminal (%) and immutable', OLD.id, OLD.state;
  END IF;
  IF NEW.state = OLD.state THEN
    RAISE EXCEPTION 'capacity_hold % permits state transitions only', OLD.id;
  END IF;
  -- active -> consumed | expired | released (ck_capacity_hold_state bounds
  -- the vocabulary; consumed additionally requires the booking pairing CHECK).
  RETURN NEW;
END $$;
CREATE TRIGGER trg_capacity_hold_transition
  BEFORE UPDATE ON capacity_hold FOR EACH ROW EXECUTE FUNCTION enforce_capacity_hold_transition();

------------------------------------------------------------------------------
-- 6. booking — docs/24 §3.4/§5.6. Purchaser (account) and participant are
--    DISTINCT concepts (D-2); the unit target is exactly-one, org-bound, and
--    composite-FK-matched to the hold''s unit; confirmation facts are
--    write-once; historical truth never depends on mutable catalogue rows
--    (quote/policy snapshots + immutable identity columns).
------------------------------------------------------------------------------

CREATE TABLE booking (
  id                 uuid        NOT NULL,
  account_id         uuid        NOT NULL,
  participant_id     uuid        NOT NULL,
  program_id         uuid        NOT NULL,
  organization_id    uuid        NOT NULL,
  branch_id          uuid        NOT NULL,
  option_kind        text        NOT NULL,
  session_id         uuid,
  camp_week_id       uuid,
  cohort_id          uuid,
  quote_id           uuid        NOT NULL,
  hold_id            uuid        NOT NULL,
  state              text        NOT NULL DEFAULT 'pending_payment',
  reference_code     text,
  policy_template_id uuid,
  confirmed_at       timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_booking PRIMARY KEY (id),
  CONSTRAINT uq_booking_reference_code UNIQUE (reference_code),
  CONSTRAINT uq_booking_id_cohort UNIQUE (id, cohort_id),
  CONSTRAINT fk_booking_account FOREIGN KEY (account_id) REFERENCES customer_account (id),
  CONSTRAINT fk_booking_participant
    FOREIGN KEY (participant_id, account_id) REFERENCES participant (id, account_id),
  CONSTRAINT fk_booking_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT fk_booking_branch
    FOREIGN KEY (branch_id, organization_id) REFERENCES branch (id, organization_id),
  CONSTRAINT fk_booking_session
    FOREIGN KEY (session_id, organization_id) REFERENCES session (id, organization_id),
  CONSTRAINT fk_booking_camp_week
    FOREIGN KEY (camp_week_id, organization_id) REFERENCES camp_week (id, organization_id),
  CONSTRAINT fk_booking_cohort
    FOREIGN KEY (cohort_id, organization_id) REFERENCES enrolment_cohort (id, organization_id),
  CONSTRAINT fk_booking_quote FOREIGN KEY (quote_id) REFERENCES price_quote (id),
  -- The hold''s unit MUST equal the booking''s unit: for the booking''s one
  -- non-null unit column, the composite FK below only matches a hold row
  -- carrying the SAME unit value (a NULL component skips its FK, so exactly
  -- the right one bites).
  CONSTRAINT fk_booking_hold_session
    FOREIGN KEY (hold_id, session_id) REFERENCES capacity_hold (id, session_id),
  CONSTRAINT fk_booking_hold_camp_week
    FOREIGN KEY (hold_id, camp_week_id) REFERENCES capacity_hold (id, camp_week_id),
  CONSTRAINT fk_booking_hold_cohort
    FOREIGN KEY (hold_id, cohort_id) REFERENCES capacity_hold (id, cohort_id),
  CONSTRAINT fk_booking_policy_template
    FOREIGN KEY (policy_template_id) REFERENCES cancellation_policy_template (id),
  CONSTRAINT ck_booking_one_unit
    CHECK (num_nonnulls(session_id, camp_week_id, cohort_id) = 1),
  CONSTRAINT ck_booking_option_kind
    CHECK (option_kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free')),
  CONSTRAINT ck_booking_state
    CHECK (state IN ('pending_payment', 'confirmed', 'expired', 'payment_failed',
                     'cancelled_by_customer', 'cancelled_by_provider', 'completed', 'no_show')),
  -- Confirmation facts exist from `confirmed` onward, never before.
  CONSTRAINT ck_booking_confirmation_facts
    CHECK ((state IN ('pending_payment', 'expired', 'payment_failed'))
           OR (reference_code IS NOT NULL AND policy_template_id IS NOT NULL
               AND confirmed_at IS NOT NULL)),
  CONSTRAINT ck_booking_version CHECK (version >= 1)
);
COMMENT ON TABLE booking IS
  'The durable customer reservation (docs/24 §3.4, §5.6). D-2: ONE participant, ONE seat per booking at launch — multiple children are separate bookings; purchaser (account_id) and participant are distinct, composite-bound; introducing a future booking-participant relation is an ADDITIVE table, never a rewrite of these rows. `confirmed` is the only state any frontend may call "booked". payment_failed is representable but unreachable until the payments slice exists (paid bookings rest at pending_payment on an active hold; the hold TTL unwinds them). Historical truth is snapshot-anchored: quote_id (immutable money), policy_template_id (immutable policy version), reference_code (write-once, non-enumerable) — later catalogue edits never change what was sold.';

CREATE INDEX ix_booking_account ON booking (account_id, created_at);
CREATE INDEX ix_booking_organization ON booking (organization_id, created_at);
CREATE INDEX ix_booking_session ON booking (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX ix_booking_camp_week ON booking (camp_week_id) WHERE camp_week_id IS NOT NULL;
CREATE INDEX ix_booking_cohort ON booking (cohort_id) WHERE cohort_id IS NOT NULL;
-- Live double-booking prevention (D-2/D-4): one live booking per participant
-- per unit — incl. "one participant per cohort enrolment at launch".
CREATE UNIQUE INDEX uq_booking_live_session
  ON booking (session_id, participant_id)
  WHERE session_id IS NOT NULL AND state IN ('pending_payment', 'confirmed');
CREATE UNIQUE INDEX uq_booking_live_camp_week
  ON booking (camp_week_id, participant_id)
  WHERE camp_week_id IS NOT NULL AND state IN ('pending_payment', 'confirmed');
CREATE UNIQUE INDEX uq_booking_live_cohort
  ON booking (cohort_id, participant_id)
  WHERE cohort_id IS NOT NULL AND state IN ('pending_payment', 'confirmed');

CREATE TRIGGER trg_booking_updated_at
  BEFORE UPDATE ON booking FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_booking_version
  BEFORE UPDATE ON booking FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_booking_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id
     OR NEW.participant_id <> OLD.participant_id
     OR NEW.program_id <> OLD.program_id OR NEW.organization_id <> OLD.organization_id
     OR NEW.branch_id <> OLD.branch_id OR NEW.option_kind <> OLD.option_kind
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.camp_week_id IS DISTINCT FROM OLD.camp_week_id
     OR NEW.cohort_id IS DISTINCT FROM OLD.cohort_id
     OR NEW.quote_id <> OLD.quote_id OR NEW.hold_id <> OLD.hold_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'booking identity/ownership columns are immutable (%)', OLD.id;
  END IF;
  IF OLD.reference_code IS NOT NULL AND NEW.reference_code IS DISTINCT FROM OLD.reference_code THEN
    RAISE EXCEPTION 'booking reference_code is write-once (%)', OLD.id;
  END IF;
  IF OLD.policy_template_id IS NOT NULL
     AND NEW.policy_template_id IS DISTINCT FROM OLD.policy_template_id THEN
    RAISE EXCEPTION 'booking policy snapshot is write-once (%)', OLD.id;
  END IF;
  IF OLD.state IN ('expired', 'cancelled_by_customer', 'cancelled_by_provider',
                   'completed', 'no_show') THEN
    RAISE EXCEPTION 'booking % is terminal (%) and immutable', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'pending_payment'
               AND NEW.state IN ('confirmed', 'expired', 'payment_failed'))
           OR (OLD.state = 'payment_failed' AND NEW.state = 'pending_payment')
           OR (OLD.state = 'confirmed'
               AND NEW.state IN ('cancelled_by_customer', 'cancelled_by_provider',
                                 'completed', 'no_show'))) THEN
    RAISE EXCEPTION 'invalid booking transition % -> % (%)', OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_booking_transition
  BEFORE UPDATE ON booking FOR EACH ROW EXECUTE FUNCTION enforce_booking_transition();

-- Hold consumption points at its booking (circular with booking.hold_id —
-- added here once both tables exist).
ALTER TABLE capacity_hold
  ADD CONSTRAINT fk_capacity_hold_consumed_by
  FOREIGN KEY (consumed_by_booking_id) REFERENCES booking (id);

------------------------------------------------------------------------------
-- 7. enrolment + package_entitlement — booking SUBTYPES (docs/24 §3.4; D-4).
------------------------------------------------------------------------------

CREATE TABLE enrolment (
  booking_id          uuid        NOT NULL,
  cohort_id           uuid        NOT NULL,
  billing_anchor_date date,
  cadence             text        NOT NULL,
  -- D-4 / docs/09 §6: the column exists; NO value semantics until the owner
  -- decision. Enrolment is PARTICIPATION — deliberately no payment-provider
  -- identifiers and no recurring-billing fields.
  renewal_policy      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_enrolment PRIMARY KEY (booking_id),
  -- The subtype''s cohort IS the booking''s unit — composite-FK-pinned.
  CONSTRAINT fk_enrolment_booking
    FOREIGN KEY (booking_id, cohort_id) REFERENCES booking (id, cohort_id),
  CONSTRAINT fk_enrolment_cohort FOREIGN KEY (cohort_id) REFERENCES enrolment_cohort (id),
  CONSTRAINT ck_enrolment_cadence CHECK (cadence IN ('monthly', 'term'))
);
COMMENT ON TABLE enrolment IS
  'Booking subtype for monthly/term cohort participation (docs/24 §3.4; D-4): NOT a subscription, payment schedule, recurring-billing mandate, or gateway object. renewal_policy is valueless until docs/09 §6 / §18 #12; recurring billing is W5 authority. One participant per cohort enrolment at launch = the live partial unique on booking (uq_booking_live_cohort). Append-only.';

CREATE TRIGGER trg_enrolment_append_only
  BEFORE UPDATE OR DELETE ON enrolment FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE package_entitlement (
  booking_id     uuid        NOT NULL,
  sessions_total integer     NOT NULL,
  sessions_used  integer     NOT NULL DEFAULT 0,
  -- Owner-open (docs/09 §21.7): structure only, no redemption/expiry rules.
  expiry_policy  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_package_entitlement PRIMARY KEY (booking_id),
  CONSTRAINT fk_package_entitlement_booking FOREIGN KEY (booking_id) REFERENCES booking (id),
  CONSTRAINT ck_package_entitlement_bounds
    CHECK (sessions_total >= 1 AND sessions_used >= 0 AND sessions_used <= sessions_total)
);
COMMENT ON TABLE package_entitlement IS
  'Booking subtype recording only what the catalogue sold (docs/24 §3.4): package redemption/expiry rules are OWNER-OPEN (docs/09 §21.7), so package PURCHASES stay deferred until that ruling — the structure exists, no path reaches it (recorded in docs/32''s S5-1 record). Redemption mutation grants arrive with the owning future slice.';

CREATE TRIGGER trg_package_entitlement_append_only
  BEFORE UPDATE OR DELETE ON package_entitlement FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 8. Application-role grants (append-only via missing grants, docs/24 §6.8).
--    No DELETE anywhere in the booking/capacity domain — history is
--    structural; retention rulings (docs/24 §6.14) arrive as their own
--    reviewed change.
------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON recurring_schedule TO himma_app;
GRANT SELECT, INSERT, UPDATE ON session TO himma_app;
GRANT SELECT, INSERT, UPDATE ON camp_week TO himma_app;
GRANT SELECT, INSERT, UPDATE ON enrolment_cohort TO himma_app;
GRANT SELECT, INSERT, UPDATE ON enrolment_cohort_schedule TO himma_app;
GRANT SELECT, INSERT, UPDATE ON cancellation_policy_template TO himma_app;
GRANT SELECT, INSERT ON price_quote TO himma_app;
GRANT SELECT, INSERT ON price_quote_line TO himma_app;
GRANT SELECT, INSERT, UPDATE ON capacity_hold TO himma_app;
GRANT SELECT, INSERT, UPDATE ON booking TO himma_app;
GRANT SELECT, INSERT ON enrolment TO himma_app;
GRANT SELECT, INSERT ON package_entitlement TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops every S5-1 object incl. the additive participant
-- constraint.

DROP TABLE package_entitlement;
DROP TABLE enrolment;
-- Break the deliberate hold<->booking FK cycle before dropping either side.
ALTER TABLE capacity_hold DROP CONSTRAINT fk_capacity_hold_consumed_by;
DROP TABLE booking;
DROP TABLE capacity_hold;
DROP TABLE price_quote_line;
DROP TABLE price_quote;
DROP TABLE enrolment_cohort_schedule;
DROP TABLE enrolment_cohort;
DROP TABLE camp_week;
DROP TABLE session;
DROP TABLE cancellation_policy_template;
DROP TABLE recurring_schedule;
DROP FUNCTION enforce_booking_transition();
DROP FUNCTION enforce_capacity_hold_transition();
DROP FUNCTION check_price_quote_total();
DROP FUNCTION enforce_policy_template_transition();
DROP FUNCTION enforce_capacity_unit_transition();
DROP FUNCTION enforce_recurring_schedule_immutability();
ALTER TABLE participant DROP CONSTRAINT uq_participant_id_account;
