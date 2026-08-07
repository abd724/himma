/**
 * Customer-public provider storefront read model (docs/27 §3, §13.1) — S3-4.
 *
 * STRUCTURAL public/private separation: this module selects ONLY the
 * explicitly enumerated columns below, from ONLY the three approved
 * sources — `organization` contributes nothing but the id and the
 * liveness-eligibility state; every customer-visible field comes from
 * `organization_public_profile` and public `branch` columns. There is no
 * `select *` anywhere, so a future private column cannot leak by existing
 * (§14.9 locks this with a structural test).
 *
 * Effective visibility (Amendment A1): `verification_state = 'live'` AND
 * `published = true`. Everything else — draft, submitted, in_review,
 * verified-not-live, rejected, suspended, offboarded, unpublished, or
 * nonexistent — is the SAME not-found; no oracle reveals which condition
 * failed. The verified badge is derived from liveness, never a settable
 * flag. Listings/ratings are deliberately ABSENT (not empty placeholders):
 * Slice 4 composes its listing read models WITH this projection.
 */
import type { Db } from '../../../db/kysely';
import { withTransaction } from '../../../db/transaction';

/**
 * The complete, closed list of columns the public projection may touch —
 * `organization` strictly for id + eligibility, `published`/`active`
 * strictly as visibility predicates (never serialized). The §14.9
 * structural test asserts these sets verbatim; extending them is an
 * owner-visible diff here, never a silent query change.
 */
export const PUBLIC_STOREFRONT_SOURCES = {
  organization: ['id', 'verification_state'],
  organization_public_profile: [
    'organization_id',
    'display_name',
    'description_en',
    'description_ar',
    'logo_media_ref',
    'cover_media_ref',
    'gallery_media_refs',
    'public_phone',
    'public_email',
    'public_website',
    'public_instagram',
    'published',
  ],
  branch: [
    'id',
    'organization_id',
    'label',
    'address_line',
    'area_label',
    'geo_point',
    'opening_hours',
    'facilities',
    'active',
  ],
} as const;

export interface PublicBranchView {
  id: string;
  label: string;
  addressLine: string | null;
  areaLabel: string;
  geoPoint: { longitude: number; latitude: number } | null;
  openingHours: unknown;
  facilities: string[];
}

export interface PublicStorefrontView {
  id: string;
  displayName: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  /** Derived from liveness (live ⇒ verified badge) — never a stored flag. */
  verified: boolean;
  logoMediaRef: string | null;
  coverMediaRef: string | null;
  galleryMediaRefs: string[];
  publicPhone: string | null;
  publicEmail: string | null;
  publicWebsite: string | null;
  publicInstagram: string | null;
  branches: PublicBranchView[];
}

export type ReadStorefrontResult =
  | { kind: 'storefront'; storefront: PublicStorefrontView }
  | { kind: 'notFound' };

export async function readPublicStorefront(
  deps: { db: Db },
  organizationId: string,
): Promise<ReadStorefrontResult> {
  return withTransaction(deps.db, async (trx) => {
    const row = await trx
      .selectFrom('organization')
      .innerJoin(
        'organization_public_profile',
        'organization_public_profile.organization_id',
        'organization.id',
      )
      .select([
        'organization.id as id',
        'organization_public_profile.display_name',
        'organization_public_profile.description_en',
        'organization_public_profile.description_ar',
        'organization_public_profile.logo_media_ref',
        'organization_public_profile.cover_media_ref',
        'organization_public_profile.gallery_media_refs',
        'organization_public_profile.public_phone',
        'organization_public_profile.public_email',
        'organization_public_profile.public_website',
        'organization_public_profile.public_instagram',
      ])
      .where('organization.id', '=', organizationId)
      // The A1 visibility rule — both conditions, one indistinguishable 404.
      .where('organization.verification_state', '=', 'live')
      .where('organization_public_profile.published', '=', true)
      .executeTakeFirst();
    if (row === undefined) return { kind: 'notFound' as const };

    // Public branches: active branches of the live organization only, in
    // stable creation order (UUIDv7 ids are time-ordered) — no invented
    // popularity/recommendation ordering.
    const branches = await trx
      .selectFrom('branch')
      .select(['id', 'label', 'address_line', 'area_label', 'geo_point', 'opening_hours', 'facilities'])
      .where('organization_id', '=', organizationId)
      .where('active', '=', true)
      .orderBy('id')
      .execute();

    return {
      kind: 'storefront' as const,
      storefront: {
        id: row.id,
        displayName: row.display_name,
        descriptionEn: row.description_en,
        descriptionAr: row.description_ar,
        verified: true, // reached only through the live-state predicate
        logoMediaRef: row.logo_media_ref,
        coverMediaRef: row.cover_media_ref,
        galleryMediaRefs: row.gallery_media_refs,
        publicPhone: row.public_phone,
        publicEmail: row.public_email,
        publicWebsite: row.public_website,
        publicInstagram: row.public_instagram,
        branches: branches.map((branch) => ({
          id: branch.id,
          label: branch.label,
          addressLine: branch.address_line,
          areaLabel: branch.area_label,
          geoPoint:
            branch.geo_point === null
              ? null
              : { longitude: branch.geo_point.x, latitude: branch.geo_point.y },
          openingHours: branch.opening_hours,
          facilities: branch.facilities,
        })),
      },
    };
  });
}
