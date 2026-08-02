import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, fontFamily, radii, shadows, spacing, typography } from '@/theme';
import type { Provider } from '@/types/domain';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

function monogram(name: string): string {
  const words = name.split(' ').filter(Boolean);
  return (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '');
}

interface Props {
  provider: Provider;
  areaLabel: string;
}

/** Provider-first card, deliberately distinct from program cards — docs/11 §7. */
export function ProviderCard({ provider, areaLabel }: Props) {
  return (
    <PressableFeedback
      accessibilityLabel={`${provider.name}, ${provider.verified ? 'verified provider, ' : ''}${provider.categories.join(', ')}, ${areaLabel}, rated ${provider.rating.toFixed(1)}`}
      style={styles.card}
    >
      <View style={styles.monogram}>
        <Text style={styles.monogramText}>{monogram(provider.name)}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>
          {provider.name}
        </Text>
        <Text style={styles.categories} numberOfLines={1}>
          {provider.categories.join(' · ')}
        </Text>
        <View style={styles.footer}>
          {provider.verified ? (
            <View style={styles.verified}>
              <Ionicons name="shield-checkmark" size={12} color={colors.status.success} />
              <Text style={styles.verifiedText}>Verified</Text>
            </View>
          ) : null}
          <Text style={styles.meta} numberOfLines={1}>
            {areaLabel}
          </Text>
          <View style={styles.rating}>
            <Ionicons name="star" size={12} color={colors.brand.reward} />
            <Text style={styles.ratingText}>{provider.rating.toFixed(1)}</Text>
          </View>
        </View>
      </View>
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 280,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    ...shadows.card,
  },
  monogram: {
    width: 52,
    height: 52,
    borderRadius: radii.image,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: {
    fontFamily: fontFamily.extraBold,
    fontSize: 17,
    color: colors.brand.primary,
  },
  info: { flex: 1, gap: 2 },
  name: {
    ...typography.cardTitle,
    color: colors.text.primary,
  },
  categories: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 4,
  },
  verified: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  verifiedText: {
    ...typography.caption,
    color: colors.status.success,
  },
  meta: {
    ...typography.caption,
    color: colors.text.secondary,
    flexShrink: 1,
  },
  rating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 'auto',
  },
  ratingText: {
    ...typography.caption,
    color: colors.text.primary,
  },
});
