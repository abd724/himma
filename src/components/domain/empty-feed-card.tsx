import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  message: string;
  onClearFilter: () => void;
  /** Recovery action label; contexts with several filters pass a plural. */
  actionLabel?: string;
  /** Not-found contexts override the default zero-match headline. */
  title?: string;
}

/** Friendly empty state with a clear recovery action — docs/11 §6. */
export function EmptyFeedCard({
  message,
  onClearFilter,
  actionLabel = 'Clear filter',
  title = 'No matches right now',
}: Props) {
  return (
    <View style={styles.wrap}>
      {/* Announce the state change when this replaces list content. */}
      <View style={styles.card} accessibilityLiveRegion="polite">
        <View style={styles.iconCircle}>
          <Ionicons name="search-outline" size={26} color={colors.brand.primary} />
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.message}>{message}</Text>
        <PressableFeedback accessibilityLabel={actionLabel} onPress={onClearFilter} style={styles.button}>
          <Text style={styles.buttonLabel}>{actionLabel}</Text>
        </PressableFeedback>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: pagePadding },
  card: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  title: {
    ...typography.cardTitle,
    fontFamily: fontFamily.extraBold,
    color: colors.text.primary,
  },
  message: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
    maxWidth: 280,
  },
  button: {
    marginTop: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
});
