import { colors, radii, typography } from '@/theme';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  label: string;
  /** offer = reward yellow; eligibility = soft indigo. */
  variant: 'offer' | 'eligibility';
  /** Natural spoken form, e.g. "Ages 6 to 9" for the label "Ages 6–9". */
  accessibilityLabel?: string;
}

export function Badge({ label, variant, accessibilityLabel }: Props) {
  return (
    <View
      style={[styles.badge, variant === 'offer' ? styles.offer : styles.eligibility]}
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={[styles.label, variant === 'offer' ? styles.offerLabel : styles.eligibilityLabel]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: radii.chip,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  offer: { backgroundColor: colors.brand.reward },
  eligibility: { backgroundColor: colors.brand.primarySoft },
  label: { ...typography.caption },
  offerLabel: { color: colors.text.primary },
  eligibilityLabel: { color: colors.brand.primary },
});
