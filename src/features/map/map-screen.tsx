import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { FilterSheet } from '@/components/domain/filter-sheet';
import { Chip } from '@/components/ui/chip';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { AreaNode } from '@/features/map/area-node';
import { listDestination, parseMapOrigin } from '@/features/map/map-navigation';
import type { MapView as MapViewData } from '@/services/contracts/map';
import { mapService } from '@/services/composition';
import { useAreaContext } from '@/state/area-context';
import { useParticipantContext } from '@/state/participant-context';
import { useResultsSession } from '@/state/results-session-context';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { qaParamActive } from '@/utils/qa';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * HMA-016 — the schematic map (docs/14 §7). A discovery alternative to the
 * Results list, not a geographic map: labeled area nodes with real supply
 * counts, fictional pins, and no coastline, districts, roads, or approximate
 * real-world positions. It reads and writes the one shared results session,
 * so list and map can never disagree (docs/16 §3.1).
 */
export function MapScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    origin?: string;
    'qa-fail'?: string;
    'qa-nocount'?: string;
  }>();
  const origin = parseMapOrigin(params.origin);

  const session = useResultsSession();
  const { participants, participantId, setParticipantId } = useParticipantContext();
  const { areaId, areaLabelById } = useAreaContext();

  const [view, setView] = useState<MapViewData | null>(null);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  // Measured rather than assumed: the bar grows with Dynamic Type and the
  // bottom safe area, and the canvas must always clear it.
  const [bottomBarHeight, setBottomBarHeight] = useState(96);

  const simulateFailure = qaParamActive(params['qa-fail']) && !retried;
  const simulateMissingCounts = qaParamActive(params['qa-nocount']);
  const selectedAreaId = session.filters.areaId;

  // Previous nodes stay visible while a filter or participant change reloads.
  useEffect(() => {
    let cancelled = false;
    mapService
      .getMapView({
        query: session.query,
        participantId,
        areaId,
        filters: session.filters,
        sort: session.sort,
        simulateFailure,
        simulateMissingCounts,
      })
      .then(
        (result) => {
          if (!cancelled) {
            setView(result);
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
  }, [
    session.query,
    session.filters,
    session.sort,
    participantId,
    areaId,
    simulateFailure,
    simulateMissingCounts,
  ]);

  /** Back always lands on the exact origin; a cold link falls back to Discover. */
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/discover');
  };

  /** Exactly one Results route survives either path (docs/15 §4.3). */
  const openList = () => {
    if (listDestination(origin).kind === 'back' && router.canGoBack()) {
      router.back();
      return;
    }
    if (router.canGoBack()) router.dismiss();
    router.push('/discover/results');
  };

  const toggleArea = (id: string) => {
    session.patchFilters({ areaId: selectedAreaId === id ? undefined : (id as typeof areaId) });
  };

  const participantLabel =
    participants.find((participant) => participant.id === participantId)?.label ?? 'Everyone';
  const selectedSummary = view?.areas.find((entry) => entry.area.id === selectedAreaId);
  const selectedLabel =
    selectedAreaId === undefined ? undefined : areaLabelById.get(selectedAreaId) ?? undefined;

  const contextLine = [
    `Browsing for ${participantLabel}`,
    session.query.length > 0 ? `“${session.query}”` : undefined,
    selectedLabel,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');

  const listCount = selectedSummary?.programCount ?? view?.totalPrograms;
  const listLabel =
    listCount === undefined
      ? 'List'
      : `List · ${listCount} ${listCount === 1 ? 'activity' : 'activities'}`;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.header}>
          <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
          <Text style={styles.title} accessibilityRole="header">
            Map
          </Text>
          <View style={styles.headerAction}>
            <Chip
              label="Filters"
              icon="options-outline"
              selected={filterSheetOpen}
              badgeCount={session.activeCount}
              onPress={() => setFilterSheetOpen(true)}
              accessibilityHint="Opens all filters"
            />
          </View>
        </View>

        <ScrollView
          style={styles.safeArea}
          contentContainerStyle={[styles.content, { paddingBottom: bottomBarHeight + spacing.xl }]}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.notice}>
            <Ionicons name="information-circle-outline" size={16} color={colors.brand.primary} />
            <Text style={styles.noticeText}>
              Schematic view. Areas are arranged for browsing, not by real location or distance.
            </Text>
          </View>

          <Text style={styles.context} accessibilityLiveRegion="polite">
            {contextLine}
          </Text>

          {failed ? (
            <ErrorStateCard onRetry={() => setRetried(true)} />
          ) : view === null ? (
            <View style={styles.canvas}>
              <View style={styles.grid}>
                {Array.from({ length: 6 }, (_, index) => (
                  <SkeletonBlock key={index} style={styles.skeletonNode} />
                ))}
              </View>
            </View>
          ) : (
            <>
              <View style={styles.canvas}>
                <View style={[styles.canvasDots, styles.noPointer]} accessibilityElementsHidden>
                  {[
                    { top: 26, left: 30 },
                    { top: 92, left: 190 },
                    { top: 170, left: 62 },
                    { top: 250, left: 210 },
                    { top: 330, left: 110 },
                  ].map((position) => (
                    <View
                      key={`${position.top}-${position.left}`}
                      style={[styles.dot, position]}
                    />
                  ))}
                </View>
                <View style={styles.grid}>
                  {view.areas.map((summary) => (
                    <AreaNode
                      key={summary.area.id}
                      summary={summary}
                      selected={summary.area.id === selectedAreaId}
                      onPress={() => toggleArea(summary.area.id)}
                    />
                  ))}
                </View>
              </View>

              {view.totalPrograms === undefined ? (
                <Text style={styles.fallbackNote} accessibilityLiveRegion="polite">
                  Activity counts aren’t available right now. Open the list to see what’s on.
                </Text>
              ) : !view.hasAnyResults ? (
                <EmptyFeedCard
                  message={
                    participantId !== 'everyone' && participantId !== 'me' && session.filters.ladiesOnly
                      ? `No ladies-only activities for ${participantLabel}. Try Everyone or Me.`
                      : session.activeCount > 0
                        ? 'No areas have activities matching these filters right now.'
                        : `No activities for ${participantLabel} in any area right now.`
                  }
                  actionLabel={session.activeCount > 0 ? 'Clear filters' : 'Browse as Everyone'}
                  onClearFilter={() => {
                    if (session.activeCount > 0) session.clearFilters();
                    else setParticipantId('everyone');
                  }}
                />
              ) : selectedSummary !== undefined && selectedSummary.programCount === 0 ? (
                <View style={styles.areaEmpty}>
                  <Text style={styles.areaEmptyText} accessibilityLiveRegion="polite">
                    No activities in {selectedSummary.area.label} with these filters yet.
                  </Text>
                  <PressableFeedback
                    accessibilityLabel="Show all areas"
                    onPress={() => session.patchFilters({ areaId: undefined })}
                    hitSlop={14}
                  >
                    <Text style={styles.areaEmptyAction}>Show all areas</Text>
                  </PressableFeedback>
                </View>
              ) : null}
            </>
          )}
        </ScrollView>
      </SafeAreaView>

      {/* The list is always one tap away — the map is never the only path
          to a result (docs/14 §9). */}
      <SafeAreaView
        edges={['bottom']}
        style={styles.bottomBar}
        onLayout={(event) => setBottomBarHeight(event.nativeEvent.layout.height)}
      >
        <View style={styles.bottomRow}>
          <Text style={styles.bottomSummary} numberOfLines={2}>
            {selectedLabel === undefined ? 'All areas' : selectedLabel}
          </Text>
          <PressableFeedback
            accessibilityLabel={
              listCount === undefined
                ? 'Show the list'
                : `Show the list, ${listCount} ${listCount === 1 ? 'activity' : 'activities'}`
            }
            onPress={openList}
            style={styles.listButton}
          >
            <Ionicons name="list-outline" size={18} color={colors.text.inverse} />
            <Text style={styles.listLabel}>{listLabel}</Text>
          </PressableFeedback>
        </View>
      </SafeAreaView>

      <FilterSheet
        visible={filterSheetOpen}
        filters={session.filters}
        onChange={session.setFilters}
        onClearAll={session.clearFilters}
        onClose={() => setFilterSheetOpen(false)}
      />
    </View>
  );
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
  title: {
    ...typography.screenTitle,
    fontSize: 22,
    lineHeight: 28,
    color: colors.text.primary,
  },
  headerAction: { marginLeft: 'auto' },
  content: {
    gap: spacing.lg,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginHorizontal: pagePadding,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  noticeText: {
    flex: 1,
    ...typography.caption,
    fontFamily: fontFamily.medium,
    color: colors.text.primary,
  },
  context: {
    ...typography.caption,
    color: colors.text.secondary,
    paddingHorizontal: pagePadding,
  },
  canvas: {
    marginHorizontal: pagePadding,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border.default,
    overflow: 'hidden',
  },
  canvasDots: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  noPointer: { pointerEvents: 'none' },
  dot: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.brand.primarySoft,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  skeletonNode: {
    flexGrow: 1,
    flexBasis: '44%',
    height: 132,
    borderRadius: radii.card,
  },
  fallbackNote: {
    ...typography.supporting,
    color: colors.text.secondary,
    paddingHorizontal: pagePadding,
  },
  areaEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: pagePadding,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  areaEmptyText: {
    flex: 1,
    ...typography.supporting,
    color: colors.text.primary,
  },
  areaEmptyAction: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background.elevated,
    borderTopWidth: 1,
    borderTopColor: colors.border.default,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  bottomSummary: {
    flex: 1,
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  listButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
  },
  listLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
});
