import { CategoryGrid } from '@/components/domain/category-grid';
import { CreditStrip } from '@/components/domain/credit-strip';
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { FloatingDock } from '@/components/domain/floating-dock';
import { HeroCard } from '@/components/domain/hero-card';
import { HomeHeader } from '@/components/domain/home-header';
import { LocationSheet } from '@/components/domain/location-sheet';
import { ParticipantChips } from '@/components/domain/participant-chips';
import { ProgramCard } from '@/components/domain/program-card';
import { ProviderCard } from '@/components/domain/provider-card';
import { QuickFilterRow } from '@/components/domain/quick-filter-row';
import { SearchBar } from '@/components/domain/search-bar';
import { SectionHeader } from '@/components/ui/section-header';
import { providers } from '@/data/mock/catalogue';
import { HomeSkeleton } from '@/features/home/home-skeleton';
import type { HomeFeed, QuickFilterId } from '@/services/contracts/home-feed';
import { homeFeedService } from '@/services/mock/mock-home-feed-service';
import { colors, dockTokens, pagePadding, spacing } from '@/theme';
import type { AreaId, ParticipantId } from '@/types/domain';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const providerNameById = new Map(providers.map((provider) => [provider.id, provider.name]));

export function HomeScreen() {
  const insets = useSafeAreaInsets();

  const participants = useMemo(() => homeFeedService.getParticipants(), []);
  const areas = useMemo(() => homeFeedService.getAreas(), []);
  const quickFilters = useMemo(() => homeFeedService.getQuickFilters(), []);
  const areaLabelById = useMemo(
    () => new Map(areas.map((area) => [area.id, area.label])),
    [areas],
  );

  const [areaId, setAreaId] = useState<AreaId>('khalifa-city');
  const [participantId, setParticipantId] = useState<ParticipantId>('everyone');
  const [quickFilterId, setQuickFilterId] = useState<QuickFilterId | undefined>(undefined);
  const [feed, setFeed] = useState<HomeFeed | null>(null);
  const [locationSheetOpen, setLocationSheetOpen] = useState(false);
  const [favourites, setFavourites] = useState<ReadonlySet<string>>(new Set());

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

  const toggleFavourite = (programId: string) => {
    setFavourites((current) => {
      const next = new Set(current);
      if (next.has(programId)) next.delete(programId);
      else next.add(programId);
      return next;
    });
  };

  const toggleFilter = (id: QuickFilterId) => {
    setQuickFilterId((current) => (current === id ? undefined : id));
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
          <SearchBar />
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
              <HeroCard hero={feed.hero} />

              <View>
                <SectionHeader title="Popular categories" actionLabel="View all" />
                <CategoryGrid categories={feed.categories} />
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

      <FloatingDock activeId="home" />

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
