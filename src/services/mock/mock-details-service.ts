import { activityTypes, areas, categories, programs, providers } from '@/data/mock/catalogue';
import { cancellationPolicies } from '@/data/mock/policies';
import { programDetailExtras, type ProgramDetailExtras } from '@/data/mock/program-details';
import { providerBranches, providerDetailExtras } from '@/data/mock/provider-details';
import type {
  DetailsService,
  ProgramDetailInput,
  ProgramDetailPage,
  ProviderStorefrontInput,
  ProviderStorefrontPage,
  StorefrontProgramGroup,
} from '@/services/contracts/details';
import type { Participant, Program, ProviderBranch, SessionOccurrence } from '@/types/domain';
import {
  ageRangeLabel,
  householdSuitability,
  MOCK_TODAY,
  participantAge,
  participantSuitability,
  suitsAdult,
  suitsChild,
} from '@/utils/eligibility';
import { priceLabel, programFormatLabel } from '@/utils/price';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Two-week presentation window from MOCK_TODAY; long repeats stay scannable. */
const SESSION_WINDOW_DAYS = 14;
const SESSION_DISPLAY_CAP = 6;
const MORE_FROM_PROVIDER_CAP = 4;

/** MOCK_TODAY (2026-08-02) is a Sunday, so weekday = offset % 7 within August. */
export function dayLabelForOffset(offset: number): string {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  return `${WEEKDAYS[offset % 7]} ${MOCK_TODAY.day + offset} Aug`;
}

/**
 * Deterministic informational sessions derived from the catalogue schedule
 * fields — docs/20 §8.3, docs/09 §20.9. No randomness, no device clock;
 * extras may override with 'none' or an explicit list.
 */
export function buildUpcomingSessions(
  program: Program,
  extras: ProgramDetailExtras,
): SessionOccurrence[] {
  if (extras.sessions === 'none') return [];
  if (Array.isArray(extras.sessions)) return extras.sessions;

  if (program.isCamp) {
    // "10–14 August · 9 AM–1 PM" → one start entry; camps read as a block.
    const startDay = Number.parseInt(program.scheduleLabel, 10);
    const timeLabel = program.scheduleLabel.split('·')[1]?.trim() ?? '';
    if (Number.isNaN(startDay) || startDay < MOCK_TODAY.day) return [];
    const dayOffset = startDay - MOCK_TODAY.day;
    return [
      {
        id: `${program.id}-camp-${dayOffset}`,
        dayOffset,
        dayLabel: `Starts ${WEEKDAYS[dayOffset % 7]} ${startDay} Aug`,
        timeLabel,
      },
    ];
  }

  let dayNames: string[];
  let timeLabel: string;
  if (program.scheduleLabel.startsWith('Today')) {
    // "Today, 7:30 PM" — a recurring slot presented time-first; repeat weekly.
    dayNames = [WEEKDAYS[0]];
    timeLabel = program.todayTime ?? program.scheduleLabel.replace('Today, ', '');
  } else {
    const [daysPart, timePart] = program.scheduleLabel.split('·').map((part) => part.trim());
    dayNames =
      daysPart === 'Daily'
        ? [...WEEKDAYS]
        : WEEKDAYS.filter((weekday) => daysPart.includes(weekday));
    timeLabel = timePart === 'after school' ? 'After school' : (timePart ?? '');
  }
  if (dayNames.length === 0 || timeLabel === '') return [];

  const occurrences: SessionOccurrence[] = [];
  for (let offset = 0; offset < SESSION_WINDOW_DAYS; offset += 1) {
    if (!dayNames.includes(WEEKDAYS[offset % 7])) continue;
    occurrences.push({
      id: `${program.id}-${offset}`,
      dayOffset: offset,
      dayLabel: dayLabelForOffset(offset),
      timeLabel,
    });
  }
  const capped = occurrences.slice(0, SESSION_DISPLAY_CAP);
  if (capped.length > 0 && extras.spotsLeft !== undefined) {
    capped[0] = { ...capped[0], spotsLeft: extras.spotsLeft };
  }
  return capped;
}

/** Fictional provider monogram — never a real logo (docs/08 §11). */
export function providerMonogram(name: string): string {
  return name
    .split(' ')
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

/** Whether the selected participant can join a program — docs/05 §7. */
function programEligible(program: Program, participant: Participant | undefined): boolean {
  if (participant === undefined || participant.kind === 'everyone') return true;
  if (participant.kind === 'child') {
    return suitsChild(program.eligibility, participantAge(participant) ?? 0);
  }
  return suitsAdult(program.eligibility);
}

export class MockDetailsService implements DetailsService {
  constructor(private readonly delayMs: number = 300) {}

  async getProgramDetailPage(input: ProgramDetailInput): Promise<ProgramDetailPage | undefined> {
    await this.delay();
    if (input.simulateFailure) throw new Error('Simulated network failure (QA only)');
    return this.buildProgramDetailPage(input);
  }

  /** Pure and synchronous so behavior is directly testable. */
  buildProgramDetailPage(input: ProgramDetailInput): ProgramDetailPage | undefined {
    const program = programs.find((entry) => entry.id === input.programId);
    if (program === undefined) return undefined;
    const provider = providers.find((entry) => entry.id === program.providerId);
    const extras = programDetailExtras[program.id];
    if (provider === undefined || extras === undefined) return undefined;

    const selected = input.participants.find(
      (participant) => participant.id === input.participantId,
    );
    const branches = providerBranches[provider.id];
    const household = householdSuitability(program.eligibility, input.participants);
    const moreFromProvider = programs
      .filter((entry) => entry.providerId === provider.id && entry.id !== program.id)
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => b.entry.rating - a.entry.rating || a.index - b.index)
      .map(({ entry }) => entry)
      .slice(0, MORE_FROM_PROVIDER_CAP);

    return {
      program,
      provider,
      extras,
      ageLabel: ageRangeLabel(program.eligibility) ?? 'All ages',
      formatLabel: programFormatLabel(program),
      priceLabel: priceLabel(program.price),
      sessions: buildUpcomingSessions(program, extras),
      branch: branches?.find((branch) => branch.id === extras.branchId),
      policy: cancellationPolicies[extras.policyId],
      suitability:
        selected === undefined || selected.kind === 'everyone'
          ? undefined
          : participantSuitability(program.eligibility, selected),
      householdSuitability: household,
      areaLabel: areas.find((area) => area.id === program.areaId)?.label ?? '',
      moreFromProvider,
    };
  }

  async getProviderStorefrontPage(
    input: ProviderStorefrontInput,
  ): Promise<ProviderStorefrontPage | undefined> {
    await this.delay();
    if (input.simulateFailure) throw new Error('Simulated network failure (QA only)');
    return this.buildProviderStorefrontPage(input);
  }

  /** Pure and synchronous so behavior is directly testable. */
  buildProviderStorefrontPage(
    input: ProviderStorefrontInput,
  ): ProviderStorefrontPage | undefined {
    const provider = providers.find((entry) => entry.id === input.providerId);
    if (provider === undefined) return undefined;
    const extras = providerDetailExtras[provider.id];
    if (extras === undefined) return undefined;

    // Explicit branches, or the implicit primary at the provider's area.
    const branches: ProviderBranch[] = extras.branches ?? [
      {
        id: `${provider.id}-main`,
        label: areas.find((area) => area.id === provider.areaId)?.label ?? provider.name,
        areaId: provider.areaId,
        addressLine: extras.addressLine ?? '',
        openingHours: extras.openingHours,
      },
    ];
    const selectedBranch =
      branches.find((branch) => branch.id === input.branchId) ?? branches[0];

    const providerPrograms = programs.filter((entry) => entry.providerId === provider.id);
    // A program without a branch assignment runs at every branch.
    const branchPrograms =
      extras.branches === undefined
        ? providerPrograms
        : providerPrograms.filter((entry) => {
            const branchId = programDetailExtras[entry.id]?.branchId;
            return branchId === undefined || branchId === selectedBranch.id;
          });

    const selected = input.participants.find(
      (participant) => participant.id === input.participantId,
    );
    const childContext = selected?.kind === 'child';
    const eligiblePrograms = branchPrograms.filter((entry) => programEligible(entry, selected));
    // Child context separates ineligible programs into the collapsed group
    // (never hidden — docs/20 §4.7); adults see everything, suitable first.
    const groupablePrograms = childContext
      ? eligiblePrograms
      : selected?.kind === 'self'
        ? [...branchPrograms].sort(
            (a, b) =>
              Number(programEligible(b, selected)) - Number(programEligible(a, selected)),
          )
        : branchPrograms;
    const ineligiblePrograms = childContext
      ? branchPrograms.filter((entry) => !programEligible(entry, selected))
      : [];

    // Taxonomy joins come from the programs, never the free-text card
    // strings (docs/20 §7.3) — identity-level, not branch-filtered.
    const providerCategories = categories.filter((category) =>
      providerPrograms.some((entry) => entry.categoryId === category.id),
    );
    const providerActivityTypes = activityTypes.filter((activityType) =>
      providerPrograms.some((entry) => entry.activityTypeId === activityType.id),
    );

    const programGroups: StorefrontProgramGroup[] = providerCategories
      .map((category) => ({
        category,
        programs: groupablePrograms.filter((entry) => entry.categoryId === category.id),
      }))
      .filter((group) => group.programs.length > 0);

    return {
      provider,
      extras,
      monogram: providerMonogram(provider.name),
      categories: providerCategories,
      activityTypes: providerActivityTypes,
      branches,
      selectedBranch,
      policy: cancellationPolicies[extras.policyId],
      programGroups,
      ineligiblePrograms,
      offerPrograms: groupablePrograms.filter((entry) => entry.offer !== undefined),
      programCount: branchPrograms.length,
      eligibleProgramCount: eligiblePrograms.length,
      eligibleParticipants: input.participants
        .filter((participant) => participant.kind !== 'everyone')
        .filter((participant) =>
          branchPrograms.some((entry) => programEligible(entry, participant)),
        )
        .map((participant) => ({ participantId: participant.id, label: participant.label })),
      areaLabel: areas.find((area) => area.id === selectedBranch.areaId)?.label ?? '',
    };
  }

  private async delay(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }
}

export const detailsService: DetailsService = new MockDetailsService();
