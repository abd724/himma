import type { FilterSelection, SortId } from '@/services/contracts/filters';
import type { Area, AreaId, ParticipantId } from '@/types/domain';

/**
 * A fictional provider marker on an area node. Pins are illustrative only —
 * they carry no coordinates and imply no real-world position (docs/14 §7).
 */
export interface MapPin {
  providerId: string;
  /** Short label drawn in the pin, e.g. "FC". */
  initials: string;
  providerName: string;
}

export interface MapAreaSummary {
  area: Area;
  /**
   * Matching programs in this area under the current session, ignoring any
   * area selection. Undefined when a count could not be resolved — the map
   * states that honestly instead of guessing (docs/16 §2).
   */
  programCount?: number;
  providerCount?: number;
  pins: MapPin[];
}

export interface MapQuery {
  query: string;
  participantId: ParticipantId;
  /** Reference area for ranking — never a narrowing filter (docs/11 §6). */
  areaId: AreaId;
  filters: FilterSelection;
  sort: SortId;
  /** QA/Playwright-only deterministic failure trigger — never customer-reachable. */
  simulateFailure?: boolean;
  /** QA/Playwright-only trigger for the missing-count fallback state. */
  simulateMissingCounts?: boolean;
}

export interface MapView {
  /** Every area, in catalogue order — zero-supply areas are shown honestly. */
  areas: MapAreaSummary[];
  /** Total across areas; undefined when counts are unavailable. */
  totalPrograms?: number;
  /** False when no area has any matching activity (docs/16 §2). */
  hasAnyResults: boolean;
}

/**
 * Map boundary — docs/14 §7, docs/15 §5. The mock implementation derives
 * every number from the same search/filter engine the Results list uses, so
 * list and map can never disagree; it invents no distances and no geography.
 */
export interface MapService {
  getMapView(query: MapQuery): Promise<MapView>;
}
