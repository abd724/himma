import { CategoryResultRow } from '@/components/domain/category-result-row';
import { CompactProgramRow } from '@/components/domain/compact-program-row';
import { CompactProviderRow } from '@/components/domain/compact-provider-row';
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { FilterSheet } from '@/components/domain/filter-sheet';
import { ParticipantChips } from '@/components/domain/participant-chips';
import { SortSheet } from '@/components/domain/sort-sheet';
import { Chip } from '@/components/ui/chip';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { areas, categories as allCategories, programs as catalogue, providers } from '@/data/mock/catalogue';
import { useDetailNavigation } from '@/features/details/detail-navigation';
import { sortOptions, type FilterSelection } from '@/services/contracts/filters';
import type { ResultsPage } from '@/services/contracts/search';
import { searchService } from '@/services/mock/mock-search-service';
import { providerProgramCount } from '@/services/mock/results-engine';
import { useAreaContext } from '@/state/area-context';
import { useFavourites } from '@/state/favourites-context';
import { useParticipantContext } from '@/state/participant-context';
import { useResultsSession, type ResultsTab } from '@/state/results-session-context';
import { colors, dockTokens, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const tabs: { id: ResultsTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'programs', label: 'Programs' },
  { id: 'providers', label: 'Providers' },
  { id: 'categories', label: 'Categories' },
];

const providerNameById = new Map(providers.map((provider) => [provider.id, provider.name]));
const categoryCountById = new Map(
  allCategories.map((category) => [
    category.id,
    catalogue.filter((program) => program.categoryId === category.id).length,
  ]),
);

/** HMA-010 — the complete Results experience (docs/14 §3.2, docs/17 §10). */
export function ResultsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ q?: string; tab?: string; 'qa-fail'?: string }>();

  const session = useResultsSession();
  const { participants, participantId, setParticipantId } = useParticipantContext();
  const { areaId, areaLabelById } = useAreaContext();
  const { isFavourite, toggleFavourite } = useFavourites();
  const isProgramFavourite = (id: string) => isFavourite('program', id);
  const toggleProgramFavourite = (id: string) => toggleFavourite('program', id);

  const [page, setPage] = useState<ResultsPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);

  const routeQuery = typeof params.q === 'string' ? params.q : '';
  const simulateFailure = params['qa-fail'] === '1' && !retried;

  // Search submission resets the session in its event handler; this fallback
  // covers only cold deep links that open Results without a session. Syncing
  // route params (an external system) into state is the effect's job here.
  useEffect(() => {
    if (routeQuery !== session.query) {
      const initialTab = tabs.some((tab) => tab.id === params.tab) ? (params.tab as ResultsTab) : 'all';
      session.newSearch(routeQuery, initialTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeQuery]);

  useEffect(() => {
    let cancelled = false;
    searchService
      .getResults({
        query: session.query,
        participantId,
        areaId,
        filters: session.filters,
        sort: session.sort,
        page: session.page,
        simulateFailure,
      })
      .then(
        (result) => {
          if (!cancelled) {
            setPage(result);
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
  }, [session.query, session.filters, session.sort, session.page, participantId, areaId, simulateFailure]);

  const resultCountForSheet = useMemo(() => {
    try {
      return searchService.countResults({
        query: session.query,
        participantId,
        areaId,
        filters: session.filters,
      });
    } catch {
      return 0;
    }
  }, [session.query, session.filters, participantId, areaId]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/discover');
  };

  /** Category results enter the taxonomy — docs/15 §4.2. */
  const openCategory = (categoryId: string) => {
    router.push(`/discover/category/${categoryId}`);
  };

  const participantLabel =
    participants.find((participant) => participant.id === participantId)?.label ?? 'Everyone';

  const activeChips = buildActiveChips(session.filters, areaLabelById);

  const emptyMessage =
    session.filters.ladiesOnly && !['me', 'everyone'].includes(participantId)
      ? `No ladies-only activities for ${participantLabel}. Try Everyone or Me.`
      : session.activeCount > 0
        ? 'Nothing matches this combination right now. Try clearing the filters.'
        : `No results for “${session.query}”. Try a different search.`;

  const contentBottomPadding =
    dockTokens.height + dockTokens.safeAreaOffset + insets.bottom + dockTokens.contentClearance;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.header}>
          <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
          <PressableFeedback
            accessibilityLabel={`Search, current query ${session.query}`}
            accessibilityHint="Opens search"
            onPress={() =>
              router.push({ pathname: '/search', params: { q: session.query, origin: 'results' } })
            }
            style={styles.queryPill}
          >
            <Ionicons name="search-outline" size={16} color={colors.text.secondary} />
            <Text style={styles.queryText} numberOfLines={1}>
              {session.query || 'Search'}
            </Text>
          </PressableFeedback>
        </View>

        <ScrollView
          style={styles.safeArea}
          contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
          showsVerticalScrollIndicator={false}
          stickyHeaderIndices={[]}
        >
          <ParticipantChips
            participants={participants}
            selectedId={participantId}
            onSelect={setParticipantId}
          />

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolbar}>
            <Chip
              label="Filters"
              icon="options-outline"
              selected={filterSheetOpen}
              badgeCount={session.activeCount}
              onPress={() => setFilterSheetOpen(true)}
              accessibilityHint="Opens all filters"
            />
            <Chip
              label={sortOptions.find((option) => option.id === session.sort)?.label ?? 'Sort'}
              accessibilityLabel={`Sort by, ${sortOptions.find((option) => option.id === session.sort)?.label ?? 'Sort'}`}
              icon="swap-vertical-outline"
              selected={session.sort !== 'recommended'}
              onPress={() => setSortSheetOpen(true)}
              accessibilityHint="Opens sort options"
            />
            {/* Map toggle belongs to the program and provider lists (docs/14 §3.2);
                it carries this exact session, so no state is rebuilt. */}
            {session.tab === 'programs' || session.tab === 'providers' ? (
              <Chip
                label="Map"
                icon="map-outline"
                selected={false}
                onPress={() => router.push('/map?origin=results')}
                accessibilityHint="Shows these results on the map"
              />
            ) : null}
            <View style={styles.toolbarDivider} />
            <Chip
              label="Today"
              selected={session.filters.when === 'today'}
              accessibilityRole="checkbox"
              onPress={() =>
                session.patchFilters({ when: session.filters.when === 'today' ? undefined : 'today' })
              }
            />
            <Chip
              label="This weekend"
              selected={session.filters.when === 'weekend'}
              accessibilityRole="checkbox"
              onPress={() =>
                session.patchFilters({
                  when: session.filters.when === 'weekend' ? undefined : 'weekend',
                })
              }
            />
            <Chip
              label="Near me"
              icon="navigate-outline"
              selected={session.filters.nearMe}
              accessibilityRole="checkbox"
              onPress={() => session.patchFilters({ nearMe: !session.filters.nearMe })}
            />
            <Chip
              label="Ladies only"
              icon="woman-outline"
              selected={session.filters.ladiesOnly}
              accessibilityRole="checkbox"
              onPress={() => session.patchFilters({ ladiesOnly: !session.filters.ladiesOnly })}
            />
            <Chip
              label="Camps"
              icon="bonfire-outline"
              selected={session.filters.formats.includes('camp')}
              accessibilityRole="checkbox"
              onPress={() =>
                session.patchFilters({
                  formats: session.filters.formats.includes('camp')
                    ? session.filters.formats.filter((format) => format !== 'camp')
                    : [...session.filters.formats, 'camp'],
                })
              }
            />
            <Chip
              label="Offers"
              icon="pricetag-outline"
              selected={session.filters.offers}
              accessibilityRole="checkbox"
              onPress={() => session.patchFilters({ offers: !session.filters.offers })}
            />
          </ScrollView>

          {activeChips.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.activeChips}
            >
              {activeChips.map((chip) => (
                <PressableFeedback
                  key={chip.key}
                  accessibilityLabel={`Remove filter ${chip.spoken ?? chip.label}`}
                  onPress={() => session.patchFilters(chip.remove)}
                  style={styles.activeChip}
                  hitSlop={5}
                >
                  <Text style={styles.activeChipLabel}>{chip.label}</Text>
                  <Ionicons name="close" size={14} color={colors.brand.primary} />
                </PressableFeedback>
              ))}
            </ScrollView>
          ) : null}

          <View style={styles.tabRow} accessibilityRole="tablist">
            {tabs.map((tab) => {
              const selected = session.tab === tab.id;
              return (
                <PressableFeedback
                  key={tab.id}
                  accessibilityRole="tab"
                  accessibilityLabel={tab.label}
                  accessibilityState={{ selected }}
                  onPress={() => session.setTab(tab.id)}
                  style={[styles.tab, selected && styles.tabSelected]}
                >
                  {/* Whole labels only in the fixed-width segments: at large
                      font scale the label shrinks toward (never below) its
                      base size instead of breaking mid-word (audit defect
                      A3; docs/12 §4 dense-control allowance). */}
                  <Text
                    style={[styles.tabLabel, selected && styles.tabLabelSelected]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.75}
                  >
                    {tab.label}
                  </Text>
                </PressableFeedback>
              );
            })}
          </View>

          {failed ? (
            <ErrorStateCard
              onRetry={() => {
                setRetried(true);
                session.patchFilters({});
              }}
            />
          ) : page === null ? (
            <View style={styles.skeletons}>
              <SkeletonBlock style={styles.skeletonCard} />
              <SkeletonBlock style={styles.skeletonCard} />
              <SkeletonBlock style={styles.skeletonCard} />
            </View>
          ) : (
            <>
              {page.correctedQuery !== undefined ? (
                <Text style={styles.corrected} accessibilityLiveRegion="polite">
                  Showing results for “{page.correctedQuery}”
                </Text>
              ) : null}
              <Text style={styles.countLine} accessibilityLiveRegion="polite">
                {page.totalPrograms} {page.totalPrograms === 1 ? 'activity' : 'activities'} ·{' '}
                {page.totalProviders} {page.totalProviders === 1 ? 'provider' : 'providers'}
              </Text>

              {page.totalPrograms === 0 && session.tab !== 'providers' && session.tab !== 'categories' ? (
                <EmptyFeedCard
                  message={emptyMessage}
                  actionLabel={session.activeCount > 0 ? 'Clear filters' : 'Try another search'}
                  onClearFilter={() => {
                    if (session.activeCount > 0) session.clearFilters();
                    else router.push({ pathname: '/search', params: { origin: 'results' } });
                  }}
                />
              ) : session.tab === 'all' ? (
                <AllTab page={page} onSeeAll={session.setTab} onOpenCategory={openCategory} isFavourite={isProgramFavourite} onToggleFavourite={toggleProgramFavourite} />
              ) : session.tab === 'programs' ? (
                <ProgramsTab page={page} isFavourite={isProgramFavourite} onToggleFavourite={toggleProgramFavourite} onLoadMore={session.loadMore} />
              ) : session.tab === 'providers' ? (
                <ProvidersTab page={page} onLoadMore={session.loadMore} />
              ) : (
                <CategoriesTab page={page} onOpenCategory={openCategory} />
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>

      <FilterSheet
        visible={filterSheetOpen}
        filters={session.filters}
        resultCount={resultCountForSheet}
        onChange={session.setFilters}
        onClearAll={session.clearFilters}
        onClose={() => setFilterSheetOpen(false)}
      />
      <SortSheet
        visible={sortSheetOpen}
        selected={session.sort}
        onSelect={session.setSort}
        onClose={() => setSortSheetOpen(false)}
      />
    </View>
  );
}

interface ChipDescriptor {
  key: string;
  label: string;
  /** Spoken override when the visual label reads poorly aloud. */
  spoken?: string;
  remove: Partial<FilterSelection>;
}

function buildActiveChips(
  filters: FilterSelection,
  areaLabelById: Map<string, string>,
): ChipDescriptor[] {
  const chips: ChipDescriptor[] = [];
  if (filters.ladiesOnly) chips.push({ key: 'ladies', label: 'Ladies only', remove: { ladiesOnly: false } });
  if (filters.when === 'today') chips.push({ key: 'today', label: 'Today', remove: { when: undefined } });
  if (filters.when === 'weekend') chips.push({ key: 'weekend', label: 'This weekend', remove: { when: undefined } });
  if (filters.afterSchool) chips.push({ key: 'after-school', label: 'After school', remove: { afterSchool: false } });
  if (filters.nearMe) chips.push({ key: 'near-me', label: 'Near me', remove: { nearMe: false } });
  if (filters.audience !== undefined) {
    chips.push({
      key: 'audience',
      label: filters.audience === 'adults' ? 'Adults' : 'Children',
      remove: { audience: undefined },
    });
  }
  if (filters.ageBand !== undefined) {
    // Canonical age wording (utils/eligibility.ts): "Ages 6–9" / "Ages 14+".
    const { min, max } = filters.ageBand;
    chips.push({
      key: 'age',
      label: max === null ? `Ages ${min}+` : `Ages ${min}–${max}`,
      spoken: max === null ? `Ages ${min} and up` : `Ages ${min} to ${max}`,
      remove: { ageBand: undefined },
    });
  }
  if (filters.areaId !== undefined) {
    chips.push({
      key: 'area',
      label: areaLabelById.get(filters.areaId) ?? 'Area',
      remove: { areaId: undefined },
    });
  }
  if (filters.categoryId !== undefined) {
    chips.push({
      key: 'category',
      label: allCategories.find((category) => category.id === filters.categoryId)?.label ?? 'Category',
      remove: { categoryId: undefined, activityTypeId: undefined, skillLevel: undefined },
    });
  }
  if (filters.formats.length > 0) {
    chips.push({ key: 'formats', label: filters.formats.includes('camp') && filters.formats.length === 1 ? 'Camps' : 'Formats', remove: { formats: [] } });
  }
  if (filters.setting !== undefined) {
    chips.push({
      key: 'setting',
      label: filters.setting === 'indoor' ? 'Indoor' : 'Outdoor',
      remove: { setting: undefined },
    });
  }
  if (filters.priceBand !== undefined) chips.push({ key: 'price', label: 'Price', remove: { priceBand: undefined } });
  if (filters.free) chips.push({ key: 'free', label: 'Free', remove: { free: false } });
  if (filters.offers) chips.push({ key: 'offers', label: 'Offers', remove: { offers: false } });
  if (filters.trial) chips.push({ key: 'trial', label: 'Free trial', remove: { trial: false } });
  if (filters.skillLevel !== undefined) {
    chips.push({
      key: 'skill',
      label: filters.skillLevel[0].toUpperCase() + filters.skillLevel.slice(1),
      remove: { skillLevel: undefined },
    });
  }
  if (filters.topRated) chips.push({ key: 'top-rated', label: 'Top rated', remove: { topRated: false } });
  return chips;
}

const areaLabel = (areaId: string) => areas.find((area) => area.id === areaId)?.label ?? '';

function ProgramList({
  programs,
  isFavourite,
  onToggleFavourite,
}: {
  programs: ResultsPage['programs'];
  isFavourite: (id: string) => boolean;
  onToggleFavourite: (id: string) => void;
}) {
  const { openProgram } = useDetailNavigation();
  return (
    <View style={styles.list}>
      {programs.map((program) => (
        <CompactProgramRow
          key={program.id}
          program={program}
          providerName={providerNameById.get(program.providerId) ?? ''}
          areaLabel={areaLabel(program.areaId)}
          isFavourite={isFavourite(program.id)}
          onToggleFavourite={onToggleFavourite}
          onPress={() => openProgram(program.id)}
        />
      ))}
    </View>
  );
}

function AllTab({
  page,
  onSeeAll,
  onOpenCategory,
  isFavourite,
  onToggleFavourite,
}: {
  page: ResultsPage;
  onSeeAll: (tab: ResultsTab) => void;
  onOpenCategory: (categoryId: string) => void;
  isFavourite: (id: string) => boolean;
  onToggleFavourite: (id: string) => void;
}) {
  const { openProvider } = useDetailNavigation();
  return (
    <View style={styles.groups}>
      {page.programs.length > 0 ? (
        <View style={styles.list}>
          <GroupHeader
            title="Programs"
            showSeeAll={page.totalPrograms > 3}
            onSeeAll={() => onSeeAll('programs')}
          />
          <ProgramList
            programs={page.programs.slice(0, 3)}
            isFavourite={isFavourite}
            onToggleFavourite={onToggleFavourite}
          />
        </View>
      ) : null}
      {page.providers.length > 0 ? (
        <View style={styles.list}>
          <GroupHeader
            title="Providers"
            showSeeAll={page.totalProviders > 3}
            onSeeAll={() => onSeeAll('providers')}
          />
          {page.providers.slice(0, 3).map((provider) => (
            <CompactProviderRow
              key={provider.id}
              provider={provider}
              areaLabel={areaLabel(provider.areaId)}
              programCount={providerProgramCount(provider.id)}
              onPress={() => openProvider(provider.id)}
            />
          ))}
        </View>
      ) : null}
      {page.categories.length > 0 ? (
        <View style={styles.list}>
          <GroupHeader
            title="Categories"
            showSeeAll={page.categories.length > 3}
            onSeeAll={() => onSeeAll('categories')}
          />
          {page.categories.slice(0, 3).map((category) => (
            <CategoryResultRow
              key={category.id}
              category={category}
              programCount={categoryCountById.get(category.id) ?? 0}
              onPress={() => onOpenCategory(category.id)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function GroupHeader({
  title,
  showSeeAll,
  onSeeAll,
}: {
  title: string;
  showSeeAll: boolean;
  onSeeAll: () => void;
}) {
  return (
    <View style={styles.groupHeader}>
      <Text style={styles.groupTitle} accessibilityRole="header">
        {title}
      </Text>
      {showSeeAll ? (
        <PressableFeedback accessibilityLabel={`See all ${title}`} onPress={onSeeAll} hitSlop={14}>
          <Text style={styles.seeAll}>See all</Text>
        </PressableFeedback>
      ) : null}
    </View>
  );
}

function ProgramsTab({
  page,
  isFavourite,
  onToggleFavourite,
  onLoadMore,
}: {
  page: ResultsPage;
  isFavourite: (id: string) => boolean;
  onToggleFavourite: (id: string) => void;
  onLoadMore: () => void;
}) {
  return (
    <View style={styles.list}>
      <ProgramList programs={page.programs} isFavourite={isFavourite} onToggleFavourite={onToggleFavourite} />
      <ListFooter
        hasMore={page.hasMorePrograms}
        shownCount={page.programs.length}
        total={page.totalPrograms}
        onLoadMore={onLoadMore}
      />
    </View>
  );
}

function ProvidersTab({ page, onLoadMore }: { page: ResultsPage; onLoadMore: () => void }) {
  const { openProvider } = useDetailNavigation();
  return (
    <View style={styles.list}>
      {page.providers.map((provider) => (
        <CompactProviderRow
          key={provider.id}
          provider={provider}
          areaLabel={areaLabel(provider.areaId)}
          programCount={providerProgramCount(provider.id)}
          onPress={() => openProvider(provider.id)}
        />
      ))}
      <ListFooter
        hasMore={page.hasMoreProviders}
        shownCount={page.providers.length}
        total={page.totalProviders}
        onLoadMore={onLoadMore}
      />
    </View>
  );
}

function CategoriesTab({
  page,
  onOpenCategory,
}: {
  page: ResultsPage;
  onOpenCategory: (categoryId: string) => void;
}) {
  return (
    <View style={styles.list}>
      {page.categories.map((category) => (
        <CategoryResultRow
          key={category.id}
          category={category}
          programCount={categoryCountById.get(category.id) ?? 0}
          onPress={() => onOpenCategory(category.id)}
        />
      ))}
    </View>
  );
}

function ListFooter({
  hasMore,
  shownCount,
  total,
  onLoadMore,
}: {
  hasMore: boolean;
  shownCount: number;
  total: number;
  onLoadMore: () => void;
}) {
  if (hasMore) {
    return (
      <PressableFeedback accessibilityLabel="Load more results" onPress={onLoadMore} style={styles.loadMore}>
        <Text style={styles.loadMoreLabel}>Load more</Text>
      </PressableFeedback>
    );
  }
  if (total > 3 && shownCount === total) {
    return <Text style={styles.endOfResults}>You’ve seen all {total} results</Text>;
  }
  return null;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  safeArea: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  queryPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.search,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  queryText: {
    flex: 1,
    ...typography.searchInput,
    color: colors.text.primary,
  },
  content: {
    gap: spacing.lg,
    paddingTop: spacing.xs,
  },
  toolbar: {
    paddingHorizontal: pagePadding,
    gap: spacing.sm,
    alignItems: 'center',
  },
  toolbarDivider: {
    width: 1,
    height: 24,
    backgroundColor: colors.border.default,
  },
  activeChips: {
    paddingHorizontal: pagePadding,
    gap: spacing.sm,
  },
  activeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 34,
    paddingHorizontal: spacing.md,
    borderRadius: radii.chip,
    backgroundColor: colors.brand.primarySoft,
  },
  activeChipLabel: {
    ...typography.caption,
    color: colors.brand.primary,
  },
  tabRow: {
    flexDirection: 'row',
    marginHorizontal: pagePadding,
    backgroundColor: colors.background.elevated,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: 3,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.button - 4,
    alignItems: 'center',
    justifyContent: 'center',
    // Keeps fitted labels visually separated at large font scale (A3).
    paddingHorizontal: 4,
  },
  tabSelected: {
    backgroundColor: colors.brand.primary,
  },
  tabLabel: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.secondary,
  },
  tabLabelSelected: {
    color: colors.text.inverse,
    fontFamily: fontFamily.bold,
  },
  corrected: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.brand.primary,
    paddingHorizontal: pagePadding,
  },
  countLine: {
    ...typography.caption,
    color: colors.text.secondary,
    paddingHorizontal: pagePadding,
  },
  skeletons: {
    paddingHorizontal: pagePadding,
    gap: spacing.lg,
  },
  skeletonCard: { height: 128, borderRadius: radii.card },
  groups: { gap: spacing.xl },
  list: {
    paddingHorizontal: pagePadding,
    gap: spacing.md,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  groupTitle: {
    ...typography.sectionTitle,
    fontSize: 18,
    lineHeight: 24,
    color: colors.text.primary,
  },
  seeAll: {
    ...typography.chip,
    color: colors.brand.primary,
  },
  loadMore: {
    minHeight: 48,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  loadMoreLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  endOfResults: {
    ...typography.caption,
    color: colors.text.secondary,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
});
