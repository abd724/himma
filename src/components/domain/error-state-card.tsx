import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  onRetry: () => void;
}

/** Network/error state with a recovery action — docs/16 §2. */
export function ErrorStateCard({ onRetry }: Props) {
  return (
    <View style={styles.wrap}>
      {/* Announce the state change when this replaces list content. */}
      <View style={styles.card} accessibilityLiveRegion="polite">
        <View style={styles.iconCircle}>
          <Ionicons name="cloud-offline-outline" size={26} color={colors.brand.primary} />
        </View>
        <Text style={styles.title}>Can’t load activities right now</Text>
        <Text style={styles.message}>Check your connection and try again.</Text>
        <PressableFeedback accessibilityLabel="Retry" onPress={onRetry} style={styles.button}>
          <Text style={styles.buttonLabel}>Retry</Text>
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
    textAlign: 'center',
  },
  message: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
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
