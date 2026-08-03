import { PressableFeedback } from '@/components/ui/pressable-feedback';
import type { WeekDay } from '@/services/contracts/home-feed';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Compact 7-day schedule preview — docs/18 §4.4. Only days with booked
 * sessions render; rows grow with Dynamic Type rather than truncating.
 * Opens the Bookings tab once HMA-006 ships; inert until then.
 */
export function WeekStrip({ days }: { days: WeekDay[] }) {
  return (
    <View style={styles.wrap}>
      <PressableFeedback accessibilityLabel="Your week. Opens your full schedule" style={styles.card}>
        {days.map((day, index) => (
          <View
            key={day.dayOffset}
            style={[styles.dayRow, index > 0 ? styles.dayRowDivider : null]}
          >
            <Text style={[styles.dayLabel, day.dayOffset === 0 ? styles.dayLabelToday : null]}>
              {day.dayLabel}
            </Text>
            <View style={styles.sessions}>
              {day.entries.map((entry) => (
                <View
                  key={entry.id}
                  style={styles.session}
                  accessible
                  accessibilityLabel={`${day.dayLabel}, ${entry.timeLabel}: ${entry.programTitle} for ${entry.participantLabel === 'You' ? 'you' : entry.participantLabel}`}
                >
                  <Text style={styles.sessionTime}>{entry.timeLabel}</Text>
                  <View style={styles.sessionInfo}>
                    <Text style={styles.sessionTitle} numberOfLines={1}>
                      {entry.programTitle}
                    </Text>
                    <Text style={styles.sessionParticipant} numberOfLines={1}>
                      {entry.participantLabel}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ))}
      </PressableFeedback>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: pagePadding },
  card: {
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    paddingHorizontal: spacing.lg,
  },
  dayRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 44,
  },
  dayRowDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.border.default,
  },
  dayLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    width: 56,
    paddingTop: 2,
  },
  dayLabelToday: {
    color: colors.brand.primary,
  },
  sessions: { flex: 1, gap: spacing.sm },
  session: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
  },
  sessionTime: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
    width: 64,
    paddingTop: 1,
  },
  sessionInfo: { flex: 1, gap: 0 },
  sessionTitle: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  sessionParticipant: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
});
