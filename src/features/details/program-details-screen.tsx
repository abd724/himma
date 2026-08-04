import { CompactProgramRow } from '@/components/domain/compact-program-row';
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { AppImage } from '@/components/ui/app-image';
import { Badge } from '@/components/ui/badge';
import { Chip } from '@/components/ui/chip';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { demoImage } from '@/data/mock/images';
import { useBookingEntry } from '@/features/booking/booking-navigation';
import { useDetailNavigation } from '@/features/details/detail-navigation';
import { shareEntity } from '@/features/details/share-entity';
import type { ProgramDetailPage } from '@/services/contracts/details';
import { detailsService, providerMonogram } from '@/services/mock/mock-details-service';
import { useAreaContext } from '@/state/area-context';
import { useFavourites } from '@/state/favourites-context';
import { useParticipantContext } from '@/state/participant-context';
import { colors, fontFamily, pagePadding, radii, shadows, spacing, typography } from '@/theme';
import type { SkillLevel } from '@/types/domain';
import { isLadiesOnly, spokenAgeLabel } from '@/utils/eligibility';
import { formatPrice, spokenPriceLabel } from '@/utils/price';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const SKILL_LABELS: Record<SkillLevel, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  'all-levels': 'All levels',
};

/**
 * HMA-015 — Program Details (docs/20 §3). Root-level route: the dock is
 * hidden structurally and the sticky Book CTA owns the bottom region. The
 * Book action opens the booking flow (docs/21 §3); the session list here
 * stays informational only — selection happens in the flow (docs/09 §20.9).
 */
export function ProgramDetailsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ programId?: string; 'qa-fail'?: string }>();
  const programId = typeof params.programId === 'string' ? params.programId : '';

  const { participants, participantId, setParticipantId } = useParticipantContext();
  const { areaId } = useAreaContext();
  const { isFavourite, toggleFavourite } = useFavourites();
  const { openProgram, openProvider } = useDetailNavigation();
  const { openBooking } = useBookingEntry();

  const [page, setPage] = useState<ProgramDetailPage | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const shareNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const simulateFailure = params['qa-fail'] === '1' && !retried;

  // Previous content stays visible while a participant switch reloads.
  useEffect(() => {
    let cancelled = false;
    detailsService
      .getProgramDetailPage({ programId, participantId, participants, areaId, simulateFailure })
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
  }, [programId, participantId, participants, areaId, simulateFailure]);

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

  const share = async () => {
    if (page === null) return;
    const outcome = await shareEntity('program', page.program.id, page.program.title);
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
            title="This program is no longer offered."
            message="It may have ended or moved. Browse current activities instead."
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

  const saved = page !== null && isFavourite('program', page.program.id);
  const price = page === null ? null : formatPrice(page.program.price);
  const ctaLabel =
    page === null
      ? 'Book'
      : page.program.price.kind === 'free'
        ? 'Book free session'
        : page.program.offer?.kind === 'freeTrial'
          ? 'Book free trial'
          : 'Book';
  const contentBottomPadding = 96 + insets.bottom + spacing.xl;

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: contentBottomPadding }}
        showsVerticalScrollIndicator={false}
      >
        {page === null ? (
          <ProgramDetailsSkeleton topInset={insets.top} />
        ) : (
          <>
            <View>
              <AppImage
                source={demoImage(page.program.imageKey)}
                style={styles.heroImage}
                accessibilityLabel={`${page.program.title} photo`}
              />
              {page.program.offer !== undefined || isLadiesOnly(page.program.eligibility) ? (
                <View style={styles.imageBadge}>
                  {page.program.offer !== undefined ? (
                    <Badge label={page.program.offer.label} variant="offer" />
                  ) : null}
                  {isLadiesOnly(page.program.eligibility) ? (
                    <Badge label="Ladies only" variant="eligibility" />
                  ) : null}
                </View>
              ) : null}
            </View>

            <View style={styles.content}>
              <Text style={styles.title} accessibilityRole="header">
                {page.program.title}
              </Text>

              {/* Provider row — the Program → Provider cross-link (HMA-014).
                  Round-trips back to a storefront directly beneath instead of
                  growing the stack (docs/20 §2.3). */}
              <PressableFeedback
                accessibilityLabel={`${page.provider.name}${page.provider.verified ? ', verified provider' : ', provider'}`}
                accessibilityHint="Opens the provider storefront"
                onPress={() => openProvider(page.provider.id)}
                style={styles.providerRow}
              >
                <View style={styles.monogram}>
                  <Text style={styles.monogramText}>{providerMonogram(page.provider.name)}</Text>
                </View>
                <View style={styles.providerText}>
                  <Text style={styles.providerName} numberOfLines={1}>
                    {page.provider.name}
                  </Text>
                  {page.provider.verified ? (
                    <View style={styles.verifiedRow}>
                      <Ionicons name="shield-checkmark" size={13} color={colors.brand.primary} />
                      <Text style={styles.verifiedText}>Verified provider</Text>
                    </View>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.text.secondary} />
              </PressableFeedback>

              <View
                style={styles.ratingRow}
                accessibilityLabel={`Rated ${page.program.rating.toFixed(1)} out of 5 from ${page.extras.reviewCount} reviews`}
              >
                <Ionicons name="star" size={15} color={colors.brand.reward} />
                <Text style={styles.ratingValue}>{page.program.rating.toFixed(1)}</Text>
                <Text style={styles.ratingCount}>({page.extras.reviewCount} reviews)</Text>
              </View>

              <View style={styles.factsRow}>
                <FactPill label={page.ageLabel} spoken={spokenAgeLabel(page.ageLabel)} />
                {page.program.eligibility.skillLevel !== undefined ? (
                  <FactPill label={SKILL_LABELS[page.program.eligibility.skillLevel]} />
                ) : null}
                <FactPill label={page.formatLabel} />
                <FactPill label={page.program.setting === 'indoor' ? 'Indoor' : 'Outdoor'} />
              </View>

              {page.suitability !== undefined ? (
                <View accessibilityLiveRegion="polite">
                  {page.suitability.suitable ? (
                    <View style={styles.suitableRow}>
                      <Ionicons name="checkmark-circle" size={18} color={colors.status.success} />
                      <Text style={styles.suitableText}>
                        Suitable for{' '}
                        {page.suitability.participantId === 'me' ? 'you' : page.suitability.label}
                        {page.suitability.participantId === 'me' ? '' : ` — ${page.suitability.reason}`}
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.unsuitableCard}>
                      <View style={styles.unsuitableHeader}>
                        <Ionicons name="information-circle" size={18} color={colors.status.error} />
                        <Text style={styles.unsuitableTitle}>
                          Not suitable for{' '}
                          {page.suitability.participantId === 'me' ? 'you' : page.suitability.label}{' '}
                          ({page.suitability.reason})
                        </Text>
                      </View>
                      {page.householdSuitability.some(
                        (entry) => entry.suitable && entry.participantId !== participantId,
                      ) ? (
                        <>
                          <Text style={styles.unsuitableHint}>Suitable for:</Text>
                          <View style={styles.recoveryChips}>
                            {page.householdSuitability
                              .filter(
                                (entry) =>
                                  entry.suitable && entry.participantId !== participantId,
                              )
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
                    </View>
                  )}
                </View>
              ) : null}

              <View style={styles.priceBlock}>
                {price !== null ? (
                  <View
                    style={styles.priceLine}
                    accessibilityLabel={spokenPriceLabel(page.program.price)}
                  >
                    <Text style={styles.priceAmount}>{price.amount}</Text>
                    {price.unit !== '' ? <Text style={styles.priceUnit}>{price.unit}</Text> : null}
                  </View>
                ) : null}
                {page.program.offer !== undefined ? (
                  <Text style={styles.offerLine}>{page.program.offer.label}</Text>
                ) : null}
              </View>

              <View style={styles.metaRow}>
                <Ionicons name="calendar-outline" size={16} color={colors.text.secondary} />
                <Text style={styles.metaText}>{page.program.scheduleLabel}</Text>
              </View>
              <View style={styles.metaRow}>
                <Ionicons name="location-outline" size={16} color={colors.text.secondary} />
                <Text style={styles.metaText}>
                  {page.areaLabel}
                  {page.branch !== undefined ? ` · ${page.branch.label}` : ''}
                </Text>
              </View>
              {page.branch !== undefined ? (
                <Text style={styles.branchDetail}>
                  {page.branch.addressLine}
                  {page.branch.openingHours !== undefined ? ` · ${page.branch.openingHours}` : ''}
                </Text>
              ) : null}

              <View>
                <DetailSectionTitle title="Upcoming sessions" />
                {page.sessions.length === 0 ? (
                  <Text style={styles.emptySessions}>
                    No upcoming sessions listed. Contact support for the next start date.
                  </Text>
                ) : (
                  <View style={styles.sessionList} accessibilityRole="list">
                    {page.sessions.map((session) => (
                      <View
                        key={session.id}
                        style={styles.sessionRow}
                        accessibilityLabel={`${session.dayLabel}, ${session.timeLabel}${
                          session.spotsLeft === 0
                            ? ', full'
                            : session.spotsLeft !== undefined
                              ? `, ${session.spotsLeft} places left`
                              : ''
                        }`}
                      >
                        <Text style={styles.sessionDay}>{session.dayLabel}</Text>
                        <Text style={styles.sessionTime}>{session.timeLabel}</Text>
                        {/* A zero-spot occurrence reads Full here too, so the
                            informational list and the booking flow share one
                            availability truth (docs/09 §21.5). */}
                        {session.spotsLeft === 0 ? (
                          <View style={styles.fullPill}>
                            <Text style={styles.fullPillText}>Full</Text>
                          </View>
                        ) : session.spotsLeft !== undefined ? (
                          <View style={styles.spotsPill}>
                            <Ionicons name="flame-outline" size={12} color={colors.text.primary} />
                            <Text style={styles.spotsText}>{session.spotsLeft} places left</Text>
                          </View>
                        ) : null}
                      </View>
                    ))}
                  </View>
                )}
              </View>

              <View>
                <DetailSectionTitle title="About this program" />
                <Text style={styles.bodyText}>{page.extras.description}</Text>
              </View>

              {page.extras.included !== undefined ? (
                <View>
                  <DetailSectionTitle title="What's included" />
                  <View style={styles.bulletList}>
                    {page.extras.included.map((item) => (
                      <View key={item} style={styles.bulletRow}>
                        <Ionicons name="checkmark" size={15} color={colors.status.success} />
                        <Text style={styles.bulletText}>{item}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {page.extras.bring !== undefined ? (
                <View>
                  <DetailSectionTitle title="What to bring" />
                  <View style={styles.bulletList}>
                    {page.extras.bring.map((item) => (
                      <View key={item} style={styles.bulletRow}>
                        <Ionicons name="ellipse" size={6} color={colors.text.secondary} />
                        <Text style={styles.bulletText}>{item}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {page.extras.instructorName !== undefined ? (
                <View>
                  <DetailSectionTitle title="Instructor" />
                  <View style={styles.instructorRow}>
                    <View style={styles.monogram}>
                      <Text style={styles.monogramText}>
                        {providerMonogram(page.extras.instructorName)}
                      </Text>
                    </View>
                    <View style={styles.providerText}>
                      <Text style={styles.providerName}>{page.extras.instructorName}</Text>
                      {page.extras.instructorTitle !== undefined ? (
                        <Text style={styles.instructorTitle}>{page.extras.instructorTitle}</Text>
                      ) : null}
                    </View>
                  </View>
                </View>
              ) : null}

              {page.extras.facilities !== undefined ? (
                <View>
                  <DetailSectionTitle title="Facilities" />
                  <View style={styles.factsRow}>
                    {page.extras.facilities.map((facility) => (
                      <FactPill key={facility} label={facility} />
                    ))}
                  </View>
                </View>
              ) : null}

              <View>
                <DetailSectionTitle title="Cancellation policy" />
                <View style={styles.policyCard}>
                  <Text style={styles.policyTitle}>{page.policy.title}</Text>
                  {page.policy.summaryLines.map((line) => (
                    <Text key={line} style={styles.policyLine}>
                      {line}
                    </Text>
                  ))}
                </View>
              </View>

              {page.program.eligibility.eligibilityNotes !== undefined ||
              page.extras.safetyNote !== undefined ? (
                <View style={styles.noteCard}>
                  <Ionicons
                    name="information-circle-outline"
                    size={17}
                    color={colors.brand.primary}
                  />
                  <Text style={styles.noteText}>
                    {[page.program.eligibility.eligibilityNotes, page.extras.safetyNote]
                      .filter((note) => note !== undefined)
                      .join(' ')}
                  </Text>
                </View>
              ) : null}

              {page.moreFromProvider.length > 0 ? (
                <View>
                  <DetailSectionTitle title={`More from ${page.provider.name}`} />
                  <View style={styles.moreList}>
                    {page.moreFromProvider.map((program) => (
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
              accessibilityLabel={`Share ${page.program.title}`}
              onPress={share}
            />
            <PressableFeedback
              accessibilityLabel={
                saved
                  ? `Remove ${page.program.title} from favourites`
                  : `Save ${page.program.title} to favourites`
              }
              accessibilityRole="checkbox"
              accessibilityState={{ checked: saved, selected: saved }}
              onPress={() => toggleFavourite('program', page.program.id)}
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

      {page !== null ? (
        <View style={[styles.ctaBar, { paddingBottom: insets.bottom + spacing.md }]}>
          <View style={styles.ctaPrice}>
            <Text style={styles.ctaPriceAmount}>{price?.amount}</Text>
            {price !== null && price.unit !== '' ? (
              <Text style={styles.ctaPriceUnit}>{price.unit}</Text>
            ) : null}
          </View>
          {/* Opens the booking flow (docs/21 §3.2). The CTA stays enabled even
              when the browsing participant is ineligible — booking-time
              participant selection is the real gate (docs/02 §8). */}
          <PressableFeedback
            accessibilityLabel={`${ctaLabel}: ${page.program.title}, ${spokenPriceLabel(page.program.price)}`}
            onPress={() => openBooking(page.program.id)}
            style={styles.ctaButton}
          >
            <Text style={styles.ctaButtonLabel} maxFontSizeMultiplier={1.4}>
              {ctaLabel}
            </Text>
          </PressableFeedback>
        </View>
      ) : null}
    </View>
  );
}

/** Section title inside the already-padded detail content column. */
function DetailSectionTitle({ title }: { title: string }) {
  return (
    <Text style={styles.sectionTitle} accessibilityRole="header">
      {title}
    </Text>
  );
}

function FactPill({ label, spoken }: { label: string; spoken?: string }) {
  return (
    <View style={styles.factPill} accessibilityLabel={spoken}>
      <Text style={styles.factPillText}>{label}</Text>
    </View>
  );
}

function ProgramDetailsSkeleton({ topInset }: { topInset: number }) {
  return (
    <View>
      <SkeletonBlock style={[styles.heroImage, { borderRadius: 0 }]} />
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
  heroImage: {
    width: '100%',
    height: 264,
  },
  imageBadge: {
    position: 'absolute',
    bottom: spacing.md,
    left: pagePadding,
    flexDirection: 'row',
    gap: spacing.xs,
  },
  content: {
    paddingHorizontal: pagePadding,
    paddingTop: spacing.lg,
    gap: spacing.lg,
  },
  title: {
    ...typography.screenTitle,
    color: colors.text.primary,
  },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.text.primary,
    letterSpacing: -0.3,
    marginBottom: spacing.md,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  monogram: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: {
    ...typography.chip,
    fontFamily: fontFamily.extraBold,
    color: colors.brand.primary,
  },
  providerText: { flex: 1, gap: 1 },
  providerName: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
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
  factsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  factPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.chip,
    backgroundColor: colors.brand.primarySoft,
  },
  factPillText: {
    ...typography.caption,
    color: colors.brand.primary,
  },
  suitableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  suitableText: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
    flexShrink: 1,
  },
  unsuitableCard: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  unsuitableHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  unsuitableTitle: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
    flexShrink: 1,
  },
  unsuitableHint: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  recoveryChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  priceBlock: { gap: 2 },
  priceLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  priceAmount: {
    ...typography.heroTitle,
    fontSize: 26,
    lineHeight: 32,
    color: colors.text.primary,
  },
  priceUnit: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  offerLine: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.brand.accentWarm,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  metaText: {
    ...typography.body,
    color: colors.text.primary,
    flexShrink: 1,
  },
  branchDetail: {
    ...typography.supporting,
    color: colors.text.secondary,
    marginTop: -spacing.sm,
    marginLeft: 16 + spacing.sm,
  },
  emptySessions: {
    ...typography.supporting,
    color: colors.text.secondary,
    paddingHorizontal: 0,
  },
  sessionList: { gap: spacing.sm },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.image,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  sessionDay: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
    width: 108,
  },
  sessionTime: {
    ...typography.supporting,
    color: colors.text.primary,
    flex: 1,
  },
  spotsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radii.chip,
    backgroundColor: colors.brand.reward,
  },
  spotsText: {
    ...typography.caption,
    color: colors.text.primary,
  },
  fullPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radii.chip,
    backgroundColor: colors.border.default,
  },
  fullPillText: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    color: colors.text.secondary,
  },
  bodyText: {
    ...typography.body,
    lineHeight: 23,
    color: colors.text.primary,
  },
  bulletList: { gap: spacing.sm },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 22,
  },
  bulletText: {
    ...typography.supporting,
    color: colors.text.primary,
    flexShrink: 1,
  },
  instructorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  instructorTitle: {
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
  noteCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  noteText: {
    ...typography.supporting,
    color: colors.text.primary,
    flexShrink: 1,
  },
  moreList: { gap: spacing.md },
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
  ctaBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.md,
    backgroundColor: colors.background.elevated,
    borderTopWidth: 1,
    borderTopColor: colors.border.default,
    ...shadows.sheet,
  },
  ctaPrice: { flexShrink: 1 },
  ctaPriceAmount: {
    ...typography.price,
    fontSize: 17,
    color: colors.text.primary,
  },
  ctaPriceUnit: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  ctaButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaButtonLabel: {
    ...typography.chip,
    fontSize: 16,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
  skeletonTitle: { height: 30, borderRadius: radii.image, width: '70%' },
  skeletonRow: { height: 56, borderRadius: radii.card },
  skeletonBlock: { height: 120, borderRadius: radii.card },
});
