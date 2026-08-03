import { describe, expect, test } from '@jest/globals';
import { programs, providers } from '@/data/mock/catalogue';
import { cancellationPolicies } from '@/data/mock/policies';
import { programDetailExtras } from '@/data/mock/program-details';
import { providerBranches } from '@/data/mock/provider-details';
import type { ProgramDetailInput } from '@/services/contracts/details';
import {
  buildUpcomingSessions,
  MockDetailsService,
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
      expect(page?.policy).toBe(cancellationPolicies[page!.extras.policyId]);
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
