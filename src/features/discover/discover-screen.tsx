import { CategoryGrid } from '@/components/domain/category-grid';
import { CollectionCard } from '@/components/domain/collection-card';
import { DiscoverHeader } from '@/components/domain/discover-header';
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { FilterSheet } from '@/components/domain/filter-sheet';
import { LocationSheet } from '@/components/domain/location-sheet';
import { MapEntryCard } from '@/components/domain/map-entry-card';
import { ParticipantChips } from '@/components/domain/participant-chips';
import { ProgramCard } from '@/components/domain/program-card';
import { ProviderCard } from '@/components/domain/provider-card';
import { QuickFilterRow } from '@/components/domain/quick-filter-row';
import { SearchEntryButton } from '@/components/domain/search-entry-button';
import { SectionHeader } from '@/components/ui/section-header';
import { collections, providers } from '@/data/mock/catalogue';
import { DiscoverSkeleton } from '@/features/discover/discover-skeleton';
import { needsBroadSession } from '@/features/map/map-navigation';
import type { DiscoverFeed } from '@/services/contracts/discover-feed';
import {
  activeFilterCount,
  collectionFilterSelection,
  quickFilterSelection,
  type FilterSelection,
} from '@/services/contracts/filters';
import type { QuickFilterId } from '@/services/contracts/home-feed';
import { discoverFeedService } from '@/services/mock/mock-discover-feed-service';
import { searchService } from '@/services/mock/mock-search-service';
import { useAreaContext } from '@/state/area-context';
import { useFavourites } from '@/state/favourites-context';
import { useParticipantContext } from '@/state/participant-context';
import { useResultsSession } from '@/state/results-session-context';
import { colors, dockTokens, pagePadding, spacing } from '@/theme';
import type { BrowseEntry } from '@/types/domain';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const providerNameById = new Map(providers.map((provider) => [provider.id, provider.name]));
const collectionById = new Map(collections.map((collection) => [collection.id, collection]));

/**
 * HMA-005 — the visual marketplace catalogue (docs/14 §2). Quick chips
 * re-filter the feed in place with Home's exact semantics and stay
 * independent of the Results session; presets (collections, filter-sheet
 * apply) open a new Results session instead (docs/16 §3.8).
 */
export function DiscoverScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ 'qa-fail'?: string }>();

  const quickFilters = discoverFeedService.getQuickFilters();
  const { participants, participantId, setParticipantId } = useParticipantContext();
  const { areas, areaId, setAreaId, areaLabelById } = useAreaContext();
  const { favourites, toggleFavourite } = useFavourites();
  const session = useResultsSession();

  const [quickFilterId, setQuickFilterId] = useState<QuickFilterId | undefined>(undefined);
  const [feed, setFeed] = useState<DiscoverFeed | null>(null);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  const [locationSheetOpen, setLocationSheetOpen] = useState(false);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  // The sheet edits a local draft: applying opens a new Results session,
  // cancelling (backdrop/back) leaves Discover untouched (commit-5 merge rule).
  const [draftFilters, setDraftFilters] = useState<FilterSelection>(quickFilterSelection(undefined));

  const simulateFailure = params['qa-fail'] === '1' && !retried;

  // Previous content stays visible while a context change reloads (Home rule).
  useEffect(() => {
    let cancelled = false;
    discoverFeedService.getDiscoverFeed({ areaId, participantId, quickFilterId, simulateFailure }).then(
      (result) => {
        if (!cancelled) {
          setFeed(result);
          setFailed(false);
        }
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [areaId, participantId, quickFilterId, simulateFailure]);

  const toggleFilter = (id: QuickFilterId) => {
    setQuickFilterId((current) => (current === id ? undefined : id));
  };

  /** Every preset opens a fresh Results session on the Programs list. */
  const openPresetResults = (filters: FilterSelection) => {
    session.newSearch('', 'programs');
    session.setFilters(filters);
    router.push('/discover/results');
  };

  const openCollection = (collectionId: string) => {
    const collection = collectionById.get(collectionId);
    if (collection !== undefined) openPresetResults(collectionFilterSelection(collection));
  };

  /**
   * The map is a view of the active results session. Browsing Discover with
   * no session yet creates a deterministic broad one; an existing session
   * (a search or a preset) carries over untouched (docs/17 §12).
   */
  const openMap = () => {
    if (needsBroadSession('discover', session.started)) session.newSearch('', 'programs');
    router.push('/map?origin=discover');
  };

  /** Tile activations — docs/15 §4.2: every target now resolves. */
  const onPressBrowseEntry = (entry: BrowseEntry) => {
    if (entry.target.kind === 'category') {
      router.push(`/discover/category/${entry.target.categoryId}`);
      return;
    }
    if (entry.target.kind === 'activityType') {
      router.push(`/discover/activity/${entry.target.activityTypeId}`);
      return;
    }
    openCollection(entry.target.collectionId);
  };

  const openFilterSheet = () => {
    setDraftFilters(quickFilterSelection(quickFilterId));
    setFilterSheetOpen(true);
  };

  const applyFilterSheet = () => {
    setFilterSheetOpen(false);
    openPresetResults(draftFilters);
  };

  const draftCount = useMemo(
    () => searchService.countResults({ query: '', participantId, areaId, filters: draftFilters }),
    [participantId, areaId, draftFilters],
  );

  const participantLabel =
    participants.find((participant) => participant.id === participantId)?.label ?? 'Everyone';
  const emptyMessage =
    quickFilterId === 'ladies-only' && !['me', 'everyone'].includes(participantId)
      ? `No ladies-only activities for ${participantLabel}. Try Everyone or Me.`
      : 'Nothing matches this combination right now. Try clearing the filter.';

  const contentBottomPadding =
    dockTokens.height + dockTokens.safeAreaOffset + insets.bottom + dockTokens.contentClearance;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <DiscoverHeader
          areaLabel={areaLabelById.get(areaId) ?? ''}
          onPressLocation={() => setLocationSheetOpen(true)}
        />
        <ScrollView
          style={styles.safeArea}
          contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
          showsVerticalScrollIndicator={false}
        >
          <SearchEntryButton onPress={() => router.push('/search')} />
          <ParticipantChips
            participants={participants}
            selectedId={participantId}
            onSelect={setParticipantId}
          />
          <QuickFilterRow
            filters={quickFilters}
            activeId={quickFilterId}
            onToggle={toggleFilter}
            onPressFilters={openFilterSheet}
            filtersActiveCount={activeFilterCount(quickFilterSelection(quickFilterId))}
          />

          {failed ? (
            <ErrorStateCard onRetry={() => setRetried(true)} />
          ) : feed === null ? (
            <DiscoverSkeleton />
          ) : (
            <>
              <View>
                <SectionHeader
                  title="Browse categories"
                  actionLabel="View all"
                  onActionPress={() => router.push('/discover/categories')}
                />
                <CategoryGrid categories={feed.browseEntries} onPressEntry={onPressBrowseEntry} />
              </View>

              {feed.collections.length > 0 ? (
                <View>
                  <SectionHeader title="Collections" />
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.carousel}
                  >
                    {feed.collections.map(({ collection, programCount }) => (
                      <CollectionCard
                        key={collection.id}
                        collection={collection}
                        programCount={programCount}
                        onPress={() => openCollection(collection.id)}
                      />
                    ))}
                  </ScrollView>
                </View>
              ) : null}

              {feed.isEmpty ? (
                <EmptyFeedCard
                  message={emptyMessage}
                  onClearFilter={() => setQuickFilterId(undefined)}
                />
              ) : (
                feed.programSections.map((section) => (
                  <View key={section.id}>
                    <SectionHeader title={section.title} />
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.carousel}
                    >
                      {section.programs.map((program) => (
                        <ProgramCard
                          key={program.id}
                          program={program}
                          providerName={providerNameById.get(program.providerId) ?? ''}
                          areaLabel={areaLabelById.get(program.areaId) ?? ''}
                          scheduleOverride={section.scheduleOverrides?.[program.id]}
                          showAgeRange
                          isFavourite={favourites.has(program.id)}
                          onToggleFavourite={toggleFavourite}
                        />
                      ))}
                    </ScrollView>
                  </View>
                ))
              )}

              {feed.providers.length > 0 ? (
                <View>
                  <SectionHeader title="Popular providers" />
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.carousel}
                  >
                    {feed.providers.map((provider) => (
                      <ProviderCard
                        key={provider.id}
                        provider={provider}
                        areaLabel={areaLabelById.get(provider.areaId) ?? ''}
                      />
                    ))}
                  </ScrollView>
                </View>
              ) : null}

              <MapEntryCard onPress={openMap} />
            </>
          )}
        </ScrollView>
      </SafeAreaView>

      <LocationSheet
        visible={locationSheetOpen}
        areas={areas}
        selectedId={areaId}
        onSelect={setAreaId}
        onClose={() => setLocationSheetOpen(false)}
      />
      <FilterSheet
        visible={filterSheetOpen}
        filters={draftFilters}
        resultCount={draftCount}
        onChange={setDraftFilters}
        onClearAll={() => setDraftFilters(quickFilterSelection(undefined))}
        onClose={() => setFilterSheetOpen(false)}
        onApply={applyFilterSheet}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  safeArea: { flex: 1 },
  content: {
    gap: spacing.xxl,
    paddingTop: spacing.xs,
  },
  carousel: {
    paddingHorizontal: pagePadding,
    gap: spacing.lg,
  },
});
