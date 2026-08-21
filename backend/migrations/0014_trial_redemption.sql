-- 0014_trial_redemption — W4 Slice 5 · S5-5: the D-10 freeTrial redemption
-- authority (owner ruling 2026-08-21, docs/32 §20 D-10).
--
-- ONE immutable record per (participant, program): the primary key IS the
-- ruling — "one confirmed freeTrial redemption per participant per stable
-- Program ID, lifetime". The PURCHASER/ACCOUNT is deliberately NOT part of
-- the key (each child/participant carries its own entitlement; account_id
-- rides along as an informational/audit column only). Different Programs
-- are independent rows; every Session of one Program contends for the SAME
-- row; replacing/reactivating the Offer changes nothing here (the key has
-- no offer component — offer_id is a snapshot of WHICH offer was redeemed).
--
-- Consumption semantics (service-enforced in the §7.3 confirmation
-- transaction, structurally backed here): the row is inserted ATOMICALLY
-- with the successful free-trial Booking confirmation — quotes, holds,
-- pending/failed/expired/released attempts never insert it; a failed or
-- rolled-back confirmation leaves no row; idempotent replays never
-- re-execute; two concurrent confirmations on different Sessions of one
-- Program serialize on the primary key and exactly one commits.
--
-- NO restoration path exists (append-only guards + zero UPDATE/DELETE
-- grants): a future explicitly certified provider-disruption restoration
-- policy would arrive as its own reviewed change. NOT a coupon engine:
-- no reset periods, no counters, no paidTrial coverage (D-10 explicitly
-- excludes paidTrial).

-- Up Migration

CREATE TABLE trial_redemption (
  participant_id uuid        NOT NULL,
  program_id     uuid        NOT NULL,
  account_id     uuid        NOT NULL,
  booking_id     uuid        NOT NULL,
  offer_id       uuid        NOT NULL,
  redeemed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_trial_redemption PRIMARY KEY (participant_id, program_id),
  -- One confirmed Booking is one redemption — a booking can never back two.
  CONSTRAINT uq_trial_redemption_booking UNIQUE (booking_id),
  -- The participant belongs to the recorded account (docs/24 §6.9 spine).
  CONSTRAINT fk_trial_redemption_participant
    FOREIGN KEY (participant_id, account_id) REFERENCES participant (id, account_id),
  CONSTRAINT fk_trial_redemption_program FOREIGN KEY (program_id) REFERENCES program (id),
  CONSTRAINT fk_trial_redemption_booking FOREIGN KEY (booking_id) REFERENCES booking (id),
  CONSTRAINT fk_trial_redemption_offer FOREIGN KEY (offer_id) REFERENCES offer (id)
);
COMMENT ON TABLE trial_redemption IS
  'D-10 (docs/32 §20): one confirmed freeTrial redemption per participant per Program, LIFETIME — the primary key is the ruling. Inserted only inside the §7.3 free-trial confirmation transaction, atomically with the confirmed Booking; append-only with no UPDATE/DELETE grant — no automatic restoration exists (a future certified disruption-restoration policy would be its own reviewed change). paidTrial is explicitly outside D-10.';

CREATE TRIGGER trg_trial_redemption_append_only
  BEFORE UPDATE OR DELETE ON trial_redemption FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT ON trial_redemption TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations).

DROP TABLE trial_redemption;
