import { AppImage } from '@/components/ui/app-image';
import { Badge } from '@/components/ui/badge';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { demoImage } from '@/data/mock/images';
import { colors, fontFamily, radii, shadows, spacing, typography } from '@/theme';
import type { Program } from '@/types/domain';
import { ageRangeLabel, isChildRelevant, isLadiesOnly, spokenAgeLabel } from '@/utils/eligibility';
import { formatPrice } from '@/utils/price';
import { useMidWordFitCap } from '@/utils/text-fit';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

interface Props {
  program: Program;
  providerName: string;
  areaLabel: string;
  /** Saved/favourites is a deferred domain — omit both props and the heart
   *  affordance disappears (owner RI-2 §14). */
  isFavourite?: boolean;
  onToggleFavourite?: (programId: string) => void;
  /** Opens Program Details (HMA-015); the favourite toggle stays a sibling. */
  onPress?: () => void;
}

/** Single source for the title's metrics — the fitting hook derives its
    scaled sizes from the same values the stylesheet uses. */
const TITLE_METRICS = { fontSize: 15, lineHeight: 20 };

/**
 * Dense vertical result card — same family and information hierarchy as the
 * approved carousel card, compressed for comparison (docs/14 §6). The
 * favourite toggle is a sibling, never a nested control.
 */
export function CompactProgramRow({
  program,
  providerName,
  areaLabel,
  isFavourite,
  onToggleFavourite,
  onPress,
}: Props) {
  const price = program.price === undefined ? undefined : formatPrice(program.price);
  const ladies = isLadiesOnly(program.eligibility);
  const ageLabel = isChildRelevant(program.eligibility)
    ? ageRangeLabel(program.eligibility)
    : undefined;
  const badge = program.offer
    ? { label: program.offer.label, variant: 'offer' as const }
    : ladies
      ? { label: 'Ladies only', variant: 'eligibility' as const }
      : undefined;
  // At large font scale on narrow widths the longest title word can exceed
  // the column and split mid-word ("Beginner C/alisthenics"); the cap only
  // engages on a detected split and never drops below base size.
  const { fontScale } = useWindowDimensions();
  const titleFit = useMidWordFitCap(program.title, TITLE_METRICS, fontScale);

  return (
    <View style={styles.card}>
      <PressableFeedback
        onPress={onPress}
        accessibilityLabel={[
          `${program.title} by ${providerName}.`,
          areaLabel ? `${areaLabel}.` : '',
          program.scheduleLabel !== undefined ? `${program.scheduleLabel}.` : '',
          price !== undefined ? `${price.amount}${price.unit ? ` ${price.unit}` : ''}.` : '',
          badge ? `${badge.label}.` : '',
          ageLabel ? `${spokenAgeLabel(ageLabel)}.` : '',
          program.rating !== undefined ? `Rated ${program.rating.toFixed(1)}` : '',
        ]
          .filter((part) => part !== '')
          .join(' ')}
        accessibilityHint={onPress ? 'Opens program details' : undefined}
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
          <Text
            key={titleFit.key}
            style={[styles.title, titleFit.style]}
            numberOfLines={2}
            onTextLayout={titleFit.onTextLayout}
            adjustsFontSizeToFit={titleFit.adjustsFontSizeToFit}
            minimumFontScale={titleFit.minimumFontScale}
          >
            {program.title}
          </Text>
          <View style={styles.providerRow}>
            <Text style={styles.provider} numberOfLines={1}>
              {providerName}
            </Text>
            {program.rating !== undefined ? (
              <View style={styles.rating}>
                <Ionicons name="star" size={12} color={colors.brand.reward} />
                <Text style={styles.ratingText}>{program.rating.toFixed(1)}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {[areaLabel, program.scheduleLabel]
              .filter((part) => part !== undefined && part !== '')
              .join(' · ')}
          </Text>
          {/* Dedicated full-width price row: the pricing model always renders
              in full at 360 pt; a long unit wraps under the amount as a whole
              instead of squeezing beside the rating. */}
          {price !== undefined ? (
            <View style={styles.priceRow}>
              <Text style={styles.price}>{price.amount}</Text>
              {price.unit ? <Text style={styles.priceUnit}>{price.unit}</Text> : null}
            </View>
          ) : null}
        </View>
      </PressableFeedback>
      {onToggleFavourite !== undefined ? (
        <PressableFeedback
          accessibilityLabel={
            isFavourite === true
              ? `Remove ${program.title} from favourites`
              : `Add ${program.title} to favourites`
          }
          accessibilityRole="checkbox"
          accessibilityState={{ checked: isFavourite === true, selected: isFavourite === true }}
          onPress={() => onToggleFavourite(program.id)}
          style={styles.heart}
          hitSlop={4}
        >
          <Ionicons
            name={isFavourite === true ? 'heart' : 'heart-outline'}
            size={20}
            color={isFavourite === true ? colors.brand.accentWarm : colors.text.primary}
          />
        </PressableFeedback>
      ) : null}
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
    ...TITLE_METRICS,
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
    // Android floors the unit's fractional measured width during layout,
    // silently wrapping-and-clipping the trailing word ("/week" → "/").
    // One point of slack keeps layout width above the painted width without
    // disturbing the documented whole-unit wrap at 360 pt.
    paddingRight: 1,
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
