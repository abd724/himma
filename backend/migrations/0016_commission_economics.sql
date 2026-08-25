-- 0016_commission_economics — W5 · W5-4 owner correction: marketplace
-- commission economics (owner ruling D-W5-7, 2026-08-21; docs/33 §14.1).
--
-- Himma's core business model: a provider-specific marketplace commission
-- on paid marketplace sales (commonly 10% = 1000 bps or 12% = 1200 bps —
-- NEVER hard-coded, NEVER defaulted). Two narrow tables:
--
-- 1. organization_commission_term — the SMALLEST authoritative
--    provider-commercial-terms mechanism (reconciled: S3-1 deliberately
--    shipped `organization.commercial_terms_ref` as a dangling reference
--    with commission "deliberately ABSENT"; docs/24 §14.B4 left the model
--    owner-open — D-W5-7 now rules it). Server-authoritative, org-bound,
--    rate immutable per row; a rate CHANGE supersedes the old row and
--    inserts a new active one, so history is preserved and at most ONE
--    active term exists per organization. No customer/Offer/payment-API
--    channel can write it (no route exists at all — a future admin
--    surface would be its own explicitly D-W3-5-classified slice; terms
--    are seeded operationally until then). NOT a contracts/billing
--    engine: one rate, one lifecycle. `commercial_terms_ref` is left
--    untouched as the anticipated future linkage seam.
--
-- 2. payment_intent_economics — the IMMUTABLE per-intent economics
--    snapshot, written in the SAME transaction as PaymentIntent creation
--    (checkout time, never payout time): commission basis (the certified
--    pre-tax activity-sale quote amount under D-W5-3 `notConfigured` —
--    deliberately a SEPARATE column from the customer charge even while
--    equal today), the applied rate in bps, and the split. Structural
--    reconciliation: commission + provider share = basis, all
--    non-negative; append-only (no UPDATE/DELETE path); a BEFORE INSERT
--    trigger pins organization_id to the intent's BOOKING's organization
--    and the composite FK pins the term to that same organization —
--    cross-provider substitution is structurally impossible. Later term
--    changes never touch existing snapshots; idempotent checkout retries
--    reuse the exact committed row (1:1 primary key on intent).
--
-- Deliberately ABSENT (D-W5-7 §9/§10): payouts, Stripe Connect,
-- transfers, refund/clawback economics, gateway-fee allocation (an
-- explicit LATER owner/commercial decision), VAT allocation. Settlement
-- ELIGIBILITY is a projection (economics × succeeded intent × confirmed
-- booking), never a schema state here: a captured-but-compensated intent
-- keeps its snapshot for audit/history and yields NO settleable
-- commission and NO provider payable.

-- Up Migration

------------------------------------------------------------------------------
-- 1. organization_commission_term — provider → active agreed rate (bps).
------------------------------------------------------------------------------

CREATE TABLE organization_commission_term (
  id              uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  rate_bps        integer     NOT NULL,
  state           text        NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_organization_commission_term PRIMARY KEY (id),
  -- Composite target so an economics row can pin term↔organization.
  CONSTRAINT uq_commission_term_id_org UNIQUE (id, organization_id),
  CONSTRAINT fk_commission_term_org FOREIGN KEY (organization_id) REFERENCES organization (id),
  CONSTRAINT ck_commission_term_rate CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  CONSTRAINT ck_commission_term_state CHECK (state IN ('active', 'superseded')),
  CONSTRAINT ck_commission_term_version CHECK (version >= 1)
);
COMMENT ON TABLE organization_commission_term IS
  'D-W5-7: the provider-specific agreed marketplace commission rate in basis points (10% = 1000; never hard-coded, never defaulted). Server-authoritative and organization-bound; at most one ACTIVE term per organization; the rate is immutable per row — a change supersedes and inserts, preserving history for existing snapshots. Written by no route (future admin surface = its own D-W3-5-classified slice).';

CREATE UNIQUE INDEX uq_commission_term_active_org
  ON organization_commission_term (organization_id) WHERE state = 'active';

CREATE FUNCTION enforce_commission_term_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
     OR NEW.rate_bps <> OLD.rate_bps OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'commission term identity/rate is immutable (%)', OLD.id;
  END IF;
  IF OLD.state = 'superseded' THEN
    RAISE EXCEPTION 'commission term % is superseded and immutable', OLD.id;
  END IF;
  IF NEW.state <> OLD.state AND NEW.state <> 'superseded' THEN
    RAISE EXCEPTION 'invalid commission term transition % -> % (%)', OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_commission_term_updated_at
  BEFORE UPDATE ON organization_commission_term FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_commission_term_version
  BEFORE UPDATE ON organization_commission_term FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_commission_term_transition
  BEFORE UPDATE ON organization_commission_term
  FOR EACH ROW EXECUTE FUNCTION enforce_commission_term_transition();
CREATE TRIGGER trg_commission_term_no_delete
  BEFORE DELETE ON organization_commission_term FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 2. payment_intent_economics — the immutable checkout-time snapshot.
------------------------------------------------------------------------------

CREATE TABLE payment_intent_economics (
  intent_id                       uuid        NOT NULL,
  organization_id                 uuid        NOT NULL,
  commission_term_id              uuid        NOT NULL,
  commission_basis_amount_fils    bigint      NOT NULL,
  platform_commission_rate_bps    integer     NOT NULL,
  platform_commission_amount_fils bigint      NOT NULL,
  provider_share_amount_fils      bigint      NOT NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_payment_intent_economics PRIMARY KEY (intent_id),
  CONSTRAINT fk_economics_intent FOREIGN KEY (intent_id) REFERENCES payment_intent (id),
  CONSTRAINT fk_economics_org FOREIGN KEY (organization_id) REFERENCES organization (id),
  -- The applied term BELONGS to the recorded organization, structurally.
  CONSTRAINT fk_economics_term
    FOREIGN KEY (commission_term_id, organization_id)
    REFERENCES organization_commission_term (id, organization_id),
  CONSTRAINT ck_economics_basis CHECK (commission_basis_amount_fils >= 0),
  CONSTRAINT ck_economics_rate
    CHECK (platform_commission_rate_bps >= 0 AND platform_commission_rate_bps <= 10000),
  CONSTRAINT ck_economics_commission CHECK (platform_commission_amount_fils >= 0),
  CONSTRAINT ck_economics_share CHECK (provider_share_amount_fils >= 0),
  -- The D-W5-7 structural invariant: the split reconciles EXACTLY.
  CONSTRAINT ck_economics_reconciles
    CHECK (platform_commission_amount_fils + provider_share_amount_fils
           = commission_basis_amount_fils)
);
COMMENT ON TABLE payment_intent_economics IS
  'D-W5-7: the immutable marketplace-economics snapshot for one paid PaymentIntent, written atomically with intent creation. Basis = the certified pre-tax activity-sale quote amount (D-W5-3 notConfigured; deliberately distinct from the customer charge column). commission + provider share = basis by CHECK; round-half-up in integer fils by the owner rounding rule. Append-only; later term changes never touch it. Settlement eligibility is a projection over succeeded intents/confirmed bookings — a compensated capture earns NO commission and NO provider payable.';

-- Cross-provider substitution is impossible: the snapshot's organization
-- IS the intent's booking's organization, verified at insert.
CREATE FUNCTION enforce_economics_org_binding() RETURNS trigger
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
CREATE TRIGGER trg_economics_org_binding
  BEFORE INSERT ON payment_intent_economics
  FOR EACH ROW EXECUTE FUNCTION enforce_economics_org_binding();
CREATE TRIGGER trg_economics_append_only
  BEFORE UPDATE OR DELETE ON payment_intent_economics
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 3. Grants — terms supersede via UPDATE; snapshots are INSERT-only;
--    no DELETE anywhere.
------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON organization_commission_term TO himma_app;
GRANT SELECT, INSERT ON payment_intent_economics TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations).

DROP TABLE payment_intent_economics;
DROP TABLE organization_commission_term;
DROP FUNCTION enforce_economics_org_binding();
DROP FUNCTION enforce_commission_term_transition();
