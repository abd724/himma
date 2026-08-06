-- 0005_provider_organizations — S3-1 (docs/27 §2–§4, §12, Amendment A1;
-- docs/24 §1.3, §5.1). Organization + OrganizationPublicProfile + Branch
-- schema foundation ONLY: no staff, invitations, provider routes, listings,
-- or catalogue objects. The canonical ownership spine this migration fixes:
--   Organization → OrganizationPublicProfile → Branch → future Listings
-- Future listings attach via organization.id and the composite
-- branch (id, organization_id) key — proven by a structural test, built by
-- Slice 4, never requiring redesign of these three tables.
--
-- Audit/outbox: NO new event tables — the Slice-1 append-only audit_event
-- and transactional outbox carry the S3 vocabulary when the services land
-- (organization.created / organization.state_changed /
-- organization.profile_published / organization.profile_unpublished /
-- organization.branch_created / organization.branch_deactivated; audit
-- actions in the org.* namespace per docs/27 §12.7).
--
-- Runs in one transaction. No PostgreSQL-18-only features.

-- Up Migration

------------------------------------------------------------------------------
-- 1. organization — the canonical commercial counterparty (docs/24 §1.3).
-- The legal/business entity: never a branch, never a listing; a multi-branch
-- provider is ONE organization. PRIVATE management record — customer reads
-- come only from organization_public_profile (+ public branch columns).
-- Deliberately ABSENT here and everywhere in S3-1: bank/payout details,
-- licence-document contents, verification notes, commission/cadence,
-- listing/catalogue fields (docs/27 §2).
------------------------------------------------------------------------------

CREATE TABLE organization (
  id                   uuid        NOT NULL,
  legal_name           text        NOT NULL,
  trade_name           text        NOT NULL,
  org_kind             text        NOT NULL DEFAULT 'provider',
  origin               text        NOT NULL DEFAULT 'admin_created',
  verification_state   text        NOT NULL DEFAULT 'draft',
  commercial_terms_ref uuid,
  suspended_at         timestamptz,
  offboarded_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_organization PRIMARY KEY (id),
  -- D-S3-4: Organization is the ONE canonical entity; 'provider' is the only
  -- launch value. Later classifications (e.g. 'partner') arrive as ADDITIVE
  -- CHECK widenings with no authorization difference until owner-approved.
  CONSTRAINT ck_organization_kind CHECK (org_kind IN ('provider')),
  -- D-S3-2: admin-initiated today; future self-registration widens this
  -- CHECK additively (e.g. 'self_signup') — the schema never hard-codes
  -- admin-only as the sole possible creation path.
  CONSTRAINT ck_organization_origin CHECK (origin IN ('admin_created')),
  CONSTRAINT ck_organization_state CHECK (verification_state IN
    ('draft', 'submitted', 'in_review', 'verified', 'rejected',
     'live', 'suspended', 'offboarded')),
  CONSTRAINT ck_organization_suspended
    CHECK ((verification_state = 'suspended') = (suspended_at IS NOT NULL)),
  CONSTRAINT ck_organization_offboarded
    CHECK ((verification_state = 'offboarded') = (offboarded_at IS NOT NULL)),
  CONSTRAINT ck_organization_version CHECK (version >= 1)
);
COMMENT ON TABLE organization IS
  'Canonical provider organization (docs/24 §1.3; docs/27 §2) — the PRIVATE legal/management record. legal_name never appears in any public read model; customers see organization_public_profile only. Actor metadata lives in audit_event, not columns. Never hard-deleted: offboarded is the terminal state; retention/pseudonymization per docs/24 §4.14 touches people (later staff/invitation rows), not this commercial record.';
COMMENT ON COLUMN organization.verification_state IS
  'docs/24 §5.1 lifecycle. Only ''live'' organizations can be publicly served, and only together with organization_public_profile.published (docs/27 §3, Amendment A1). Production transitions to verified/live are additionally fail-closed behind the D-S3-3 verificationEvidenceCapabilityReady gate — a SERVICE/API-layer capability arriving with its owning later commit, deliberately not modeled in this schema.';

-- Public catalogue lookups only ever want live organizations.
CREATE INDEX ix_organization_live ON organization (id) WHERE verification_state = 'live';

CREATE TRIGGER trg_organization_updated_at
  BEFORE UPDATE ON organization FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_organization_version
  BEFORE UPDATE ON organization FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_organization_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_kind <> OLD.org_kind
     OR NEW.origin <> OLD.origin OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'organization identity/provenance columns are immutable (organization %)', OLD.id;
  END IF;
  IF OLD.verification_state = 'offboarded' THEN
    RAISE EXCEPTION 'organization % is offboarded and permanently immutable', OLD.id;
  END IF;
  IF NEW.verification_state <> OLD.verification_state
     AND NOT ((OLD.verification_state = 'draft'      AND NEW.verification_state = 'submitted')
           OR (OLD.verification_state = 'submitted'  AND NEW.verification_state = 'in_review')
           OR (OLD.verification_state = 'in_review'  AND NEW.verification_state IN ('verified', 'rejected'))
           OR (OLD.verification_state = 'rejected'   AND NEW.verification_state = 'submitted')
           OR (OLD.verification_state = 'verified'   AND NEW.verification_state = 'live')
           OR (OLD.verification_state = 'live'       AND NEW.verification_state IN ('suspended', 'offboarded'))
           OR (OLD.verification_state = 'suspended'  AND NEW.verification_state IN ('live', 'offboarded'))) THEN
    RAISE EXCEPTION 'invalid organization transition % -> % (organization %)',
      OLD.verification_state, NEW.verification_state, OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_organization_transition() IS
  'S3-1: the docs/24 §5.1 machine verbatim — draft→submitted→in_review→verified|rejected (rejected→submitted resubmission), verified→live, live⇄suspended, live|suspended→offboarded (terminal, row frozen). Actor legality (provider-owner vs admin edges) is service-enforced; the database refuses every structurally invalid edge even if a future service forgets.';

CREATE TRIGGER trg_organization_transition
  BEFORE UPDATE ON organization FOR EACH ROW
  EXECUTE FUNCTION enforce_organization_transition();

------------------------------------------------------------------------------
-- 2. organization_public_profile — the customer-facing storefront record
-- (docs/27 §3). STRUCTURAL public/private separation: future customer read
-- models select from THIS table (+ public branch columns + the owning
-- organization's verification_state for the liveness gate) and nothing
-- else. A field is public because the provider explicitly put it here.
-- No JSON blob exists that could later smuggle private data into the
-- public surface.
------------------------------------------------------------------------------

CREATE TABLE organization_public_profile (
  organization_id    uuid        NOT NULL,
  display_name       text        NOT NULL,
  description_en     text,
  description_ar     text,
  logo_media_ref     uuid,
  cover_media_ref    uuid,
  gallery_media_refs uuid[]      NOT NULL DEFAULT '{}',
  public_phone       text,
  public_email       text,
  public_website     text,
  public_instagram   text,
  published          boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_organization_public_profile PRIMARY KEY (organization_id),
  CONSTRAINT fk_organization_public_profile_org
    FOREIGN KEY (organization_id) REFERENCES organization (id),
  CONSTRAINT ck_organization_public_profile_version CHECK (version >= 1)
);
COMMENT ON TABLE organization_public_profile IS
  'Customer-facing storefront record (docs/27 §3, Amendment A1) — 1:1 with organization; ONLY customer-safe fields, realized as a separate table so public reads structurally cannot touch private management data. `published` is the provider''s publication intent/readiness switch and MAY be set while the organization is still pre-live (drafting/staging is deliberately allowed); EFFECTIVE public visibility is always the combined predicate organization.verification_state = ''live'' AND published = true, applied by the future read model — suspension/offboarding removes availability through the lifecycle state regardless of this flag.';

CREATE TRIGGER trg_organization_public_profile_updated_at
  BEFORE UPDATE ON organization_public_profile FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_organization_public_profile_version
  BEFORE UPDATE ON organization_public_profile FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_org_profile_row_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'organization_public_profile ownership is immutable (organization %)', OLD.organization_id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_org_profile_row_rules() IS
  'S3-1: a storefront profile can never be re-pointed at another organization.';

CREATE TRIGGER trg_organization_public_profile_rules
  BEFORE UPDATE ON organization_public_profile FOR EACH ROW
  EXECUTE FUNCTION enforce_org_profile_row_rules();

------------------------------------------------------------------------------
-- 3. branch — organization-owned location (docs/24 §1.3; docs/27 §4).
-- UNIQUE (id, organization_id) is the composite ownership target future
-- listing↔branch joins reference so a listing can only ever be offered at
-- branches of its OWN organization. area_id stays FK-less until the Slice-4
-- taxonomy migration (additive); area_label serves reads meanwhile.
-- geo_point is (longitude, latitude). Branches deactivate, never delete.
------------------------------------------------------------------------------

CREATE TABLE branch (
  id              uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  label           text        NOT NULL,
  address_line    text,
  city            text,
  area_id         uuid,
  area_label      text        NOT NULL,
  geo_point       point,
  opening_hours   jsonb,
  facilities      text[]      NOT NULL DEFAULT '{}',
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_branch PRIMARY KEY (id),
  CONSTRAINT fk_branch_organization FOREIGN KEY (organization_id) REFERENCES organization (id),
  CONSTRAINT uq_branch_id_organization UNIQUE (id, organization_id),
  CONSTRAINT ck_branch_geo_point CHECK (
    geo_point IS NULL
    OR (geo_point[0] BETWEEN -180 AND 180 AND geo_point[1] BETWEEN -90 AND 90)
  ),
  CONSTRAINT ck_branch_version CHECK (version >= 1)
);
COMMENT ON TABLE branch IS
  'Organization-owned location (docs/27 §4). Public visibility of a branch = active AND owning organization live-and-published (read-model predicate). UNIQUE (id, organization_id) is the binding composite target for future listing/staff scope joins — cross-organization association is structurally impossible. No session/schedule/capacity/pricing fields exist here by design.';

CREATE INDEX ix_branch_organization ON branch (organization_id, active);

CREATE TRIGGER trg_branch_updated_at
  BEFORE UPDATE ON branch FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_branch_version
  BEFORE UPDATE ON branch FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE FUNCTION enforce_branch_row_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'branch identity/ownership columns are immutable (branch %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION enforce_branch_row_rules() IS
  'S3-1: a branch can never move between organizations; deactivation (active=false) is the only retirement path.';

CREATE TRIGGER trg_branch_rules
  BEFORE UPDATE ON branch FOR EACH ROW
  EXECUTE FUNCTION enforce_branch_row_rules();

------------------------------------------------------------------------------
-- 4. Application-role grants — same posture as every slice: read/insert/
-- update only; deactivation/offboarding are UPDATEs; no DELETE anywhere
-- (retention actions run under the elevated role).
------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON organization TO himma_app;
GRANT SELECT, INSERT, UPDATE ON organization_public_profile TO himma_app;
GRANT SELECT, INSERT, UPDATE ON branch TO himma_app;

-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9 forbids production
-- down migrations). Drops every S3-1 object.

DROP TABLE branch;
DROP TABLE organization_public_profile;
DROP TABLE organization;
DROP FUNCTION enforce_branch_row_rules();
DROP FUNCTION enforce_org_profile_row_rules();
DROP FUNCTION enforce_organization_transition();
