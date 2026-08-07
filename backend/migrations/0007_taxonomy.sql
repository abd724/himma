-- 0007_taxonomy — S4-1 (docs/28 §9 "0007", D-S4-3; docs/24 §2.1; docs/15 §3).
-- Taxonomy and reference schema ONLY: area, category, activity_type,
-- collection, the deterministic docs/15 §3 twelve-entry launch seed, and the
-- ADDITIVE branch.area_id FK that S3-1 left pending (docs/27 §17). No
-- catalogue/listing tables (0008), no taxonomy services or routes, no search
-- objects.
--
-- D-S4-3 (binding): the taxonomy is database-managed DATA with stable ids
-- and slugs, deterministic ordering, active/inactive state, English launch
-- content, and localization-ready nullable _ar columns. Taxonomy changes are
-- migration/admin-data changes, never frontend constants, and no commercial
-- behavior derives from taxonomy names.
--
-- Seed determinism: ids are fixed literals so migrate-from-zero always
-- produces the identical canonical taxonomy. docs/15 §3 entries 1–11 are
-- categories; entry 12 ("Kids & Teens", "Camps & seasonal") is explicitly a
-- collection lens and a format lens over the shared catalogue (docs/15 §2)
-- and is seeded into `collection`, never as categories.
--
-- branch.area_id backfill note: existing branches keep `area_label` as the
-- denormalized display value; area rows are admin-created data and the
-- label→area reconciliation completes with the taxonomy admin tooling
-- (docs/28 §22 "facilities/area reconciliation timing"). area_id stays
-- nullable until then; no backfill is attempted here because no approved
-- area seed content exists.
--
-- Audit/outbox: NO new event tables — the Slice-1 audit/outbox carry the
-- future taxonomy.* vocabulary (taxonomy.category_changed /
-- taxonomy.activity_type_changed / taxonomy.collection_changed /
-- taxonomy.area_changed, docs/28 §15) when the admin services land.
--
-- Runs in one transaction. No PostgreSQL-18-only features.

-- Up Migration

------------------------------------------------------------------------------
-- 1. Shared taxonomy row rules — id, slug, and creation time are immutable
-- after insert (docs/28 §9.5); labels/synonyms/active remain admin-editable
-- data under the standard updated_at/version conventions.
------------------------------------------------------------------------------

CREATE FUNCTION enforce_taxonomy_row_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.slug <> OLD.slug OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'taxonomy identity columns (id, slug, created_at) are immutable (% %)',
      TG_TABLE_NAME, OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_taxonomy_row_rules() IS
  'S4-1 (D-S4-3): taxonomy slugs are stable public identifiers — immutable after insert; retirement is active=false, never deletion or slug reuse.';

------------------------------------------------------------------------------
-- 2. area — canonical location reference (docs/28 §9 "0007.1"; docs/24
-- §12.1: the mock AreaId enum opens up into admin-owned data). Geo detail
-- beyond city naming is later work; branches keep their own geo_point.
------------------------------------------------------------------------------

CREATE TABLE area (
  id         uuid        NOT NULL,
  slug       text        NOT NULL,
  label_en   text        NOT NULL,
  label_ar   text,
  city       text,
  sort_hint  integer     NOT NULL DEFAULT 0,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_area PRIMARY KEY (id),
  CONSTRAINT uq_area_slug UNIQUE (slug),
  CONSTRAINT ck_area_version CHECK (version >= 1)
);
COMMENT ON TABLE area IS
  'Admin-owned area reference data (docs/24 §12.1) — the table S3-1''s branch.area_id has been waiting for. English-only content is sufficient; label_ar is the W7 localization seam. Not seeded: no owner-approved launch area list exists; areas arrive as admin data.';

CREATE TRIGGER trg_area_updated_at
  BEFORE UPDATE ON area FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_area_version
  BEFORE UPDATE ON area FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_area_rules
  BEFORE UPDATE ON area FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_row_rules();

-- The additive FK completion promised by S3-1 (docs/27 §17): branch.area_id
-- now references canonical areas; Branch itself is NOT redesigned and
-- area_label remains as denormalized display until reconciliation.
ALTER TABLE branch
  ADD CONSTRAINT fk_branch_area FOREIGN KEY (area_id) REFERENCES area (id);

------------------------------------------------------------------------------
-- 3. category — top-level browse group (docs/24 §2.1; docs/15 §3).
------------------------------------------------------------------------------

CREATE TABLE category (
  id         uuid        NOT NULL,
  slug       text        NOT NULL,
  label_en   text        NOT NULL,
  label_ar   text,
  image_ref  uuid,
  sort_hint  integer     NOT NULL DEFAULT 0,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_category PRIMARY KEY (id),
  CONSTRAINT uq_category_slug UNIQUE (slug),
  CONSTRAINT ck_category_version CHECK (version >= 1)
);
COMMENT ON TABLE category IS
  'Top-level customer browse group (docs/24 §2.1). Exactly two visible taxonomy levels exist (Category → ActivityType, docs/28 §9.5) — no parent/hierarchy column may ever be added without a new owner decision. Deactivation, never deletion. No logic branches on names (D-S4-3).';

CREATE TRIGGER trg_category_updated_at
  BEFORE UPDATE ON category FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_category_version
  BEFORE UPDATE ON category FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_category_rules
  BEFORE UPDATE ON category FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_row_rules();

------------------------------------------------------------------------------
-- 4. activity_type — one canonical activity inside a category (docs/24
-- §2.1). Adult/junior variants are different PROGRAMS, never duplicated
-- types (docs/15 §2). Synonym arrays are the future search expansion input
-- (docs/14 §3.4) — data only; no search object exists in S4-1.
------------------------------------------------------------------------------

CREATE TABLE activity_type (
  id          uuid        NOT NULL,
  category_id uuid        NOT NULL,
  slug        text        NOT NULL,
  label_en    text        NOT NULL,
  label_ar    text,
  synonyms_en text[]      NOT NULL DEFAULT '{}',
  synonyms_ar text[]      NOT NULL DEFAULT '{}',
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_activity_type PRIMARY KEY (id),
  CONSTRAINT uq_activity_type_slug UNIQUE (slug),
  CONSTRAINT fk_activity_type_category FOREIGN KEY (category_id) REFERENCES category (id),
  CONSTRAINT ck_activity_type_version CHECK (version >= 1)
);
COMMENT ON TABLE activity_type IS
  'Second (and last) taxonomy level (docs/24 §2.1). Deactivating a type never breaks existing program references — publication-time "active taxonomy" completeness is service-enforced (docs/28 §9.6b), history is preserved.';

CREATE INDEX ix_activity_type_category ON activity_type (category_id, active);

CREATE TRIGGER trg_activity_type_updated_at
  BEFORE UPDATE ON activity_type FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_activity_type_version
  BEFORE UPDATE ON activity_type FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_activity_type_rules
  BEFORE UPDATE ON activity_type FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_row_rules();

------------------------------------------------------------------------------
-- 5. collection — admin-curated editorial grouping resolving to filtered
-- results (docs/24 §2.1; docs/28 §9 "0007.4"). The filter preset is TYPED
-- columns mirroring the approved mock preset booleans — never an opaque
-- jsonb that could smuggle untyped behavior. child_focused drives the
-- docs/18 §6 visibility gate; no logic ever branches on titles.
------------------------------------------------------------------------------

CREATE TABLE collection (
  id                     uuid        NOT NULL,
  title_en               text        NOT NULL,
  title_ar               text,
  subtitle_en            text,
  subtitle_ar            text,
  image_ref              uuid,
  preset_ladies_only     boolean     NOT NULL DEFAULT false,
  preset_child_relevant  boolean     NOT NULL DEFAULT false,
  preset_camps           boolean     NOT NULL DEFAULT false,
  preset_offers          boolean     NOT NULL DEFAULT false,
  preset_available_today boolean     NOT NULL DEFAULT false,
  preset_after_school    boolean     NOT NULL DEFAULT false,
  preset_indoor          boolean     NOT NULL DEFAULT false,
  audience               text        NOT NULL DEFAULT 'all',
  child_focused          boolean     NOT NULL DEFAULT false,
  featured               boolean     NOT NULL DEFAULT false,
  seasonal_label         text,
  state                  text        NOT NULL DEFAULT 'draft',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_collection PRIMARY KEY (id),
  CONSTRAINT ck_collection_audience CHECK (audience IN ('all', 'adults', 'children')),
  CONSTRAINT ck_collection_state CHECK (state IN ('draft', 'published', 'archived')),
  CONSTRAINT ck_collection_version CHECK (version >= 1)
);
COMMENT ON TABLE collection IS
  'Admin-curated browse lens over the shared catalogue (docs/15 §2) — deletable-as-data via state, never a parallel taxonomy. preset_available_today resolves against Slice-6 session data when it exists; until then the preset column is inert data, never a fake availability source.';

CREATE FUNCTION enforce_collection_row_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'collection identity columns are immutable (collection %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_collection_row_rules() IS
  'S4-1: collection identity is stable; editorial content and state remain admin-editable.';

CREATE TRIGGER trg_collection_updated_at
  BEFORE UPDATE ON collection FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_collection_version
  BEFORE UPDATE ON collection FOR EACH ROW EXECUTE FUNCTION bump_row_version();
CREATE TRIGGER trg_collection_rules
  BEFORE UPDATE ON collection FOR EACH ROW EXECUTE FUNCTION enforce_collection_row_rules();

------------------------------------------------------------------------------
-- 6. Deterministic launch seed — docs/15 §3 (D-S4-3), fixed ids so every
-- migrate-from-zero yields the identical canonical taxonomy. Entries 1–11
-- are categories (order = docs/15 §3 order via sort_hint); entry 12 is the
-- two collection/format lenses. English-only content; Arabic stays NULL
-- until the W7 workflow (docs/24 §14.B12). No activity types are seeded:
-- docs/15 §3 lists only representative examples, and D-S4-3 scopes the
-- approved seed to the twelve entries.
------------------------------------------------------------------------------

INSERT INTO category (id, slug, label_en, sort_hint) VALUES
  ('01986aa0-0000-7000-8000-000000000101', 'fitness',         'Fitness & gyms',            10),
  ('01986aa0-0000-7000-8000-000000000102', 'martial-arts',    'Martial arts & combat',     20),
  ('01986aa0-0000-7000-8000-000000000103', 'swimming',        'Swimming & water',          30),
  ('01986aa0-0000-7000-8000-000000000104', 'padel-racquet',   'Padel & racquet',           40),
  ('01986aa0-0000-7000-8000-000000000105', 'pilates-yoga',    'Pilates, yoga & movement',  50),
  ('01986aa0-0000-7000-8000-000000000106', 'team-outdoor',    'Team & outdoor sports',     60),
  ('01986aa0-0000-7000-8000-000000000107', 'wellness',        'Wellness & recovery',       70),
  ('01986aa0-0000-7000-8000-000000000108', 'learning',        'Learning & languages',      80),
  ('01986aa0-0000-7000-8000-000000000109', 'quran',           'Quran & Islamic learning',  90),
  ('01986aa0-0000-7000-8000-00000000010a', 'tech-stem',       'Technology & STEM',        100),
  ('01986aa0-0000-7000-8000-00000000010b', 'arts-creativity', 'Arts, music & creativity', 110);

INSERT INTO collection
  (id, title_en, preset_child_relevant, preset_camps, audience, child_focused, featured, state)
VALUES
  -- docs/15 §3 entry 12a — collection lens; grid-only (not the Discover
  -- editorial rail), promoted per the docs/18 §6 child gate.
  ('01986aa0-0000-7000-8000-000000000201', 'Kids & Teens',    true,  false, 'all', true, false, 'published'),
  -- docs/15 §3 entry 12b — format lens over camp-kind supply.
  ('01986aa0-0000-7000-8000-000000000202', 'Camps & seasonal', false, true,  'all', true, false, 'published');

------------------------------------------------------------------------------
-- 7. Application-role grants — read/insert/update only; deactivation and
-- state changes are UPDATEs; no DELETE anywhere (D-S4-3: deactivation,
-- never deletion; retention actions run under the elevated role).
------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON area TO himma_app;
GRANT SELECT, INSERT, UPDATE ON category TO himma_app;
GRANT SELECT, INSERT, UPDATE ON activity_type TO himma_app;
GRANT SELECT, INSERT, UPDATE ON collection TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops every 0007 object; branch.area_id COLUMN belongs
-- to 0005 and only the FK added here is removed.

ALTER TABLE branch DROP CONSTRAINT fk_branch_area;
DROP TABLE collection;
DROP TABLE activity_type;
DROP TABLE category;
DROP TABLE area;
DROP FUNCTION enforce_collection_row_rules();
DROP FUNCTION enforce_taxonomy_row_rules();
