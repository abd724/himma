import { CompactProgramRow } from '@/components/domain/compact-program-row';
import { CompactProviderRow } from '@/components/domain/compact-provider-row';
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { FilterSheet } from '@/components/domain/filter-sheet';
import { LocationSheet } from '@/components/domain/location-sheet';
import { ParticipantChips } from '@/components/domain/participant-chips';
import { SortSheet } from '@/components/domain/sort-sheet';
import { Chip } from '@/components/ui/chip';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SectionHeader } from '@/components/ui/section-header';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { providers as allProviders } from '@/data/mock/catalogue';
import { CataloguePageHeader } from '@/features/catalogue/catalogue-page-header';
import { useDetailNavigation } from '@/features/details/detail-navigation';
import type { CategoryPage } from '@/services/contracts/catalogue';
import {
  activeFilterCount,
  emptyFilters,
  type FilterSelection,
  type SortId,
} from '@/services/contracts/filters';
import { catalogueService } from '@/services/mock/mock-catalogue-service';
import { providerProgramCount } from '@/services/mock/results-engine';
import { searchService } from '@/services/mock/mock-search-service';
import { useAreaContext } from '@/state/area-context';
import { useFavourites } from '@/state/favourites-context';
import { useParticipantContext } from '@/state/participant-context';
import { useResultsSession } from '@/state/results-session-context';
import { colors, dockTokens, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import type { CategoryId } from '@/types/domain';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const providerNameById = new Map(allProviders.map((provider) => [provider.id, provider.name]));

/**
 * HMA-012 — one category of the shared taxonomy: featured activity types,
 * popular programs, providers, and offers, with the Filter/Sort/Map toolbar
 * feeding the shared results session (docs/17 §11.2). The page always opens;
 * weak supply is stated honestly (docs/16 §2).
 */
export function CategoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ categoryId?: string }>();
  const categoryId = (typeof params.categoryId === 'string' ? params.categoryId : '') as CategoryId;

  const session = useResultsSession();
  const { participants, participantId, setParticipantId } = useParticipantContext();
  const { areas, areaId, setAreaId, areaLabelById } = useAreaContext();
  const { isFavourite, toggleFavourite } = useFavourites();
  const { openProgram, openProvider } = useDetailNavigation();

  const [page, setPage] = useState<CategoryPage | null>(null);
  const [missing, setMissing] = useState(false);
  const [locationSheetOpen, setLocationSheetOpen] = useState(false);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  // The sheet edits a local draft seeded to this category; applying opens a
  // new Results session, cancelling leaves the page untouched (Discover rule).
  const [draftFilters, setDraftFilters] = useState<FilterSelection>(emptyFilters);

  // Previous content stays visible while a context change reloads (Home rule).
  useEffect(() => {
    let cancelled = false;
    catalogueService.getCategoryPage({ categoryId, areaId, participantId }).then((result) => {
      if (!cancelled) {
        setPage(result ?? null);
        setMissing(result === undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [categoryId, areaId, participantId]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/discover');
  };

  /** Toolbar actions land in the shared results session (docs/17 §11.2). */
  const openPresetResults = (filters: FilterSelection, sort: SortId = 'recommended') => {
    session.newSearch('', 'programs');
    session.setFilters(filters);
    if (sort !== 'recommended') session.setSort(sort);
    router.push('/discover/results');
  };

  const categoryPreset: FilterSelection = useMemo(
    () => ({ ...emptyFilters, categoryId }),
    [categoryId],
  );

  /** The map opens on this category's session, so List returns to it. */
  const openMap = () => {
    session.newSearch('', 'programs');
    session.setFilters(categoryPreset);
    router.push('/map?origin=category');
  };

  const openFilterSheet = () => {
    setDraftFilters(categoryPreset);
    setFilterSheetOpen(true);
  };

  const draftCount = useMemo(
    () =>
      filterSheetOpen
        ? searchService.countResults({ query: '', participantId, areaId, filters: draftFilters })
        : 0,
    [filterSheetOpen, participantId, areaId, draftFilters],
  );

  const participantLabel =
    participants.find((participant) => participant.id === participantId)?.label ?? 'Everyone';
  const areaLabel = areaLabelById.get(areaId) ?? '';

  const contentBottomPadding =
    dockTokens.height + dockTokens.safeAreaOffset + insets.bottom + dockTokens.contentClearance;

  if (missing) {
    return (
      <View style={styles.root}>
        <SafeAreaView edges={['top']} style={styles.safeArea}>
          <CataloguePageHeader title="Category" onBack={goBack} />
          <EmptyFeedCard
            title="We can’t find that category"
            message="Browse the full catalogue instead."
            actionLabel="Browse all categories"
            onClearFilter={() => router.replace('/discover/categories')}
          />
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <CataloguePageHeader title={page?.category.label ?? ' '} onBack={goBack} />
        <ScrollView
          style={styles.safeArea}
          contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
          showsVerticalScrollIndicator={false}
        >
          {page === null ? (
            <CataloguePageSkeleton />
          ) : (
            <>
              {page.activityTypes.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipRow}
                >
                  {page.activityTypes.map(({ activityType, programCount }) => (
                    <Chip
                      key={activityType.id}
                      label={activityType.label}
                      selected={false}
                      accessibilityHint={`Opens ${activityType.label}, ${programCount} ${
                        programCount === 1 ? 'activity' : 'activities'
                      }`}
                      onPress={() => router.push(`/discover/activity/${activityType.id}`)}
                    />
                  ))}
                </ScrollView>
              ) : null}

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
              >
                <Chip
                  label="Filters"
                  icon="options-outline"
                  selected={filterSheetOpen}
                  badgeCount={activeFilterCount(categoryPreset)}
                  onPress={openFilterSheet}
                  accessibilityHint="Opens all filters for this category"
                />
                <Chip
                  label="Sort"
                  icon="swap-vertical-outline"
                  selected={sortSheetOpen}
                  onPress={() => setSortSheetOpen(true)}
                  accessibilityHint="Opens sort options"
                />
                <Chip
                  label="Map"
                  icon="map-outline"
                  selected={false}
                  onPress={() => openMap()}
                  accessibilityHint="Shows this category on the map"
                />
              </ScrollView>

              <ParticipantChips
                participants={participants}
                selectedId={participantId}
                onSelect={setParticipantId}
              />

              {page.visibleProgramCount === 0 ? (
                <EmptyFeedCard
                  message={
                    participantId !== 'everyone' && participantId !== 'me'
                      ? `No ${page.category.label} activities for ${participantLabel}’s age right now. Try Everyone or Me.`
                      : `No ${page.category.label} activities right now. Try nearby areas.`
                  }
                  actionLabel={
                    participantId !== 'everyone' && participantId !== 'me'
                      ? 'Browse as Everyone'
                      : 'Change area'
                  }
                  onClearFilter={() => {
                    if (participantId !== 'everyone' && participantId !== 'me') {
                      setParticipantId('everyone');
                    } else {
                      setLocationSheetOpen(true);
                    }
                  }}
                />
              ) : (
                <>
                  {page.visibleProgramCount <= 2 ? (
                    <View style={styles.supplyNote}>
                      <Text style={styles.supplyText} accessibilityLiveRegion="polite">
                        Only {page.visibleProgramCount}{' '}
                        {page.visibleProgramCount === 1 ? 'activity' : 'activities'} near {areaLabel}{' '}
                        right now. Try nearby areas.
                      </Text>
                      <PressableFeedback
                        accessibilityLabel="Change area"
                        onPress={() => setLocationSheetOpen(true)}
                        hitSlop={14}
                      >
                        <Text style={styles.supplyAction}>Change area</Text>
                      </PressableFeedback>
                    </View>
                  ) : null}

                  <View>
                    <SectionHeader
                      title="Popular programs"
                      actionLabel={`View all ${page.visibleProgramCount}`}
                      onActionPress={() => openPresetResults(categoryPreset)}
                    />
                    <View style={styles.list}>
                      {page.popularPrograms.map((program) => (
                        <CompactProgramRow
                          key={program.id}
                          program={program}
                          providerName={providerNameById.get(program.providerId) ?? ''}
                          areaLabel={areaLabelById.get(program.areaId) ?? ''}
                          isFavourite={isFavourite('program', program.id)}
                          onToggleFavourite={(id) => toggleFavourite('program', id)}
                          onPress={() => openProgram(program.id)}
                        />
                      ))}
                    </View>
                  </View>

                  {page.providers.length > 0 ? (
                    <View>
                      <SectionHeader title="Providers" />
                      <View style={styles.list}>
                        {page.providers.map((provider) => (
                          <CompactProviderRow
                            key={provider.id}
                            provider={provider}
                            areaLabel={areaLabelById.get(provider.areaId) ?? ''}
                            programCount={providerProgramCount(provider.id)}
                            onPress={() => openProvider(provider.id)}
                          />
                        ))}
                      </View>
                    </View>
                  ) : null}

                  {page.offerPrograms.length > 0 ? (
                    <View>
                      <SectionHeader title="Offers & trials" />
                      <View style={styles.list}>
                        {page.offerPrograms.map((program) => (
                          <CompactProgramRow
                            key={program.id}
                            program={program}
                            providerName={providerNameById.get(program.providerId) ?? ''}
                            areaLabel={areaLabelById.get(program.areaId) ?? ''}
                            isFavourite={isFavourite('program', program.id)}
                            onToggleFavourite={(id) => toggleFavourite('program', id)}
                            onPress={() => openProgram(program.id)}
                          />
                        ))}
                      </View>
                    </View>
                  ) : null}
                </>
              )}
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
        onClearAll={() => setDraftFilters(emptyFilters)}
        onClose={() => setFilterSheetOpen(false)}
        onApply={() => {
          setFilterSheetOpen(false);
          openPresetResults(draftFilters);
        }}
      />
      <SortSheet
        visible={sortSheetOpen}
        selected="recommended"
        onSelect={(sort) => openPresetResults(categoryPreset, sort)}
        onClose={() => setSortSheetOpen(false)}
      />
    </View>
  );
}

export function CataloguePageSkeleton() {
  return (
    <View style={styles.skeletons}>
      <SkeletonBlock style={styles.skeletonChips} />
      <SkeletonBlock style={styles.skeletonCard} />
      <SkeletonBlock style={styles.skeletonCard} />
      <SkeletonBlock style={styles.skeletonCard} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  safeArea: { flex: 1 },
  content: {
    gap: spacing.xl,
    paddingTop: spacing.xs,
  },
  chipRow: {
    paddingHorizontal: pagePadding,
    gap: spacing.sm,
    alignItems: 'center',
  },
  supplyNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: pagePadding,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  supplyText: {
    flex: 1,
    ...typography.supporting,
    color: colors.text.primary,
  },
  supplyAction: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  list: {
    paddingHorizontal: pagePadding,
    gap: spacing.md,
  },
  skeletons: {
    paddingHorizontal: pagePadding,
    gap: spacing.lg,
  },
  skeletonChips: { height: 44, borderRadius: radii.chip },
  skeletonCard: { height: 128, borderRadius: radii.card },
});
