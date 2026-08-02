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
  programCount: number;
}

/** Dense provider row for Results lists — inert until storefronts ship. */
export function CompactProviderRow({ provider, areaLabel, programCount }: Props) {
  return (
    <PressableFeedback
      accessibilityLabel={`${provider.name}, ${provider.verified ? 'verified provider, ' : ''}${provider.categories.join(', ')}, ${areaLabel}, ${programCount} activities, rated ${provider.rating.toFixed(1)}`}
      style={styles.card}
    >
      <View style={styles.monogram}>
        <Text style={styles.monogramText}>{monogram(provider.name)}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {provider.name}
        </Text>
        <Text style={styles.categories} numberOfLines={1}>
          {provider.categories.join(' · ')}
        </Text>
        <View style={styles.footer}>
          {provider.verified ? (
            <Ionicons name="shield-checkmark" size={12} color={colors.status.success} />
          ) : null}
          <Text style={styles.meta} numberOfLines={1}>
            {areaLabel} · {programCount} activities
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
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    ...shadows.card,
  },
  monogram: {
    width: 48,
    height: 48,
    borderRadius: radii.image,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: {
    fontFamily: fontFamily.extraBold,
    fontSize: 16,
    color: colors.brand.primary,
  },
  info: { flex: 1, gap: 2, justifyContent: 'center' },
  name: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  categories: {
    ...typography.caption,
    fontFamily: fontFamily.medium,
    color: colors.text.secondary,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
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
