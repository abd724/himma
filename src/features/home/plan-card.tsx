import { PressableFeedback } from '@/components/ui/pressable-feedback';
import type { ActivePlan } from '@/services/contracts/schedule';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

/**
 * An active membership, package, or recurring enrolment with progress
 * emphasis — docs/18 §4.5. Opens the plan detail once HMA-026 ships;
 * inert with press feedback until then.
 */
export function PlanCard({ plan }: { plan: ActivePlan }) {
  const forLine = plan.participantLabel === 'You' ? 'For you' : `For ${plan.participantLabel}`;
  return (
    <View style={styles.wrap}>
      <PressableFeedback
        accessibilityLabel={`${plan.programTitle}, ${plan.providerName}, ${forLine.toLowerCase()}. ${plan.progressLabel}. Next session ${plan.nextSessionLabel}`}
        style={styles.card}
      >
        <View style={styles.iconWrap}>
          <Ionicons name="repeat" size={20} color={colors.brand.primary} />
        </View>
        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={1}>
            {plan.programTitle}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {forLine} · {plan.providerName}
          </Text>
          <View style={styles.progressRow}>
            <Text style={styles.progress}>{plan.progressLabel}</Text>
            <Text style={styles.next}>Next: {plan.nextSessionLabel}</Text>
          </View>
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
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1, gap: 2 },
  title: {
    ...typography.cardTitle,
    color: colors.text.primary,
  },
  meta: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  progressRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: spacing.md,
    marginTop: 2,
  },
  progress: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  next: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
});
