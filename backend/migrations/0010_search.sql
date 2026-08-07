-- 0010_search — Slice-4 search foundation (docs/28 §9.11–12, §11–§13).
-- The derived, rebuildable `program_search_document` projection plus the
-- pg_trgm extension and the canonical FTS/trigram indexes. PostgreSQL is the
-- launch search engine (docs/23 §10.5 Tier 1; docs/28 §12) behind the
-- application-layer SearchReadPort — no external engine, no second store.
--
-- Projection semantics (binding, docs/28 §13):
--  * EXACTLY ONE document per searchable Program (D-S4-1: options never
--    become documents/results of their own);
--  * derived state only — rebuilt from the authoritative catalogue tables at
--    any time; NEVER consulted for authorization or visibility: every
--    customer query re-joins the live docs/28 §6 predicate, so a stale or
--    poisoned document cannot expose a suspended provider or unpublished
--    listing even for one request;
--  * maintenance is same-transaction for catalogue changes and event-driven
--    (outbox → 'search-projection' inbox consumer) for organization-side
--    changes, with the query-time predicate covering the window;
--  * ineligible listings are DEACTIVATED (active = false), never deleted —
--    the platform's no-DELETE grant posture applies here too; a projection
--    row carries no history value but deletion rights stay unexpanded.
--
-- search_vector composition (English launch, docs/28 §11–§12): weighted
-- English tsvector over title (A), activity-type label + synonyms_en (B),
-- category label (C), and provider storefront display name (D). Arabic is a
-- later additive configuration (docs/24 §14.B12) — nothing here requires it.
--
-- No booking/session/capacity/payment/rating column exists or may be added.
--
-- Runs in one transaction. No PostgreSQL-18-only features.

-- Up Migration

-- pg_trgm: trusted core extension (same pattern as 0003's btree_gist) —
-- typo tolerance for title/display-name per docs/28 §12.
CREATE EXTENSION pg_trgm;

CREATE TABLE program_search_document (
  program_id         uuid        NOT NULL,
  organization_id    uuid        NOT NULL,
  -- Mirror of the §6 eligibility at last refresh. Filter input only; the
  -- live predicate stays authoritative at query time.
  active             boolean     NOT NULL DEFAULT true,
  title_en           text        NOT NULL,
  display_name       text        NOT NULL,
  search_vector      tsvector    NOT NULL,
  category_id        uuid        NOT NULL,
  activity_type_id   uuid        NOT NULL,
  area_ids           uuid[]      NOT NULL DEFAULT '{}',
  branch_ids         uuid[]      NOT NULL DEFAULT '{}',
  min_age            integer,
  max_age            integer,
  all_ages           boolean     NOT NULL DEFAULT false,
  gender_eligibility text        NOT NULL,
  skill_level        text,
  setting            text        NOT NULL,
  -- Derived pricing metadata over ACTIVE options (docs/28 §14): the kinds
  -- array and the minimum paid amount. Never an authoritative price.
  price_kinds        text[]      NOT NULL DEFAULT '{}',
  min_price_fils     money_fils,
  has_trial          boolean     NOT NULL DEFAULT false,
  published_at       timestamptz NOT NULL,
  rebuilt_at         timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_program_search_document PRIMARY KEY (program_id),
  CONSTRAINT fk_program_search_document_program
    FOREIGN KEY (program_id, organization_id) REFERENCES program (id, organization_id),
  CONSTRAINT ck_program_search_document_version CHECK (version >= 1)
);
COMMENT ON TABLE program_search_document IS
  'Derived, fully-rebuildable search projection (docs/28 §9.11/§13) — one document per LISTING (D-S4-1). Never authoritative: customer search queries always re-join the live §6 visibility predicate, so this table can never expose an ineligible listing. Ineligibility deactivates (active=false); rows are never deleted. No booking/session/capacity/payment/rating data may ever be added.';
COMMENT ON COLUMN program_search_document.search_vector IS
  'English launch configuration (docs/28 §12): setweight A=title_en, B=activity-type label+synonyms_en, C=category label, D=storefront display name. Arabic arrives as an additive configuration (docs/24 §14.B12).';
COMMENT ON COLUMN program_search_document.min_price_fils IS
  'MIN(amount_fils) over the listing''s ACTIVE paid options — filter/sort metadata derived per docs/28 §14, never an authoritative Program price (none exists; PriceQuote remains booking-time truth).';

CREATE INDEX ix_program_search_document_vector
  ON program_search_document USING gin (search_vector);
CREATE INDEX ix_program_search_document_title_trgm
  ON program_search_document USING gin (title_en gin_trgm_ops);
CREATE INDEX ix_program_search_document_display_trgm
  ON program_search_document USING gin (display_name gin_trgm_ops);
-- Organization-scoped refresh path (event consumer, suspension projection).
CREATE INDEX ix_program_search_document_org
  ON program_search_document (organization_id);

CREATE TRIGGER trg_program_search_document_updated_at
  BEFORE UPDATE ON program_search_document FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_program_search_document_version
  BEFORE UPDATE ON program_search_document FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_search_document_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.program_id <> OLD.program_id OR NEW.organization_id <> OLD.organization_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'search document identity/ownership columns are immutable (document %)',
      OLD.program_id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_search_document_rules() IS
  'S4 search: a projection row belongs to its program and organization forever — content is freely rebuilt, identity is not.';

CREATE TRIGGER trg_program_search_document_rules
  BEFORE UPDATE ON program_search_document FOR EACH ROW
  EXECUTE FUNCTION enforce_search_document_rules();

-- Application-role grants: read + upsert + deactivate; NO DELETE (platform
-- posture — removal is active=false).
GRANT SELECT, INSERT, UPDATE ON program_search_document TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops every 0010 object; pg_trgm is dropped because no
-- other object uses it (same pattern as 0003's btree_gist).

DROP TABLE program_search_document;
DROP FUNCTION enforce_search_document_rules();
DROP EXTENSION pg_trgm;
