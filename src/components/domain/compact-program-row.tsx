import { AppImage } from '@/components/ui/app-image';
import { Badge } from '@/components/ui/badge';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { formatPrice } from '@/components/domain/program-card';
import { demoImage } from '@/data/mock/images';
import { colors, fontFamily, radii, shadows, spacing, typography } from '@/theme';
import type { Program } from '@/types/domain';
import { ageRangeLabel, isChildRelevant, isLadiesOnly, spokenAgeLabel } from '@/utils/eligibility';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  program: Program;
  providerName: string;
  areaLabel: string;
  isFavourite: boolean;
  onToggleFavourite: (programId: string) => void;
}

/**
 * Dense vertical result card — same family and information hierarchy as the
 * approved carousel card, compressed for comparison (docs/14 §6). The card
 * body is inert until program details ship; the favourite toggle is a
 * sibling, never a nested control.
 */
export function CompactProgramRow({
  program,
  providerName,
  areaLabel,
  isFavourite,
  onToggleFavourite,
}: Props) {
  const price = formatPrice(program.price);
  const ladies = isLadiesOnly(program.eligibility);
  const ageLabel = isChildRelevant(program.eligibility)
    ? ageRangeLabel(program.eligibility)
    : undefined;
  const badge = program.offer
    ? { label: program.offer.label, variant: 'offer' as const }
    : ladies
      ? { label: 'Ladies only', variant: 'eligibility' as const }
      : undefined;

  return (
    <View style={styles.card}>
      <PressableFeedback
        accessibilityLabel={`${program.title} by ${providerName}. ${areaLabel}. ${program.scheduleLabel}. ${price.amount}${price.unit ? ` ${price.unit}` : ''}.${badge ? ` ${badge.label}.` : ''}${ageLabel ? ` ${spokenAgeLabel(ageLabel)}.` : ''} Rated ${program.rating.toFixed(1)}`}
        style={styles.pressable}
      >
        <AppImage source={demoImage(program.imageKey)} style={styles.thumbnail} />
        <View style={styles.body}>
          {badge || ageLabel ? (
            <View style={styles.badgeRow}>
              {badge ? <Badge label={badge.label} variant={badge.variant} /> : null}
              {ageLabel ? (
                <Badge
                  label={ageLabel}
                  variant="eligibility"
                  accessibilityLabel={spokenAgeLabel(ageLabel)}
                />
              ) : null}
            </View>
          ) : null}
          <Text style={styles.title} numberOfLines={2}>
            {program.title}
          </Text>
          <View style={styles.providerRow}>
            <Text style={styles.provider} numberOfLines={1}>
              {providerName}
            </Text>
            <View style={styles.rating}>
              <Ionicons name="star" size={12} color={colors.brand.reward} />
              <Text style={styles.ratingText}>{program.rating.toFixed(1)}</Text>
            </View>
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {areaLabel} · {program.scheduleLabel}
          </Text>
          {/* Dedicated full-width price row: the pricing model always renders
              in full at 360 pt; a long unit wraps under the amount as a whole
              instead of squeezing beside the rating. */}
          <View style={styles.priceRow}>
            <Text style={styles.price}>{price.amount}</Text>
            {price.unit ? <Text style={styles.priceUnit}>{price.unit}</Text> : null}
          </View>
        </View>
      </PressableFeedback>
      <PressableFeedback
        accessibilityLabel={
          isFavourite
            ? `Remove ${program.title} from favourites`
            : `Add ${program.title} to favourites`
        }
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isFavourite, selected: isFavourite }}
        onPress={() => onToggleFavourite(program.id)}
        style={styles.heart}
        hitSlop={4}
      >
        <Ionicons
          name={isFavourite ? 'heart' : 'heart-outline'}
          size={20}
          color={isFavourite ? colors.brand.accentWarm : colors.text.primary}
        />
      </PressableFeedback>
    </View>
  );
}


const styles = StyleSheet.create({
  card: {
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    ...shadows.card,
  },
  pressable: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  thumbnail: {
    width: 88,
    height: 104,
    borderRadius: radii.image,
    backgroundColor: colors.brand.primarySoft,
  },
  body: {
    flex: 1,
    gap: 2,
    paddingRight: 40, // clear space for the favourite action
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: 2,
  },
  title: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  provider: {
    ...typography.caption,
    fontFamily: fontFamily.medium,
    color: colors.text.secondary,
    flexShrink: 1,
  },
  meta: {
    ...typography.caption,
    fontFamily: fontFamily.medium,
    color: colors.text.secondary,
  },
  priceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: 4,
    marginTop: spacing.xs,
  },
  price: {
    ...typography.price,
    fontSize: 14,
    color: colors.text.primary,
  },
  priceUnit: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  rating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  ratingText: {
    ...typography.caption,
    color: colors.text.primary,
  },
  heart: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
