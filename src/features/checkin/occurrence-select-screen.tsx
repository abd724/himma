/**
 * RI-4 — canonical occurrence selection for CampWeek/Cohort check-in
 * (docs/35 §26–§29; owner RI-4 §24–§26).
 *
 * The backend requires an EXPLICIT canonical occurrence (`date +
 * startTime`) for multi-occurrence Bookings. The choices here come
 * verbatim from the bounded SERVER occurrence projection (the same
 * canonical derivation the backend validates against) — the app never
 * reconstructs recurring rules, never builds dates from the booking span,
 * and never picks "whichever occurrence is closest to now". Two same-day
 * meetings at different times list separately; exception dates simply
 * never appear (the server omits them).
 */
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { issueForTarget } from '@/features/checkin/checkin-entry';
import { occurrenceChoices, type OccurrenceChoice } from '@/features/passes/passes-presentation';
import { entitlementsApi } from '@/services/composition';
import { customerErrorCopy } from '@/services/http/error-copy';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function isoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function OccurrenceSelectScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ bookingId?: string }>();
  const bookingId = typeof params.bookingId === 'string' ? params.bookingId : '';

  const [choices, setChoices] = useState<OccurrenceChoice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [issuingKey, setIssuingKey] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const lastPressAt = useRef(0);

  const load = useCallback(() => {
    let cancelled = false;
    // Yesterday is included so a just-after-midnight occurrence whose −60
    // window opened before midnight stays selectable; the server refuses
    // anything genuinely out of window.
    entitlementsApi.listOccurrences({ from: isoDate(-1), to: isoDate(55) }).then(
      (events) => {
        if (cancelled) return;
        setChoices(occurrenceChoices(events, bookingId));
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  useEffect(() => load(), [load, reloads]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(`/bookings/${bookingId}` as never);
  };

  const checkIn = async (choice: OccurrenceChoice) => {
    const key = `${choice.date}:${choice.startTime}`;
    setIssuingKey(key);
    setRefusal(null);
    try {
      const { href } = await issueForTarget(entitlementsApi, {
        kind: 'booking',
        bookingId,
        occurrence: { date: choice.date, startTime: choice.startTime },
      });
      router.push(href as never);
    } catch (error) {
      setRefusal(customerErrorCopy(error));
    } finally {
      setIssuingKey(null);
    }
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <Text style={styles.heading} accessibilityRole="header">
          Choose your day
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        showsVerticalScrollIndicator={false}
      >
        {failed ? (
          <ErrorStateCard onRetry={() => setReloads((value) => value + 1)} />
        ) : choices === null ? (
          <SkeletonBlock style={styles.skeleton} />
        ) : choices.length === 0 ? (
          <EmptyFeedCard
            title="No upcoming days to check in"
            message="This booking has no upcoming scheduled days in the next few weeks."
            actionLabel="Back to booking"
            onClearFilter={goBack}
          />
        ) : (
          <>
            <Text style={styles.intro}>
              Pick the day and time you’re attending — each one checks in separately.
            </Text>
            {refusal !== null ? (
              <Text style={styles.refusal} accessibilityLiveRegion="polite">
                {refusal}
              </Text>
            ) : null}
            <View style={styles.list}>
              {choices.map((choice) => {
                const key = `${choice.date}:${choice.startTime}`;
                const busy = issuingKey === key;
                return (
                  <PressableFeedback
                    key={key}
                    accessibilityLabel={`Check in for ${choice.dayLabel}, ${choice.timeLabel}`}
                    accessibilityState={{ disabled: issuingKey !== null }}
                    disabled={issuingKey !== null}
                    onPress={() => {
                      const now = Date.now();
                      if (now - lastPressAt.current < 700) return;
                      lastPressAt.current = now;
                      void checkIn(choice);
                    }}
                    style={[styles.row, issuingKey !== null && !busy && styles.rowDimmed]}
                    testID={`occurrence-${choice.date}-${choice.startTime.replace(':', '')}`}
                  >
                    <View style={styles.rowText}>
                      <Text style={styles.rowDay}>{choice.dayLabel}</Text>
                      <Text style={styles.rowTime}>{choice.timeLabel}</Text>
                    </View>
                    <Text style={styles.rowAction}>{busy ? 'Getting code…' : 'Check in'}</Text>
                  </PressableFeedback>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
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
  heading: {
    ...typography.sectionTitle,
    letterSpacing: -0.3,
    color: colors.text.primary,
    flex: 1,
  },
  content: {
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  skeleton: { height: 260, borderRadius: radii.card },
  intro: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  refusal: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  list: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  rowDimmed: { opacity: 0.5 },
  rowText: { gap: 2 },
  rowDay: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  rowTime: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  rowAction: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
});
