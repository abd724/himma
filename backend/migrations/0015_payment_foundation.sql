-- 0015_payment_foundation — W5 · W5-1: payment persistence foundation
-- (docs/33 §4–§5, §17 W5-1; docs/24 §4.1, §5.8, §6; owner rulings D-W5-1
-- Stripe / D-W5-2 hosted Checkout / D-W5-3 tax-notConfigured with gated
-- production charging, recorded in docs/33 §14.1).
--
-- Four tables in the CANONICAL docs/24 vocabulary (never Stripe object
-- names): payment_intent (the durable internal commercial/orchestration
-- record — NOT a cached gateway object), payment_attempt (append-only
-- post-terminal interaction records), payment_transaction (the append-only
-- financial ledger — no state machine, no edits), gateway_event (the
-- replay-safe webhook inbox — bounded machine fields + payload digest,
-- never a raw JSON blob as domain model).
--
-- Structural bindings (docs/24 §6.9-style spine): a PaymentIntent can NEVER
-- migrate to another Booking, customer, quote, hold, or amount — one
-- composite FK pins (booking, account, quote, hold) to the SAME booking
-- row, a BEFORE INSERT trigger pins amount_fils to the bound quote's
-- total_fils (> 0: a zero-total quote is §7.3's free path and never enters
-- the paid boundary — the certified S5-3 invariant), and the transition
-- trigger freezes every identity column plus terminal states.
--
-- Exactly-one commercial intent (docs/24 §4.1/§6.6): UNIQUE
-- idempotency_key (a retried checkout confirmation REJOINS its intent);
-- at most ONE live (created|in_progress) intent per booking; at most ONE
-- succeeded intent per booking.
--
-- Deliberately ABSENT (docs/33 §18; D-W5-1/D-W5-3): refund, payout,
-- credit-ledger, reconciliation tables (their owning slices create them);
-- Stripe Connect; VAT columns beyond the certified quote snapshot; ANY
-- column for PAN/CVV/track data or gateway/webhook secrets — credentials
-- live in runtime secret configuration, never PostgreSQL business rows
-- (pinned by payment-schema.test.ts).
--
-- State vocabulary is docs/24 §5.8 EXACTLY. Two reconciliations are
-- surfaced (not silent): (1) `created → expired|cancelled` is legal in
-- addition to the linear `created → in_progress` chain — a gateway-create
-- failure or pre-attempt abandonment must be able to terminate an intent
-- that never reached the gateway; `succeeded` remains reachable ONLY from
-- `in_progress`. (2) `started → captured` is legal on payment_attempt —
-- D-W5-2 hosted Checkout auto-captures, so capture evidence may arrive
-- without a distinct authorized step (docs/33 §6: the vocabulary is not
-- widened; the authorized state simply may not occur at runtime).

-- Up Migration

------------------------------------------------------------------------------
-- 0. Certified-table change (additive; the 0004/S5-1 reported pattern):
--    booking gains ONE enabling unique so the intent's composite FK can pin
--    booking+account+quote+hold to a single row. `id` is already unique, so
--    this adds no new row constraint — it is purely the FK target.
------------------------------------------------------------------------------

ALTER TABLE booking
  ADD CONSTRAINT uq_booking_id_account_quote_hold UNIQUE (id, account_id, quote_id, hold_id);

------------------------------------------------------------------------------
-- 1. payment_intent — the durable internal payment-orchestration authority.
------------------------------------------------------------------------------

CREATE TABLE payment_intent (
  id              uuid        NOT NULL,
  booking_id      uuid        NOT NULL,
  account_id      uuid        NOT NULL,
  quote_id        uuid        NOT NULL,
  hold_id         uuid        NOT NULL,
  amount_fils     bigint      NOT NULL,
  currency        char(3)     NOT NULL DEFAULT 'AED',
  state           text        NOT NULL DEFAULT 'created',
  idempotency_key text        NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_payment_intent PRIMARY KEY (id),
  -- One intent per intended checkout confirmation (docs/24 §4.1): retries
  -- rejoin via this key; a NEW checkout is a NEW key.
  CONSTRAINT uq_payment_intent_idempotency_key UNIQUE (idempotency_key),
  -- The intent's booking/account/quote/hold are ONE booking row's values —
  -- a mismatched account, foreign quote, or foreign hold cannot exist.
  CONSTRAINT fk_payment_intent_booking
    FOREIGN KEY (booking_id, account_id, quote_id, hold_id)
    REFERENCES booking (id, account_id, quote_id, hold_id),
  CONSTRAINT fk_payment_intent_account FOREIGN KEY (account_id) REFERENCES customer_account (id),
  CONSTRAINT fk_payment_intent_quote FOREIGN KEY (quote_id) REFERENCES price_quote (id),
  CONSTRAINT fk_payment_intent_hold FOREIGN KEY (hold_id) REFERENCES capacity_hold (id),
  CONSTRAINT ck_payment_intent_currency CHECK (currency = 'AED'),
  -- Zero-total never enters the paid boundary (S5-3 certified invariant).
  CONSTRAINT ck_payment_intent_amount CHECK (amount_fils > 0),
  CONSTRAINT ck_payment_intent_state
    CHECK (state IN ('created', 'in_progress', 'succeeded', 'failed', 'expired', 'cancelled')),
  CONSTRAINT ck_payment_intent_version CHECK (version >= 1)
);
COMMENT ON TABLE payment_intent IS
  'docs/24 §4.1/§5.8: the durable INTERNAL commercial/payment-orchestration record — never a cached gateway object. One per intended checkout confirmation (unique idempotency_key; retries rejoin). Identity (booking/account/quote/hold/amount/currency/key/TTL) is immutable after creation; amount equals the bound quote total by trigger; terminal states freeze the row. Gateway identifiers live on payment_attempt, never here.';

CREATE INDEX ix_payment_intent_booking ON payment_intent (booking_id);
-- At most one LIVE intended payment per booking (duplicate-intent storm
-- serializer), and at most one commercial success per booking — partial
-- uniques are the database authority, not application courtesy.
CREATE UNIQUE INDEX uq_payment_intent_live_booking
  ON payment_intent (booking_id) WHERE state IN ('created', 'in_progress');
CREATE UNIQUE INDEX uq_payment_intent_succeeded_booking
  ON payment_intent (booking_id) WHERE state = 'succeeded';

-- amount_fils == the bound quote's total, at insert time, structurally.
CREATE FUNCTION enforce_payment_intent_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  quote_total bigint;
BEGIN
  SELECT total_fils INTO quote_total FROM price_quote WHERE id = NEW.quote_id;
  IF quote_total IS NULL THEN
    RAISE EXCEPTION 'payment_intent quote % not found', NEW.quote_id;
  END IF;
  IF quote_total = 0 THEN
    RAISE EXCEPTION 'zero-total quote % has no payment to intend (free path)', NEW.quote_id;
  END IF;
  IF NEW.amount_fils <> quote_total THEN
    RAISE EXCEPTION 'payment_intent amount % must equal quote total % (docs/24 §7.4a)',
      NEW.amount_fils, quote_total;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payment_intent_amount
  BEFORE INSERT ON payment_intent FOR EACH ROW EXECUTE FUNCTION enforce_payment_intent_amount();

CREATE FUNCTION enforce_payment_intent_transition() RETURNS trigger
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
CREATE TRIGGER trg_payment_intent_updated_at
  BEFORE UPDATE ON payment_intent FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payment_intent_version
  BEFORE UPDATE ON payment_intent FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_payment_intent_transition
  BEFORE UPDATE ON payment_intent FOR EACH ROW EXECUTE FUNCTION enforce_payment_intent_transition();

------------------------------------------------------------------------------
-- 2. payment_attempt — one row per gateway interaction; a retry is a NEW
--    attempt under the same intent (docs/24 §4.1/§5.8). Append-only after a
--    terminal state (§6.8).
------------------------------------------------------------------------------

CREATE TABLE payment_attempt (
  id           uuid        NOT NULL,
  intent_id    uuid        NOT NULL,
  sequence_no  integer     NOT NULL,
  -- D-W5-2 reconciliation: under hosted Checkout the concrete method is
  -- EVIDENCE-derived (chosen on the gateway's page), so it is nullable
  -- until known; the vocabulary is the docs/24 §4.1 set when present.
  method       text,
  -- OPAQUE provider reference (docs/33 §6): Stripe ids are stored as
  -- meaningless text; the domain never parses or shapes them.
  gateway_ref  text,
  state        text        NOT NULL DEFAULT 'started',
  -- Bounded machine category, never gateway prose; failed terminals only.
  failure_code text,
  threeds_ref  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_payment_attempt PRIMARY KEY (id),
  CONSTRAINT uq_payment_attempt_sequence UNIQUE (intent_id, sequence_no),
  CONSTRAINT fk_payment_attempt_intent FOREIGN KEY (intent_id) REFERENCES payment_intent (id),
  CONSTRAINT ck_payment_attempt_method
    CHECK (method IS NULL OR method IN ('card', 'applePay', 'googlePay')),
  CONSTRAINT ck_payment_attempt_state
    CHECK (state IN ('started', 'requires_action', 'authorized', 'captured',
                     'declined', 'errored')),
  CONSTRAINT ck_payment_attempt_sequence CHECK (sequence_no >= 1),
  CONSTRAINT ck_payment_attempt_failure_code
    CHECK (failure_code IS NULL OR state IN ('declined', 'errored')),
  CONSTRAINT ck_payment_attempt_version CHECK (version >= 1)
);
COMMENT ON TABLE payment_attempt IS
  'docs/24 §4.1/§5.8: one gateway interaction; retries are NEW attempts under the same intent (never one-browser-attempt = one-intent). gateway_ref is an opaque write-once provider reference; method is evidence-derived under D-W5-2 hosted Checkout; terminal rows (captured/declined/errored) are frozen (§6.8 post-terminal append-only). No raw gateway request/response blobs, no PAN/CVV, ever.';

-- One provider object maps to at most one attempt — a replayed gateway
-- reference can never seed a second commercial trail.
CREATE UNIQUE INDEX uq_payment_attempt_gateway_ref
  ON payment_attempt (gateway_ref) WHERE gateway_ref IS NOT NULL;

CREATE FUNCTION enforce_payment_attempt_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.intent_id <> OLD.intent_id
     OR NEW.sequence_no <> OLD.sequence_no OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'payment_attempt identity columns are immutable (%)', OLD.id;
  END IF;
  IF OLD.gateway_ref IS NOT NULL AND NEW.gateway_ref IS DISTINCT FROM OLD.gateway_ref THEN
    RAISE EXCEPTION 'payment_attempt gateway_ref is write-once (%)', OLD.id;
  END IF;
  IF OLD.method IS NOT NULL AND NEW.method IS DISTINCT FROM OLD.method THEN
    RAISE EXCEPTION 'payment_attempt method is write-once (%)', OLD.id;
  END IF;
  IF OLD.state IN ('captured', 'declined', 'errored') THEN
    RAISE EXCEPTION 'payment_attempt % is terminal (%) and append-only', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'started'
               AND NEW.state IN ('requires_action', 'authorized', 'captured',
                                 'declined', 'errored'))
           OR (OLD.state = 'requires_action' AND NEW.state = 'started')
           OR (OLD.state = 'authorized'
               AND NEW.state IN ('captured', 'declined', 'errored'))) THEN
    RAISE EXCEPTION 'invalid payment_attempt transition % -> % (%)', OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payment_attempt_updated_at
  BEFORE UPDATE ON payment_attempt FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payment_attempt_version
  BEFORE UPDATE ON payment_attempt FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_payment_attempt_transition
  BEFORE UPDATE ON payment_attempt FOR EACH ROW EXECUTE FUNCTION enforce_payment_attempt_transition();
CREATE TRIGGER trg_payment_attempt_no_delete
  BEFORE DELETE ON payment_attempt FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 3. payment_transaction — the append-only financial ledger (docs/24 §4.1):
--    no state machine, no edits; the sum of postings is the financial truth.
--    Kinds cover the later capture / void-reversal / refund / adjustment
--    executions; W5-1 ships the AUTHORITY only — no gateway operation runs.
------------------------------------------------------------------------------

CREATE TABLE payment_transaction (
  id                     uuid        NOT NULL,
  attempt_id             uuid        NOT NULL,
  kind                   text        NOT NULL,
  -- Strictly positive magnitudes; DIRECTION is the kind (capture in,
  -- refund/reversal out — docs/24 §6.1's signed-column exception is not
  -- needed here). Signed adjustments, if ever required, are a reviewed
  -- reconciliation-slice change.
  amount_fils            bigint      NOT NULL,
  currency               char(3)     NOT NULL DEFAULT 'AED',
  gateway_transaction_id text        NOT NULL,
  posted_at              timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_payment_transaction PRIMARY KEY (id),
  -- Replay-safe financial identity (docs/24 §6): one gateway transaction
  -- posts exactly once, ever.
  CONSTRAINT uq_payment_transaction_gateway_id UNIQUE (gateway_transaction_id),
  CONSTRAINT fk_payment_transaction_attempt
    FOREIGN KEY (attempt_id) REFERENCES payment_attempt (id),
  CONSTRAINT ck_payment_transaction_kind
    CHECK (kind IN ('authorization', 'capture', 'refund', 'reversal', 'adjustment')),
  CONSTRAINT ck_payment_transaction_amount CHECK (amount_fils > 0),
  CONSTRAINT ck_payment_transaction_currency CHECK (currency = 'AED')
);
COMMENT ON TABLE payment_transaction IS
  'docs/24 §4.1: the append-only financial ledger — no state machine, no UPDATE/DELETE path ever (trigger + zero grants); corrections are compensating postings. gateway_transaction_id is globally unique so a replayed gateway notification can never post twice. W5-1 creates the persistence authority only; capture/void/reversal/refund execution belongs to later slices.';

CREATE INDEX ix_payment_transaction_attempt ON payment_transaction (attempt_id);

CREATE TRIGGER trg_payment_transaction_append_only
  BEFORE UPDATE OR DELETE ON payment_transaction FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 4. gateway_event — the replay-safe webhook/event inbox (docs/24 §4.1,
--    §7.8): bounded machine fields + payload digest; the raw body is
--    verified (W5-3) and digested, never stored as the domain model.
--    IDENTITY is append-only; the processing LIFECYCLE alone may move
--    (received → verified → processed | quarantined, §5.8) — the §6.8
--    append-only listing and the §5.8 machine reconciled explicitly.
------------------------------------------------------------------------------

CREATE TABLE gateway_event (
  id                 uuid        NOT NULL,
  -- D-W5-1: 'stripe' is the production provider; 'deterministicTest' exists
  -- for the certified test provider and is unselectable in production
  -- composition (payment-provider-port.test.ts pins both).
  provider           text        NOT NULL,
  gateway_event_id   text        NOT NULL,
  event_type         text        NOT NULL,
  payload_digest     text        NOT NULL,
  signature_verified boolean     NOT NULL DEFAULT false,
  processing_state   text        NOT NULL DEFAULT 'received',
  attempt_id         uuid,
  transaction_id     uuid,
  received_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_gateway_event PRIMARY KEY (id),
  -- ONE commercial effect per provider event: duplicate deliveries
  -- insert-conflict into a no-op (docs/24 §6.7, §8.8).
  CONSTRAINT uq_gateway_event_provider_event UNIQUE (provider, gateway_event_id),
  CONSTRAINT fk_gateway_event_attempt FOREIGN KEY (attempt_id) REFERENCES payment_attempt (id),
  CONSTRAINT fk_gateway_event_transaction
    FOREIGN KEY (transaction_id) REFERENCES payment_transaction (id),
  CONSTRAINT ck_gateway_event_provider CHECK (provider IN ('stripe', 'deterministicTest')),
  CONSTRAINT ck_gateway_event_state
    CHECK (processing_state IN ('received', 'verified', 'processed', 'quarantined')),
  CONSTRAINT ck_gateway_event_version CHECK (version >= 1)
);
COMMENT ON TABLE gateway_event IS
  'docs/24 §4.1/§7.8: append-only webhook inbox — (provider, gateway_event_id) unique makes duplicate delivery a structural no-op; identity/digest/receipt facts are immutable; ONLY the §5.8 processing lifecycle moves (received → verified → processed | quarantined; terminals frozen — a quarantine re-drive would be its own reviewed, audited operation). Signature verification (raw body, timestamp/replay window, endpoint-specific secret) precedes trusted acceptance and is W5-3 work. Bounded fields + digest only: no raw webhook JSON blob, no secrets.';

-- The W5-3 catch-up sweep reads unprocessed events oldest-first.
CREATE INDEX ix_gateway_event_unprocessed
  ON gateway_event (received_at) WHERE processing_state IN ('received', 'verified');

CREATE FUNCTION enforce_gateway_event_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.provider <> OLD.provider
     OR NEW.gateway_event_id <> OLD.gateway_event_id
     OR NEW.event_type <> OLD.event_type
     OR NEW.payload_digest <> OLD.payload_digest
     OR NEW.signature_verified <> OLD.signature_verified
     OR NEW.received_at <> OLD.received_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'gateway_event identity/receipt columns are immutable (%)', OLD.id;
  END IF;
  IF OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id THEN
    RAISE EXCEPTION 'gateway_event attempt link is write-once (%)', OLD.id;
  END IF;
  IF OLD.transaction_id IS NOT NULL
     AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
    RAISE EXCEPTION 'gateway_event transaction link is write-once (%)', OLD.id;
  END IF;
  IF OLD.processing_state IN ('processed', 'quarantined') THEN
    RAISE EXCEPTION 'gateway_event % is terminal (%) and immutable', OLD.id, OLD.processing_state;
  END IF;
  IF NEW.processing_state <> OLD.processing_state
     AND NOT ((OLD.processing_state = 'received'
               AND NEW.processing_state IN ('verified', 'quarantined'))
           OR (OLD.processing_state = 'verified'
               AND NEW.processing_state IN ('processed', 'quarantined'))) THEN
    RAISE EXCEPTION 'invalid gateway_event transition % -> % (%)',
      OLD.processing_state, NEW.processing_state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_gateway_event_updated_at
  BEFORE UPDATE ON gateway_event FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_gateway_event_version
  BEFORE UPDATE ON gateway_event FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_gateway_event_transition
  BEFORE UPDATE ON gateway_event FOR EACH ROW EXECUTE FUNCTION enforce_gateway_event_transition();
CREATE TRIGGER trg_gateway_event_no_delete
  BEFORE DELETE ON gateway_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- 5. Grants — no DELETE anywhere; the financial ledger additionally has no
--    UPDATE (docs/24 §6.8).
------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON payment_intent TO himma_app;
GRANT SELECT, INSERT, UPDATE ON payment_attempt TO himma_app;
GRANT SELECT, INSERT ON payment_transaction TO himma_app;
GRANT SELECT, INSERT, UPDATE ON gateway_event TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations).

DROP TABLE gateway_event;
DROP TABLE payment_transaction;
DROP TABLE payment_attempt;
DROP TABLE payment_intent;
DROP FUNCTION enforce_gateway_event_transition();
DROP FUNCTION enforce_payment_attempt_transition();
DROP FUNCTION enforce_payment_intent_transition();
DROP FUNCTION enforce_payment_intent_amount();
ALTER TABLE booking DROP CONSTRAINT uq_booking_id_account_quote_hold;
