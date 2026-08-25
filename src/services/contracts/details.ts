import type {
  ActivityType,
  AreaId,
  CancellationPolicy,
  Category,
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
 */
/**
 * Detail extras — enrichment content beyond the core listing. Every field
 * without a real backend authority is OPTIONAL and simply absent in real
 * composition (review counts, instructor bios, packing lists are mock demo
 * content until their domains exist); surfaces hide absent sections.
 */
export interface ProgramDetailExtras {
  description: string;
  /** Reviews are a deferred domain — absent in real composition. */
  reviewCount?: number;
  included?: string[];
  bring?: string[];
  instructorName?: string;
  instructorTitle?: string;
  safetyNote?: string;
  /** Facilities at the hosting venue relevant to this program. */
  facilities?: string[];
}

export interface ProviderDetailExtras {
  description: string;
  /** Reviews are a deferred domain — absent in real composition. */
  reviewCount?: number;
  /** Reuses existing demo image keys; absent = monogram banner (the design). */
  coverImageKey?: string;
  facilities?: string[];
  team?: { name: string; title: string }[];
}

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
  /** Absent until the real policy snapshot arrives with the RI-3 quote —
   *  no public policy authority exists; the section hides. */
  policy?: CancellationPolicy;
  /** Selected participant's suitability; undefined for `everyone` and guests. */
  suitability?: ParticipantSuitability;
  /** Every real household participant, primary first (recovery chips). */
  householdSuitability: ParticipantSuitability[];
  areaLabel: string;
  /** Up to 4 other programs by the same provider (cross-links). */
  moreFromProvider: Program[];
}

export interface ProviderStorefrontInput {
  providerId: string;
  /** The selected browsing participant (shared app context). */
  participantId: ParticipantId;
  /** Real household participants, primary first; empty for guest. */
  participants: Participant[];
  areaId: AreaId;
  /** Selected branch for multi-branch providers; defaults to the first. */
  branchId?: string;
  /** QA/Playwright-only deterministic failure trigger — never customer-reachable. */
  simulateFailure?: boolean;
}

/** Programs grouped under a category header — docs/20 §4.7. */
export interface StorefrontProgramGroup {
  category: Category;
  programs: Program[];
}

export interface ProviderStorefrontPage {
  provider: Provider;
  extras: ProviderDetailExtras;
  /** Fictional monogram derived from the name — never a real logo (docs/08 §11). */
  monogram: string;
  /** Taxonomy-joined via the provider's programs — never the free-text strings (docs/20 §7.3). */
  categories: Category[];
  activityTypes: ActivityType[];
  /** ≥ 1: explicit branches, or the implicit primary at the provider's area. */
  branches: ProviderBranch[];
  selectedBranch: ProviderBranch;
  /** Absent until the real policy snapshot arrives with the RI-3 quote. */
  policy?: CancellationPolicy;
  /**
   * Branch-filtered programs the selected participant can join, grouped by
   * category in taxonomy order. Child context: eligible only; adult context:
   * adult-suitable ranked first, nothing hidden (docs/20 §4.7, docs/05 §7).
   */
  programGroups: StorefrontProgramGroup[];
  /** Child context only — shown collapsed with the age reason, never hidden. */
  ineligiblePrograms: Program[];
  /** Offer/trial subset of the visible programs. */
  offerPrograms: Program[];
  /** Programs at the selected branch. */
  programCount: number;
  eligibleProgramCount: number;
  /** Real household participants with ≥ 1 eligible program here (recovery chips). */
  eligibleParticipants: { participantId: ParticipantId; label: string }[];
  /** The selected branch's area label. */
  areaLabel: string;
}

export interface DetailsService {
  /** Undefined for unknown ids — the screen owns the recovery state (docs/16 §2). */
  getProgramDetailPage(input: ProgramDetailInput): Promise<ProgramDetailPage | undefined>;
  getProviderStorefrontPage(
    input: ProviderStorefrontInput,
  ): Promise<ProviderStorefrontPage | undefined>;
}
