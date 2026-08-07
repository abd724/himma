-- 0008_catalogue — S4-1 (docs/28 §3–§10, §9 "0008", D-S4-1/D-S4-2; docs/24
-- §2.2/§2.5/§2.6/§5.3 as amended by A2). Program (Listing) catalogue schema
-- foundation ONLY: program, program_price_option, program_branch,
-- program_media, offer, program_revision — with the §5.3 lifecycle machine,
-- immutable ownership, eligibility CHECKs, and himma_app grants.
--
-- Deliberately ABSENT here (docs/28 §1 exclusions; task boundary):
-- program_search_document and every search index/object (the docs/28 §17
-- S4-1 row does not assign them; they arrive with the search commit),
-- sessions/schedules/camp weeks/cohorts, capacity or counts of any kind,
-- holds, bookings, quotes, payments, entitlements, redemption, attendance,
-- ratings/reviews, popularity, Instructor, and all services/routes.
--
-- The canonical hierarchy this schema fixes (D-S4-1, binding):
--   Program (listing, discovered)
--     → ProgramPriceOption (commercial purchase shape — catalogue metadata ONLY)
--     → [later slices] bookable options → capacity unit → hold/booking
-- No authoritative single Program.price exists anywhere; public From-prices
-- are derived at read time from ACTIVE options (docs/28 §14) and PriceQuote
-- remains the only booking-time money truth (docs/24 §3.2/§4.2).
--
-- Audit/outbox: NO new event tables — the Slice-1 audit/outbox carry the
-- docs/28 §15 listing.*/offer.* vocabulary (listing.created/updated/
-- submitted/review_started/approved/changes_requested/published/paused/
-- archived/revision_*/branch_association_changed/media_changed,
-- offer.created/updated/ended) when the catalogue services land.
--
-- Runs in one transaction. No PostgreSQL-18-only features.

-- Up Migration

------------------------------------------------------------------------------
-- 1. program — the canonical Listing (docs/24 §2.2): the ONE discoverable
-- search/discovery unit, owned by exactly one organization forever.
-- Eligibility is embedded per §2.5 (catalogue/discovery metadata — booking
-- eligibility stays server-validated in later slices; session-level
-- overrides arrive with Slice 6). Bilingual columns nullable per W7.
------------------------------------------------------------------------------

CREATE TABLE program (
  id                       uuid        NOT NULL,
  organization_id          uuid        NOT NULL,
  activity_type_id         uuid        NOT NULL,
  title_en                 text        NOT NULL,
  title_ar                 text,
  description_en           text,
  description_ar           text,
  setting                  text        NOT NULL,
  min_age                  integer,
  max_age                  integer,
  all_ages                 boolean     NOT NULL DEFAULT false,
  gender_eligibility       text        NOT NULL,
  skill_level              text,
  eligibility_notes        text,
  policy_ref               uuid,
  listing_state            text        NOT NULL DEFAULT 'draft',
  published_at             timestamptz,
  archived_at              timestamptz,
  sensitive_fields_version integer     NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_program PRIMARY KEY (id),
  -- The composite ownership target every organization-owned child references
  -- (options, branches, media, offers, revisions, and the Slice-6 units).
  CONSTRAINT uq_program_id_organization UNIQUE (id, organization_id),
  CONSTRAINT fk_program_organization FOREIGN KEY (organization_id) REFERENCES organization (id),
  -- Category is derived by join through the type — never stored twice.
  CONSTRAINT fk_program_activity_type FOREIGN KEY (activity_type_id) REFERENCES activity_type (id),
  CONSTRAINT ck_program_setting CHECK (setting IN ('indoor', 'outdoor')),
  CONSTRAINT ck_program_gender CHECK (gender_eligibility IN ('men', 'ladies', 'mixed')),
  CONSTRAINT ck_program_skill CHECK (skill_level IS NULL
    OR skill_level IN ('beginner', 'intermediate', 'advanced', 'all-levels')),
  CONSTRAINT ck_program_min_age CHECK (min_age IS NULL OR min_age >= 0),
  CONSTRAINT ck_program_max_age CHECK (max_age IS NULL OR max_age >= 0),
  CONSTRAINT ck_program_age_range CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
  CONSTRAINT ck_program_all_ages CHECK (NOT all_ages OR (min_age IS NULL AND max_age IS NULL)),
  CONSTRAINT ck_program_listing_state CHECK (listing_state IN
    ('draft', 'submitted', 'in_review', 'approved', 'changes_requested',
     'published', 'paused', 'archived')),
  -- Timestamp-state ties: a listing publicly on (or paused from) the market
  -- always carries its publication time (search recency input); archival
  -- time exists exactly in the terminal state and survives with history.
  CONSTRAINT ck_program_published_at
    CHECK (listing_state NOT IN ('published', 'paused') OR published_at IS NOT NULL),
  CONSTRAINT ck_program_archived_at
    CHECK ((listing_state = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT ck_program_sensitive_fields_version CHECK (sensitive_fields_version >= 1),
  CONSTRAINT ck_program_version CHECK (version >= 1)
);
COMMENT ON TABLE program IS
  'Canonical Listing (docs/24 §2.2, Amendment A2). NO price column exists by design (D-S4-1): pricing lives on program_price_option; From-price displays are derived at read time, never stored. NO schedule/availability/capacity/rating column exists: those are later-slice server-computed projections, never faked. Customer visibility is the docs/28 §6 compound predicate (published + org live/published + ≥1 active branch), applied by future read models. Draft listings may exist incomplete; submission/publication completeness (≥1 branch, ≥1 active option, active taxonomy) is service-enforced per docs/28 §4/§9.6b.';
COMMENT ON COLUMN program.listing_state IS
  'docs/24 §5.3 machine, DB-trigger-enforced. D-S4-2: approval and publication are DISTINCT — approved never auto-advances; publish/unpublish authority (Owner + Organization Manager only) is service-layer, arriving with the catalogue-management commit.';
COMMENT ON COLUMN program.sensitive_fields_version IS
  'Bumped when an approved sensitive-field revision (docs/28 §7) is applied; monotonic, trigger-enforced.';

CREATE INDEX ix_program_org_state ON program (organization_id, listing_state);
CREATE INDEX ix_program_activity_type ON program (activity_type_id);
CREATE INDEX ix_program_published ON program (id) WHERE listing_state = 'published';

CREATE TRIGGER trg_program_updated_at
  BEFORE UPDATE ON program FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_program_version
  BEFORE UPDATE ON program FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_program_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'program identity/ownership columns are immutable (program %)', OLD.id;
  END IF;
  IF OLD.listing_state = 'archived' THEN
    RAISE EXCEPTION 'program % is archived and permanently immutable', OLD.id;
  END IF;
  IF NEW.sensitive_fields_version < OLD.sensitive_fields_version THEN
    RAISE EXCEPTION 'program sensitive_fields_version can only move forward (program %)', OLD.id;
  END IF;
  IF NEW.listing_state <> OLD.listing_state
     AND NOT ((OLD.listing_state = 'draft'             AND NEW.listing_state = 'submitted')
           OR (OLD.listing_state = 'submitted'         AND NEW.listing_state = 'in_review')
           OR (OLD.listing_state = 'in_review'         AND NEW.listing_state IN ('approved', 'changes_requested'))
           OR (OLD.listing_state = 'changes_requested' AND NEW.listing_state = 'submitted')
           OR (OLD.listing_state = 'approved'          AND NEW.listing_state = 'published')
           OR (OLD.listing_state = 'published'         AND NEW.listing_state IN ('paused', 'archived'))
           OR (OLD.listing_state = 'paused'            AND NEW.listing_state IN ('published', 'archived'))) THEN
    RAISE EXCEPTION 'invalid program transition % -> % (program %)',
      OLD.listing_state, NEW.listing_state, OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_program_transition() IS
  'S4-1: the docs/24 §5.3 machine verbatim — draft→submitted→in_review→approved|changes_requested (→submitted on resubmit), approved→published (a SEPARATE action — D-S4-2: approval never auto-publishes and no draft→published edge exists at any layer), published⇄paused, published|paused→archived (terminal, row frozen). Actor legality (provider vs admin edges, publisher roles) is service-enforced; the database refuses every structurally invalid edge even if a future service forgets.';

CREATE TRIGGER trg_program_transition
  BEFORE UPDATE ON program FOR EACH ROW EXECUTE FUNCTION enforce_program_transition();

------------------------------------------------------------------------------
-- 2. program_price_option — the D-S4-1 child (Amendment A1). A commercial
-- way to purchase/access the SAME listed concept: one listing, many
-- options. Catalogue/commercial metadata ONLY — never capacity, booking,
-- entitlement, payment, attendance, or redemption records; a `package`
-- option DESCRIBES the commercial choice, the five-use entitlement ledger
-- is a later slice (docs/24 §3.4). Options must never collapse materially
-- different experiences into one listing (the §3 modelling rule — service/
-- moderation-enforced; the schema deliberately does not force separate
-- Programs merely because several commercial options exist).
------------------------------------------------------------------------------

CREATE TABLE program_price_option (
  id              uuid          NOT NULL,
  program_id      uuid          NOT NULL,
  organization_id uuid          NOT NULL,
  kind            text          NOT NULL,
  amount_fils     money_fils,
  currency        currency_code NOT NULL DEFAULT 'AED',
  sessions_count  integer,
  label_en        text,
  label_ar        text,
  sort_hint       integer       NOT NULL DEFAULT 0,
  state           text          NOT NULL DEFAULT 'active',
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  version         integer       NOT NULL DEFAULT 1,
  CONSTRAINT pk_program_price_option PRIMARY KEY (id),
  -- Composite target for same-program references (program_revision option
  -- change sets, future booking-draft validation).
  CONSTRAINT uq_program_price_option_id_program UNIQUE (id, program_id),
  -- The ownership spine: an option can never attach to another
  -- organization's listing, even under direct SQL.
  CONSTRAINT fk_program_price_option_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  -- Launch kind subset (docs/24 §2.6 as amended): mock freeTrial is dropped
  -- (trials are Offers); membership|weekly arrive as ADDITIVE CHECK
  -- widenings when docs/24 §14.B7 decides.
  CONSTRAINT ck_program_price_option_kind CHECK (kind IN
    ('dropIn', 'monthly', 'term', 'camp', 'package', 'free')),
  CONSTRAINT ck_program_price_option_state CHECK (state IN ('active', 'archived')),
  -- Money ties: free means NULL amount; every paid kind carries positive
  -- integer fils (0 would be an ambiguous fake-free price).
  CONSTRAINT ck_program_price_option_amount_free CHECK ((kind = 'free') = (amount_fils IS NULL)),
  CONSTRAINT ck_program_price_option_amount_positive
    CHECK (amount_fils IS NULL OR amount_fils > 0),
  -- Package metadata tie: sessions_count exists exactly for package options.
  CONSTRAINT ck_program_price_option_sessions CHECK ((kind = 'package') = (sessions_count IS NOT NULL)),
  CONSTRAINT ck_program_price_option_sessions_positive
    CHECK (sessions_count IS NULL OR sessions_count > 0),
  CONSTRAINT ck_program_price_option_version CHECK (version >= 1)
);
COMMENT ON TABLE program_price_option IS
  'D-S4-1 (Amendment A1): a commercial purchase shape of ONE Program. The stable opaque id is the selection handle — future booking drafts select an option BY ID, never by label, sort order, or array position. Customer ordering is deterministic: (sort_hint, id). Retirement is archive-only (frozen row, no delete, no reactivation); re-offering a retired shape is a NEW option with a NEW id. sessions_count is catalogue description only — the redemption ledger (PackageEntitlement) is a later slice. Booking-time money truth remains PriceQuote (docs/24 §3.2/§4.2).';

CREATE INDEX ix_program_price_option_program ON program_price_option (program_id, state);

CREATE TRIGGER trg_program_price_option_updated_at
  BEFORE UPDATE ON program_price_option FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_program_price_option_version
  BEFORE UPDATE ON program_price_option FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_program_price_option_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.program_id <> OLD.program_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'price option identity/ownership columns are immutable (option %)', OLD.id;
  END IF;
  IF OLD.state = 'archived' THEN
    RAISE EXCEPTION 'price option % is archived and permanently immutable', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_program_price_option_rules() IS
  'S4-1 (D-S4-1): an option belongs to its program and organization forever; archive is terminal — an archived option can never silently reactivate or be edited, so a historical option id always means what it meant.';

CREATE TRIGGER trg_program_price_option_rules
  BEFORE UPDATE ON program_price_option FOR EACH ROW
  EXECUTE FUNCTION enforce_program_price_option_rules();

------------------------------------------------------------------------------
-- 3. program_branch — the §4 many-to-many association carried on the
-- Slice-3 composite spine: BOTH sides bind organization_id, so a Program of
-- Provider A is database-incapable of associating with Provider B's branch.
-- Association changes are audited adds and active=false removals — history
-- is never deleted; branch deactivation never deletes associations.
------------------------------------------------------------------------------

CREATE TABLE program_branch (
  program_id      uuid        NOT NULL,
  branch_id       uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_program_branch PRIMARY KEY (program_id, branch_id),
  CONSTRAINT fk_program_branch_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT fk_program_branch_branch
    FOREIGN KEY (branch_id, organization_id) REFERENCES branch (id, organization_id),
  CONSTRAINT ck_program_branch_version CHECK (version >= 1)
);
COMMENT ON TABLE program_branch IS
  'docs/28 §4: a listing is offerable only at branches of its OWN organization (composite FKs both sides — the exact shape the docs/27 §12.8 probe proved). ≥1 association is a SERVICE-enforced submission-completeness rule; drafts may exist branchless. Branchless/online listings are NOT representable under approved canon (branch_ids ≥ 1) — a future owner decision, never silently added.';

CREATE INDEX ix_program_branch_branch ON program_branch (branch_id);

CREATE TRIGGER trg_program_branch_updated_at
  BEFORE UPDATE ON program_branch FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_program_branch_version
  BEFORE UPDATE ON program_branch FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_program_branch_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.program_id <> OLD.program_id OR NEW.branch_id <> OLD.branch_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'program-branch association identity is immutable (program % branch %)',
      OLD.program_id, OLD.branch_id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_program_branch_rules() IS
  'S4-1: an association row is never re-pointed; removal is active=false, keeping history.';

CREATE TRIGGER trg_program_branch_rules
  BEFORE UPDATE ON program_branch FOR EACH ROW
  EXECUTE FUNCTION enforce_program_branch_rules();

------------------------------------------------------------------------------
-- 4. program_media — listing media REFERENCES only (docs/28 §14): ordered,
-- alt-texted, organization-owned metadata. Upload pipeline, object storage,
-- and CDN are docs/23 §10.6 infrastructure owned elsewhere. Logo/cover stay
-- on the provider profile (S3-1); listing images belong to listings.
------------------------------------------------------------------------------

CREATE TABLE program_media (
  id              uuid        NOT NULL,
  program_id      uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  media_ref       uuid        NOT NULL,
  sort_hint       integer     NOT NULL DEFAULT 0,
  alt_text_en     text,
  alt_text_ar     text,
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_program_media PRIMARY KEY (id),
  CONSTRAINT fk_program_media_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT ck_program_media_version CHECK (version >= 1)
);
COMMENT ON TABLE program_media IS
  'Ordered media reference metadata (docs/28 §9.8/§14) — media_ref is an opaque object reference; no storage/upload/processing object exists in this slice. Retirement is active=false (retention), never deletion.';

CREATE INDEX ix_program_media_program ON program_media (program_id, active);

CREATE TRIGGER trg_program_media_updated_at
  BEFORE UPDATE ON program_media FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_program_media_version
  BEFORE UPDATE ON program_media FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_program_media_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.program_id <> OLD.program_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'program media identity/ownership columns are immutable (media %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_program_media_rules() IS
  'S4-1: a media reference belongs to its program and organization forever.';

CREATE TRIGGER trg_program_media_rules
  BEFORE UPDATE ON program_media FOR EACH ROW
  EXECUTE FUNCTION enforce_program_media_rules();

------------------------------------------------------------------------------
-- 5. offer — the structured docs/24 §2.2 entity. Trials are Offers, never
-- duplicate listings and never a price-option kind (Amendment A2 dropped
-- the mock freeTrial price kind). discount/promo stay INFORMATIONAL in
-- every customer surface (docs/09 §22.5): an Offer is never booking
-- inventory, a promotion engine, a coupon system, or a payment discount
-- ledger — quote-applied discounts, when decided, flow through PriceQuote
-- lines (docs/24 §4.2), never label parsing.
------------------------------------------------------------------------------

CREATE TABLE offer (
  id                uuid          NOT NULL,
  program_id        uuid          NOT NULL,
  organization_id   uuid          NOT NULL,
  kind              text          NOT NULL,
  label_en          text          NOT NULL,
  label_ar          text,
  trial_amount_fils money_fils,
  currency          currency_code NOT NULL DEFAULT 'AED',
  effective_start   timestamptz,
  effective_end     timestamptz,
  state             text          NOT NULL DEFAULT 'active',
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  version           integer       NOT NULL DEFAULT 1,
  CONSTRAINT pk_offer PRIMARY KEY (id),
  CONSTRAINT fk_offer_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT ck_offer_kind CHECK (kind IN ('freeTrial', 'paidTrial', 'discount', 'promo')),
  CONSTRAINT ck_offer_state CHECK (state IN ('active', 'ended')),
  CONSTRAINT ck_offer_trial_amount CHECK ((kind = 'paidTrial') = (trial_amount_fils IS NOT NULL)),
  CONSTRAINT ck_offer_trial_amount_positive
    CHECK (trial_amount_fils IS NULL OR trial_amount_fils > 0),
  CONSTRAINT ck_offer_effective_range
    CHECK (effective_start IS NULL OR effective_end IS NULL OR effective_end > effective_start),
  CONSTRAINT ck_offer_version CHECK (version >= 1)
);
COMMENT ON TABLE offer IS
  'Structured offer (docs/24 §2.2): typed kind + structured trial amount in fils — never free-text-parsed. Catalogue metadata only; no redemption, usage, or discount-application record exists in this slice.';

CREATE INDEX ix_offer_program ON offer (program_id, state);

CREATE TRIGGER trg_offer_updated_at
  BEFORE UPDATE ON offer FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_offer_version
  BEFORE UPDATE ON offer FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_offer_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.program_id <> OLD.program_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'offer identity/ownership columns are immutable (offer %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_offer_rules() IS
  'S4-1: an offer belongs to its program and organization forever.';

CREATE TRIGGER trg_offer_rules
  BEFORE UPDATE ON offer FOR EACH ROW EXECUTE FUNCTION enforce_offer_rules();

------------------------------------------------------------------------------
-- 6. program_revision — the docs/28 §7 sensitive-field revision foundation:
-- STRUCTURED copies of exactly the admin-designated sensitive field set (no
-- free-form payload blob) moving through their own review machine while the
-- current listing version stays live. Price options are sensitive fields
-- (D-S4-1): the option change set records the target option id (or an
-- add-intent when NULL) plus the changed fields. Approval-application (one
-- transaction: apply + state + audit + outbox + sensitive_fields_version
-- bump) is the later moderation service; only the schema exists here.
------------------------------------------------------------------------------

CREATE TABLE program_revision (
  id                    uuid          NOT NULL,
  program_id            uuid          NOT NULL,
  organization_id       uuid          NOT NULL,
  -- Price-option change set (option_id NULL = add a new option).
  option_id             uuid,
  option_kind           text,
  option_amount_fils    money_fils,
  option_sessions_count integer,
  option_label_en       text,
  option_label_ar       text,
  option_sort_hint      integer,
  option_state          text,
  currency              currency_code NOT NULL DEFAULT 'AED',
  -- Eligibility change set (docs/24 §2.5 vocabulary).
  min_age               integer,
  max_age               integer,
  all_ages              boolean,
  gender_eligibility    text,
  skill_level           text,
  eligibility_notes     text,
  -- Safety-relevant copy change set.
  description_en        text,
  description_ar        text,
  state                 text          NOT NULL DEFAULT 'submitted',
  submitted_by          uuid          NOT NULL,
  decided_by            uuid,
  decided_at            timestamptz,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  version               integer       NOT NULL DEFAULT 1,
  CONSTRAINT pk_program_revision PRIMARY KEY (id),
  CONSTRAINT fk_program_revision_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  -- An option change set may only target an option of the SAME program
  -- (MATCH SIMPLE: skipped while option_id is NULL — the add-intent).
  CONSTRAINT fk_program_revision_option
    FOREIGN KEY (option_id, program_id) REFERENCES program_price_option (id, program_id),
  CONSTRAINT ck_program_revision_state CHECK (state IN
    ('submitted', 'in_review', 'approved', 'rejected')),
  CONSTRAINT ck_program_revision_option_kind CHECK (option_kind IS NULL
    OR option_kind IN ('dropIn', 'monthly', 'term', 'camp', 'package', 'free')),
  CONSTRAINT ck_program_revision_option_state CHECK (option_state IS NULL
    OR option_state IN ('active', 'archived')),
  CONSTRAINT ck_program_revision_option_sessions_positive
    CHECK (option_sessions_count IS NULL OR option_sessions_count > 0),
  CONSTRAINT ck_program_revision_gender CHECK (gender_eligibility IS NULL
    OR gender_eligibility IN ('men', 'ladies', 'mixed')),
  CONSTRAINT ck_program_revision_skill CHECK (skill_level IS NULL
    OR skill_level IN ('beginner', 'intermediate', 'advanced', 'all-levels')),
  CONSTRAINT ck_program_revision_min_age CHECK (min_age IS NULL OR min_age >= 0),
  CONSTRAINT ck_program_revision_max_age CHECK (max_age IS NULL OR max_age >= 0),
  -- Decision metadata exists exactly in the decided states.
  CONSTRAINT ck_program_revision_decided_at
    CHECK ((state IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT ck_program_revision_decided_by
    CHECK ((state IN ('approved', 'rejected')) = (decided_by IS NOT NULL)),
  CONSTRAINT ck_program_revision_version CHECK (version >= 1)
);
COMMENT ON TABLE program_revision IS
  'docs/28 §7: pending revision of admin-designated sensitive fields (price options, eligibility, safety copy) on a published listing — review-gated so no provider can bypass moderation by editing a sensitive public field after approval. At most one OPEN revision per program (partial unique). Terminal rows are immutable history.';

CREATE UNIQUE INDEX uq_program_revision_open
  ON program_revision (program_id) WHERE state IN ('submitted', 'in_review');
CREATE INDEX ix_program_revision_program ON program_revision (program_id);

CREATE TRIGGER trg_program_revision_updated_at
  BEFORE UPDATE ON program_revision FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_program_revision_version
  BEFORE UPDATE ON program_revision FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_program_revision_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.program_id <> OLD.program_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.submitted_by <> OLD.submitted_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'revision identity/provenance columns are immutable (revision %)', OLD.id;
  END IF;
  IF OLD.state IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'revision % is decided and permanently immutable', OLD.id;
  END IF;
  IF NEW.state <> OLD.state
     AND NOT ((OLD.state = 'submitted' AND NEW.state = 'in_review')
           OR (OLD.state = 'in_review' AND NEW.state IN ('approved', 'rejected'))) THEN
    RAISE EXCEPTION 'invalid revision transition % -> % (revision %)',
      OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_program_revision_transition() IS
  'S4-1: submitted→in_review→approved|rejected, decided rows frozen — the docs/28 §7 machine; resubmission after rejection is a NEW revision row (append-only history).';

CREATE TRIGGER trg_program_revision_transition
  BEFORE UPDATE ON program_revision FOR EACH ROW
  EXECUTE FUNCTION enforce_program_revision_transition();

------------------------------------------------------------------------------
-- 7. Application-role grants — read/insert/update only; archive/pause/
-- deactivation are UPDATEs guarded by the triggers above; no DELETE
-- anywhere (retention; historical catalogue identity may later appear in
-- Booking, PriceQuote, analytics, audit, and provider reports).
------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON program TO himma_app;
GRANT SELECT, INSERT, UPDATE ON program_price_option TO himma_app;
GRANT SELECT, INSERT, UPDATE ON program_branch TO himma_app;
GRANT SELECT, INSERT, UPDATE ON program_media TO himma_app;
GRANT SELECT, INSERT, UPDATE ON offer TO himma_app;
GRANT SELECT, INSERT, UPDATE ON program_revision TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops every 0008 object in dependency order.

DROP TABLE program_revision;
DROP TABLE offer;
DROP TABLE program_media;
DROP TABLE program_branch;
DROP TABLE program_price_option;
DROP TABLE program;
DROP FUNCTION enforce_program_revision_transition();
DROP FUNCTION enforce_offer_rules();
DROP FUNCTION enforce_program_media_rules();
DROP FUNCTION enforce_program_branch_rules();
DROP FUNCTION enforce_program_price_option_rules();
DROP FUNCTION enforce_program_transition();
