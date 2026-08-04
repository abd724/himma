import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { programHref } from '@/features/details/detail-navigation';
import type {
  BookingOption,
  BookingOptionsPage,
  SessionOption,
} from '@/services/contracts/booking';
import { bookingService } from '@/services/mock/mock-booking-service';
import { useAreaContext } from '@/state/area-context';
import { useBookingSession } from '@/state/booking-session-context';
import { useParticipantContext } from '@/state/participant-context';
import { colors, fontFamily, pagePadding, radii, shadows, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Booking step 1 — session/plan selection (docs/21 §5, owner decisions
 * docs/09 §21). Selection is the only thing that happens here: nothing is
 * reserved, held, or implied to be held (docs/08 §14). The Continue action
 * is inert with press feedback until the participant step ships in
 * Commit 13 (docs/09 §17.2).
 */
export function BookingSelectionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ programId?: string; 'qa-fail'?: string }>();
  const programId = typeof params.programId === 'string' ? params.programId : '';

  const { participants, participantId } = useParticipantContext();
  const { areaId } = useAreaContext();
  const { draft, dispatch } = useBookingSession();

  const [page, setPage] = useState<BookingOptionsPage | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);

  const simulateFailure = params['qa-fail'] === '1' && !retried;

  useEffect(() => {
    let cancelled = false;
    bookingService
      .getBookingOptions({ programId, participantId, participants, areaId, simulateFailure })
      .then(
        (result) => {
          if (cancelled) return;
          setPage(result ?? null);
          setMissing(result === undefined);
          setFailed(false);
          // A single option needs no explicit choice — select it so the
          // session list (or plan card) is immediately actionable.
          if (result !== undefined && result.options.length === 1) {
            dispatch({ type: 'selectOption', optionId: result.options[0].id });
          }
        },
        () => {
          if (!cancelled) setFailed(true);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [programId, participantId, participants, areaId, simulateFailure, dispatch]);

  // Exact-origin back; a cold deep link falls back to the evaluation surface
  // (docs/21 §3.2), never to a dead end.
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(programHref(programId));
  };

  const browse = () => router.replace('/discover');

  const selectedOption = page?.options.find((option) => option.id === draft.optionId);
  const selectedSession = selectedOption?.sessions.find(
    (session) => session.id === draft.sessionId,
  );
  const selectionValid =
    selectedOption !== undefined &&
    (!selectedOption.requiresSession ||
      (selectedSession !== undefined && selectedSession.availability !== 'full'));

  const heading =
    page === null || page.availability.status !== 'bookable'
      ? 'Book'
      : page.options.length > 1
        ? 'How would you like to start?'
        : page.options[0].requiresSession
          ? page.options[0].kind === 'camp-week'
            ? 'Choose a week'
            : 'Choose a session'
          : 'Your plan';

  const statusLine =
    selectedOption === undefined
      ? 'Choose an option to continue'
      : selectedOption.requiresSession && selectedSession === undefined
        ? selectedOption.kind === 'camp-week'
          ? 'Choose a week to continue'
          : 'Choose a session to continue'
        : `${selectedOption.priceLabel}${selectedSession !== undefined ? ` · ${selectedSession.dayLabel}` : ''}`;

  const showCta = page !== null && page.availability.status === 'bookable';

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <View style={styles.headerText}>
          <Text style={styles.heading} accessibilityRole="header">
            {heading}
          </Text>
          {showCta ? <Text style={styles.progress}>Step 1 of 3</Text> : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingBottom: showCta ? 120 + insets.bottom + spacing.xl : insets.bottom + spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {page === null && !missing && !failed ? (
          <SelectionSkeleton />
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
              {page.availability.status === 'bookable' &&
              page.options.length === 1 &&
              page.options[0].requiresSession ? (
                <Text style={styles.programPrice}>{page.options[0].priceLabel}</Text>
              ) : null}
            </View>

            {page.availability.status === 'registrationClosed' ? (
              <EmptyFeedCard
                title="Registration has closed"
                message={`${page.availability.reason} Browse current activities instead.`}
                actionLabel="Browse activities"
                onClearFilter={browse}
              />
            ) : page.availability.status === 'noSessions' ? (
              <EmptyFeedCard
                title="No upcoming sessions listed"
                message="Contact support for the next start date, or browse other activities."
                actionLabel="Browse activities"
                onClearFilter={browse}
              />
            ) : (
              <>
                {page.options.length > 1 ? (
                  <View accessibilityRole="radiogroup" style={styles.optionList}>
                    {page.options.map((option) => (
                      <OptionRow
                        key={option.id}
                        option={option}
                        selected={option.id === draft.optionId}
                        onSelect={() => dispatch({ type: 'selectOption', optionId: option.id })}
                      />
                    ))}
                  </View>
                ) : null}

                {selectedOption !== undefined && !selectedOption.requiresSession ? (
                  <View style={styles.planCard}>
                    {page.options.length === 1 ? (
                      <>
                        <Text style={styles.planTitle}>{selectedOption.title}</Text>
                        <Text style={styles.planPrice}>{selectedOption.priceLabel}</Text>
                      </>
                    ) : null}
                    {selectedOption.detailLines.map((line) => (
                      <Text key={line} style={styles.planLine}>
                        {line}
                      </Text>
                    ))}
                  </View>
                ) : null}

                {selectedOption !== undefined && selectedOption.requiresSession ? (
                  <View>
                    {page.options.length > 1 ? (
                      <Text style={styles.sessionListTitle} accessibilityRole="header">
                        {selectedOption.kind === 'camp-week' ? 'Choose a week' : 'Choose a session'}
                      </Text>
                    ) : null}
                    <View accessibilityRole="radiogroup" style={styles.sessionList}>
                      {selectedOption.sessions.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          selected={session.id === draft.sessionId}
                          onSelect={() =>
                            dispatch({ type: 'selectSession', sessionId: session.id })
                          }
                        />
                      ))}
                    </View>
                  </View>
                ) : null}
              </>
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
          {/* Continue is inert with press feedback until the participant step
              ships in Commit 13 (docs/09 §17.2) — no placeholder screen. */}
          <PressableFeedback
            accessibilityLabel={selectionValid ? `Continue: ${statusLine}` : statusLine}
            accessibilityState={{ disabled: !selectionValid }}
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

function OptionRow({
  option,
  selected,
  onSelect,
}: {
  option: BookingOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <PressableFeedback
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, selected }}
      accessibilityLabel={`${option.title}, ${option.priceLabel}`}
      onPress={onSelect}
      style={[styles.optionRow, selected && styles.rowSelected]}
    >
      <View style={styles.optionText}>
        <Text style={styles.optionTitle}>{option.title}</Text>
        <Text style={styles.optionPrice}>{option.priceLabel}</Text>
      </View>
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={22}
        color={selected ? colors.brand.primary : colors.border.default}
      />
    </PressableFeedback>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const full = session.availability === 'full';
  if (full) {
    // Visible, disabled, and explained — never hidden, and no press feedback
    // that would suggest it can be chosen (docs/09 §21.3).
    return (
      <View
        accessible
        accessibilityRole="radio"
        accessibilityState={{ checked: false, disabled: true }}
        accessibilityLabel={`${session.dayLabel}, ${session.timeLabel}, full. This session is full.`}
        style={[styles.sessionRow, styles.sessionRowFull]}
      >
        <View style={styles.sessionText}>
          <Text style={[styles.sessionDay, styles.sessionTextFull]}>{session.dayLabel}</Text>
          <Text style={[styles.sessionTime, styles.sessionTextFull]}>{session.timeLabel}</Text>
        </View>
        <View style={styles.fullPill}>
          <Text style={styles.fullPillText}>Full</Text>
        </View>
        <Ionicons name="radio-button-off" size={22} color={colors.border.default} />
      </View>
    );
  }
  return (
    <PressableFeedback
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, selected }}
      accessibilityLabel={`${session.dayLabel}, ${session.timeLabel}${
        session.spotsLeft !== undefined ? `, ${session.spotsLeft} places left` : ''
      }`}
      onPress={onSelect}
      style={[styles.sessionRow, selected && styles.rowSelected]}
    >
      <View style={styles.sessionText}>
        <Text style={styles.sessionDay}>{session.dayLabel}</Text>
        <Text style={styles.sessionTime}>{session.timeLabel}</Text>
      </View>
      {session.spotsLeft !== undefined ? (
        <View style={styles.spotsPill}>
          <Ionicons name="flame-outline" size={12} color={colors.text.primary} />
          <Text style={styles.spotsText}>{session.spotsLeft} places left</Text>
        </View>
      ) : null}
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={22}
        color={selected ? colors.brand.primary : colors.border.default}
      />
    </PressableFeedback>
  );
}

function SelectionSkeleton() {
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
  programPrice: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
    marginTop: 2,
  },
  optionList: { gap: spacing.sm },
  optionRow: {
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
  optionText: { flex: 1, gap: 1 },
  optionTitle: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  optionPrice: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  rowSelected: {
    borderColor: colors.brand.primary,
    borderWidth: 2,
  },
  planCard: {
    gap: spacing.xs,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  planTitle: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  planPrice: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  planLine: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  sessionListTitle: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  sessionList: { gap: spacing.sm },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.image,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  sessionRowFull: {
    backgroundColor: colors.background.main,
  },
  sessionText: { flex: 1, gap: 1 },
  sessionDay: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  sessionTime: {
    ...typography.supporting,
    color: colors.text.primary,
  },
  sessionTextFull: {
    color: colors.text.secondary,
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
  skeletonRow: { height: 56, borderRadius: radii.image },
});
