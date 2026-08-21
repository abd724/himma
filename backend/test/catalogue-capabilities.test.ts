/**
 * S4-2 — Slice-4 catalogue capability activation (docs/28 §1.5, §6; D-S4-2;
 * docs/27 §6 registry). The exact seven-role × capability matrix: the four
 * activated catalogue capabilities (`catalogue.read`, `listings.manage`,
 * `listings.publish`, `media.manage`) land on exactly the approved roles,
 * publication authority is Owner + Organization Manager ONLY, Finance/Coach/
 * Front Desk gain nothing, and every other reserved capability stays
 * reserved and non-executable.
 */
import {
  ACTIVE_PROVIDER_CAPABILITIES,
  PROVIDER_ROLE_CAPABILITIES,
  PROVIDER_ROLE_RESERVED_CAPABILITIES,
  RESERVED_PROVIDER_CAPABILITIES,
  capabilitiesForRole,
} from '../src/modules/provider/provider-capabilities';
import { PROVIDER_ROLES } from '../src/modules/provider/provider-roles';

const CATALOGUE_CAPABILITIES = [
  'catalogue.read',
  'listings.manage',
  'listings.publish',
  'media.manage',
] as const;

/** The binding S4-2 role × catalogue-capability matrix (docs/28 §6; D-S4-2). */
const EXPECTED_CATALOGUE_MATRIX: Record<string, readonly string[]> = {
  owner: ['catalogue.read', 'listings.manage', 'listings.publish', 'media.manage'],
  org_manager: ['catalogue.read', 'listings.manage', 'listings.publish', 'media.manage'],
  branch_manager: ['catalogue.read', 'listings.manage', 'media.manage'],
  listings_editor: ['catalogue.read', 'listings.manage', 'media.manage'],
  coach: [],
  front_desk: [],
  finance: [],
};

describe('S4-2 catalogue capability activation', () => {
  it('activates exactly the four approved catalogue capabilities', () => {
    for (const capability of CATALOGUE_CAPABILITIES) {
      expect(ACTIVE_PROVIDER_CAPABILITIES as readonly string[]).toContain(capability);
      expect(RESERVED_PROVIDER_CAPABILITIES as readonly string[]).not.toContain(capability);
    }
  });

  it('grants each of the seven roles exactly its approved catalogue capability set', () => {
    for (const role of PROVIDER_ROLES) {
      const catalogueGranted = capabilitiesForRole(role).filter((capability) =>
        (CATALOGUE_CAPABILITIES as readonly string[]).includes(capability),
      );
      expect([...catalogueGranted].sort()).toEqual([...EXPECTED_CATALOGUE_MATRIX[role]!].sort());
    }
  });

  it('publication authority is Owner + Organization Manager ONLY (D-S4-2)', () => {
    for (const role of PROVIDER_ROLES) {
      const canPublish = capabilitiesForRole(role).includes('listings.publish');
      expect(canPublish).toBe(role === 'owner' || role === 'org_manager');
    }
  });

  it('Finance gains nothing from monetary catalogue metadata; Coach and Front Desk gain nothing', () => {
    for (const role of ['finance', 'coach', 'front_desk'] as const) {
      for (const capability of capabilitiesForRole(role)) {
        expect(CATALOGUE_CAPABILITIES as readonly string[]).not.toContain(capability);
      }
    }
  });

  it('keeps future capabilities reserved: sessions, offers, reports, attendance, payouts… (S5-4 activated schedules.manage, capacity.manage, bookings.view — locked in booking-provider-routes.test.ts)', () => {
    for (const stillReserved of [
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
    ]) {
      expect(RESERVED_PROVIDER_CAPABILITIES as readonly string[]).toContain(stillReserved);
      expect(ACTIVE_PROVIDER_CAPABILITIES as readonly string[]).not.toContain(stillReserved);
    }
    // The two vocabularies stay disjoint, active grants stay active-only.
    for (const role of PROVIDER_ROLES) {
      for (const capability of PROVIDER_ROLE_CAPABILITIES[role]) {
        expect(ACTIVE_PROVIDER_CAPABILITIES).toContain(capability);
      }
      for (const capability of PROVIDER_ROLE_RESERVED_CAPABILITIES[role]) {
        expect(ACTIVE_PROVIDER_CAPABILITIES as readonly string[]).not.toContain(capability);
      }
    }
  });
});
