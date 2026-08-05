import { PressableFeedback } from '@/components/ui/pressable-feedback';
import type { PaymentMethod } from '@/services/contracts/checkout';
import { colors, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Payment-method contract row — docs/22 §7.5, owner decision docs/09 §22.6.
 * The label is generic (`Card payment`): no card details, last-four digits,
 * expiry, cardholder names, or tokens exist or are implied anywhere.
 * Radio semantics follow the booking-flow precedent (explicit web aria state
 * via PressableFeedback / the disabled View — HANDOFF rule). An
 * 'unavailable' method renders visible, disabled, and explained (docs/22
 * §7.5's reserved honest-disablement shape) — never hidden, never selectable.
 */
export function PaymentMethodRow({
  method,
  selected,
  onSelect,
}: {
  method: PaymentMethod;
  selected: boolean;
  onSelect: () => void;
}) {
  if (method.availability.status === 'unavailable') {
    return (
      <View
        accessible
        accessibilityRole="radio"
        accessibilityState={{ checked: false, disabled: true }}
        // RN-web doesn't emit aria state from accessibilityState (HANDOFF rule).
        aria-checked={false}
        aria-disabled
        accessibilityLabel={`${method.label}, unavailable — ${method.availability.reason}`}
        style={[styles.row, styles.rowDisabled]}
      >
        <Ionicons name="card-outline" size={20} color={colors.text.secondary} />
        <View style={styles.text}>
          <Text style={[styles.label, styles.labelDisabled]}>{method.label}</Text>
          <Text style={styles.reason}>{method.availability.reason}</Text>
        </View>
        <Ionicons name="radio-button-off" size={22} color={colors.border.default} />
      </View>
    );
  }
  return (
    <PressableFeedback
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, selected }}
      accessibilityLabel={method.label}
      onPress={onSelect}
      style={[styles.row, selected && styles.rowSelected]}
    >
      <Ionicons
        name="card-outline"
        size={20}
        color={selected ? colors.brand.primary : colors.text.secondary}
      />
      <View style={styles.text}>
        <Text style={styles.label}>{method.label}</Text>
      </View>
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={22}
        color={selected ? colors.brand.primary : colors.border.default}
      />
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  rowSelected: {
    borderColor: colors.brand.primary,
    backgroundColor: colors.brand.primarySoft,
  },
  rowDisabled: {
    opacity: 0.7,
  },
  text: { flex: 1, gap: 2 },
  label: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  labelDisabled: {
    color: colors.text.secondary,
  },
  reason: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
});
