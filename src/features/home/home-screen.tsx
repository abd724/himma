import { CreditStrip } from '@/components/domain/credit-strip';
import { HeroCard } from '@/components/domain/hero-card';
import { HomeHeader } from '@/components/domain/home-header';
import { LocationSheet } from '@/components/domain/location-sheet';
import { ProgramCard } from '@/components/domain/program-card';
import { SearchEntryButton } from '@/components/domain/search-entry-button';
import { SectionHeader } from '@/components/ui/section-header';
import { collections, providers } from '@/data/mock/catalogue';
import { HomeActionCard } from '@/features/home/home-action-card';
import { HomeSkeleton } from '@/features/home/home-skeleton';
import { PlanCard } from '@/features/home/plan-card';
import { UpcomingActivityCard } from '@/features/home/upcoming-activity-card';
import { WeekStrip } from '@/features/home/week-strip';
import { collectionFilterSelection, type FilterSelection } from '@/services/contracts/filters';
import {
  toHomeFeedBuildInput,
  type HomeFeed,
  type HomeSection,
} from '@/services/contracts/home-feed';
import { homeFeedService } from '@/services/mock/mock-home-feed-service';
import { useAccount } from '@/state/account-context';
import { useAreaContext } from '@/state/area-context';
import { useFavourites } from '@/state/favourites-context';
import { useResultsSession } from '@/state/results-session-context';
import { colors, dockTokens, pagePadding, spacing } from '@/theme';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const providerNameById = new Map(providers.map((provider) => [provider.id, provider.name]));

/** The guest welcome card's action resolves to the seasonal indoor collection. */
const summerCollection = collections.find((collection) => collection.id === 'beat-the-heat');

/** Section titles for schedule kinds — docs/18 §4. */
const SECTION_TITLES = { upcoming: 'Upcoming activity', week: 'Your week', plans: 'Continue your routine' } as const;

/**
 * HMA-004 — the personalized activity hub (docs/18): "What matters to me
 * right now?" Context-complete: every participant's content renders in
 * labelled sections from the account's real participant list; the screen is
 * a pass-through around the feed's section list and adds no logic of its
 * own. Participant chips, quick filters, categories, and the provider
 * directory live on Discover exclusively (docs/18 §7).
 */
export function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const session = useResultsSession();

  const account = useAccount();
  const { areas, areaId, setAreaId, areaLabelById } = useAreaContext();
  const { favourites, toggleFavourite } = useFavourites();

  const [feed, setFeed] = useState<HomeFeed | null>(null);
  const [locationSheetOpen, setLocationSheetOpen] = useState(false);

  // Previous feed stays visible while an area change reloads, so location
  // switches never flash back to the skeleton.
  useEffect(() => {
    let cancelled = false;
    homeFeedService.getHomeFeed(toHomeFeedBuildInput(account, areaId)).then((result) => {
      if (!cancelled) setFeed(result);
    });
    return () => {
      cancelled = true;
    };
  }, [account, areaId]);

  /** Approved Home activations open a fresh preset Results session (docs/15 §4.2). */
  const openPresetResults = (filters: FilterSelection) => {
    session.newSearch('', 'programs');
    session.setFilters(filters);
    router.push('/discover/results');
  };

  const contentBottomPadding =
    dockTokens.height + dockTokens.safeAreaOffset + insets.bottom + dockTokens.contentClearance;

  const renderSection = (section: HomeSection) => {
    switch (section.kind) {
      case 'welcome':
        return (
          <HeroCard
            key="welcome"
            hero={section.content}
            onPressAction={
              summerCollection === undefined
                ? undefined
                : () => openPresetResults(collectionFilterSelection(summerCollection))
            }
          />
        );
      case 'upcoming':
        return (
          <View key="upcoming">
            <SectionHeader title={SECTION_TITLES.upcoming} />
            <UpcomingActivityCard entry={section.entry} />
          </View>
        );
      case 'week':
        return (
          <View key="week">
            <SectionHeader title={SECTION_TITLES.week} />
            <WeekStrip days={section.days} />
          </View>
        );
      case 'plans':
        return (
          <View key="plans" style={styles.planList}>
            <SectionHeader title={SECTION_TITLES.plans} />
            {section.plans.map((plan) => (
              <PlanCard key={plan.id} plan={plan} />
            ))}
          </View>
        );
      case 'programs':
        return (
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
                  showAgeRange
                  isFavourite={favourites.has(program.id)}
                  onToggleFavourite={toggleFavourite}
                />
              ))}
            </ScrollView>
          </View>
        );
      case 'action':
        return <HomeActionCard key={section.id} title={section.title} body={section.body} />;
      case 'credit':
        return <CreditStrip key="credit" credit={section.credit} />;
    }
  };

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
          {feed === null ? <HomeSkeleton /> : feed.sections.map(renderSection)}
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
  planList: { gap: spacing.md },
});
