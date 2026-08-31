import { AppImage } from '@/components/ui/app-image';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { demoImage } from '@/data/mock/images';
import type { ScheduleEntry } from '@/services/contracts/schedule';
import { colors, fontFamily, pagePadding, radii, shadows, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

/**
 * The household's next booked session — Home's lead card (docs/18 §4.3).
 * Prominent but calm: no countdowns, no urgency. RI-5: opens the owning
 * Booking/Pass detail via the entry's EXPLICIT server identifier where one
 * exists (fixture entries stay inert with press feedback — docs/09 §17.2).
 */
export function UpcomingActivityCard({
  entry,
  onPress,
}: {
  entry: ScheduleEntry;
  onPress?: () => void;
}) {
  const forLine =
    entry.participantLabel === 'You' ? 'For you' : `For ${entry.participantLabel}`;
  const spokenFor = entry.participantLabel === 'You' ? 'for you' : `for ${entry.participantLabel}`;
  return (
    <View style={styles.wrap}>
      <PressableFeedback
        accessibilityLabel={`Upcoming activity: ${entry.programTitle} ${spokenFor}, ${entry.dayLabel} at ${entry.timeLabel}, ${entry.providerName}, ${entry.areaLabel}${onPress === undefined ? '' : '. Opens details'}`}
        onPress={onPress}
        style={styles.card}
      >
        <AppImage source={demoImage(entry.imageKey)} style={styles.image} />
        <View style={styles.info}>
          <Text style={styles.time}>
            {entry.dayLabel} · {entry.timeLabel}
          </Text>
          <Text style={styles.title} numberOfLines={2}>
            {entry.programTitle}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {forLine} · {entry.providerName}
          </Text>
          <Text style={styles.area} numberOfLines={1}>
            {entry.areaLabel}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.text.secondary} />
      </PressableFeedback>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: pagePadding },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    ...shadows.card,
  },
  image: {
    width: 84,
    height: 84,
    borderRadius: radii.image,
  },
  info: { flex: 1, gap: 2 },
  time: {
    ...typography.caption,
    color: colors.brand.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  title: {
    ...typography.cardTitle,
    color: colors.text.primary,
  },
  meta: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  area: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
});
