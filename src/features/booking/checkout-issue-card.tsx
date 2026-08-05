import { PressableFeedback } from '@/components/ui/pressable-feedback';
import {
  checkoutIssuePresentation,
  checkoutIssueRecovery,
  REVALIDATION_REASSURANCE,
} from '@/features/booking/checkout-revalidation';
import type { CheckoutIssueCode, CheckoutPriceComparison } from '@/services/contracts/checkout';
import { colors, fontFamily, radii, shadows, spacing, typography } from '@/theme';
import { spokenLabel } from '@/utils/price';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

/**
 * CheckoutIssueCard — the dedicated checkout revalidation surface
 * (owner-directed redesign, 2026-08-05; replaces the generic feed
 * empty-state). One left-aligned content system on a full-width soft
 * elevated card: state-appropriate icon chip, small state label, headline,
 * supporting copy, the structured old → new price comparison where the
 * issue carries one (previous muted and struck through, updated
 * emphasized — labels come exclusively from structured service data),
 * a reassurance row (`No payment has been made.`), and one full-width
 * primary recovery CTA. Presentation only: issue codes, recovery routes,
 * and the docs/09 §22.11 payment prohibition are untouched, and nothing
 * here can advance, confirm, or claim anything.
 */
export function CheckoutIssueCard({
  code,
  priceComparison,
  onRecover,
}: {
  code: CheckoutIssueCode;
  priceComparison?: CheckoutPriceComparison;
  onRecover: () => void;
}) {
  const presentation = checkoutIssuePresentation(code);
  const recovery = checkoutIssueRecovery(code);

  return (
    // Announce the interruption when it replaces checkout content
    // (docs/22 §12: message then recovery action in reading order).
    <View style={styles.card} accessibilityLiveRegion="polite">
      <View style={styles.iconChip}>
        <Ionicons
          name={presentation.icon as keyof typeof Ionicons.glyphMap}
          size={22}
          color={colors.brand.primary}
        />
      </View>
      <Text style={styles.stateLabel}>{presentation.stateLabel}</Text>
      <Text style={styles.headline} accessibilityRole="header">
        {presentation.headline}
      </Text>
      <Text style={styles.support}>{presentation.support}</Text>

      {priceComparison === undefined ? null : (
        <View
          style={styles.comparison}
          accessible
          accessibilityLabel={`Previous price, ${spokenLabel(priceComparison.previousLabel)}. Updated price, ${spokenLabel(priceComparison.updatedLabel)}.`}
        >
          <View style={styles.comparisonRow}>
            <Text style={styles.comparisonCaption}>Previous price</Text>
            <Text style={styles.previousPrice}>{priceComparison.previousLabel}</Text>
          </View>
          <View style={styles.comparisonDivider} />
          <View style={styles.comparisonRow}>
            <Text style={styles.comparisonCaption}>Updated price</Text>
            <Text style={styles.updatedPrice}>{priceComparison.updatedLabel}</Text>
          </View>
        </View>
      )}

      <View style={styles.reassuranceRow}>
        <Ionicons name="shield-checkmark-outline" size={16} color={colors.status.success} />
        <Text style={styles.reassuranceText}>{REVALIDATION_REASSURANCE}</Text>
      </View>

      <PressableFeedback
        accessibilityLabel={recovery.actionLabel}
        onPress={onRecover}
        style={styles.cta}
      >
        <Text style={styles.ctaLabel} maxFontSizeMultiplier={1.4}>
          {recovery.actionLabel}
        </Text>
      </PressableFeedback>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    padding: spacing.xxl,
    borderRadius: radii.hero,
    backgroundColor: colors.background.elevated,
    ...shadows.card,
  },
  iconChip: {
    width: 48,
    height: 48,
    borderRadius: radii.tile,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  stateLabel: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.brand.primary,
  },
  headline: {
    ...typography.sectionTitle,
    letterSpacing: -0.3,
    color: colors.text.primary,
  },
  support: {
    ...typography.body,
    color: colors.text.secondary,
  },
  comparison: {
    marginTop: spacing.xs,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  comparisonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  comparisonCaption: {
    ...typography.supporting,
    color: colors.text.secondary,
    flexShrink: 0,
  },
  comparisonDivider: {
    height: 1,
    backgroundColor: colors.border.default,
    opacity: 0.6,
  },
  previousPrice: {
    ...typography.supporting,
    color: colors.text.secondary,
    textDecorationLine: 'line-through',
    flex: 1,
    textAlign: 'right',
  },
  updatedPrice: {
    ...typography.cardTitle,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text.primary,
    flex: 1,
    textAlign: 'right',
  },
  reassuranceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.xs,
  },
  reassuranceText: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  cta: {
    marginTop: spacing.sm,
    minHeight: 52,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  ctaLabel: {
    ...typography.chip,
    fontSize: 16,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
});
