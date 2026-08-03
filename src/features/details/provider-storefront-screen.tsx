import { CompactProgramRow } from '@/components/domain/compact-program-row';
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { AppImage } from '@/components/ui/app-image';
import { Chip } from '@/components/ui/chip';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { demoImage } from '@/data/mock/images';
import { useDetailNavigation } from '@/features/details/detail-navigation';
import { shareEntity } from '@/features/details/share-entity';
import type { ProviderStorefrontPage } from '@/services/contracts/details';
import { detailsService } from '@/services/mock/mock-details-service';
import { useAreaContext } from '@/state/area-context';
import { useFavourites } from '@/state/favourites-context';
import { useParticipantContext } from '@/state/participant-context';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { ageRangeLabel, participantAge, spokenAgeLabel } from '@/utils/eligibility';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * HMA-014 — Provider Storefront (docs/20 §4). Root-level route: the dock is
 * hidden structurally and there is no sticky CTA (nothing to book at provider
 * level). Programs are immediately visible — no extra directory layers.
 */
export function ProviderStorefrontScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ providerId?: string; 'qa-fail'?: string }>();
  const providerId = typeof params.providerId === 'string' ? params.providerId : '';

  const { participants, participantId, setParticipantId } = useParticipantContext();
  const { areaId } = useAreaContext();
  const { isFavourite, toggleFavourite } = useFavourites();
  const { openProgram } = useDetailNavigation();

  const [page, setPage] = useState<ProviderStorefrontPage | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  const [branchId, setBranchId] = useState<string | undefined>(undefined);
  const [ineligibleOpen, setIneligibleOpen] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const shareNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const simulateFailure = params['qa-fail'] === '1' && !retried;

  // Previous content stays visible while a participant or branch switch
  // reloads (Home rule).
  useEffect(() => {
    let cancelled = false;
    detailsService
      .getProviderStorefrontPage({
        providerId,
        participantId,
        participants,
        areaId,
        branchId,
        simulateFailure,
      })
      .then(
        (result) => {
          if (!cancelled) {
            setPage(result ?? null);
            setMissing(result === undefined);
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
  }, [providerId, participantId, participants, areaId, branchId, simulateFailure]);

  useEffect(
    () => () => {
      if (shareNoticeTimer.current !== null) clearTimeout(shareNoticeTimer.current);
    },
    [],
  );

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/discover');
  };

  /**
   * Taxonomy chips leave the storefront for a browsing surface. The detail
   * route is dismissed first so the destination stacks on the Discover feed
   * (the established /search and /map mechanism) — pushing a tab route on
   * top of a root detail route would corrupt the stack.
   */
  const openTaxonomy = (
    path: `/discover/category/${string}` | `/discover/activity/${string}`,
  ) => {
    if (router.canGoBack()) {
      router.dismiss();
      router.push(path);
      return;
    }
    // Cold deep link: nothing beneath to stack on — replace, the
    // established cold-link fallback.
    router.replace(path);
  };

  const share = async () => {
    if (page === null) return;
    const outcome = await shareEntity('provider', page.provider.id, page.provider.name);
    if (outcome === 'copied') {
      setShareNotice('Link copied');
      if (shareNoticeTimer.current !== null) clearTimeout(shareNoticeTimer.current);
      shareNoticeTimer.current = setTimeout(() => setShareNotice(null), 2500);
    }
  };

  if (missing) {
    return (
      <View style={styles.root}>
        <View style={[styles.headerOverlay, { top: insets.top + spacing.sm }]}>
          <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        </View>
        <View style={[styles.missingWrap, { paddingTop: insets.top + 96 }]}>
          <EmptyFeedCard
            title="This provider is no longer on Himma."
            message="They may have left or changed their listing. Browse current activities instead."
            actionLabel="Browse activities"
            onClearFilter={() => router.replace('/discover')}
          />
        </View>
      </View>
    );
  }

  if (failed) {
    return (
      <View style={styles.root}>
        <View style={[styles.headerOverlay, { top: insets.top + spacing.sm }]}>
          <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        </View>
        <View style={[styles.missingWrap, { paddingTop: insets.top + 96 }]}>
          <ErrorStateCard onRetry={() => setRetried(true)} />
        </View>
      </View>
    );
  }

  const saved = page !== null && isFavourite('provider', page.provider.id);
  const selectedParticipant = participants.find(
    (participant) => participant.id === participantId,
  );
  const childContext = selectedParticipant?.kind === 'child';
  const childName = selectedParticipant?.label ?? '';
  const childAge = selectedParticipant === undefined ? undefined : participantAge(selectedParticipant);
  const multiBranch = page !== null && page.branches.length > 1;
  const showCategoryHeaders = page !== null && page.programGroups.length > 1;

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }}
        showsVerticalScrollIndicator={false}
      >
        {page === null ? (
          <StorefrontSkeleton topInset={insets.top} />
        ) : (
          <>
            {page.extras.coverImageKey !== undefined ? (
              <AppImage source={demoImage(page.extras.coverImageKey)} style={styles.cover} />
            ) : (
              // The monogram banner is the design for providers without
              // photography — not an error state (docs/20 §9.2).
              <View
                style={styles.monogramBanner}
                accessibilityLabel={`${page.provider.name} logo placeholder`}
              >
                <View style={styles.monogramBannerCircle}>
                  <Text style={styles.monogramBannerText}>{page.monogram}</Text>
                </View>
              </View>
            )}

            <View style={styles.content}>
              <View style={styles.identityRow}>
                <View style={styles.monogram}>
                  <Text style={styles.monogramText}>{page.monogram}</Text>
                </View>
                <View style={styles.identityText}>
                  <Text style={styles.title} accessibilityRole="header">
                    {page.provider.name}
                  </Text>
                  {page.provider.verified ? (
                    <View style={styles.verifiedRow}>
                      <Ionicons name="shield-checkmark" size={14} color={colors.brand.primary} />
                      <Text style={styles.verifiedText}>Verified provider</Text>
                    </View>
                  ) : null}
                </View>
              </View>

              <View
                style={styles.ratingRow}
                accessibilityLabel={`Rated ${page.provider.rating.toFixed(1)} out of 5 from ${page.extras.reviewCount} reviews`}
              >
                <Ionicons name="star" size={15} color={colors.brand.reward} />
                <Text style={styles.ratingValue}>{page.provider.rating.toFixed(1)}</Text>
                <Text style={styles.ratingCount}>({page.extras.reviewCount} reviews)</Text>
              </View>

              <Text style={styles.bodyText}>{page.extras.description}</Text>

              {/* Taxonomy chips — deep links into category and activity pages
                  (docs/20 §4.5). */}
              <View style={styles.chipRow}>
                {page.categories.map((category) => (
                  <PressableFeedback
                    key={category.id}
                    accessibilityLabel={category.label}
                    accessibilityHint="Opens the category page"
                    onPress={() => openTaxonomy(`/discover/category/${category.id}`)}
                    style={styles.linkChip}
                  >
                    <Text style={styles.linkChipText}>{category.label}</Text>
                  </PressableFeedback>
                ))}
                {page.activityTypes.map((activityType) => (
                  <PressableFeedback
                    key={activityType.id}
                    accessibilityLabel={activityType.label}
                    accessibilityHint="Opens the activity page"
                    onPress={() => openTaxonomy(`/discover/activity/${activityType.id}`)}
                    style={[styles.linkChip, styles.linkChipSecondary]}
                  >
                    <Text style={[styles.linkChipText, styles.linkChipTextSecondary]}>
                      {activityType.label}
                    </Text>
                  </PressableFeedback>
                ))}
              </View>

              <View>
                <SectionTitle title={multiBranch ? 'Branches' : 'Location'} />
                {multiBranch ? (
                  <View style={styles.branchSelector} accessibilityRole="radiogroup">
                    {page.branches.map((branch) => (
                      <Chip
                        key={branch.id}
                        label={branch.label}
                        selected={branch.id === page.selectedBranch.id}
                        accessibilityRole="radio"
                        accessibilityHint={`Shows programs and details for ${branch.label}`}
                        onPress={() => setBranchId(branch.id)}
                      />
                    ))}
                  </View>
                ) : null}
                <View style={styles.branchCard}>
                  {multiBranch ? (
                    <Text style={styles.branchLabel}>{page.selectedBranch.label}</Text>
                  ) : null}
                  <View style={styles.branchLine}>
                    <Ionicons name="location-outline" size={16} color={colors.text.secondary} />
                    <Text style={styles.branchLineText}>
                      {page.areaLabel} · {page.selectedBranch.addressLine}
                    </Text>
                  </View>
                  {page.selectedBranch.openingHours !== undefined ? (
                    <View style={styles.branchLine}>
                      <Ionicons name="time-outline" size={16} color={colors.text.secondary} />
                      <Text style={styles.branchLineText}>
                        {page.selectedBranch.openingHours}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>

              <View>
                <SectionTitle
                  title="Programs"
                  detail={`${page.programCount} ${page.programCount === 1 ? 'program' : 'programs'}${multiBranch ? ` at ${page.selectedBranch.label}` : ''}`}
                />

                {childContext && page.eligibleProgramCount === 0 ? (
                  // Suitability recovery — the provider stays visible and
                  // trusted; nothing pretends the storefront is empty
                  // (docs/20 §6.2). No silent participant switching.
                  <View style={styles.recoveryCard} accessibilityLiveRegion="polite">
                    <View style={styles.recoveryHeader}>
                      <Ionicons name="information-circle" size={18} color={colors.status.error} />
                      <Text style={styles.recoveryTitle}>
                        No programs for {childName}’s age at this provider yet.
                      </Text>
                    </View>
                    {page.eligibleParticipants.some(
                      (entry) => entry.participantId !== participantId,
                    ) ? (
                      <>
                        <Text style={styles.recoveryHint}>Programs here suit:</Text>
                        <View style={styles.recoveryChips}>
                          {page.eligibleParticipants
                            .filter((entry) => entry.participantId !== participantId)
                            .map((entry) => (
                              <Chip
                                key={entry.participantId}
                                label={entry.label}
                                selected={false}
                                accessibilityHint={`Switches browsing to ${entry.label}`}
                                onPress={() => setParticipantId(entry.participantId)}
                              />
                            ))}
                        </View>
                      </>
                    ) : null}
                    <PressableFeedback
                      accessibilityLabel={`Browse activities for ${childName}`}
                      onPress={() => router.replace('/discover')}
                      style={styles.recoveryButton}
                    >
                      <Text style={styles.recoveryButtonLabel}>
                        Browse activities for {childName}
                      </Text>
                    </PressableFeedback>
                  </View>
                ) : (
                  <View style={styles.groupList}>
                    {childContext && page.eligibleProgramCount > 0 ? (
                      <Text style={styles.eligibilityNote} accessibilityLiveRegion="polite">
                        Showing programs suitable for {childName}
                        {childAge !== undefined ? ` (age ${childAge})` : ''}
                      </Text>
                    ) : null}
                    {page.programGroups.map((group) => (
                      <View key={group.category.id} style={styles.list}>
                        {showCategoryHeaders ? (
                          <Text style={styles.groupTitle} accessibilityRole="header">
                            {group.category.label}
                          </Text>
                        ) : null}
                        {group.programs.map((program) => (
                          <CompactProgramRow
                            key={program.id}
                            program={program}
                            providerName={page.provider.name}
                            areaLabel={page.areaLabel}
                            isFavourite={isFavourite('program', program.id)}
                            onToggleFavourite={(id) => toggleFavourite('program', id)}
                            onPress={() => openProgram(program.id)}
                          />
                        ))}
                      </View>
                    ))}
                  </View>
                )}

                {page.ineligiblePrograms.length > 0 ? (
                  // Honesty over silent filtering: age-ineligible programs
                  // stay reachable in a clearly separated group (docs/20 §4.7).
                  <View style={styles.ineligibleWrap}>
                    <PressableFeedback
                      accessibilityLabel={`Not for ${childName}’s age, ${page.ineligiblePrograms.length} ${page.ineligiblePrograms.length === 1 ? 'program' : 'programs'}`}
                      accessibilityHint={ineligibleOpen ? 'Collapses the list' : 'Expands the list'}
                      accessibilityState={{ expanded: ineligibleOpen }}
                      onPress={() => setIneligibleOpen((open) => !open)}
                      style={styles.ineligibleHeader}
                    >
                      <Text style={styles.ineligibleTitle}>
                        Not for {childName}’s age ({page.ineligiblePrograms.length})
                      </Text>
                      <Ionicons
                        name={ineligibleOpen ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color={colors.text.secondary}
                      />
                    </PressableFeedback>
                    {ineligibleOpen ? (
                      <View style={styles.list} accessibilityLiveRegion="polite">
                        <Text style={styles.ineligibleExplain}>
                          These programs have age ranges that don’t include {childName}
                          {childAge !== undefined ? ` (age ${childAge})` : ''}
                          {'. '}
                          Age ranges are set by the provider.
                        </Text>
                        {page.ineligiblePrograms.map((program) => (
                          <View key={program.id}>
                            <CompactProgramRow
                              program={program}
                              providerName={page.provider.name}
                              areaLabel={page.areaLabel}
                              isFavourite={isFavourite('program', program.id)}
                              onToggleFavourite={(id) => toggleFavourite('program', id)}
                              onPress={() => openProgram(program.id)}
                            />
                            <Text style={styles.ineligibleReason}>
                              {ageRangeLabel(program.eligibility) === undefined
                                ? `Not in ${childName}’s age range`
                                : `${spokenAgeLabel(ageRangeLabel(program.eligibility)!)} — ${childName} is ${childAge}`}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>

              {page.offerPrograms.length > 0 ? (
                <View>
                  <SectionTitle title="Offers & trials" />
                  <View style={styles.list}>
                    {page.offerPrograms.map((program) => (
                      <CompactProgramRow
                        key={program.id}
                        program={program}
                        providerName={page.provider.name}
                        areaLabel={page.areaLabel}
                        isFavourite={isFavourite('program', program.id)}
                        onToggleFavourite={(id) => toggleFavourite('program', id)}
                        onPress={() => openProgram(program.id)}
                      />
                    ))}
                  </View>
                </View>
              ) : null}

              {page.extras.facilities !== undefined ? (
                <View>
                  <SectionTitle title="Facilities & amenities" />
                  <View style={styles.chipRow}>
                    {page.extras.facilities.map((facility) => (
                      <View key={facility} style={styles.factPill}>
                        <Text style={styles.factPillText}>{facility}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {page.extras.team !== undefined ? (
                <View>
                  <SectionTitle title="Team" />
                  <View style={styles.teamList}>
                    {page.extras.team.map((member) => (
                      <View key={member.name} style={styles.teamRow}>
                        <View style={styles.monogram}>
                          <Text style={styles.monogramText}>
                            {member.name
                              .split(' ')
                              .filter((word) => word.length > 0)
                              .slice(0, 2)
                              .map((word) => word[0].toUpperCase())
                              .join('')}
                          </Text>
                        </View>
                        <View style={styles.teamText}>
                          <Text style={styles.teamName}>{member.name}</Text>
                          <Text style={styles.teamTitle}>{member.title}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              <View>
                <SectionTitle title="Cancellation policy" />
                <View style={styles.policyCard}>
                  <Text style={styles.policyTitle}>{page.policy.title}</Text>
                  {page.policy.summaryLines.map((line) => (
                    <Text key={line} style={styles.policyLine}>
                      {line}
                    </Text>
                  ))}
                </View>
              </View>

              {/* Schematic map entry — area-based, never geographic
                  coordinates (docs/09 §20.7). */}
              <PressableFeedback
                accessibilityLabel={`See ${page.areaLabel} on the map`}
                accessibilityHint="Opens the schematic area map"
                onPress={() => router.push({ pathname: '/map', params: { origin: 'provider' } })}
                style={styles.mapRow}
              >
                <Ionicons name="map-outline" size={18} color={colors.brand.primary} />
                <Text style={styles.mapRowText}>See {page.areaLabel} on the map</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.text.secondary} />
              </PressableFeedback>

              {/* Support contract — future help entry (HMA-032); inert. */}
              <PressableFeedback
                accessibilityLabel="Something wrong with this listing? Contact support"
                style={styles.supportRow}
              >
                <Ionicons name="help-circle-outline" size={17} color={colors.text.secondary} />
                <Text style={styles.supportText}>Something wrong with this listing?</Text>
              </PressableFeedback>
            </View>
          </>
        )}
      </ScrollView>

      <View style={[styles.headerOverlay, { top: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        {page !== null ? (
          <View style={styles.headerActions}>
            <IconButton
              icon="share-outline"
              accessibilityLabel={`Share ${page.provider.name}`}
              onPress={share}
            />
            <PressableFeedback
              accessibilityLabel={
                saved
                  ? `Remove ${page.provider.name} from favourites`
                  : `Save ${page.provider.name} to favourites`
              }
              accessibilityRole="checkbox"
              accessibilityState={{ checked: saved, selected: saved }}
              onPress={() => toggleFavourite('provider', page.provider.id)}
              style={styles.saveButton}
            >
              <Ionicons
                name={saved ? 'heart' : 'heart-outline'}
                size={22}
                color={saved ? colors.brand.accentWarm : colors.text.primary}
              />
            </PressableFeedback>
          </View>
        ) : null}
      </View>

      {shareNotice !== null ? (
        <View
          style={[styles.shareNotice, { top: insets.top + 64 }]}
          accessibilityLiveRegion="polite"
        >
          <Text style={styles.shareNoticeText}>{shareNotice}</Text>
        </View>
      ) : null}
    </View>
  );
}

function SectionTitle({ title, detail }: { title: string; detail?: string }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {detail !== undefined ? <Text style={styles.sectionDetail}>{detail}</Text> : null}
    </View>
  );
}

function StorefrontSkeleton({ topInset }: { topInset: number }) {
  return (
    <View>
      <SkeletonBlock style={[styles.cover, { borderRadius: 0 }]} />
      <View style={[styles.content, { paddingTop: spacing.xl }]}>
        <SkeletonBlock style={styles.skeletonTitle} />
        <SkeletonBlock style={styles.skeletonRow} />
        <SkeletonBlock style={styles.skeletonRow} />
        <SkeletonBlock style={styles.skeletonBlock} />
        <SkeletonBlock style={styles.skeletonBlock} />
      </View>
      {/* Header actions arrive with content; back renders immediately above. */}
      <View style={{ height: topInset }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  headerOverlay: {
    position: 'absolute',
    left: pagePadding,
    right: pagePadding,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  saveButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  missingWrap: { flex: 1 },
  cover: {
    width: '100%',
    height: 220,
  },
  monogramBanner: {
    width: '100%',
    height: 220,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramBannerCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.background.elevated,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  monogramBannerText: {
    fontFamily: fontFamily.extraBold,
    fontSize: 34,
    color: colors.brand.primary,
  },
  content: {
    paddingHorizontal: pagePadding,
    paddingTop: spacing.lg,
    gap: spacing.lg,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  identityText: { flex: 1, gap: 2 },
  title: {
    ...typography.screenTitle,
    color: colors.text.primary,
  },
  monogram: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: {
    ...typography.chip,
    fontFamily: fontFamily.extraBold,
    color: colors.brand.primary,
  },
  verifiedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  verifiedText: {
    ...typography.caption,
    color: colors.brand.primary,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  ratingValue: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  ratingCount: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  bodyText: {
    ...typography.body,
    lineHeight: 23,
    color: colors.text.primary,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  linkChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.chip,
    backgroundColor: colors.brand.primarySoft,
  },
  linkChipSecondary: {
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  linkChipText: {
    ...typography.chip,
    color: colors.brand.primary,
  },
  linkChipTextSecondary: {
    color: colors.text.primary,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.text.primary,
    letterSpacing: -0.3,
  },
  sectionDetail: {
    ...typography.caption,
    color: colors.text.secondary,
    flexShrink: 1,
    textAlign: 'right',
  },
  branchSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  branchCard: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  branchLabel: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  branchLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  branchLineText: {
    ...typography.supporting,
    color: colors.text.primary,
    flexShrink: 1,
  },
  groupList: { gap: spacing.lg },
  list: { gap: spacing.md },
  groupTitle: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.secondary,
  },
  eligibilityNote: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  recoveryCard: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  recoveryHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  recoveryTitle: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
    flexShrink: 1,
  },
  recoveryHint: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  recoveryChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  recoveryButton: {
    marginTop: spacing.xs,
    minHeight: 44,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  recoveryButtonLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
  ineligibleWrap: {
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  ineligibleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  ineligibleTitle: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
    flexShrink: 1,
  },
  ineligibleExplain: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  ineligibleReason: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.xs,
    marginLeft: spacing.md,
  },
  factPill: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.chip,
    backgroundColor: colors.brand.primarySoft,
  },
  factPillText: {
    ...typography.caption,
    color: colors.brand.primary,
  },
  teamList: { gap: spacing.md },
  teamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
  },
  teamText: { flex: 1, gap: 1 },
  teamName: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  teamTitle: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  policyCard: {
    gap: 4,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  policyTitle: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  policyLine: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  mapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  mapRowText: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
    flex: 1,
  },
  supportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
  },
  supportText: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  shareNotice: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 20,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.chip,
    backgroundColor: colors.text.primary,
  },
  shareNoticeText: {
    ...typography.caption,
    color: colors.text.inverse,
  },
  skeletonTitle: { height: 30, borderRadius: radii.image, width: '70%' },
  skeletonRow: { height: 56, borderRadius: radii.card },
  skeletonBlock: { height: 120, borderRadius: radii.card },
});
