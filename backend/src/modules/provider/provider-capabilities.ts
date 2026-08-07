/**
 * Typed provider capability registry (docs/27 §6) — S3-3.
 *
 * Policies and services check CAPABILITIES, never role names, so later
 * slices activate reserved capabilities without touching route policy code.
 * Two strictly separated vocabularies:
 *
 * - ACTIVE capabilities exist only for entities that exist in Slice 3
 *   (organization, public profile, branch, staff membership, invitation).
 *   Only these can ever appear in a resolved orgScope or a route
 *   declaration — the types make a reserved capability unrepresentable
 *   there, and a structural test locks it.
 * - RESERVED capabilities are the approved docs/27 §6 future vocabulary
 *   (listings, schedules, attendance, bookings, reports, payouts…): named
 *   now so Slice 4+ activates them by MOVING an entry, never by redesign.
 *   Nothing in Slice 3 resolves, grants, or executes them — a role named
 *   `finance` carries identity only; no financial entity or read exists.
 */
import type { ProviderRole } from './provider-roles';

/** Capabilities enforceable against entities that exist in Slice 3. */
export const ACTIVE_PROVIDER_CAPABILITIES = [
  /** Provider-private organization view (all roles; coach sees the
   *  data-minimized shape — no legal/commercial fields, §7.7). */
  'org.read',
  /** Legal identity (legal_name) inside the private view — every role
   *  except coach (docs/27 §6 coach minimization). */
  'org.legal.view',
  /** Commercial-terms reference sight — owner only (docs/27 §6). */
  'commercial_terms.view',
  /** Public-profile draft/edit incl. publish flag — owner, org_manager. */
  'profile.edit',
  /** Branch create — owner, org_manager (org-wide by nature). */
  'branch.create',
  /** Branch edit — owner, org_manager org-wide; branch_manager on
   *  assigned ACTIVE branches only (scope-enforced). */
  'branch.edit',
  /** Branch deactivate — owner, org_manager. */
  'branch.deactivate',
  /** Staff/invitation read — owner only (docs/24 §1.3). */
  'staff.read',
  /** Staff invite/revoke/role management — owner only; always step-up. */
  'staff.manage',
  /** draft/rejected → submitted lifecycle edge — owner (docs/27 §10). */
  'org.submit',
  // -- Slice-4 catalogue activation (docs/28 §1.5, §6; D-S4-2) ------------
  /** Provider-private catalogue read (own listings incl. drafts) — owner,
   *  org_manager, branch_manager (scoped), listings_editor. */
  'catalogue.read',
  /** Listing create/edit/submit + price-option, offer, and branch-
   *  association management — owner, org_manager, listings_editor;
   *  branch_manager within branch scope only (service-enforced). Offer
   *  management rides this capability: docs/28 §1.5 activates exactly
   *  `listings.manage`, `media.manage`, `listings.publish`, and
   *  `catalogue.read` — `offers.manage` stays reserved. */
  'listings.manage',
  /** Publish/unpublish/pause/archive — Owner + Organization Manager ONLY
   *  (D-S4-2). Listings Editor never publishes; Branch Manager holds no
   *  publication authority. */
  'listings.publish',
  /** Listing media-reference metadata management (references only). */
  'media.manage',
] as const;

export type ProviderCapability = (typeof ACTIVE_PROVIDER_CAPABILITIES)[number];

/** Approved future vocabulary — named, typed, and INERT until the owning
 *  slice activates an entry by MOVING it into the active set (S4-2 moved
 *  `listings.manage` + `media.manage` and added `listings.publish` +
 *  `catalogue.read` per docs/28 §1.5). */
export const RESERVED_PROVIDER_CAPABILITIES = [
  'schedules.manage',
  'sessions.manage',
  'capacity.manage',
  'offers.manage',
  'bulk_import.run',
  'bookings.view',
  'reports.view',
  'attendance.manage',
  'roster.view',
  'statements.view',
  'payouts.view',
  'refund_reports.view',
  'payout_bank_details.manage',
] as const;

export type ReservedProviderCapability =
  (typeof RESERVED_PROVIDER_CAPABILITIES)[number];

/** Role → ACTIVE capabilities (docs/27 §6 Slice-3 column + the docs/28 §6
 *  Slice-4 catalogue activation; D-S4-2 publication matrix). Coach, Front
 *  Desk, and Finance gain NO catalogue capability — Finance acquires nothing
 *  merely because price options carry monetary catalogue metadata. */
export const PROVIDER_ROLE_CAPABILITIES: Record<ProviderRole, readonly ProviderCapability[]> = {
  owner: [
    'org.read',
    'org.legal.view',
    'commercial_terms.view',
    'profile.edit',
    'branch.create',
    'branch.edit',
    'branch.deactivate',
    'staff.read',
    'staff.manage',
    'org.submit',
    'catalogue.read',
    'listings.manage',
    'listings.publish',
    'media.manage',
  ],
  org_manager: [
    'org.read',
    'org.legal.view',
    'profile.edit',
    'branch.create',
    'branch.edit',
    'branch.deactivate',
    'catalogue.read',
    'listings.manage',
    'listings.publish',
    'media.manage',
  ],
  branch_manager: [
    'org.read',
    'org.legal.view',
    'branch.edit',
    'catalogue.read',
    'listings.manage',
    'media.manage',
  ],
  listings_editor: [
    'org.read',
    'org.legal.view',
    'catalogue.read',
    'listings.manage',
    'media.manage',
  ],
  coach: ['org.read'],
  front_desk: ['org.read', 'org.legal.view'],
  finance: ['org.read', 'org.legal.view'],
};

/**
 * Role → RESERVED capabilities (docs/27 §6, reserved column) — the future
 * activation map. Deliberately NOT consulted by orgScope resolution or any
 * policy: recorded vocabulary only, so activating one is an explicit move
 * into PROVIDER_ROLE_CAPABILITIES with its owning slice.
 */
export const PROVIDER_ROLE_RESERVED_CAPABILITIES: Record<
  ProviderRole,
  readonly ReservedProviderCapability[]
> = {
  owner: ['payout_bank_details.manage'],
  org_manager: [
    'schedules.manage',
    'sessions.manage',
    'capacity.manage',
    'offers.manage',
    'bookings.view',
    'reports.view',
    'bulk_import.run',
  ],
  branch_manager: [
    'schedules.manage',
    'sessions.manage',
    'capacity.manage',
    'offers.manage',
    'bookings.view',
    'reports.view',
  ],
  listings_editor: ['schedules.manage', 'bulk_import.run'],
  coach: ['roster.view', 'attendance.manage'],
  front_desk: ['sessions.manage', 'attendance.manage', 'bookings.view'],
  finance: ['statements.view', 'payouts.view', 'refund_reports.view'],
};

export function capabilitiesForRole(role: ProviderRole): readonly ProviderCapability[] {
  return PROVIDER_ROLE_CAPABILITIES[role];
}

export function isActiveCapability(value: string): value is ProviderCapability {
  return (ACTIVE_PROVIDER_CAPABILITIES as readonly string[]).includes(value);
}
