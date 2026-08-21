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
  // -- W3-4 verification-evidence activation (docs/31 W3-4; D-W3-1) -------
  /** PRIVATE verification-evidence submission/retrieval for the OWN
   *  organization's review round — owner only (business legal documents;
   *  widening to other roles is a future owner decision, not a default).
   *  Never grants any admin/operations authority. */
  'verification.evidence.manage',
  // -- S5-4 scheduling/capacity activation (docs/32 §11; docs/27 §6 map) --
  /** RecurringSchedule create/edit/end + session generation — owner,
   *  org_manager, branch_manager (program-in-scope enforced service-side),
   *  listings_editor (docs/27 §6: “create/edit/submit listings, schedules”). */
  'schedules.manage',
  /** Capacity-unit administration (Session/CampWeek/EnrolmentCohort create,
   *  time/capacity/cutoff edits under the S5-1 floor, open/close status) —
   *  owner, org_manager, branch_manager (scoped). Providers submit COMMANDS
   *  only: no input anywhere carries held_count/booked_count. */
  'capacity.manage',
  /** Per-unit occupancy + PII-lean booking roster reads — owner,
   *  org_manager, branch_manager (scoped), front_desk (scoped; docs/27 §6
   *  “booking lookup minimal PII”). Coach roster.view stays RESERVED until
   *  assigned-session scoping exists (attendance slice). */
  'bookings.view',
] as const;

export type ProviderCapability = (typeof ACTIVE_PROVIDER_CAPABILITIES)[number];

/** Approved future vocabulary — named, typed, and INERT until the owning
 *  slice activates an entry by MOVING it into the active set (S4-2 moved
 *  `listings.manage` + `media.manage` and added `listings.publish` +
 *  `catalogue.read` per docs/28 §1.5). */
export const RESERVED_PROVIDER_CAPABILITIES = [
  'sessions.manage',
  'offers.manage',
  'bulk_import.run',
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
    'verification.evidence.manage',
    'schedules.manage',
    'capacity.manage',
    'bookings.view',
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
    'schedules.manage',
    'capacity.manage',
    'bookings.view',
  ],
  branch_manager: [
    'org.read',
    'org.legal.view',
    'branch.edit',
    'catalogue.read',
    'listings.manage',
    'media.manage',
    'schedules.manage',
    'capacity.manage',
    'bookings.view',
  ],
  listings_editor: [
    'org.read',
    'org.legal.view',
    'catalogue.read',
    'listings.manage',
    'media.manage',
    'schedules.manage',
  ],
  coach: ['org.read'],
  front_desk: ['org.read', 'org.legal.view', 'bookings.view'],
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
    'sessions.manage',
    'offers.manage',
    'reports.view',
    'bulk_import.run',
  ],
  branch_manager: ['sessions.manage', 'offers.manage', 'reports.view'],
  listings_editor: ['bulk_import.run'],
  coach: ['roster.view', 'attendance.manage'],
  front_desk: ['sessions.manage', 'attendance.manage'],
  finance: ['statements.view', 'payouts.view', 'refund_reports.view'],
};

export function capabilitiesForRole(role: ProviderRole): readonly ProviderCapability[] {
  return PROVIDER_ROLE_CAPABILITIES[role];
}

export function isActiveCapability(value: string): value is ProviderCapability {
  return (ACTIVE_PROVIDER_CAPABILITIES as readonly string[]).includes(value);
}
