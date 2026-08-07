import { deriveOnboarding } from '../src/onboarding/derive-onboarding';
import type { OnboardingSnapshot } from '../src/onboarding/contract';

function snapshot(overrides: {
  verificationState?: string;
  displayName?: string;
  activeBranches?: number;
  role?: OnboardingSnapshot['membership']['role'];
  capabilities?: string[];
  listingCount?: number | null;
}): OnboardingSnapshot {
  const role = overrides.role ?? 'owner';
  return {
    organization: {
      id: 'org-1',
      tradeName: 'Coral Kids Climbing',
      verificationState: overrides.verificationState ?? 'draft',
      version: 3,
    },
    profile: {
      displayName: overrides.displayName ?? 'Coral Kids Climbing',
      published: false,
    },
    branches:
      overrides.activeBranches === undefined || overrides.activeBranches > 0
        ? Array.from({ length: overrides.activeBranches ?? 1 }, (_, index) => ({
            id: `branch-${index}`,
            label: `Branch ${index + 1}`,
            active: true,
          }))
        : [{ id: 'branch-inactive', label: 'Closed branch', active: false }],
    membership: {
      role,
      capabilities:
        overrides.capabilities ??
        (role === 'owner'
          ? ['org.read', 'profile.edit', 'branch.create', 'org.submit', 'catalogue.read', 'listings.manage', 'staff.manage']
          : ['org.read']),
    },
    listingCount: overrides.listingCount === undefined ? 0 : overrides.listingCount,
  };
}

function item(view: ReturnType<typeof deriveOnboarding>, id: string) {
  const found = view.items.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`missing item ${id}`);
  }
  return found;
}

describe('deriveOnboarding (readiness model over canonical fields)', () => {
  test('draft + incomplete: provider-actionable items, submission blocked on completeness', () => {
    const view = deriveOnboarding(snapshot({ displayName: '  ', activeBranches: 0 }));
    expect(view.stage).toBe('setup');
    expect(item(view, 'profile')).toMatchObject({ state: 'actionRequired', actionable: true });
    expect(item(view, 'branches')).toMatchObject({ state: 'actionRequired', actionable: true });
    expect(item(view, 'review')).toMatchObject({ state: 'blocked' });
    expect(item(view, 'goLive')).toMatchObject({ state: 'blocked' });
    expect(view.submission).toEqual({ kind: 'incomplete', missing: ['profile', 'branches'] });
  });

  test('draft + complete: review becomes the provider-actionable submit step', () => {
    const view = deriveOnboarding(snapshot({}));
    expect(view.stage).toBe('setup');
    expect(item(view, 'profile').state).toBe('complete');
    expect(item(view, 'branches').state).toBe('complete');
    expect(item(view, 'review')).toMatchObject({ state: 'actionRequired', actionable: true });
    expect(view.submission).toEqual({ kind: 'ready' });
  });

  test('profile/branch completeness mirrors the exact backend submit rules (trimmed display name, ≥1 ACTIVE branch)', () => {
    const emptyName = deriveOnboarding(snapshot({ displayName: '   ' }));
    expect(item(emptyName, 'profile').state).toBe('actionRequired');

    const inactiveOnly = deriveOnboarding(snapshot({ activeBranches: 0 }));
    expect(item(inactiveOnly, 'branches').state).toBe('actionRequired');
    expect(inactiveOnly.submission).toEqual({ kind: 'incomplete', missing: ['branches'] });
  });

  test('submitted and in_review: Himma holds the ball; nothing provider-actionable on review', () => {
    for (const state of ['submitted', 'in_review']) {
      const view = deriveOnboarding(snapshot({ verificationState: state }));
      expect(view.stage).toBe(state === 'submitted' ? 'submitted' : 'inReview');
      expect(item(view, 'review').state).toBe('awaitingHimma');
      expect(item(view, 'goLive').state).toBe('blocked');
      expect(view.submission).toEqual({ kind: 'notApplicable' });
    }
  });

  test('rejected: resubmission is provider-actionable again', () => {
    const view = deriveOnboarding(snapshot({ verificationState: 'rejected' }));
    expect(view.stage).toBe('rejected');
    expect(item(view, 'review')).toMatchObject({ state: 'actionRequired', actionable: true });
    expect(view.submission).toEqual({ kind: 'ready' });
  });

  test('verified: go-live awaits Himma and is never provider-triggerable', () => {
    const view = deriveOnboarding(snapshot({ verificationState: 'verified' }));
    expect(view.stage).toBe('verified');
    expect(item(view, 'review').state).toBe('complete');
    expect(item(view, 'goLive').state).toBe('awaitingHimma');
    expect(view.submission).toEqual({ kind: 'notApplicable' });
  });

  test('live: operational; the first-listing prompt appears only here', () => {
    const noListings = deriveOnboarding(snapshot({ verificationState: 'live', listingCount: 0 }));
    expect(noListings.stage).toBe('live');
    expect(item(noListings, 'goLive').state).toBe('complete');
    expect(item(noListings, 'firstListing')).toMatchObject({ state: 'actionRequired' });

    const withListings = deriveOnboarding(snapshot({ verificationState: 'live', listingCount: 4 }));
    expect(item(withListings, 'firstListing').state).toBe('complete');

    const preLive = deriveOnboarding(snapshot({ verificationState: 'draft' }));
    expect(preLive.items.some((entry) => entry.id === 'firstListing')).toBe(false);
  });

  test('suspended: no go-live path, no submission', () => {
    const view = deriveOnboarding(snapshot({ verificationState: 'suspended' }));
    expect(view.stage).toBe('suspended');
    expect(view.submission).toEqual({ kind: 'notApplicable' });
    expect(item(view, 'goLive').state).toBe('blocked');
  });

  test('role-aware actionability comes from REAL capabilities, never invented rules', () => {
    const coach = deriveOnboarding(
      snapshot({ displayName: ' ', activeBranches: 0, role: 'coach', capabilities: ['org.read'], listingCount: null }),
    );
    expect(item(coach, 'profile')).toMatchObject({ state: 'actionRequired', actionable: false });
    expect(item(coach, 'branches')).toMatchObject({ state: 'actionRequired', actionable: false });
    expect(coach.submission).toEqual({ kind: 'notAllowed' });

    // org_manager can edit profile/branches but NOT submit (org.submit is owner-only in canon).
    const manager = deriveOnboarding(
      snapshot({
        role: 'org_manager',
        capabilities: ['org.read', 'profile.edit', 'branch.create', 'catalogue.read'],
      }),
    );
    expect(item(manager, 'profile').actionable).toBe(true);
    expect(manager.submission).toEqual({ kind: 'notAllowed' });
  });

  test('team stays an optional step (management arrives with a later task)', () => {
    const view = deriveOnboarding(snapshot({}));
    expect(item(view, 'team').state).toBe('optional');
  });

  test('an unknown verification state renders conservatively, never as live', () => {
    const view = deriveOnboarding(snapshot({ verificationState: 'something_new' }));
    expect(view.stage).toBe('unknown');
    expect(view.submission).toEqual({ kind: 'notApplicable' });
    expect(item(view, 'goLive').state).toBe('blocked');
  });

  test('no percentage is fabricated anywhere in the model', () => {
    const view = deriveOnboarding(snapshot({}));
    expect(JSON.stringify(view)).not.toMatch(/percent|%/i);
  });
});
