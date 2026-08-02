import { colors, radii, typography } from '@/theme';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  label: string;
  /** offer = reward yellow; eligibility = soft indigo. */
  variant: 'offer' | 'eligibility';
}

export function Badge({ label, variant }: Props) {
  return (
    <View style={[styles.badge, variant === 'offer' ? styles.offer : styles.eligibility]}>
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
