import { describe, expect, test } from '@jest/globals';
import { activityTypes, categories, programs, providers } from '@/data/mock/catalogue';
import { cancellationPolicies } from '@/data/mock/policies';
import { programDetailExtras } from '@/data/mock/program-details';
import { providerBranches, providerDetailExtras } from '@/data/mock/provider-details';
import type { ProgramDetailInput, ProviderStorefrontInput } from '@/services/contracts/details';
import {
  buildUpcomingSessions,
  MockDetailsService,
  providerMonogram,
} from '@/services/mock/mock-details-service';
import type { Participant } from '@/types/domain';

const service = new MockDetailsService(0);

const me: Participant = { id: 'me', label: 'Me', kind: 'self' };
const adam: Participant = { id: 'adam', label: 'Adam', kind: 'child', dateOfBirth: '2018-03-14' }; // 8
const lina: Participant = { id: 'lina', label: 'Lina', kind: 'child', dateOfBirth: '2013-11-02' }; // 12
const everyone: Participant = { id: 'everyone', label: 'Everyone', kind: 'everyone' };
const household = [everyone, me, adam, lina];

function input(overrides: Partial<ProgramDetailInput>): ProgramDetailInput {
  return {
    programId: 'beginner-calisthenics',
    participantId: 'everyone',
    participants: household,
    areaId: 'khalifa-city',
    ...overrides,
  };
}

describe('Program detail lookup (docs/20 §8.4, docs/16 §2)', () => {
  test('every catalogue program builds a complete page', () => {
    for (const program of programs) {
      const page = service.buildProgramDetailPage(input({ programId: program.id }));
      expect(page).toBeDefined();
      expect(page?.extras.description.length).toBeGreaterThan(20);
      expect(page?.extras.reviewCount).toBeGreaterThan(0);
      expect(page?.ageLabel.length).toBeGreaterThan(0);
      expect(page?.formatLabel.length).toBeGreaterThan(0);
      expect(page?.priceLabel.length).toBeGreaterThan(0);
      expect(page?.provider.id).toBe(program.providerId);
      expect(page?.policy).toBe(cancellationPolicies[programDetailExtras[program.id]!.policyId]);
      expect(page?.areaLabel.length).toBeGreaterThan(0);
    }
  });

  test('extras cover exactly the 36 catalogue programs — no orphans', () => {
    const catalogueIds = new Set(programs.map((program) => program.id));
    const extraIds = Object.keys(programDetailExtras);
    expect(programs).toHaveLength(36);
    expect(extraIds).toHaveLength(36);
    for (const id of extraIds) expect(catalogueIds.has(id)).toBe(true);
  });

  test('unknown program id returns undefined for screen-level recovery', () => {
    expect(service.buildProgramDetailPage(input({ programId: 'not-real' }))).toBeUndefined();
  });

  test('more-from-provider excludes self, caps at 4, same provider only', () => {
    for (const program of programs) {
      const page = service.buildProgramDetailPage(input({ programId: program.id }));
      const more = page!.moreFromProvider;
      expect(more.length).toBeLessThanOrEqual(4);
      expect(more.some((entry) => entry.id === program.id)).toBe(false);
      for (const entry of more) expect(entry.providerId).toBe(program.providerId);
    }
  });

  test('simulated failure rejects with the QA-only error', async () => {
    await expect(
      service.getProgramDetailPage(input({ simulateFailure: true })),
    ).rejects.toThrow('Simulated network failure');
  });
});

describe('Participant suitability on details (docs/05 §7, docs/20 §6)', () => {
  test('child inside the provider-defined range is suitable', () => {
    const page = service.buildProgramDetailPage(
      input({ programId: 'junior-swim-squad', participantId: 'adam' }),
    );
    expect(page?.suitability).toEqual(
      expect.objectContaining({ participantId: 'adam', suitable: true }),
    );
  });

  test('child outside the range is unsuitable with the age reason', () => {
    const page = service.buildProgramDetailPage(
      input({ programId: 'beginner-calisthenics', participantId: 'adam' }),
    );
    expect(page?.suitability?.suitable).toBe(false);
    expect(page?.suitability?.reason).toBe('Ages 16+ — Adam is 8');
  });

  test('adult on a junior program gets an honest designed-for reason', () => {
    const page = service.buildProgramDetailPage(
      input({ programId: 'junior-karate', participantId: 'me' }),
    );
    expect(page?.suitability?.suitable).toBe(false);
    expect(page?.suitability?.reason).toContain('ages 6–12');
  });

  test('adults are never gender-excluded from ladies-only programs', () => {
    const page = service.buildProgramDetailPage(
      input({ programId: 'ladies-strength', participantId: 'me' }),
    );
    expect(page?.suitability?.suitable).toBe(true);
  });

  test('everyone context has no per-person line but full household list', () => {
    const page = service.buildProgramDetailPage(input({ participantId: 'everyone' }));
    expect(page?.suitability).toBeUndefined();
    expect(page?.householdSuitability.map((entry) => entry.participantId)).toEqual([
      'me',
      'adam',
      'lina',
    ]);
  });

  test('guest input (no participants) renders without suitability', () => {
    const page = service.buildProgramDetailPage(
      input({ participants: [], participantId: 'everyone' }),
    );
    expect(page?.suitability).toBeUndefined();
    expect(page?.householdSuitability).toEqual([]);
  });
});

describe('Deterministic sessions (docs/20 §8.3, docs/09 §20.9)', () => {
  const byId = (id: string) => programs.find((program) => program.id === id)!;

  test('recurring offsets stay inside the two-week window; camps use real start dates', () => {
    for (const program of programs) {
      for (const session of buildUpcomingSessions(program, programDetailExtras[program.id])) {
        expect(session.dayOffset).toBeGreaterThanOrEqual(0);
        if (program.isCamp) {
          expect(session.dayLabel.startsWith('Starts ')).toBe(true);
          expect(session.dayOffset).toBeLessThan(30);
        } else {
          expect(session.dayOffset).toBeLessThan(14);
        }
      }
    }
  });

  test('a later-in-month camp keeps its real start date (17 August → Monday)', () => {
    const sessions = buildUpcomingSessions(
      byId('holiday-swim-camp'),
      programDetailExtras['holiday-swim-camp'],
    );
    expect(sessions).toEqual([
      expect.objectContaining({ dayOffset: 15, dayLabel: 'Starts Mon 17 Aug' }),
    ]);
  });

  test('today-led schedules lead with a Today occurrence', () => {
    const sessions = buildUpcomingSessions(
      byId('beginner-calisthenics'),
      programDetailExtras['beginner-calisthenics'],
    );
    expect(sessions[0]).toEqual(
      expect.objectContaining({ dayOffset: 0, dayLabel: 'Today', timeLabel: '7:30 PM' }),
    );
  });

  test('weekday schedules land on the right offsets (Sun & Wed from a Sunday)', () => {
    const sessions = buildUpcomingSessions(byId('ladies-strength'), {
      ...programDetailExtras['ladies-strength'],
      spotsLeft: undefined,
    });
    expect(sessions.map((session) => session.dayOffset)).toEqual([0, 3, 7, 10]);
    expect(sessions.every((session) => session.timeLabel === '9:30 AM')).toBe(true);
  });

  test('camps produce a single start entry from the date range', () => {
    const sessions = buildUpcomingSessions(
      byId('teen-coding-camp'),
      programDetailExtras['teen-coding-camp'],
    );
    expect(sessions).toEqual([
      expect.objectContaining({ dayOffset: 8, dayLabel: 'Starts Mon 10 Aug' }),
    ]);
  });

  test("the 'none' override yields the no-sessions state", () => {
    expect(
      buildUpcomingSessions(byId('public-speaking'), programDetailExtras['public-speaking']),
    ).toEqual([]);
  });

  test('weak availability marks only the first occurrence', () => {
    const sessions = buildUpcomingSessions(
      byId('reformer-pilates'),
      programDetailExtras['reformer-pilates'],
    );
    expect(sessions[0].spotsLeft).toBe(3);
    expect(sessions.slice(1).every((session) => session.spotsLeft === undefined)).toBe(true);
  });

  test('derivation is deterministic across calls', () => {
    for (const program of programs) {
      expect(buildUpcomingSessions(program, programDetailExtras[program.id])).toEqual(
        buildUpcomingSessions(program, programDetailExtras[program.id]),
      );
    }
  });
});

function storefrontInput(
  overrides: Partial<ProviderStorefrontInput>,
): ProviderStorefrontInput {
  return {
    providerId: 'falcon',
    participantId: 'everyone',
    participants: household,
    areaId: 'khalifa-city',
    ...overrides,
  };
}

describe('Provider storefront lookup (docs/20 §8.4, docs/16 §2)', () => {
  test('every catalogue provider builds a complete page', () => {
    for (const provider of providers) {
      const page = service.buildProviderStorefrontPage(
        storefrontInput({ providerId: provider.id }),
      );
      expect(page).toBeDefined();
      expect(page?.extras.description.length).toBeGreaterThan(20);
      expect(page?.extras.reviewCount).toBeGreaterThan(0);
      expect(page?.monogram.length).toBeGreaterThan(0);
      expect(page?.branches.length).toBeGreaterThanOrEqual(1);
      expect(page?.policy).toBe(cancellationPolicies[providerDetailExtras[provider.id]!.policyId]);
      expect(page?.areaLabel.length).toBeGreaterThan(0);
      expect(page?.programCount).toBeGreaterThan(0);
    }
  });

  test('extras cover exactly the 11 catalogue providers — no orphans', () => {
    const catalogueIds = new Set(providers.map((provider) => provider.id));
    const extraIds = Object.keys(providerDetailExtras);
    expect(providers).toHaveLength(11);
    expect(extraIds).toHaveLength(11);
    for (const id of extraIds) expect(catalogueIds.has(id)).toBe(true);
  });

  test('unknown provider id returns undefined for screen-level recovery', () => {
    expect(
      service.buildProviderStorefrontPage(storefrontInput({ providerId: 'not-real' })),
    ).toBeUndefined();
  });

  test('monogram derives from the provider name — never a real logo', () => {
    expect(providerMonogram('Falcon Combat Academy')).toBe('FC');
    expect(providerMonogram('Gravity Movement Studio')).toBe('GM');
    const page = service.buildProviderStorefrontPage(storefrontInput({}));
    expect(page?.monogram).toBe('FC');
  });

  test('simulated failure rejects with the QA-only error', async () => {
    await expect(
      service.getProviderStorefrontPage(storefrontInput({ simulateFailure: true })),
    ).rejects.toThrow('Simulated network failure');
  });
});

describe('Storefront program relationships and taxonomy (docs/20 §7.3)', () => {
  test('program groups exactly partition the provider catalogue in everyone context', () => {
    for (const provider of providers) {
      const page = service.buildProviderStorefrontPage(
        storefrontInput({ providerId: provider.id, branchId: undefined }),
      )!;
      const providerProgramIds = programs
        .filter((program) => program.providerId === provider.id)
        .map((program) => program.id);
      const groupedIds = page.programGroups.flatMap((group) =>
        group.programs.map((program) => program.id),
      );
      // Multi-branch providers filter to the selected branch; the union of
      // both branches must still partition the full catalogue set.
      if (provider.id === 'blue-wave') {
        const gardens = service.buildProviderStorefrontPage(
          storefrontInput({ providerId: provider.id, branchId: 'blue-wave-gardens' }),
        )!;
        const union = new Set([
          ...groupedIds,
          ...gardens.programGroups.flatMap((group) =>
            group.programs.map((program) => program.id),
          ),
        ]);
        expect([...union].sort()).toEqual([...providerProgramIds].sort());
      } else {
        expect(groupedIds.sort()).toEqual([...providerProgramIds].sort());
        expect(new Set(groupedIds).size).toBe(groupedIds.length);
      }
    }
  });

  test('categories and activity types join the taxonomy via programs, never free text', () => {
    for (const provider of providers) {
      const page = service.buildProviderStorefrontPage(
        storefrontInput({ providerId: provider.id }),
      )!;
      const providerPrograms = programs.filter((program) => program.providerId === provider.id);
      const expectedCategoryIds = categories
        .filter((category) =>
          providerPrograms.some((program) => program.categoryId === category.id),
        )
        .map((category) => category.id);
      const expectedActivityIds = activityTypes
        .filter((activityType) =>
          providerPrograms.some((program) => program.activityTypeId === activityType.id),
        )
        .map((activityType) => activityType.id);
      expect(page.categories.map((category) => category.id)).toEqual(expectedCategoryIds);
      expect(page.activityTypes.map((activityType) => activityType.id)).toEqual(
        expectedActivityIds,
      );
    }
  });

  test('noor spans two categories and groups under both headers', () => {
    const page = service.buildProviderStorefrontPage(storefrontInput({ providerId: 'noor' }))!;
    expect(page.programGroups.map((group) => group.category.id).sort()).toEqual([
      'learning',
      'quran',
    ]);
  });
});

describe('Storefront branches (docs/09 §20.6)', () => {
  test('blue-wave returns two branches; the default selection is the first', () => {
    const page = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'blue-wave' }),
    )!;
    expect(page.branches).toHaveLength(2);
    expect(page.selectedBranch.id).toBe('blue-wave-beach');
  });

  test('branch selection filters the represented program availability', () => {
    const beach = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'blue-wave', branchId: 'blue-wave-beach' }),
    )!;
    const gardens = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'blue-wave', branchId: 'blue-wave-gardens' }),
    )!;
    const beachIds = beach.programGroups.flatMap((group) =>
      group.programs.map((program) => program.id),
    );
    const gardensIds = gardens.programGroups.flatMap((group) =>
      group.programs.map((program) => program.id),
    );
    expect(beachIds).toEqual(['junior-swim-squad', 'holiday-swim-camp', 'adult-swim-technique']);
    expect(gardensIds).toEqual(['ladies-aqua']);
    expect(beach.programCount).toBe(3);
    expect(gardens.programCount).toBe(1);
  });

  test('an unknown branch id falls back to the first branch', () => {
    const page = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'blue-wave', branchId: 'not-a-branch' }),
    )!;
    expect(page.selectedBranch.id).toBe('blue-wave-beach');
  });

  test('single-branch providers expose one implicit branch with address details', () => {
    for (const provider of providers.filter((entry) => entry.id !== 'blue-wave')) {
      const page = service.buildProviderStorefrontPage(
        storefrontInput({ providerId: provider.id }),
      )!;
      expect(page.branches).toHaveLength(1);
      expect(page.selectedBranch.areaId).toBe(provider.areaId);
      expect(page.selectedBranch.addressLine.length).toBeGreaterThan(0);
    }
  });
});

describe('Storefront eligibility grouping (docs/05 §7, docs/20 §4.7, §6.2)', () => {
  test('adult context ranks adult-suitable first and never gender-filters', () => {
    const page = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'gravity', participantId: 'me' }),
    )!;
    const ids = page.programGroups.flatMap((group) =>
      group.programs.map((program) => program.id),
    );
    expect(ids).toEqual([
      'beginner-calisthenics',
      'ladies-strength',
      'mens-strength-basics',
      'active-summer-camp',
      'junior-calisthenics',
    ]);
    // Ladies-only stays visible for Me; nothing is hidden for adults.
    expect(page.ineligiblePrograms).toEqual([]);
    expect(page.programCount).toBe(5);
  });

  test('child context lists eligible programs and separates (never hides) the rest', () => {
    const page = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'blue-wave', participantId: 'adam' }),
    )!;
    const eligibleIds = page.programGroups.flatMap((group) =>
      group.programs.map((program) => program.id),
    );
    expect(eligibleIds).toEqual(['junior-swim-squad', 'holiday-swim-camp']);
    expect(page.ineligiblePrograms.map((program) => program.id)).toEqual([
      'adult-swim-technique',
    ]);
    expect(page.eligibleProgramCount).toBe(2);
    expect(page.programCount).toBe(3);
  });

  test('a child with no eligible programs gets recovery data, not an empty provider', () => {
    const page = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'restore', participantId: 'adam', areaId: 'saadiyat' }),
    )!;
    expect(page.eligibleProgramCount).toBe(0);
    expect(page.programGroups).toEqual([]);
    expect(page.ineligiblePrograms).toHaveLength(2);
    // Recovery chips: the adult can join; neither child can.
    expect(page.eligibleParticipants.map((entry) => entry.participantId)).toEqual(['me']);
    // Identity and trust content is still present.
    expect(page.provider.name.length).toBeGreaterThan(0);
    expect(page.extras.description.length).toBeGreaterThan(0);
  });

  test('everyone context keeps catalogue order with nothing separated', () => {
    const page = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'gravity', participantId: 'everyone' }),
    )!;
    const ids = page.programGroups.flatMap((group) =>
      group.programs.map((program) => program.id),
    );
    expect(ids).toEqual([
      'beginner-calisthenics',
      'ladies-strength',
      'active-summer-camp',
      'mens-strength-basics',
      'junior-calisthenics',
    ]);
    expect(page.ineligiblePrograms).toEqual([]);
  });

  test('guest input (no participants) renders the full storefront', () => {
    const page = service.buildProviderStorefrontPage(
      storefrontInput({ participants: [], participantId: 'everyone' }),
    )!;
    expect(page.programGroups.flatMap((group) => group.programs)).toHaveLength(5);
    expect(page.eligibleParticipants).toEqual([]);
  });
});

describe('Storefront supply and offers states (docs/20 §9.2)', () => {
  test('weak supply stays an honest short list', () => {
    const page = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'coastal-tennis' }),
    )!;
    expect(page.programCount).toBe(1);
    expect(page.programGroups.flatMap((group) => group.programs)).toHaveLength(1);
  });

  test('falcon has no offer programs — the offers section collapses', () => {
    const page = service.buildProviderStorefrontPage(storefrontInput({ providerId: 'falcon' }))!;
    expect(page.offerPrograms).toEqual([]);
  });

  test('gravity surfaces its offer subset', () => {
    const page = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'gravity' }),
    )!;
    expect(page.offerPrograms.map((program) => program.id)).toEqual([
      'ladies-strength',
      'active-summer-camp',
    ]);
  });

  test('the missing-cover provider falls back to the monogram banner data', () => {
    expect(providerDetailExtras['coastal-tennis'].coverImageKey).toBeUndefined();
    const page = service.buildProviderStorefrontPage(
      storefrontInput({ providerId: 'coastal-tennis' }),
    )!;
    expect(page.monogram).toBe('CT');
  });
});

describe('Branches (docs/09 §20.6)', () => {
  test('blue-wave programs resolve their branch; others have none', () => {
    const swim = service.buildProgramDetailPage(input({ programId: 'junior-swim-squad' }));
    expect(swim?.branch?.label).toBe('Al Raha Beach');
    const gym = service.buildProgramDetailPage(input({ programId: 'beginner-calisthenics' }));
    expect(gym?.branch).toBeUndefined();
  });

  test('every extras branchId resolves to a real provider branch', () => {
    for (const program of programs) {
      const extras = programDetailExtras[program.id];
      if (extras.branchId === undefined) continue;
      const branches = providerBranches[program.providerId] ?? [];
      expect(branches.some((branch) => branch.id === extras.branchId)).toBe(true);
    }
  });

  test('branches never move a program outside its catalogue area', () => {
    for (const [providerId, branches] of Object.entries(providerBranches)) {
      const provider = providers.find((entry) => entry.id === providerId)!;
      for (const branch of branches) expect(branch.areaId).toBe(provider.areaId);
    }
  });
});
