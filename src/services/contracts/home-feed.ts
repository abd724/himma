import type {
  AccountSnapshot,
  ActivePlan,
  ResolvedAccount,
  ScheduleEntry,
} from '@/services/contracts/schedule';
import type { FilterSelection } from '@/services/contracts/filters';
import type { Area, AreaId, CreditSummary, Participant, Program } from '@/types/domain';

export interface HeroContent {
  eyebrow: string;
  title: string;
  subtitle: string;
  actionLabel: string;
  imageKey: string;
  /** Preset the hero action opens as a fresh Results session — data-driven,
   *  never hard-coded in the screen. */
  actionFilters?: FilterSelection;
}

export interface WeekDay {
  dayOffset: number;
  dayLabel: string;
  entries: ScheduleEntry[];
}

/**
 * Home's typed, ordered section list — docs/18 §4, docs/19 §3. The screen
 * renders this with a kind-switch and adds nothing of its own. The union
 * stays extensible; only 'setup' (guest) is emitted as an action this
 * milestone — never an add-child prompt (docs/09 §19.6).
 */
export type HomeSection =
  | { kind: 'welcome'; content: HeroContent }
  | { kind: 'upcoming'; entry: ScheduleEntry }
  | { kind: 'week'; days: WeekDay[] }
  | { kind: 'plans'; plans: ActivePlan[] }
  | { kind: 'programs'; id: string; title: string; programs: Program[] }
  | { kind: 'action'; id: 'setup'; title: string; body: string }
  | { kind: 'credit'; credit: CreditSummary };

/**
 * The real feed domain input: resolved account data only — never scenario
 * ids (docs/19 §3). Every behavioral difference derives from this data:
 * null account = guest, empty scheduleEntries = no history, and so on.
 */
export interface HomeFeedBuildInput {
  areaId: AreaId;
  /** null = guest (no account). */
  account: AccountSnapshot | null;
  /** Primary participant first, then additional profiles. Empty for guest. */
  participants: Participant[];
  scheduleEntries: ScheduleEntry[];
  activePlans: ActivePlan[];
  credit?: CreditSummary;
}

/** Pass-through composition from resolved account data — used by the screen. */
export function toHomeFeedBuildInput(resolved: ResolvedAccount, areaId: AreaId): HomeFeedBuildInput {
  return {
    areaId,
    account: resolved.account,
    participants: resolved.participants,
    scheduleEntries: resolved.scheduleEntries,
    activePlans: resolved.activePlans,
    credit: resolved.credit,
  };
}

export interface HomeFeed {
  sections: HomeSection[];
}

/**
 * Home feed boundary — docs/08 §8. The mock implementation is deterministic;
 * a real API client replaces it later without touching screens.
 */
export interface HomeFeedService {
  getHomeFeed(input: HomeFeedBuildInput): Promise<HomeFeed>;
  getAreas(): Promise<Area[]>;
}
