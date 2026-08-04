import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { AppImage } from '@/components/ui/app-image';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import {
  bookingHref,
  bookingStepHref,
  summaryStepAccess,
} from '@/features/booking/booking-navigation';
import {
  spokenBookingPriceLabel,
  summaryParticipantBlock,
} from '@/features/booking/summary-presentation';
import { demoImage } from '@/data/mock/images';
import type { BookingOptionsPage, BookingSummary } from '@/services/contracts/booking';
import { bookingService } from '@/services/mock/mock-booking-service';
import { useAreaContext } from '@/state/area-context';
import { useBookingSession } from '@/state/booking-session-context';
import { useParticipantContext } from '@/state/participant-context';
import { colors, fontFamily, pagePadding, radii, shadows, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Booking summary — docs/21 §8, owner decisions docs/09 §21. Renders only a
 * fully re-validated draft (invalid drafts redirect, never render broken);
 * shows the catalogue price as `Booking price` with no VAT, fees, or
 * discount arithmetic (docs/09 §21.10–§21.11); and ends at the Continue to
 * checkout contract — inert with press feedback, no route, no sheet, no
 * payment, nothing reserved (docs/09 §21.8, docs/08 §14).
 */
export function BookingSummaryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ programId?: string; 'qa-fail'?: string }>();
  const programId = typeof params.programId === 'string' ? params.programId : '';

  const { participants } = useParticipantContext();
  const { areaId, areaLabelById } = useAreaContext();
  const { draft } = useBookingSession();
  // Redirect decisions read the draft at response time, not render time.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const [page, setPage] = useState<BookingOptionsPage | null>(null);
  const [summary, setSummary] = useState<BookingSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);

  const simulateFailure = params['qa-fail'] === '1' && !retried;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      bookingService.getBookingOptions({
        programId,
        // Preselection is irrelevant here; the draft already owns the choice.
        participantId: 'everyone',
        participants,
        areaId,
        simulateFailure,
      }),
      bookingService.getBookingSummary({
        draft: draftRef.current,
        participants,
        areaId,
        simulateFailure,
      }),
    ]).then(
      ([optionsPage, summaryResult]) => {
        if (cancelled) return;
        if (optionsPage === undefined) {
          setMissing(true);
          setFailed(false);
          return;
        }
        // Invalid or incomplete drafts never render — each failure redirects
        // to the step that owns the fix (docs/21 §3.2, §11).
        const access = summaryStepAccess(optionsPage, draftRef.current);
        if (access === 'redirect-selection' || summaryResult === undefined) {
          router.replace(bookingHref(programId));
          return;
        }
        if (access === 'redirect-participant') {
          router.replace(bookingStepHref(programId, 'participant'));
          return;
        }
        setPage(optionsPage);
        setSummary(summaryResult);
        setMissing(false);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [programId, participants, areaId, simulateFailure, router]);

  // Back returns to the participant step — the summary is only ever pushed
  // from it (docs/21 §3.2); the replace fallback covers stackless edge cases.
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(bookingStepHref(programId, 'participant'));
  };
  const browse = () => router.replace('/discover');
  const changeParticipant = goBack;
  // Change session pops back to the selection step so the flow's exact-origin
  // back chain stays intact; the draft (and its participant) survives because
  // the flow's provider stays mounted (docs/21 §10).
  const changeSession = () => router.dismissTo(bookingHref(programId));

  const ready = page !== null && summary !== null;
  const participantBlock =
    summary === null ? undefined : summaryParticipantBlock(summary.participant, participants);
  const spokenPrice = summary === null ? '' : spokenBookingPriceLabel(summary.bookingPriceLabel);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <View style={styles.headerText}>
          <Text style={styles.heading} accessibilityRole="header">
            Review your booking
          </Text>
          {ready ? (
            <Text style={styles.progress}>
              {page.skipSelectionStep ? 'Step 2 of 2' : 'Step 3 of 3'}
            </Text>
          ) : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingBottom: ready ? 132 + insets.bottom + spacing.xl : insets.bottom + spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {!ready && !missing && !failed ? (
          <SummarySkeleton />
        ) : missing ? (
          <View style={styles.stateWrap}>
            <EmptyFeedCard
              title="This program is no longer offered."
              message="It may have ended or moved. Browse current activities instead."
              actionLabel="Browse activities"
              onClearFilter={browse}
            />
          </View>
        ) : failed ? (
          <View style={styles.stateWrap}>
            <ErrorStateCard onRetry={() => setRetried(true)} />
          </View>
        ) : !ready || participantBlock === undefined ? null : (
          <View style={styles.content}>
            {/* Program block — docs/21 §8.2. */}
            <View style={styles.programCard}>
              <AppImage source={demoImage(summary.program.imageKey)} style={styles.thumbnail} />
              <View style={styles.programText}>
                <Text style={styles.programTitle} numberOfLines={2}>
                  {summary.program.title}
                </Text>
                <View style={styles.providerRow}>
                  <Text style={styles.programMeta} numberOfLines={1}>
                    {summary.provider.name}
                  </Text>
                  {summary.provider.verified ? (
                    <Ionicons
                      name="shield-checkmark"
                      size={13}
                      color={colors.brand.primary}
                      accessibilityLabel="Verified provider"
                    />
                  ) : null}
                </View>
                <Text style={styles.programMeta} numberOfLines={1}>
                  {areaLabelById.get(summary.program.areaId) ?? ''}
                  {summary.branch === undefined ? '' : ` · ${summary.branch.label}`}
                </Text>
              </View>
            </View>

            {/* Participant block — docs/21 §8.3. */}
            <View style={styles.block}>
              <View style={styles.blockHeader}>
                <Text style={styles.blockLabel}>Participant</Text>
                <PressableFeedback
                  accessibilityRole="button"
                  accessibilityLabel="Change participant"
                  onPress={changeParticipant}
                  style={styles.changeAction}
                >
                  <Text style={styles.changeActionLabel}>Change participant</Text>
                </PressableFeedback>
              </View>
              <View accessible accessibilityLabel={participantBlock.accessibilityLabel}>
                <Text style={styles.blockTitle}>
                  {participantBlock.displayName}
                  {participantBlock.detailLine === undefined
                    ? ''
                    : ` · ${participantBlock.detailLine}`}
                </Text>
                <View style={styles.confirmationRow}>
                  <Ionicons name="checkmark-circle" size={16} color={colors.status.success} />
                  <Text style={styles.confirmationText}>{participantBlock.confirmation}</Text>
                </View>
              </View>
            </View>

            {/* Selection block — docs/21 §8.4; Change session only when a
                real selection step exists (skip rule). */}
            <View style={styles.block}>
              <View style={styles.blockHeader}>
                <Text style={styles.blockLabel}>Your selection</Text>
                {page.skipSelectionStep ? null : (
                  <PressableFeedback
                    accessibilityRole="button"
                    accessibilityLabel="Change session"
                    onPress={changeSession}
                    style={styles.changeAction}
                  >
                    <Text style={styles.changeActionLabel}>Change session</Text>
                  </PressableFeedback>
                )}
              </View>
              <Text style={styles.blockTitle}>{summary.option.title}</Text>
              {summary.selectionLines.map((line) => (
                <Text key={line} style={styles.blockLine}>
                  {line}
                </Text>
              ))}
            </View>

            {/* Price block — docs/21 §9: catalogue price only. */}
            <View style={styles.block}>
              <Text style={styles.blockLabel}>Price</Text>
              {summary.priceLines.map((line) => (
                <View key={line.label} style={styles.priceRow}>
                  <Text style={styles.blockLine}>{line.label}</Text>
                  <Text style={styles.priceValue}>{line.value}</Text>
                </View>
              ))}
              {summary.offerLine === undefined ? null : (
                <View style={styles.offerRow}>
                  <Ionicons name="pricetag-outline" size={14} color={colors.brand.primary} />
                  <Text style={styles.offerText}>{summary.offerLine}</Text>
                </View>
              )}
              <View
                style={styles.bookingPriceRow}
                accessible
                accessibilityLabel={spokenPrice}
              >
                <Text style={styles.bookingPriceText}>{summary.bookingPriceLabel}</Text>
              </View>
            </View>

            {/* Cancellation summary — display-only preset (docs/09 §21.12). */}
            <View style={styles.block}>
              <Text style={styles.blockLabel}>Cancellation policy</Text>
              <Text style={styles.blockTitle}>{summary.policy.title}</Text>
              {summary.policy.summaryLines.map((line) => (
                <Text key={line} style={styles.blockLine}>
                  {line}
                </Text>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {ready ? (
        <View style={[styles.ctaBar, { paddingBottom: insets.bottom + spacing.md }]}>
          <View style={styles.ctaStatus} accessibilityLiveRegion="polite">
            <Text style={styles.ctaStatusText} numberOfLines={2}>
              {summary.bookingPriceLabel}
            </Text>
          </View>
          {/* Continue to checkout is a contract, not a pretense — inert with
              press feedback until the Checkout milestone (docs/09 §21.8). */}
          <PressableFeedback
            accessibilityRole="button"
            accessibilityLabel={`Continue to checkout, ${spokenPrice}`}
            style={styles.ctaButton}
          >
            <Text style={styles.ctaButtonLabel} maxFontSizeMultiplier={1.4}>
              Continue to checkout
            </Text>
          </PressableFeedback>
        </View>
      ) : null}
    </View>
  );
}

function SummarySkeleton() {
  return (
    <View style={styles.content}>
      <SkeletonBlock style={styles.skeletonCard} />
      <SkeletonBlock style={styles.skeletonRow} />
      <SkeletonBlock style={styles.skeletonRow} />
      <SkeletonBlock style={styles.skeletonRow} />
      <SkeletonBlock style={styles.skeletonRow} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: pagePadding,
    paddingBottom: spacing.md,
  },
  headerText: { flex: 1, gap: 1 },
  heading: {
    ...typography.sectionTitle,
    letterSpacing: -0.3,
    color: colors.text.primary,
  },
  progress: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  content: {
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  stateWrap: { paddingTop: spacing.xl },
  programCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  thumbnail: {
    width: 64,
    height: 64,
    borderRadius: radii.image,
  },
  programText: { flex: 1, gap: 2 },
  programTitle: {
    ...typography.cardTitle,
    color: colors.text.primary,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  programMeta: {
    ...typography.supporting,
    color: colors.text.secondary,
    flexShrink: 1,
  },
  block: {
    gap: spacing.xs,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  blockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  blockLabel: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.text.secondary,
  },
  changeAction: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    marginRight: -spacing.sm,
    marginVertical: -spacing.sm,
  },
  changeActionLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  blockTitle: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  blockLine: {
    ...typography.supporting,
    color: colors.text.secondary,
    flexShrink: 1,
  },
  confirmationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  confirmationText: {
    ...typography.supporting,
    color: colors.status.success,
    fontFamily: fontFamily.semiBold,
    flexShrink: 1,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  priceValue: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  offerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  offerText: {
    ...typography.supporting,
    color: colors.brand.primary,
    flexShrink: 1,
  },
  bookingPriceRow: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border.default,
  },
  bookingPriceText: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
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
  ctaStatus: { flex: 1 },
  ctaStatusText: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  ctaButton: {
    minHeight: 52,
    paddingHorizontal: spacing.xl,
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
  skeletonCard: { height: 88, borderRadius: radii.card },
  skeletonRow: { height: 96, borderRadius: radii.card },
});
