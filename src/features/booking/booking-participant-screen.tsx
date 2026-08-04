import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import {
  bookingHref,
  bookingStepHref,
  participantSelectionValid,
  participantStepAccess,
} from '@/features/booking/booking-navigation';
import { buildParticipantRows, type ParticipantRow } from '@/features/booking/participant-rows';
import { programHref } from '@/features/details/detail-navigation';
import type { BookingOptionsPage } from '@/services/contracts/booking';
import { bookingService } from '@/services/mock/mock-booking-service';
import { useAccount } from '@/state/account-context';
import { useAreaContext } from '@/state/area-context';
import { useBookingSession } from '@/state/booking-session-context';
import { useParticipantContext } from '@/state/participant-context';
import { colors, fontFamily, pagePadding, radii, shadows, spacing, typography } from '@/theme';
import { ageRangeLabel } from '@/utils/eligibility';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Booking step — participant selection with inline eligibility (docs/21 §6,
 * docs/09 §21.2/§21.15). One participant per booking; the choice lives only
 * in the booking draft — the shared browsing context is never written here.
 * A valid selection's Continue pushes the summary step (docs/21 §3.2).
 */
export function BookingParticipantScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ programId?: string; 'qa-fail'?: string }>();
  const programId = typeof params.programId === 'string' ? params.programId : '';

  const account = useAccount();
  const { participants, participantId } = useParticipantContext();
  const { areaId } = useAreaContext();
  const { draft, dispatch } = useBookingSession();
  // Redirect decisions read the draft at response time, not render time.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const [page, setPage] = useState<BookingOptionsPage | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  const lastContinueAt = useRef(0);

  const simulateFailure = params['qa-fail'] === '1' && !retried;

  useEffect(() => {
    let cancelled = false;
    bookingService
      .getBookingOptions({ programId, participantId, participants, areaId, simulateFailure })
      .then(
        (result) => {
          if (cancelled) return;
          if (result === undefined) {
            setPage(null);
            setMissing(true);
            setFailed(false);
            return;
          }
          // Incomplete drafts (cold links) and non-bookable entry states are
          // owned by the selection route — docs/21 §3.2.
          if (participantStepAccess(result, draftRef.current) === 'redirect-selection') {
            router.replace(bookingHref(programId));
            return;
          }
          setPage(result);
          setMissing(false);
          setFailed(false);
          if (result.options.length === 1) {
            dispatch({ type: 'selectOption', optionId: result.options[0].id });
          }
          if (result.preselectedParticipantId !== undefined) {
            dispatch({
              type: 'preselectParticipant',
              participantId: result.preselectedParticipantId,
            });
          }
        },
        () => {
          if (!cancelled) setFailed(true);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [programId, participantId, participants, areaId, simulateFailure, dispatch, router]);

  // Exact-origin back: after a skipped selection the step beneath is Program
  // Details itself (the selection route was replaced) — docs/21 §3.2.
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(programHref(programId));
  };
  const browse = () => router.replace('/discover');

  const guest = account.account === null;
  const rows = page === null ? [] : buildParticipantRows(page.householdEligibility, participants);
  const noneEligible = page !== null && !guest && rows.every((row) => !row.suitable);
  const selectedRow = rows.find((row) => row.participantId === draft.participantId);
  const selectionValid =
    page !== null && participantSelectionValid(page.householdEligibility, draft.participantId);

  const selectedOption = page?.options.find((option) => option.id === draft.optionId);
  const selectedSession = selectedOption?.sessions.find(
    (session) => session.id === draft.sessionId,
  );
  const selectionRecap =
    selectedOption === undefined
      ? undefined
      : `${selectedOption.title}${selectedSession !== undefined ? ` · ${selectedSession.dayLabel}, ${selectedSession.timeLabel}` : ''}`;

  const statusLine = !selectionValid
    ? 'Choose who is attending'
    : `Booking for ${selectedRow?.displayName === 'You' ? 'you' : selectedRow?.displayName}`;
  const showCta = page !== null && !guest && !noneEligible;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <View style={styles.headerText}>
          <Text style={styles.heading} accessibilityRole="header">
            {guest ? 'Sign in to book' : 'Who is attending?'}
          </Text>
          {page !== null && !guest ? (
            <Text style={styles.progress}>
              {page.skipSelectionStep ? 'Step 1 of 2' : 'Step 2 of 3'}
            </Text>
          ) : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingBottom: showCta ? 120 + insets.bottom + spacing.xl : insets.bottom + spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {page === null && !missing && !failed ? (
          <ParticipantSkeleton />
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
        ) : page === null ? null : (
          <View style={styles.content}>
            <View style={styles.programCard}>
              <Text style={styles.programTitle} numberOfLines={2}>
                {page.program.title}
              </Text>
              <Text style={styles.programMeta} numberOfLines={1}>
                {page.provider.name}
                {page.branch !== undefined ? ` · ${page.branch.label}` : ''}
              </Text>
              {selectionRecap !== undefined ? (
                <Text style={styles.programRecap} numberOfLines={1}>
                  {selectionRecap}
                </Text>
              ) : null}
            </View>

            {guest ? (
              // Sign-in-required contract state — docs/09 §21.9. The action
              // stays inert with press feedback until authentication exists;
              // nothing is fabricated (no `Me`, no participant radios).
              <View style={styles.guestCard}>
                <View style={styles.guestIcon}>
                  <Ionicons name="person-circle-outline" size={26} color={colors.brand.primary} />
                </View>
                <Text style={styles.guestTitle}>Sign in to book</Text>
                <Text style={styles.guestMessage}>
                  Create an account or sign in to book activities for you and your family.
                </Text>
                <PressableFeedback accessibilityLabel="Sign in" style={styles.primaryAction}>
                  <Text style={styles.primaryActionLabel}>Sign in</Text>
                </PressableFeedback>
              </View>
            ) : noneEligible ? (
              <View style={styles.guestCard}>
                <View style={styles.guestIcon}>
                  <Ionicons
                    name="information-circle-outline"
                    size={26}
                    color={colors.brand.primary}
                  />
                </View>
                <Text style={styles.guestTitle}>None of your profiles can join this program.</Text>
                <Text style={styles.guestMessage}>
                  {page.program.title} is for{' '}
                  {(ageRangeLabel(page.program.eligibility) ?? 'All ages').toLowerCase()}.
                </Text>
                <PressableFeedback
                  accessibilityLabel="Back to program"
                  onPress={goBack}
                  style={styles.primaryAction}
                >
                  <Text style={styles.primaryActionLabel}>Back to program</Text>
                </PressableFeedback>
                <PressableFeedback
                  accessibilityLabel="Browse activities"
                  onPress={browse}
                  style={styles.secondaryAction}
                >
                  <Text style={styles.secondaryActionLabel}>Browse activities</Text>
                </PressableFeedback>
              </View>
            ) : (
              <View accessibilityRole="radiogroup" style={styles.rowList}>
                {rows.map((row) => (
                  <ParticipantRowControl
                    key={row.participantId}
                    row={row}
                    selected={row.participantId === draft.participantId}
                    onSelect={() =>
                      dispatch({ type: 'selectParticipant', participantId: row.participantId })
                    }
                  />
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {showCta ? (
        <View style={[styles.ctaBar, { paddingBottom: insets.bottom + spacing.md }]}>
          <View style={styles.ctaStatus} accessibilityLiveRegion="polite">
            <Text style={styles.ctaStatusText} numberOfLines={2}>
              {statusLine}
            </Text>
          </View>
          <PressableFeedback
            accessibilityLabel={selectionValid ? `Continue: ${statusLine}` : statusLine}
            accessibilityState={{ disabled: !selectionValid }}
            onPress={() => {
              if (!selectionValid) return;
              // One press, one summary route (double-tap guard).
              const now = Date.now();
              if (now - lastContinueAt.current < 700) return;
              lastContinueAt.current = now;
              router.push(bookingStepHref(programId, 'summary'));
            }}
            style={[styles.ctaButton, !selectionValid && styles.ctaButtonDisabled]}
          >
            <Text
              style={[styles.ctaButtonLabel, !selectionValid && styles.ctaButtonLabelDisabled]}
              maxFontSizeMultiplier={1.4}
            >
              Continue
            </Text>
          </PressableFeedback>
        </View>
      ) : null}
    </View>
  );
}

function ParticipantRowControl({
  row,
  selected,
  onSelect,
}: {
  row: ParticipantRow;
  selected: boolean;
  onSelect: () => void;
}) {
  if (!row.suitable) {
    // Visible, disabled, and explained — never hidden, no press feedback
    // suggesting it can be chosen (docs/09 §21.15, docs/04 HMA-019).
    return (
      <View
        accessible
        accessibilityRole="radio"
        accessibilityState={{ checked: false, disabled: true }}
        accessibilityLabel={row.accessibilityLabel}
        style={[styles.participantRow, styles.participantRowDisabled]}
      >
        <View style={styles.participantText}>
          <Text style={[styles.participantName, styles.participantTextDisabled]}>
            {row.displayName}
          </Text>
          {row.detailLine !== undefined ? (
            <Text style={[styles.participantDetail, styles.participantTextDisabled]}>
              {row.detailLine}
            </Text>
          ) : null}
        </View>
        <View style={styles.notSuitablePill}>
          <Text style={styles.notSuitablePillText}>Not suitable</Text>
        </View>
        <Ionicons name="radio-button-off" size={22} color={colors.border.default} />
      </View>
    );
  }
  return (
    <PressableFeedback
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, selected }}
      accessibilityLabel={row.accessibilityLabel}
      onPress={onSelect}
      style={[styles.participantRow, selected && styles.participantRowSelected]}
    >
      <View style={styles.participantText}>
        <Text style={styles.participantName}>{row.displayName}</Text>
        {row.detailLine !== undefined ? (
          <Text style={styles.participantDetail}>{row.detailLine}</Text>
        ) : null}
      </View>
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={22}
        color={selected ? colors.brand.primary : colors.border.default}
      />
    </PressableFeedback>
  );
}

function ParticipantSkeleton() {
  return (
    <View style={styles.content}>
      <SkeletonBlock style={styles.skeletonCard} />
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
    gap: spacing.lg,
  },
  stateWrap: { paddingTop: spacing.xl },
  programCard: {
    gap: 2,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  programTitle: {
    ...typography.cardTitle,
    color: colors.text.primary,
  },
  programMeta: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  programRecap: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
    marginTop: 2,
  },
  rowList: { gap: spacing.sm },
  participantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 64,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  participantRowSelected: {
    borderColor: colors.brand.primary,
    borderWidth: 2,
  },
  participantRowDisabled: {
    backgroundColor: colors.background.main,
  },
  participantText: { flex: 1, gap: 1 },
  participantName: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  participantDetail: {
    ...typography.supporting,
    color: colors.text.secondary,
    flexShrink: 1,
  },
  participantTextDisabled: {
    color: colors.text.secondary,
  },
  notSuitablePill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radii.chip,
    backgroundColor: colors.border.default,
  },
  notSuitablePillText: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    color: colors.text.secondary,
  },
  guestCard: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  guestIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  guestTitle: {
    ...typography.cardTitle,
    fontFamily: fontFamily.extraBold,
    color: colors.text.primary,
    textAlign: 'center',
  },
  guestMessage: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
    maxWidth: 280,
  },
  primaryAction: {
    marginTop: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
  secondaryAction: {
    minHeight: 44,
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryActionLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
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
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaButtonDisabled: {
    backgroundColor: colors.border.default,
  },
  ctaButtonLabel: {
    ...typography.chip,
    fontSize: 16,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
  ctaButtonLabelDisabled: {
    color: colors.text.secondary,
  },
  skeletonCard: { height: 72, borderRadius: radii.card },
  skeletonRow: { height: 64, borderRadius: radii.card },
});
