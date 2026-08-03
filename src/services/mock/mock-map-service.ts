import { areas } from '@/data/mock/catalogue';
import type {
  MapAreaSummary,
  MapPin,
  MapQuery,
  MapService,
  MapView,
} from '@/services/contracts/map';
import { MockSearchService, mockSearchEngine } from '@/services/mock/mock-search-service';
import type { Provider } from '@/types/domain';

const PINS_PER_AREA = 3;

/** "Falcon Combat Academy" → "FC". Deterministic, never a real logo. */
function initialsOf(provider: Provider): string {
  return provider.name
    .split(' ')
    .filter((word) => /^[A-Za-z]/.test(word))
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

/**
 * Schematic map data — every count comes from the same engine that builds the
 * Results list, with the area filter lifted so each node reports its own
 * supply under the rest of the session (docs/16 §3.1: one source of truth).
 */
export class MockMapService implements MapService {
  constructor(
    private readonly search: MockSearchService = mockSearchEngine,
    private readonly delayMs: number = 300,
  ) {}

  async getMapView(query: MapQuery): Promise<MapView> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.buildMapView(query);
  }

  /** Pure and synchronous so behavior is directly testable. */
  buildMapView(query: MapQuery): MapView {
    if (query.simulateFailure === true) {
      throw new Error('Simulated network failure (QA only)');
    }

    const summaries: MapAreaSummary[] = areas.map((area) => {
      if (query.simulateMissingCounts === true) {
        return { area, programCount: undefined, providerCount: undefined, pins: [] };
      }
      // Each node answers "what is here", so the session's own area selection
      // is lifted; selecting a node writes it back as the shared area filter.
      const page = this.search.buildResults({
        query: query.query,
        participantId: query.participantId,
        areaId: query.areaId,
        filters: { ...query.filters, areaId: area.id },
        sort: query.sort,
        page: 1,
      });
      const pins: MapPin[] = page.providers.slice(0, PINS_PER_AREA).map((provider) => ({
        providerId: provider.id,
        initials: initialsOf(provider),
        providerName: provider.name,
      }));
      return {
        area,
        programCount: page.totalPrograms,
        providerCount: page.totalProviders,
        pins,
      };
    });

    const counted = summaries.filter((summary) => summary.programCount !== undefined);
    const totalPrograms =
      counted.length === summaries.length
        ? counted.reduce((total, summary) => total + (summary.programCount ?? 0), 0)
        : undefined;

    return {
      areas: summaries,
      totalPrograms,
      hasAnyResults: counted.some((summary) => (summary.programCount ?? 0) > 0),
    };
  }
}

export const mapService: MapService = new MockMapService();
