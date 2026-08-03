import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, fontFamily, pagePadding, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  areaLabel: string;
  onPressLocation: () => void;
}

/**
 * Discover's safe-area-aware header — screen title, shared location chip,
 * notification action. No wordmark (Home owns it) and no duplicate profile
 * action (docs/14 §2.1).
 */
export function DiscoverHeader({ areaLabel, onPressLocation }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.left}>
        <Text style={styles.title} accessibilityRole="header">
          Discover
        </Text>
        <PressableFeedback
          onPress={onPressLocation}
          accessibilityLabel={`Change area. Current area ${areaLabel}, Abu Dhabi`}
          style={styles.location}
          hitSlop={10}
        >
          <Ionicons name="location-outline" size={15} color={colors.brand.primary} />
          <Text style={styles.locationText} numberOfLines={1}>
            {areaLabel}, Abu Dhabi
          </Text>
          <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
        </PressableFeedback>
      </View>
      <IconButton icon="notifications-outline" accessibilityLabel="Notifications" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.background.main,
  },
  left: { flexShrink: 1, gap: 2 },
  title: {
    ...typography.screenTitle,
    color: colors.text.primary,
    letterSpacing: -0.5,
  },
  location: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 24,
  },
  locationText: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
});
