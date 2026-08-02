import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import type { CreditSummary } from '@/types/domain';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

/** Compact credit preview — no balance logic, tap feedback only (docs/11 §4.12). */
export function CreditStrip({ credit }: { credit: CreditSummary }) {
  return (
    <View style={styles.wrap}>
      <PressableFeedback
        accessibilityLabel={`Marketplace credit. AED ${credit.availableCredit} available. Use it at checkout when you book`}
        style={styles.card}
      >
        <View style={styles.iconWrap}>
          <Ionicons name="gift-outline" size={20} color={colors.text.primary} />
        </View>
        <View style={styles.textWrap}>
          <Text style={styles.title}>AED {credit.availableCredit} credit available</Text>
          <Text style={styles.subtitle}>Use it at checkout when you book</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.text.primary} />
      </PressableFeedback>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: pagePadding },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.brand.reward,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.background.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrap: { flex: 1, gap: 1 },
  title: {
    ...typography.body,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  subtitle: {
    ...typography.supporting,
    color: colors.text.primary,
    opacity: 0.75,
  },
});
