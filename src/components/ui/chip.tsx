import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text } from 'react-native';

interface Props {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Ionicons name shown before the label. */
  icon?: keyof typeof Ionicons.glyphMap;
  accessibilityHint?: string;
}

/**
 * Selection chip. The selected state never relies on color alone: a checkmark
 * replaces the leading icon and the weight changes — docs/11 §6.
 */
export function Chip({ label, selected, onPress, icon, accessibilityHint }: Props) {
  const iconName = selected ? 'checkmark' : icon;
  return (
    <PressableFeedback
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      accessibilityHint={accessibilityHint}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      {iconName ? (
        <Ionicons
          name={iconName}
          size={15}
          color={selected ? colors.text.inverse : colors.text.secondary}
        />
      ) : null}
      <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.chip,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  chipSelected: {
    backgroundColor: colors.brand.primary,
    borderColor: colors.brand.primary,
  },
  label: {
    ...typography.chip,
    color: colors.text.primary,
  },
  labelSelected: {
    color: colors.text.inverse,
    fontFamily: typography.price.fontFamily,
  },
});
