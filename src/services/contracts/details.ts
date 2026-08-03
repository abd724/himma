import type { ProgramDetailExtras } from '@/data/mock/program-details';
import type {
  AreaId,
  CancellationPolicy,
  Participant,
  ParticipantId,
  Program,
  Provider,
  ProviderBranch,
  SessionOccurrence,
} from '@/types/domain';
import type { ParticipantSuitability } from '@/utils/eligibility';

/**
 * Detail-surface boundary — docs/20 §8.4. Joins are done in the service,
 * never in screens (docs/08 §8). Participants are resolved account data
 * passed in by the caller (docs/19 pattern) — the service never assumes a
 * fixed household.
 *
 * `getProviderStorefrontPage` joins this contract in the storefront commit
 * (docs/20 §13, Commit 10).
 */
export interface ProgramDetailInput {
  programId: string;
  /** The selected browsing participant (shared app context). */
  participantId: ParticipantId;
  /** Real household participants, primary first; empty for guest. */
  participants: Participant[];
  areaId: AreaId;
  /** QA/Playwright-only deterministic failure trigger — never customer-reachable. */
  simulateFailure?: boolean;
}

export interface ProgramDetailPage {
  program: Program;
  provider: Provider;
  extras: ProgramDetailExtras;
  /** "Ages 6–12" · "Ages 16+" · "All ages" — always present (docs/20 §3.6). */
  ageLabel: string;
  /** Commercial shape, e.g. "Drop-in", "Monthly program", "Camp". */
  formatLabel: string;
  /** One-line price, e.g. "AED 85 per session". */
  priceLabel: string;
  /** Informational upcoming occurrences — docs/09 §20.9. Empty = none listed. */
  sessions: SessionOccurrence[];
  /** Present only when the provider has explicit branches. */
  branch?: ProviderBranch;
  policy: CancellationPolicy;
  /** Selected participant's suitability; undefined for `everyone` and guests. */
  suitability?: ParticipantSuitability;
  /** Every real household participant, primary first (recovery chips). */
  householdSuitability: ParticipantSuitability[];
  areaLabel: string;
  /** Up to 4 other programs by the same provider (cross-links). */
  moreFromProvider: Program[];
}

export interface DetailsService {
  /** Undefined for unknown ids — the screen owns the recovery state (docs/16 §2). */
  getProgramDetailPage(input: ProgramDetailInput): Promise<ProgramDetailPage | undefined>;
}
