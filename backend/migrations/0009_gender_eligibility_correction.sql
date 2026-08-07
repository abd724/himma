-- 0009_gender_eligibility_correction — S4-1 owner correction (2026-08-07).
-- Narrowly scoped: the binding Himma product/filter model requires DISTINCT
-- gender-eligibility values `women | men | girls | boys | mixed` (a
-- girls-only activity must be representable directly, never inferred from
-- age ranges). The S4-1 schema shipped the superseded three-value
-- `men | ladies | mixed` vocabulary; `women` is the canonical stored code —
-- customer UI may later render it as "Ladies only", but presentation
-- wording never determines database semantics. min_age/max_age remain
-- independent constraints: nothing infers or rewrites girls/boys from age.
--
-- 0008_catalogue is applied and checksum-immutable (docs/25 §9), so this is
-- a corrective forward migration: it recodes any existing development/test
-- `ladies` rows to `women`, then replaces the two CHECK constraints
-- (program.gender_eligibility and the program_revision change-set copy).
-- No other schema object changes.
--
-- Runs in one transaction. No PostgreSQL-18-only features.

-- Up Migration

ALTER TABLE program DROP CONSTRAINT ck_program_gender;
ALTER TABLE program_revision DROP CONSTRAINT ck_program_revision_gender;

-- Deterministic recode of any pre-correction rows. User triggers are
-- suspended for the mechanical recode only: the frozen-terminal guards
-- (archived programs, decided revisions) would otherwise refuse the data
-- correction, and a vocabulary recode must not consume optimistic versions.
-- This is a reviewed migration running under the elevated role — himma_app
-- can never do this (no trigger-bypass privilege; proven in tests).
ALTER TABLE program DISABLE TRIGGER USER;
ALTER TABLE program_revision DISABLE TRIGGER USER;
UPDATE program SET gender_eligibility = 'women' WHERE gender_eligibility = 'ladies';
UPDATE program_revision SET gender_eligibility = 'women' WHERE gender_eligibility = 'ladies';
ALTER TABLE program ENABLE TRIGGER USER;
ALTER TABLE program_revision ENABLE TRIGGER USER;

ALTER TABLE program ADD CONSTRAINT ck_program_gender
  CHECK (gender_eligibility IN ('women', 'men', 'girls', 'boys', 'mixed'));
ALTER TABLE program_revision ADD CONSTRAINT ck_program_revision_gender
  CHECK (gender_eligibility IS NULL
    OR gender_eligibility IN ('women', 'men', 'girls', 'boys', 'mixed'));

COMMENT ON COLUMN program.gender_eligibility IS
  'Owner-corrected five-value vocabulary (2026-08-07): women|men|girls|boys|mixed. `women` is the canonical stored code ("Ladies only" is presentation wording only). Independent of min_age/max_age — girls/boys are explicit provider-declared eligibility, never age-inferred. Adults are never gender-filtered automatically (docs/24 §2.5.2).';

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Restores the superseded three-value CHECK. LOSSY by
-- necessity: `women` maps back to `ladies`; `girls`/`boys` have no
-- three-value equivalent and collapse to `mixed` — acceptable only because
-- down migrations never run in production and dev/test data is disposable.

ALTER TABLE program DROP CONSTRAINT ck_program_gender;
ALTER TABLE program_revision DROP CONSTRAINT ck_program_revision_gender;
ALTER TABLE program DISABLE TRIGGER USER;
ALTER TABLE program_revision DISABLE TRIGGER USER;
UPDATE program SET gender_eligibility = 'ladies' WHERE gender_eligibility = 'women';
UPDATE program SET gender_eligibility = 'mixed' WHERE gender_eligibility IN ('girls', 'boys');
UPDATE program_revision SET gender_eligibility = 'ladies' WHERE gender_eligibility = 'women';
UPDATE program_revision SET gender_eligibility = 'mixed' WHERE gender_eligibility IN ('girls', 'boys');
ALTER TABLE program ENABLE TRIGGER USER;
ALTER TABLE program_revision ENABLE TRIGGER USER;
ALTER TABLE program ADD CONSTRAINT ck_program_gender
  CHECK (gender_eligibility IN ('men', 'ladies', 'mixed'));
ALTER TABLE program_revision ADD CONSTRAINT ck_program_revision_gender
  CHECK (gender_eligibility IS NULL OR gender_eligibility IN ('men', 'ladies', 'mixed'));
COMMENT ON COLUMN program.gender_eligibility IS NULL;
