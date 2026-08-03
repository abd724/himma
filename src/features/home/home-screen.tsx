import { CategoryGrid } from '@/components/domain/category-grid';
import { CreditStrip } from '@/components/domain/credit-strip';
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { HeroCard } from '@/components/domain/hero-card';
import { HomeHeader } from '@/components/domain/home-header';
import { LocationSheet } from '@/components/domain/location-sheet';
import { ParticipantChips } from '@/components/domain/participant-chips';
import { ProgramCard } from '@/components/domain/program-card';
import { ProviderCard } from '@/components/domain/provider-card';
import { QuickFilterRow } from '@/components/domain/quick-filter-row';
import { SearchEntryButton } from '@/components/domain/search-entry-button';
import { SectionHeader } from '@/components/ui/section-header';
import { collections, providers } from '@/data/mock/catalogue';
import { HomeSkeleton } from '@/features/home/home-skeleton';
import { collectionFilterSelection, type FilterSelection } from '@/services/contracts/filters';
import type { HomeFeed, QuickFilterId } from '@/services/contracts/home-feed';
import { homeFeedService } from '@/services/mock/mock-home-feed-service';
import { useAreaContext } from '@/state/area-context';
import { useFavourites } from '@/state/favourites-context';
import { useParticipantContext } from '@/state/participant-context';
import { useResultsSession } from '@/state/results-session-context';
import { colors, dockTokens, pagePadding, spacing } from '@/theme';
import type { BrowseEntry } from '@/types/domain';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const providerNameById = new Map(providers.map((provider) => [provider.id, provider.name]));
const collectionById = new Map(collections.map((collection) => [collection.id, collection]));

/** The hero's summer feature resolves to the seasonal indoor collection. */
const summerCollection = collectionById.get('beat-the-heat');

export function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const session = useResultsSession();

  const quickFilters = homeFeedService.getQuickFilters();
  const { participants, participantId, setParticipantId } = useParticipantContext();
  const { areas, areaId, setAreaId, areaLabelById } = useAreaContext();
  const { favourites, toggleFavourite } = useFavourites();

  const [quickFilterId, setQuickFilterId] = useState<QuickFilterId | undefined>(undefined);
  const [feed, setFeed] = useState<HomeFeed | null>(null);
  const [locationSheetOpen, setLocationSheetOpen] = useState(false);

  // Previous feed stays visible while a context change reloads, so filter and
  // participant switches never flash back to the skeleton.
  useEffect(() => {
    let cancelled = false;
    homeFeedService.getHomeFeed({ areaId, participantId, quickFilterId }).then((result) => {
      if (!cancelled) setFeed(result);
    });
    return () => {
      cancelled = true;
    };
  }, [areaId, participantId, quickFilterId]);

  const toggleFilter = (id: QuickFilterId) => {
    setQuickFilterId((current) => (current === id ? undefined : id));
  };

  /** Approved Home activations open a fresh preset Results session (docs/15 §4.2). */
  const openPresetResults = (filters: FilterSelection) => {
    session.newSearch('', 'programs');
    session.setFilters(filters);
    router.push('/discover/results');
  };

  /** Approved tile activations — docs/15 §4.2: every target now resolves. */
  const onPressBrowseEntry = (entry: BrowseEntry) => {
    if (entry.target.kind === 'category') {
      router.push(`/discover/category/${entry.target.categoryId}`);
      return;
    }
    if (entry.target.kind === 'activityType') {
      router.push(`/discover/activity/${entry.target.activityTypeId}`);
      return;
    }
    const collection = collectionById.get(entry.target.collectionId);
    if (collection !== undefined) openPresetResults(collectionFilterSelection(collection));
  };

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
        <HomeHeader
          areaLabel={areaLabelById.get(areaId) ?? ''}
          onPressLocation={() => setLocationSheetOpen(true)}
        />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
          showsVerticalScrollIndicator={false}
        >
          <SearchEntryButton onPress={() => router.push('/search')} />
          <ParticipantChips
            participants={participants}
            selectedId={participantId}
            onSelect={setParticipantId}
          />
          <QuickFilterRow filters={quickFilters} activeId={quickFilterId} onToggle={toggleFilter} />

          {feed === null ? (
            <HomeSkeleton />
          ) : (
            <>
              <HeroCard
                hero={feed.hero}
                onPressAction={
                  summerCollection === undefined
                    ? undefined
                    : () => openPresetResults(collectionFilterSelection(summerCollection))
                }
              />

              <View>
                <SectionHeader
                  title="Popular categories"
                  actionLabel="View all"
                  onActionPress={() => router.push('/discover/categories')}
                />
                <CategoryGrid categories={feed.categories} onPressEntry={onPressBrowseEntry} />
              </View>

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
                  <SectionHeader title="Popular providers near you" />
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

              <CreditStrip credit={feed.credit} />
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  safeArea: { flex: 1 },
  scroll: { flex: 1 },
  content: {
    gap: spacing.xxl,
    paddingTop: spacing.xs,
  },
  carousel: {
    paddingHorizontal: pagePadding,
    gap: spacing.lg,
  },
});
