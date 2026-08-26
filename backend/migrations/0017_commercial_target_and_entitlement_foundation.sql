-- 0017_commercial_target_and_entitlement_foundation — W4 Slice 6 · S6-1
-- (docs/35 §3–§6, §11, §21 — owner-approved at S6-0 closure `3b7d770`;
-- rulings D-S6-1 direction + exact structure, D-S6-2, D-S6-3, D-S6-4).
--
-- ONE atomic migration carrying the complete S6-1 commercial-target +
-- entitlement foundation:
--
--  * `membership` joins the commercial price-kind vocabulary ONLY (D-S6-3:
--    fulfillment semantics NEVER live in a price enum); entitlement kinds
--    (package/membership) may carry a genuine zero amount — a provider may
--    intentionally sell a free introductory package, and 0 is its real
--    price, not a fake-free ambiguity (capacity kinds keep the 0008 rule).
--  * price_option_fulfillment_revision (+ schedule-term snapshot child) —
--    IMMUTABLE revisioned fulfillment terms (the organization_commission_term
--    supersede pattern): a provider "edit" supersedes and inserts the next
--    revision; sold quotes/entitlements reference their frozen revision, so
--    later edits can never rewrite purchased terms (D-S6-4 / Correction A1).
--  * price_quote gains the D-S6-1 commercial-shape invariant: exactly one
--    fulfillment shape per quote (capacityPurchase | entitlementAcquisition
--    | entitlementReservation), with the §4 cross-trail impossibility
--    mechanisms (quote↔unit composite FKs on capacity_hold; the entitlement
--    ownership/lineage FK for the future S6-3 reservation shape — structure
--    only, no service can create a reservation quote in S6-1).
--  * entitlement_purchase — the parallel unit-less commercial anchor (never
--    a fake capacity unit, never a hold) with its exact state machine.
--  * entitlement — the append-only participant-owned grant: exactly one per
--    confirmed purchase, finite/unlimited EXPLICIT, validity snapshotted
--    from acquisition confirmation.
--  * payment_intent — the exactly-one-commercial-target evolution: Booking
--    target byte-compatible (all FKs retained verbatim), purchase target
--    additive; economics org-binding becomes target-neutral without
--    weakening D-W5-7.
--  * package_entitlement — SUPERSEDED and dropped (D-S6-2): never
--    authoritative, provably empty (guarded), structurally the wrong anchor.
--
-- Deliberately ABSENT (their owning slices): redemption_credential,
-- attendance_record, entitlement_reservation (S6-2 / migration 0018);
-- reservation quote creation and confirmation (S6-3); provider fulfillment
-- config routes (W2-13); recurring billing; payouts; refunds.

-- Up Migration

------------------------------------------------------------------------------
-- 1. Commercial vocabulary — `membership` price kind (D-S6-3) + genuine
--    zero-price entitlement products.
------------------------------------------------------------------------------

ALTER TABLE program_price_option DROP CONSTRAINT ck_program_price_option_kind;
ALTER TABLE program_price_option ADD CONSTRAINT ck_program_price_option_kind
  CHECK (kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free', 'membership'));
-- Entitlement kinds may be genuinely free (amount = 0); capacity kinds keep
-- the certified 0008 rule (free ⇔ NULL amount; paid > 0).
ALTER TABLE program_price_option DROP CONSTRAINT ck_program_price_option_amount_positive;
ALTER TABLE program_price_option ADD CONSTRAINT ck_program_price_option_amount_positive
  CHECK (amount_fils IS NULL OR amount_fils > 0
         OR (kind IN ('package', 'membership') AND amount_fils = 0));

------------------------------------------------------------------------------
-- 2. price_option_fulfillment_revision — immutable fulfillment terms
--    (docs/35 §3). One ACTIVE revision per entitlement-producing option;
--    supersede-and-insert, never mutate (the D-W5-7 commission-term pattern).
------------------------------------------------------------------------------

CREATE TABLE price_option_fulfillment_revision (
  id              uuid        NOT NULL,
  price_option_id uuid        NOT NULL,
  program_id      uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  revision_no     integer     NOT NULL,
  usage_kind      text        NOT NULL,
  -- Finite membership total. For `package` the certified public
  -- sessions_count IS the total (no duplicate column) — enforced by trigger.
  uses_total      integer,
  validity_kind   text        NOT NULL,
  validity_days   integer,
  validity_end_date date,
  reservation_required boolean NOT NULL,
  walk_in_allowed boolean     NOT NULL,
  -- NULL = valid at all provider branches (the smallest branch limitation).
  branch_id       uuid,
  state           text        NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_price_option_fulfillment_revision PRIMARY KEY (id),
  -- Composite targets: quotes/purchases pin revision↔option structurally.
  CONSTRAINT uq_fulfillment_revision_id_option UNIQUE (id, price_option_id),
  CONSTRAINT uq_fulfillment_revision_no UNIQUE (price_option_id, revision_no),
  CONSTRAINT fk_fulfillment_revision_option
    FOREIGN KEY (price_option_id, program_id) REFERENCES program_price_option (id, program_id),
  CONSTRAINT fk_fulfillment_revision_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT fk_fulfillment_revision_branch
    FOREIGN KEY (branch_id, organization_id) REFERENCES branch (id, organization_id),
  CONSTRAINT ck_fulfillment_usage_kind CHECK (usage_kind IN ('finite', 'unlimited')),
  CONSTRAINT ck_fulfillment_validity_kind
    CHECK (validity_kind IN ('daysFromConfirmation', 'fixedEndDate', 'none')),
  CONSTRAINT ck_fulfillment_validity_days
    CHECK ((validity_kind = 'daysFromConfirmation') = (validity_days IS NOT NULL)),
  CONSTRAINT ck_fulfillment_validity_days_positive
    CHECK (validity_days IS NULL OR validity_days > 0),
  CONSTRAINT ck_fulfillment_validity_end
    CHECK ((validity_kind = 'fixedEndDate') = (validity_end_date IS NOT NULL)),
  -- An unlimited pass with no expiry is not a V1 product (docs/35 §3).
  CONSTRAINT ck_fulfillment_unlimited_expires
    CHECK (usage_kind = 'finite' OR validity_kind <> 'none'),
  -- A product must permit at least one use mode; both true is legal.
  CONSTRAINT ck_fulfillment_reservation_or_walkin
    CHECK (reservation_required OR walk_in_allowed),
  CONSTRAINT ck_fulfillment_uses_total CHECK (uses_total IS NULL OR uses_total > 0),
  -- uses_total exists only for finite semantics (membership; package derives
  -- from sessions_count — the shape trigger enforces the per-kind rule).
  CONSTRAINT ck_fulfillment_finite_uses
    CHECK (usage_kind = 'finite' OR uses_total IS NULL),
  CONSTRAINT ck_fulfillment_state CHECK (state IN ('active', 'superseded')),
  CONSTRAINT ck_fulfillment_version CHECK (version >= 1)
);
COMMENT ON TABLE price_option_fulfillment_revision IS
  'docs/35 §3 (D-S6-3): the IMMUTABLE fulfillment-terms authority for one entitlement-producing price option (package/membership). Terms are frozen per row; a provider edit supersedes (state active → superseded) and inserts the next revision_no — sold quotes/entitlements reference their frozen revision, so later edits never rewrite purchased terms. At most one ACTIVE revision per option. Fulfillment semantics live HERE, never in the price kind.';

CREATE UNIQUE INDEX uq_fulfillment_revision_active_option
  ON price_option_fulfillment_revision (price_option_id) WHERE state = 'active';

-- Per-kind shape: only package/membership options carry revisions; package
-- is finite with the certified sessions_count as its total (uses_total NULL);
-- finite membership requires uses_total.
CREATE FUNCTION enforce_fulfillment_revision_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  option_kind text;
BEGIN
  SELECT kind INTO option_kind FROM program_price_option WHERE id = NEW.price_option_id;
  IF option_kind IS NULL THEN
    RAISE EXCEPTION 'fulfillment revision option % not found', NEW.price_option_id;
  END IF;
  IF option_kind NOT IN ('package', 'membership') THEN
    RAISE EXCEPTION 'fulfillment revisions exist only for entitlement kinds (option %, kind %)',
      NEW.price_option_id, option_kind;
  END IF;
  IF option_kind = 'package' THEN
    IF NEW.usage_kind <> 'finite' THEN
      RAISE EXCEPTION 'package fulfillment is finite (option %)', NEW.price_option_id;
    END IF;
    IF NEW.uses_total IS NOT NULL THEN
      RAISE EXCEPTION 'package uses_total derives from sessions_count (option %)',
        NEW.price_option_id;
    END IF;
  ELSIF NEW.usage_kind = 'finite' AND NEW.uses_total IS NULL THEN
    RAISE EXCEPTION 'finite membership requires uses_total (option %)', NEW.price_option_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_fulfillment_revision_shape
  BEFORE INSERT ON price_option_fulfillment_revision
  FOR EACH ROW EXECUTE FUNCTION enforce_fulfillment_revision_shape();

-- Immutability: every term column frozen; only active → superseded moves.
CREATE FUNCTION enforce_fulfillment_revision_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.price_option_id <> OLD.price_option_id
     OR NEW.program_id <> OLD.program_id OR NEW.organization_id <> OLD.organization_id
     OR NEW.revision_no <> OLD.revision_no OR NEW.usage_kind <> OLD.usage_kind
     OR NEW.uses_total IS DISTINCT FROM OLD.uses_total
     OR NEW.validity_kind <> OLD.validity_kind
     OR NEW.validity_days IS DISTINCT FROM OLD.validity_days
     OR NEW.validity_end_date IS DISTINCT FROM OLD.validity_end_date
     OR NEW.reservation_required <> OLD.reservation_required
     OR NEW.walk_in_allowed <> OLD.walk_in_allowed
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'fulfillment revision terms are immutable (%)', OLD.id;
  END IF;
  IF OLD.state = 'superseded' THEN
    RAISE EXCEPTION 'fulfillment revision % is superseded and immutable', OLD.id;
  END IF;
  IF NEW.state <> OLD.state AND NEW.state <> 'superseded' THEN
    RAISE EXCEPTION 'invalid fulfillment revision transition % -> % (%)',
      OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_fulfillment_revision_updated_at
  BEFORE UPDATE ON price_option_fulfillment_revision
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_fulfillment_revision_version
  BEFORE UPDATE ON price_option_fulfillment_revision
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_fulfillment_revision_immutability
  BEFORE UPDATE ON price_option_fulfillment_revision
  FOR EACH ROW EXECUTE FUNCTION enforce_fulfillment_revision_immutability();
CREATE TRIGGER trg_fulfillment_revision_no_delete
  BEFORE DELETE ON price_option_fulfillment_revision
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The PROMISED recurring-pattern snapshot for schedule-bound membership
-- products (docs/35 §12, Correction 9): pattern TERMS copied at revision
-- creation — never a reference into the mutable recurring_schedule table.
CREATE TABLE price_option_fulfillment_schedule_term (
  id          uuid     NOT NULL,
  revision_id uuid     NOT NULL,
  weekday     smallint NOT NULL,
  start_time  time     NOT NULL,
  end_time    time     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_fulfillment_schedule_term PRIMARY KEY (id),
  CONSTRAINT uq_fulfillment_schedule_term UNIQUE (revision_id, weekday, start_time),
  CONSTRAINT fk_fulfillment_schedule_term_revision
    FOREIGN KEY (revision_id) REFERENCES price_option_fulfillment_revision (id),
  CONSTRAINT ck_fulfillment_schedule_weekday CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT ck_fulfillment_schedule_times CHECK (start_time < end_time)
);
COMMENT ON TABLE price_option_fulfillment_schedule_term IS
  'docs/35 §12: the immutable snapshot of the schedule pattern a schedule-bound membership product PROMISED at revision creation (weekday/time values copied — never a reference to mutable recurring_schedule rows). The purchased calendar derives from this snapshot ∩ entitlement validity; provider schedule edits affect only future revisions.';

CREATE TRIGGER trg_fulfillment_schedule_term_append_only
  BEFORE UPDATE OR DELETE ON price_option_fulfillment_schedule_term
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 3. price_quote — the generalized commercial-shape invariant (docs/35 §4).
--    Existing rows: default 'capacityPurchase', exactly one unit, capacity
--    option kind, NULL revision/entitlement — valid with ZERO rewrites.
------------------------------------------------------------------------------

ALTER TABLE price_quote
  ADD COLUMN commercial_shape text NOT NULL DEFAULT 'capacityPurchase';
ALTER TABLE price_quote ADD COLUMN fulfillment_revision_id uuid;
-- The S6-3 reservation binding (Correction A). Structure lands here so the
-- COMPLETE shape invariant is atomic in one migration; the FK is added
-- below once `entitlement` exists. No S6-1 service can create this shape.
ALTER TABLE price_quote ADD COLUMN entitlement_id uuid;

ALTER TABLE price_quote ADD CONSTRAINT ck_price_quote_commercial_shape
  CHECK (commercial_shape IN ('capacityPurchase', 'entitlementAcquisition',
                              'entitlementReservation'));
ALTER TABLE price_quote DROP CONSTRAINT ck_price_quote_option_kind;
ALTER TABLE price_quote ADD CONSTRAINT ck_price_quote_option_kind
  CHECK (option_kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free',
                         'membership'));
-- The owner-required quote invariant: exactly ONE commercial fulfillment
-- shape per quote (replaces ck_price_quote_one_unit).
ALTER TABLE price_quote DROP CONSTRAINT ck_price_quote_one_unit;
ALTER TABLE price_quote ADD CONSTRAINT ck_price_quote_shape CHECK (
  (commercial_shape = 'capacityPurchase'
     AND num_nonnulls(session_id, camp_week_id, cohort_id) = 1
     AND option_kind IN ('dropIn', 'monthly', 'term', 'camp', 'free')
     AND fulfillment_revision_id IS NULL AND entitlement_id IS NULL)
  OR (commercial_shape = 'entitlementAcquisition'
     AND num_nonnulls(session_id, camp_week_id, cohort_id) = 0
     AND option_kind IN ('package', 'membership')
     AND fulfillment_revision_id IS NOT NULL AND entitlement_id IS NULL)
  OR (commercial_shape = 'entitlementReservation'
     AND num_nonnulls(session_id, camp_week_id, cohort_id) = 1
     AND option_kind IN ('package', 'membership')
     AND total_fils = 0
     AND fulfillment_revision_id IS NULL AND entitlement_id IS NOT NULL)
);
-- The acquisition quote is structurally bound to the immutable terms in
-- force when the customer was quoted (revision ↔ option pinned).
ALTER TABLE price_quote ADD CONSTRAINT fk_price_quote_fulfillment_revision
  FOREIGN KEY (fulfillment_revision_id, price_option_id)
  REFERENCES price_option_fulfillment_revision (id, price_option_id);

-- Cross-trail impossibility, capacity side (docs/35 §4): composite targets
-- so a hold's unit must EQUAL its quote's unit — and a zero-unit
-- acquisition quote can never be held (hence never booked).
ALTER TABLE price_quote ADD CONSTRAINT uq_price_quote_id_session UNIQUE (id, session_id);
ALTER TABLE price_quote ADD CONSTRAINT uq_price_quote_id_camp_week UNIQUE (id, camp_week_id);
ALTER TABLE price_quote ADD CONSTRAINT uq_price_quote_id_cohort UNIQUE (id, cohort_id);
ALTER TABLE capacity_hold ADD CONSTRAINT fk_capacity_hold_quote_session
  FOREIGN KEY (quote_id, session_id) REFERENCES price_quote (id, session_id);
ALTER TABLE capacity_hold ADD CONSTRAINT fk_capacity_hold_quote_camp_week
  FOREIGN KEY (quote_id, camp_week_id) REFERENCES price_quote (id, camp_week_id);
ALTER TABLE capacity_hold ADD CONSTRAINT fk_capacity_hold_quote_cohort
  FOREIGN KEY (quote_id, cohort_id) REFERENCES price_quote (id, cohort_id);

------------------------------------------------------------------------------
-- 4. entitlement_purchase — the parallel unit-less commercial anchor
--    (docs/35 §5.1; D-RI-1/D-S6-1: never a fake capacity unit, never a hold).
------------------------------------------------------------------------------

CREATE TABLE entitlement_purchase (
  id                      uuid        NOT NULL,
  account_id              uuid        NOT NULL,
  participant_id          uuid        NOT NULL,
  organization_id         uuid        NOT NULL,
  program_id              uuid        NOT NULL,
  price_option_id         uuid        NOT NULL,
  offer_id                uuid,
  quote_id                uuid        NOT NULL,
  fulfillment_revision_id uuid        NOT NULL,
  state                   text        NOT NULL DEFAULT 'pending_payment',
  reference_code          text,
  -- Commercial checkout-ABANDONMENT metadata only (docs/35 §5.1): a
  -- Purchase holds no inventory; the wind-down sweep terminalizes only
  -- capture-less lapsed checkouts. Never capacity ownership.
  expires_at              timestamptz NOT NULL,
  confirmed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  version                 integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_entitlement_purchase PRIMARY KEY (id),
  -- One acquisition quote → at most ONE Purchase, ever (Correction B2:
  -- free/paid cross-path double-acquisition is structurally impossible).
  CONSTRAINT uq_entitlement_purchase_quote UNIQUE (quote_id),
  CONSTRAINT uq_entitlement_purchase_reference_code UNIQUE (reference_code),
  -- Composite target for the PaymentIntent purchase-trail FK (docs/35 §5.2).
  CONSTRAINT uq_entitlement_purchase_id_account_quote UNIQUE (id, account_id, quote_id),
  -- Composite target for the entitlement grant-identity FK: the grant's
  -- ownership/lineage/terms are provably the PURCHASE's, structurally.
  CONSTRAINT uq_entitlement_purchase_grant_identity
    UNIQUE (id, account_id, participant_id, organization_id, program_id,
            price_option_id, fulfillment_revision_id),
  CONSTRAINT fk_entitlement_purchase_account
    FOREIGN KEY (account_id) REFERENCES customer_account (id),
  CONSTRAINT fk_entitlement_purchase_participant
    FOREIGN KEY (participant_id, account_id) REFERENCES participant (id, account_id),
  CONSTRAINT fk_entitlement_purchase_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT fk_entitlement_purchase_option
    FOREIGN KEY (price_option_id, program_id) REFERENCES program_price_option (id, program_id),
  CONSTRAINT fk_entitlement_purchase_offer FOREIGN KEY (offer_id) REFERENCES offer (id),
  CONSTRAINT fk_entitlement_purchase_quote FOREIGN KEY (quote_id) REFERENCES price_quote (id),
  CONSTRAINT fk_entitlement_purchase_revision
    FOREIGN KEY (fulfillment_revision_id, price_option_id)
    REFERENCES price_option_fulfillment_revision (id, price_option_id),
  CONSTRAINT ck_entitlement_purchase_state
    CHECK (state IN ('pending_payment', 'confirmed', 'payment_failed', 'expired',
                     'compensated')),
  -- Confirmation facts exist from `confirmed` onward, never before.
  CONSTRAINT ck_entitlement_purchase_confirmation_facts
    CHECK ((state <> 'confirmed')
           OR (reference_code IS NOT NULL AND confirmed_at IS NOT NULL)),
  CONSTRAINT ck_entitlement_purchase_version CHECK (version >= 1)
);
COMMENT ON TABLE entitlement_purchase IS
  'docs/35 §5.1 (D-RI-1/D-S6-1): the smallest parallel commercial anchor for UNIT-LESS entitlement sales — one participant-beneficiary purchase of one entitlement-producing price option, once. Never a capacity unit, never a hold. Bound to its entitlementAcquisition quote (unique — one quote, one purchase, ever) and the immutable fulfillment revision the quote sold. Paid acquisition rests pending_payment beside its PaymentIntent; zero-price acquisition is inserted atomically as confirmed (Correction B — no observable zero-price pending_payment exists). expires_at is abandonment metadata only.';

CREATE INDEX ix_entitlement_purchase_account ON entitlement_purchase (account_id, created_at);
CREATE INDEX ix_entitlement_purchase_org ON entitlement_purchase (organization_id, created_at);

-- Insert shape: the referenced quote IS an entitlementAcquisition quote and
-- every identity column matches it (a capacity or reservation quote — or a
-- foreign identity — is refused at the row level; docs/35 §4 cross-trail).
CREATE FUNCTION enforce_entitlement_purchase_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
BEGIN
  SELECT commercial_shape, account_id, participant_id, organization_id, program_id,
         price_option_id, offer_id, fulfillment_revision_id
    INTO q FROM price_quote WHERE id = NEW.quote_id;
  IF q IS NULL THEN
    RAISE EXCEPTION 'entitlement_purchase quote % not found', NEW.quote_id;
  END IF;
  IF q.commercial_shape <> 'entitlementAcquisition' THEN
    RAISE EXCEPTION 'entitlement_purchase requires an entitlementAcquisition quote (%)',
      NEW.quote_id;
  END IF;
  IF q.account_id <> NEW.account_id OR q.participant_id <> NEW.participant_id
     OR q.organization_id <> NEW.organization_id OR q.program_id <> NEW.program_id
     OR q.price_option_id IS DISTINCT FROM NEW.price_option_id
     OR q.offer_id IS DISTINCT FROM NEW.offer_id
     OR q.fulfillment_revision_id IS DISTINCT FROM NEW.fulfillment_revision_id THEN
    RAISE EXCEPTION 'entitlement_purchase identity must equal its quote''s (%)', NEW.quote_id;
  END IF;
  IF NEW.state NOT IN ('pending_payment', 'confirmed') THEN
    RAISE EXCEPTION 'entitlement_purchase must be created pending_payment or confirmed (%)',
      NEW.state;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_entitlement_purchase_shape
  BEFORE INSERT ON entitlement_purchase
  FOR EACH ROW EXECUTE FUNCTION enforce_entitlement_purchase_shape();

-- The exact §5.1 state machine: identity frozen; terminals frozen;
-- pending_payment → confirmed | payment_failed | expired | compensated;
-- payment_failed → pending_payment | expired | compensated.
CREATE FUNCTION enforce_entitlement_purchase_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id
     OR NEW.participant_id <> OLD.participant_id
     OR NEW.organization_id <> OLD.organization_id OR NEW.program_id <> OLD.program_id
     OR NEW.price_option_id <> OLD.price_option_id
     OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
     OR NEW.quote_id <> OLD.quote_id
     OR NEW.fulfillment_revision_id <> OLD.fulfillment_revision_id
     OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'entitlement_purchase identity columns are immutable (%)', OLD.id;
  END IF;
  IF OLD.reference_code IS NOT NULL
     AND NEW.reference_code IS DISTINCT FROM OLD.reference_code THEN
    RAISE EXCEPTION 'entitlement_purchase reference_code is write-once (%)', OLD.id;
  END IF;
  IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION 'entitlement_purchase confirmed_at is write-once (%)', OLD.id;
  END IF;
  IF OLD.state IN ('confirmed', 'expired', 'compensated') THEN
    RAISE EXCEPTION 'entitlement_purchase % is terminal (%) and immutable', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'pending_payment'
               AND NEW.state IN ('confirmed', 'payment_failed', 'expired', 'compensated'))
           OR (OLD.state = 'payment_failed'
               AND NEW.state IN ('pending_payment', 'expired', 'compensated'))) THEN
    RAISE EXCEPTION 'invalid entitlement_purchase transition % -> % (%)',
      OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_entitlement_purchase_updated_at
  BEFORE UPDATE ON entitlement_purchase FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_entitlement_purchase_version
  BEFORE UPDATE ON entitlement_purchase FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_entitlement_purchase_transition
  BEFORE UPDATE ON entitlement_purchase
  FOR EACH ROW EXECUTE FUNCTION enforce_entitlement_purchase_transition();
CREATE TRIGGER trg_entitlement_purchase_no_delete
  BEFORE DELETE ON entitlement_purchase FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 5. entitlement — the append-only participant-owned grant (docs/35 §6).
------------------------------------------------------------------------------

CREATE TABLE entitlement (
  id                      uuid        NOT NULL,
  purchase_id             uuid        NOT NULL,
  account_id              uuid        NOT NULL,
  participant_id          uuid        NOT NULL,
  organization_id         uuid        NOT NULL,
  program_id              uuid        NOT NULL,
  price_option_id         uuid        NOT NULL,
  fulfillment_revision_id uuid        NOT NULL,
  usage_kind              text        NOT NULL,
  uses_total              integer,
  valid_from              timestamptz NOT NULL,
  valid_until             timestamptz,
  reservation_required    boolean     NOT NULL,
  walk_in_allowed         boolean     NOT NULL,
  branch_id               uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_entitlement PRIMARY KEY (id),
  -- Exactly ONE entitlement per confirmed purchase, ever.
  CONSTRAINT uq_entitlement_purchase UNIQUE (purchase_id),
  -- Composite target for the S6-3 reservation-quote ownership/lineage FK
  -- (Correction A): a reservation quote's account/participant/org/program
  -- are provably the ENTITLEMENT's at the row level.
  CONSTRAINT uq_entitlement_reservation_lineage
    UNIQUE (id, account_id, participant_id, organization_id, program_id),
  -- Grant identity ≡ purchase identity, structurally (7-column composite).
  CONSTRAINT fk_entitlement_purchase_identity
    FOREIGN KEY (purchase_id, account_id, participant_id, organization_id, program_id,
                 price_option_id, fulfillment_revision_id)
    REFERENCES entitlement_purchase (id, account_id, participant_id, organization_id,
                                     program_id, price_option_id, fulfillment_revision_id),
  CONSTRAINT fk_entitlement_account FOREIGN KEY (account_id) REFERENCES customer_account (id),
  CONSTRAINT fk_entitlement_participant
    FOREIGN KEY (participant_id, account_id) REFERENCES participant (id, account_id),
  CONSTRAINT fk_entitlement_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT fk_entitlement_option
    FOREIGN KEY (price_option_id, program_id) REFERENCES program_price_option (id, program_id),
  CONSTRAINT fk_entitlement_revision
    FOREIGN KEY (fulfillment_revision_id, price_option_id)
    REFERENCES price_option_fulfillment_revision (id, price_option_id),
  CONSTRAINT fk_entitlement_branch
    FOREIGN KEY (branch_id, organization_id) REFERENCES branch (id, organization_id),
  CONSTRAINT ck_entitlement_usage_kind CHECK (usage_kind IN ('finite', 'unlimited')),
  -- Finite vs unlimited are EXPLICIT modes: finite carries its immutable
  -- allowance; unlimited carries NO count of any kind (never a sentinel).
  CONSTRAINT ck_entitlement_finite_uses
    CHECK ((usage_kind = 'finite') = (uses_total IS NOT NULL)),
  CONSTRAINT ck_entitlement_uses_total CHECK (uses_total IS NULL OR uses_total > 0),
  CONSTRAINT ck_entitlement_validity
    CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT ck_entitlement_reservation_or_walkin
    CHECK (reservation_required OR walk_in_allowed)
);
COMMENT ON TABLE entitlement IS
  'docs/35 §6: the append-only participant-owned grant — created COMPLETE at acquisition confirmation, never edited (validity/terms snapshotted; D-S6-4: valid_from = acquisition confirmation). Belongs to ONE specific participant (composite FKs — cross-account/cross-participant substitution structurally impossible; no transferable/family package in V1). Finite truth: uses_total minus the S6-2 append-only attendance count — NO mutable used-counter exists as authority. Unlimited: a semantic mode with no count. Effective status (active/expired/exhausted) is DERIVED; no sweep is needed for correctness.';

CREATE INDEX ix_entitlement_account ON entitlement (account_id, created_at);
CREATE INDEX ix_entitlement_participant ON entitlement (participant_id);

-- A grant can exist only for a CONFIRMED purchase (created in the same
-- confirming transaction — the row is visible in-transaction).
CREATE FUNCTION enforce_entitlement_creation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  purchase_state text;
BEGIN
  SELECT state INTO purchase_state FROM entitlement_purchase WHERE id = NEW.purchase_id;
  IF purchase_state IS NULL THEN
    RAISE EXCEPTION 'entitlement purchase % not found', NEW.purchase_id;
  END IF;
  IF purchase_state <> 'confirmed' THEN
    RAISE EXCEPTION 'entitlement requires a confirmed purchase (% is %)',
      NEW.purchase_id, purchase_state;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_entitlement_creation
  BEFORE INSERT ON entitlement FOR EACH ROW EXECUTE FUNCTION enforce_entitlement_creation();
CREATE TRIGGER trg_entitlement_append_only
  BEFORE UPDATE OR DELETE ON entitlement FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The S6-3 reservation-quote binding (structure only in S6-1): ownership +
-- lineage pinned in ONE five-column FK; NULL entitlement_id skips it.
ALTER TABLE price_quote ADD CONSTRAINT fk_price_quote_entitlement
  FOREIGN KEY (entitlement_id, account_id, participant_id, organization_id, program_id)
  REFERENCES entitlement (id, account_id, participant_id, organization_id, program_id);

------------------------------------------------------------------------------
-- 6. payment_intent — exactly ONE commercial target (docs/35 §5.2).
--    Booking trail byte-compatible: columns, FKs, partial uniques untouched;
--    every existing row satisfies the new CHECKs with zero rewrites.
------------------------------------------------------------------------------

ALTER TABLE payment_intent ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE payment_intent ALTER COLUMN hold_id DROP NOT NULL;
ALTER TABLE payment_intent ADD COLUMN purchase_id uuid;
ALTER TABLE payment_intent ADD CONSTRAINT fk_payment_intent_purchase
  FOREIGN KEY (purchase_id, account_id, quote_id)
  REFERENCES entitlement_purchase (id, account_id, quote_id);
ALTER TABLE payment_intent ADD CONSTRAINT ck_payment_intent_one_target
  CHECK (num_nonnulls(booking_id, purchase_id) = 1);
-- A Booking target always carries its hold; a Purchase target never does.
ALTER TABLE payment_intent ADD CONSTRAINT ck_payment_intent_target_shape
  CHECK ((booking_id IS NULL) = (hold_id IS NULL));
CREATE UNIQUE INDEX uq_payment_intent_live_purchase
  ON payment_intent (purchase_id) WHERE state IN ('created', 'in_progress');
CREATE UNIQUE INDEX uq_payment_intent_succeeded_purchase
  ON payment_intent (purchase_id) WHERE state = 'succeeded';
CREATE INDEX ix_payment_intent_purchase
  ON payment_intent (purchase_id) WHERE purchase_id IS NOT NULL;

-- Identity freeze becomes NULL-safe and covers the new target column;
-- state-machine semantics unchanged.
CREATE OR REPLACE FUNCTION enforce_payment_intent_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.purchase_id IS DISTINCT FROM OLD.purchase_id
     OR NEW.account_id <> OLD.account_id OR NEW.quote_id <> OLD.quote_id
     OR NEW.hold_id IS DISTINCT FROM OLD.hold_id OR NEW.amount_fils <> OLD.amount_fils
     OR NEW.currency <> OLD.currency OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'payment_intent identity/commercial columns are immutable (%)', OLD.id;
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'payment_intent % is terminal (%) and immutable', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'created'
               AND NEW.state IN ('in_progress', 'expired', 'cancelled'))
           OR (OLD.state = 'in_progress'
               AND NEW.state IN ('succeeded', 'failed', 'expired', 'cancelled'))) THEN
    RAISE EXCEPTION 'invalid payment_intent transition % -> % (%)', OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;

-- D-W5-7 org binding becomes TARGET-NEUTRAL without weakening: the
-- snapshot's organization must equal the intent's ACTUAL target's
-- organization (Booking or EntitlementPurchase); the composite term FK
-- continues to pin term ↔ organization. Cross-provider substitution stays
-- structurally impossible on BOTH trails.
CREATE OR REPLACE FUNCTION enforce_economics_org_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_org uuid;
BEGIN
  SELECT COALESCE(b.organization_id, ep.organization_id) INTO target_org
  FROM payment_intent i
  LEFT JOIN booking b ON b.id = i.booking_id
  LEFT JOIN entitlement_purchase ep ON ep.id = i.purchase_id
  WHERE i.id = NEW.intent_id;
  IF target_org IS NULL THEN
    RAISE EXCEPTION 'payment_intent_economics intent % not found', NEW.intent_id;
  END IF;
  IF target_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'economics organization must be the commercial target''s organization (%)',
      NEW.intent_id;
  END IF;
  RETURN NEW;
END $$;

------------------------------------------------------------------------------
-- 7. package_entitlement — SUPERSEDED (D-S6-2). Guarded: the legacy table
--    has never had a write path; refuse destructive supersession if any row
--    somehow exists.
------------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM package_entitlement) THEN
    RAISE EXCEPTION 'package_entitlement must be empty before supersession (D-S6-2)';
  END IF;
END $$;
DROP TABLE package_entitlement;

------------------------------------------------------------------------------
-- 8. Grants — no DELETE anywhere; append-only surfaces have no UPDATE.
------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON price_option_fulfillment_revision TO himma_app;
GRANT SELECT, INSERT ON price_option_fulfillment_schedule_term TO himma_app;
GRANT SELECT, INSERT, UPDATE ON entitlement_purchase TO himma_app;
GRANT SELECT, INSERT ON entitlement TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Restores the exact pre-S6-1 schema.
--
-- FAIL-CLOSED PREFLIGHT (S6-1 owner correction): the downgrade may proceed
-- ONLY when the database is fully representable by the legacy 0016 schema.
-- If ANY S6-1-native durable commercial state exists — entitlement
-- purchases, entitlements, purchase-target payment intents, non-capacity
-- quote shapes, fulfillment revisions/schedule snapshots, or price options
-- the 0016 CHECKs cannot represent (membership kind; zero-amount
-- entitlement pricing) — the downgrade is REFUSED as the FIRST statement,
-- before any destructive DDL. Safety never depends on a later NOT NULL/FK
-- restoration accidentally failing: node-pg-migrate runs each migration in
-- ONE transaction, and this explicit guard aborts it with nothing touched.
-- Production commercial data is never deleted or transformed automatically.

DO $$
DECLARE
  purchases        bigint;
  grants           bigint;
  purchase_intents bigint;
  shaped_quotes    bigint;
  revisions        bigint;
  schedule_terms   bigint;
  new_options      bigint;
BEGIN
  SELECT count(*) INTO purchases FROM entitlement_purchase;
  SELECT count(*) INTO grants FROM entitlement;
  SELECT count(*) INTO purchase_intents FROM payment_intent WHERE purchase_id IS NOT NULL;
  SELECT count(*) INTO shaped_quotes FROM price_quote
    WHERE commercial_shape <> 'capacityPurchase';
  SELECT count(*) INTO revisions FROM price_option_fulfillment_revision;
  SELECT count(*) INTO schedule_terms FROM price_option_fulfillment_schedule_term;
  SELECT count(*) INTO new_options FROM program_price_option
    WHERE kind = 'membership' OR (kind = 'package' AND amount_fils = 0);
  IF purchases > 0 OR grants > 0 OR purchase_intents > 0 OR shaped_quotes > 0
     OR revisions > 0 OR schedule_terms > 0 OR new_options > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'Downgrade of 0017 refused: S6-1-native data exists and the legacy 0016 schema cannot represent it (entitlement_purchase=%s, entitlement=%s, purchase-target payment_intents=%s, non-capacityPurchase quotes=%s, fulfillment revisions=%s, schedule terms=%s, 0016-incompatible price options=%s). Commercial state is never silently destroyed — roll forward instead (docs/25 §9; docs/35 §21).',
      purchases, grants, purchase_intents, shaped_quotes, revisions, schedule_terms,
      new_options);
  END IF;
END $$;

ALTER TABLE payment_intent DROP CONSTRAINT ck_payment_intent_target_shape;
ALTER TABLE payment_intent DROP CONSTRAINT ck_payment_intent_one_target;
ALTER TABLE payment_intent DROP CONSTRAINT fk_payment_intent_purchase;
DROP INDEX uq_payment_intent_live_purchase;
DROP INDEX uq_payment_intent_succeeded_purchase;
DROP INDEX ix_payment_intent_purchase;
ALTER TABLE payment_intent DROP COLUMN purchase_id;
ALTER TABLE payment_intent ALTER COLUMN booking_id SET NOT NULL;
ALTER TABLE payment_intent ALTER COLUMN hold_id SET NOT NULL;

CREATE OR REPLACE FUNCTION enforce_payment_intent_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.booking_id <> OLD.booking_id
     OR NEW.account_id <> OLD.account_id OR NEW.quote_id <> OLD.quote_id
     OR NEW.hold_id <> OLD.hold_id OR NEW.amount_fils <> OLD.amount_fils
     OR NEW.currency <> OLD.currency OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'payment_intent identity/commercial columns are immutable (%)', OLD.id;
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'payment_intent % is terminal (%) and immutable', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'created'
               AND NEW.state IN ('in_progress', 'expired', 'cancelled'))
           OR (OLD.state = 'in_progress'
               AND NEW.state IN ('succeeded', 'failed', 'expired', 'cancelled'))) THEN
    RAISE EXCEPTION 'invalid payment_intent transition % -> % (%)', OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_economics_org_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  booking_org uuid;
BEGIN
  SELECT b.organization_id INTO booking_org
  FROM payment_intent i JOIN booking b ON b.id = i.booking_id
  WHERE i.id = NEW.intent_id;
  IF booking_org IS NULL THEN
    RAISE EXCEPTION 'payment_intent_economics intent % not found', NEW.intent_id;
  END IF;
  IF booking_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'economics organization must be the booking''s organization (%)',
      NEW.intent_id;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE price_quote DROP CONSTRAINT fk_price_quote_entitlement;
DROP TABLE entitlement;
DROP TABLE entitlement_purchase;
DROP FUNCTION enforce_entitlement_creation();
DROP FUNCTION enforce_entitlement_purchase_transition();
DROP FUNCTION enforce_entitlement_purchase_shape();

ALTER TABLE capacity_hold DROP CONSTRAINT fk_capacity_hold_quote_session;
ALTER TABLE capacity_hold DROP CONSTRAINT fk_capacity_hold_quote_camp_week;
ALTER TABLE capacity_hold DROP CONSTRAINT fk_capacity_hold_quote_cohort;
ALTER TABLE price_quote DROP CONSTRAINT uq_price_quote_id_session;
ALTER TABLE price_quote DROP CONSTRAINT uq_price_quote_id_camp_week;
ALTER TABLE price_quote DROP CONSTRAINT uq_price_quote_id_cohort;
ALTER TABLE price_quote DROP CONSTRAINT fk_price_quote_fulfillment_revision;
ALTER TABLE price_quote DROP CONSTRAINT ck_price_quote_shape;
ALTER TABLE price_quote ADD CONSTRAINT ck_price_quote_one_unit
  CHECK (num_nonnulls(session_id, camp_week_id, cohort_id) = 1);
ALTER TABLE price_quote DROP CONSTRAINT ck_price_quote_option_kind;
ALTER TABLE price_quote ADD CONSTRAINT ck_price_quote_option_kind
  CHECK (option_kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free'));
ALTER TABLE price_quote DROP CONSTRAINT ck_price_quote_commercial_shape;
ALTER TABLE price_quote DROP COLUMN entitlement_id;
ALTER TABLE price_quote DROP COLUMN fulfillment_revision_id;
ALTER TABLE price_quote DROP COLUMN commercial_shape;

DROP TABLE price_option_fulfillment_schedule_term;
DROP TABLE price_option_fulfillment_revision;
DROP FUNCTION enforce_fulfillment_revision_immutability();
DROP FUNCTION enforce_fulfillment_revision_shape();

ALTER TABLE program_price_option DROP CONSTRAINT ck_program_price_option_amount_positive;
ALTER TABLE program_price_option ADD CONSTRAINT ck_program_price_option_amount_positive
  CHECK (amount_fils IS NULL OR amount_fils > 0);
ALTER TABLE program_price_option DROP CONSTRAINT ck_program_price_option_kind;
ALTER TABLE program_price_option ADD CONSTRAINT ck_program_price_option_kind
  CHECK (kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free'));

CREATE TABLE package_entitlement (
  booking_id     uuid        NOT NULL,
  sessions_total integer     NOT NULL,
  sessions_used  integer     NOT NULL DEFAULT 0,
  expiry_policy  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_package_entitlement PRIMARY KEY (booking_id),
  CONSTRAINT fk_package_entitlement_booking FOREIGN KEY (booking_id) REFERENCES booking (id),
  CONSTRAINT ck_package_entitlement_bounds
    CHECK (sessions_total >= 1 AND sessions_used >= 0 AND sessions_used <= sessions_total)
);
CREATE TRIGGER trg_package_entitlement_append_only
  BEFORE UPDATE OR DELETE ON package_entitlement FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT SELECT, INSERT ON package_entitlement TO himma_app;
