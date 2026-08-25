import { CompactProgramRow } from '@/components/domain/compact-program-row';
import { CompactProviderRow } from '@/components/domain/compact-provider-row';
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { FilterSheet } from '@/components/domain/filter-sheet';
import { ParticipantChips } from '@/components/domain/participant-chips';
import { Chip } from '@/components/ui/chip';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { CataloguePageHeader } from '@/features/catalogue/catalogue-page-header';
import { CataloguePageSkeleton } from '@/features/catalogue/category-screen';
import { useDetailNavigation } from '@/features/details/detail-navigation';
import type { ActivityTypePage } from '@/services/contracts/catalogue';
import {
  activeFilterCount,
  emptyFilters,
  type FilterSelection,
} from '@/services/contracts/filters';
import { catalogueService } from '@/services/composition';
import { useAreaContext } from '@/state/area-context';
import { useParticipantContext } from '@/state/participant-context';
import { useResultsSession } from '@/state/results-session-context';
import { colors, dockTokens, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

type Segment = 'programs' | 'providers';

const segments: { id: Segment; label: string }[] = [
  { id: 'programs', label: 'Programs' },
  { id: 'providers', label: 'Providers' },
];

/**
 * HMA-013 — one canonical activity type: Programs default, Providers
 * segment, map entry. Adult and junior programs share this page, differing
 * only at program level — the single-catalogue proof (docs/15 §8.5).
 */
export function ActivityTypeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ activityTypeId?: string }>();
  const activityTypeId = typeof params.activityTypeId === 'string' ? params.activityTypeId : '';

  const session = useResultsSession();
  const { participants, participantId, setParticipantId } = useParticipantContext();
  const { areaId } = useAreaContext();
  const { openProgram, openProvider } = useDetailNavigation();
  const participant = participants.find((entry) => entry.id === participantId);

  const [page, setPage] = useState<ActivityTypePage | null>(null);
  const [missing, setMissing] = useState(false);
  const [segment, setSegment] = useState<Segment>('programs');
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<FilterSelection>(emptyFilters);

  // Previous content stays visible while a context change reloads (Home rule).
  useEffect(() => {
    let cancelled = false;
    catalogueService
      .getActivityTypePage({
        activityTypeId,
        areaId,
        participantId,
        ...(participant !== undefined ? { participant } : {}),
      })
      .then(
        (result) => {
          if (!cancelled) {
            setPage(result ?? null);
            setMissing(result === undefined);
          }
        },
        () => {
          if (!cancelled) setMissing(true);
        },
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityTypeId, areaId, participantId]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/discover');
  };

  const typePreset: FilterSelection = useMemo(
    () =>
      page === null
        ? emptyFilters
        : { ...emptyFilters, categoryId: page.category.id, activityTypeId },
    [page, activityTypeId],
  );

  /** The map opens on this activity type's session, so List returns to it. */
  const openMap = () => {
    session.newSearch('', 'programs');
    session.setFilters(typePreset);
    router.push('/map?origin=activity');
  };

  const openFilterSheet = () => {
    setDraftFilters(typePreset);
    setFilterSheetOpen(true);
  };

  const applyFilterSheet = () => {
    setFilterSheetOpen(false);
    session.newSearch('', 'programs');
    session.setFilters(draftFilters);
    router.push('/discover/results');
  };

  const participantLabel =
    participants.find((participant) => participant.id === participantId)?.label ?? 'Everyone';

  const contentBottomPadding =
    dockTokens.height + dockTokens.safeAreaOffset + insets.bottom + dockTokens.contentClearance;

  if (missing) {
    return (
      <View style={styles.root}>
        <SafeAreaView edges={['top']} style={styles.safeArea}>
          <CataloguePageHeader title="Activity" onBack={goBack} />
          <EmptyFeedCard
            title="We can’t find that activity"
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
        <CataloguePageHeader
          title={page?.activityType.label ?? ' '}
          subtitle={page?.category.label}
          onBack={goBack}
        />
        <ScrollView
          style={styles.safeArea}
          contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
          showsVerticalScrollIndicator={false}
        >
          {page === null ? (
            <CataloguePageSkeleton />
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
              >
                <Chip
                  label="Filters"
                  icon="options-outline"
                  selected={filterSheetOpen}
                  badgeCount={activeFilterCount(typePreset)}
                  onPress={openFilterSheet}
                  accessibilityHint="Opens all filters for this activity"
                />
                <Chip
                  label="Map"
                  icon="map-outline"
                  selected={false}
                  onPress={openMap}
                  accessibilityHint="Shows this activity on the map"
                />
              </ScrollView>

              <ParticipantChips
                participants={participants}
                selectedId={participantId}
                onSelect={setParticipantId}
              />

              <View style={styles.segmentRow} accessibilityRole="tablist">
                {segments.map((entry) => {
                  const selected = segment === entry.id;
                  return (
                    <PressableFeedback
                      key={entry.id}
                      accessibilityRole="tab"
                      accessibilityLabel={entry.label}
                      accessibilityState={{ selected }}
                      onPress={() => setSegment(entry.id)}
                      style={[styles.segment, selected && styles.segmentSelected]}
                    >
                      <Text style={[styles.segmentLabel, selected && styles.segmentLabelSelected]}>
                        {entry.label}
                      </Text>
                    </PressableFeedback>
                  );
                })}
              </View>

              {segment === 'programs' ? (
                page.programs.length === 0 ? (
                  <EmptyFeedCard
                    message={`No ${page.activityType.label} activities for ${participantLabel}’s age right now. Try Everyone or Me.`}
                    actionLabel="Browse as Everyone"
                    onClearFilter={() => setParticipantId('everyone')}
                  />
                ) : (
                  <View style={styles.list}>
                    <Text style={styles.countLine} accessibilityLiveRegion="polite">
                      {page.programs.length}{' '}
                      {page.programs.length === 1 ? 'activity' : 'activities'}
                    </Text>
                    {page.programs.map((program) => (
                      <CompactProgramRow
                        key={program.id}
                        program={program}
                        providerName={program.providerName ?? ''}
                        areaLabel={program.areaLabel ?? ''}
                        onPress={() => openProgram(program.id)}
                      />
                    ))}
                  </View>
                )
              ) : page.providers.length === 0 ? (
                <EmptyFeedCard
                  message={`No providers offer ${page.activityType.label} for ${participantLabel} right now. Try Everyone or Me.`}
                  actionLabel="Browse as Everyone"
                  onClearFilter={() => setParticipantId('everyone')}
                />
              ) : (
                <View style={styles.list}>
                  <Text style={styles.countLine} accessibilityLiveRegion="polite">
                    {page.providers.length}{' '}
                    {page.providers.length === 1 ? 'provider' : 'providers'}
                  </Text>
                  {page.providers.map((provider) => (
                    <CompactProviderRow
                      key={provider.id}
                      provider={provider}
                      areaLabel={provider.areaLabel ?? ''}
                      onPress={() => openProvider(provider.id)}
                    />
                  ))}
                </View>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>

      <FilterSheet
        visible={filterSheetOpen}
        filters={draftFilters}
        onChange={setDraftFilters}
        onClearAll={() => setDraftFilters(emptyFilters)}
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
    gap: spacing.xl,
    paddingTop: spacing.xs,
  },
  chipRow: {
    paddingHorizontal: pagePadding,
    gap: spacing.sm,
    alignItems: 'center',
  },
  segmentRow: {
    flexDirection: 'row',
    marginHorizontal: pagePadding,
    backgroundColor: colors.background.elevated,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: 3,
  },
  segment: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.button - 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentSelected: {
    backgroundColor: colors.brand.primary,
  },
  segmentLabel: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.secondary,
  },
  segmentLabelSelected: {
    color: colors.text.inverse,
    fontFamily: fontFamily.bold,
  },
  countLine: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  list: {
    paddingHorizontal: pagePadding,
    gap: spacing.md,
  },
});
