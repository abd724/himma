/**
 * RI-5 — the unified Himma Calendar (HMA-006 "Calendar or agenda" view):
 * the customer's activity schedule across all providers, rendered from the
 * certified bounded server Calendar read. Read-only — no reservation, no
 * credential issuance, no editing; opening an event navigates to the
 * owning Booking or Pass, where the certified RI-4 actions live.
 *
 * V1 shape: week navigation + a 7-day date strip + a chronological agenda
 * for the selected day. One bounded request covers the visible range;
 * fresh server truth on focus and on booking-change signals.
 */
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import {
  addDays,
  chipLabels,
  civilDate,
  contextLabel,
  dayHeading,
  daysWithEvents,
  eventsForDay,
  eventTarget,
  eventTimeLabel,
  spanLine,
  weekDates,
  weekRangeLabel,
  weekStart,
} from '@/features/calendar/calendar-presentation';
import {
  INITIAL_CALENDAR_STATE,
  loadFailed,
  loadStarted,
  loadSucceeded,
  requiredRequest,
  type CalendarRange,
} from '@/features/calendar/calendar-loader';
import { entitlementsApi } from '@/services/composition';
import type { CalendarOccurrence } from '@/services/contracts/entitlements';
import { useAccount } from '@/state/account-context';
import { subscribeBookingsChanged } from '@/state/bookings-events';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

const CIVIL_DATE_PARAM = /^\d{4}-\d{2}-\d{2}$/;

export function CalendarView({ initialDate }: { initialDate?: string }) {
  const router = useRouter();
  const account = useAccount();
  const selfParticipantId = account.account?.primaryParticipantId;
  const today = civilDate(new Date());
  const [selectedDate, setSelectedDate] = useState(
    initialDate !== undefined && CIVIL_DATE_PARAM.test(initialDate) ? initialDate : today,
  );
  const [state, setState] = useState(INITIAL_CALENDAR_STATE);
  // Effect-mirrored refs so callbacks read the CURRENT state/date without
  // re-subscribing the focus effect (selecting a day must never itself
  // force a re-fetch — one bounded request covers the visible range).
  const stateRef = useRef(state);
  const selectedRef = useRef(selectedDate);
  useEffect(() => {
    stateRef.current = state;
    selectedRef.current = selectedDate;
  });
  // The latest issued request wins; superseded responses are ignored by
  // the loader's range check AND this generation guard.
  const generation = useRef(0);

  const request = useCallback((range: CalendarRange) => {
    const mine = ++generation.current;
    setState((current) => loadStarted(current, range));
    entitlementsApi.listOccurrences(range).then(
      (events) => {
        if (generation.current !== mine) return;
        setState((current) => loadSucceeded(current, range, events));
      },
      () => {
        if (generation.current !== mine) return;
        setState((current) => loadFailed(current, range));
      },
    );
  }, []);

  const ensureLoaded = useCallback(
    (date: string, force = false) => {
      const needed = requiredRequest(stateRef.current, date, force);
      if (needed !== null) request(needed);
    },
    [request],
  );

  // Fresh server truth on every focus and on booking-change signals (a new
  // reservation appears via re-read — never an optimistic insert).
  useFocusEffect(
    useCallback(() => {
      ensureLoaded(selectedRef.current, true);
      const unsubscribe = subscribeBookingsChanged(() => ensureLoaded(selectedRef.current, true));
      return unsubscribe;
    }, [ensureLoaded]),
  );

  const selectDate = (date: string) => {
    setSelectedDate(date);
    ensureLoaded(date);
  };

  const start = weekStart(selectedDate);
  const days = weekDates(start);
  const events = state.events ?? [];
  const marked = daysWithEvents(events);
  const dayEvents = eventsForDay(events, selectedDate);
  const loading = state.events === null && !state.failed;

  return (
    <View style={styles.root}>
      <View style={styles.weekNav}>
        <PressableFeedback
          accessibilityLabel="Previous week"
          onPress={() => selectDate(addDays(start, -7))}
          style={styles.navButton}
          testID="calendar-prev-week"
        >
          <Ionicons name="chevron-back" size={18} color={colors.text.primary} />
        </PressableFeedback>
        <View style={styles.weekNavCenter}>
          <Text style={styles.weekLabel}>{weekRangeLabel(start)}</Text>
          {selectedDate !== today ? (
            <PressableFeedback
              accessibilityLabel="Go to today"
              onPress={() => selectDate(today)}
              style={styles.todayButton}
              testID="calendar-today"
            >
              <Text style={styles.todayLabel}>Today</Text>
            </PressableFeedback>
          ) : null}
        </View>
        <PressableFeedback
          accessibilityLabel="Next week"
          onPress={() => selectDate(addDays(start, 7))}
          style={styles.navButton}
          testID="calendar-next-week"
        >
          <Ionicons name="chevron-forward" size={18} color={colors.text.primary} />
        </PressableFeedback>
      </View>

      <View style={styles.strip} accessibilityRole="tablist">
        {days.map((day) => {
          const chip = chipLabels(day);
          const selected = day === selectedDate;
          return (
            <PressableFeedback
              key={day}
              accessibilityRole="tab"
              accessibilityLabel={`${dayHeading(day, today)}${marked.has(day) ? ', has activities' : ''}`}
              accessibilityState={{ selected }}
              onPress={() => selectDate(day)}
              style={[styles.chip, selected && styles.chipSelected]}
              testID={`calendar-day-${day}`}
            >
              <Text style={[styles.chipWeekday, selected && styles.chipTextSelected]}>
                {chip.weekday}
              </Text>
              <Text
                style={[
                  styles.chipDay,
                  day === today && styles.chipDayToday,
                  selected && styles.chipTextSelected,
                ]}
              >
                {chip.day}
              </Text>
              <View
                style={[
                  styles.chipDot,
                  marked.has(day) && (selected ? styles.chipDotSelected : styles.chipDotMarked),
                ]}
              />
            </PressableFeedback>
          );
        })}
      </View>

      <Text style={styles.dayHeading} accessibilityRole="header">
        {dayHeading(selectedDate, today)}
      </Text>

      {state.failed ? (
        <ErrorStateCard onRetry={() => ensureLoaded(selectedDate, true)} />
      ) : loading ? (
        <View style={styles.skeletons}>
          <SkeletonBlock style={styles.skeletonRow} />
          <SkeletonBlock style={styles.skeletonRow} />
        </View>
      ) : dayEvents.length === 0 ? (
        <View style={styles.emptyCard} testID="calendar-empty-day">
          <Text style={styles.emptyTitle}>Nothing scheduled this day</Text>
          <Text style={styles.emptyMessage}>
            Pick another day to see the rest of your schedule.
          </Text>
        </View>
      ) : (
        <View style={styles.agenda}>
          {dayEvents.map((event) => (
            <CalendarEventCard
              key={event.eventKey}
              event={event}
              selfParticipantId={selfParticipantId}
              onOpen={(target) =>
                target.kind === 'booking'
                  ? router.push(`/bookings/${target.bookingId}` as never)
                  : router.push(`/passes/${target.entitlementId}` as never)
              }
            />
          ))}
        </View>
      )}
    </View>
  );
}

function CalendarEventCard({
  event,
  selfParticipantId,
  onOpen,
}: {
  event: CalendarOccurrence;
  selfParticipantId: string | undefined;
  onOpen: (target: NonNullable<ReturnType<typeof eventTarget>>) => void;
}) {
  const target = eventTarget(event);
  const badge = contextLabel(event);
  const camp = spanLine(event);
  // Participant context stays visible on every event (owner item 10): a
  // family account's activities for different participants never merge.
  const forLine =
    event.participant.id === selfParticipantId ? 'For you' : `For ${event.participant.firstName}`;
  const time = eventTimeLabel(event);
  const label = `${time}, ${event.program.titleEn}, ${forLine.toLowerCase()}, ${event.provider.displayName}${
    badge !== null ? `, ${badge.toLowerCase()}` : ''
  }`;
  return (
    <PressableFeedback
      accessibilityLabel={target === null ? label : `${label}. Opens details`}
      onPress={target === null ? undefined : () => onOpen(target)}
      style={styles.eventCard}
      testID={`calendar-event-${event.eventKey}`}
    >
      <View style={styles.eventTime}>
        <Text style={styles.eventTimeLabel}>{time}</Text>
      </View>
      <View style={styles.eventBody}>
        <Text style={styles.eventTitle} numberOfLines={2}>
          {event.program.titleEn}
        </Text>
        <Text style={styles.eventMeta} numberOfLines={1}>
          {forLine} · {event.provider.displayName}
        </Text>
        {event.branch !== null ? (
          <Text style={styles.eventLocation} numberOfLines={1}>
            {event.branch.label}
          </Text>
        ) : null}
        {camp !== null ? <Text style={styles.eventSupport}>{camp}</Text> : null}
        {badge !== null ? (
          <View style={styles.badge}>
            <Ionicons name="checkmark-circle" size={12} color={colors.brand.primary} />
            <Text style={styles.badgeLabel}>{badge}</Text>
          </View>
        ) : null}
      </View>
      {target !== null ? (
        <Ionicons name="chevron-forward" size={16} color={colors.text.secondary} />
      ) : null}
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  weekNav: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: pagePadding,
    gap: spacing.sm,
  },
  navButton: {
    width: 44,
    height: 44,
    borderRadius: radii.chip,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekNavCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  weekLabel: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  todayButton: {
    minHeight: 28,
    paddingHorizontal: spacing.md,
    borderRadius: radii.chip,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayLabel: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  strip: {
    flexDirection: 'row',
    paddingHorizontal: pagePadding,
    gap: spacing.xs,
  },
  chip: {
    flex: 1,
    minHeight: 64,
    borderRadius: radii.chip,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    gap: 2,
  },
  chipSelected: {
    backgroundColor: colors.brand.primary,
    borderColor: colors.brand.primary,
  },
  chipWeekday: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  chipDay: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  chipDayToday: { color: colors.brand.primary },
  chipTextSelected: { color: colors.text.inverse },
  chipDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'transparent',
  },
  chipDotMarked: { backgroundColor: colors.brand.primary },
  chipDotSelected: { backgroundColor: colors.text.inverse },
  dayHeading: {
    ...typography.sectionTitle,
    fontSize: 18,
    lineHeight: 24,
    color: colors.text.primary,
    paddingHorizontal: pagePadding,
  },
  agenda: {
    paddingHorizontal: pagePadding,
    gap: spacing.md,
  },
  eventCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  eventTime: { width: 76 },
  eventTimeLabel: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  eventBody: { flex: 1, gap: 2 },
  eventTitle: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  eventMeta: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  eventLocation: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  eventSupport: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  badgeLabel: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  emptyCard: {
    marginHorizontal: pagePadding,
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  emptyTitle: {
    ...typography.cardTitle,
    color: colors.text.primary,
    textAlign: 'center',
  },
  emptyMessage: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  skeletons: {
    paddingHorizontal: pagePadding,
    gap: spacing.md,
  },
  skeletonRow: { height: 88, borderRadius: radii.card },
});
