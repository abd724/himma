import { AppImage } from '@/components/ui/app-image';
import { Badge } from '@/components/ui/badge';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { demoImage } from '@/data/mock/images';
import { colors, fontFamily, radii, shadows, spacing, typography } from '@/theme';
import type { Program } from '@/types/domain';
import { ageRangeLabel, isChildRelevant, isLadiesOnly, spokenAgeLabel } from '@/utils/eligibility';
import { formatPrice } from '@/utils/price';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  program: Program;
  providerName: string;
  areaLabel: string;
  /** Saved/favourites is a deferred domain (no backend state exists) —
   *  omit both props and the heart affordance disappears (owner RI-2 §14). */
  isFavourite?: boolean;
  onToggleFavourite?: (programId: string) => void;
  /** Opens Program Details (HMA-015). The provider name stays non-interactive
      inside the card — docs/09 §20.2, no nested pressables. */
  onPress?: () => void;
  /** Time-led surfaces show "Today, 7:30 PM" instead of the weekly schedule. */
  scheduleOverride?: string;
  /**
   * Shows the provider-defined age range on child-relevant cards (docs/14 §6).
   * Off by default so Home keeps its approved baseline pixels.
   */
  showAgeRange?: boolean;
}

/** Program-first card — docs/11 §7. */
export function ProgramCard({
  program,
  providerName,
  areaLabel,
  isFavourite,
  onToggleFavourite,
  onPress,
  scheduleOverride,
  showAgeRange = false,
}: Props) {
  const price = program.price === undefined ? undefined : formatPrice(program.price);
  const scheduleLabel = scheduleOverride ?? program.scheduleLabel;
  const badge = program.offer
    ? { label: program.offer.label, variant: 'offer' as const }
    : isLadiesOnly(program.eligibility)
      ? { label: 'Ladies only', variant: 'eligibility' as const }
      : undefined;
  const ageLabel =
    showAgeRange && isChildRelevant(program.eligibility)
      ? ageRangeLabel(program.eligibility)
      : undefined;

  // The favourite toggle is a sibling of the card pressable, not a child —
  // nested interactive controls are invalid on web and confuse screen readers.
  return (
    <View style={styles.card}>
      <PressableFeedback
        onPress={onPress}
        accessibilityLabel={[
          `${program.title} by ${providerName}.`,
          areaLabel ? `${areaLabel}.` : '',
          scheduleLabel !== undefined ? `${scheduleLabel}.` : '',
          price !== undefined ? `${price.amount}${price.unit ? ` ${price.unit}` : ''}.` : '',
          badge ? `${badge.label}.` : '',
          ageLabel ? `${spokenAgeLabel(ageLabel)}.` : '',
          program.rating !== undefined ? `Rated ${program.rating.toFixed(1)}` : '',
        ]
          .filter((part) => part !== '')
          .join(' ')}
        accessibilityHint={onPress ? 'Opens program details' : undefined}
      >
        <View>
          <AppImage source={demoImage(program.imageKey)} style={styles.image} />
          {badge || ageLabel ? (
            <View style={styles.badge}>
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
        </View>
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={2}>
            {program.title}
          </Text>
          <Text style={styles.provider} numberOfLines={1}>
            {providerName}
          </Text>
          <View style={styles.metaRow}>
            <Ionicons name="location-outline" size={13} color={colors.text.secondary} />
            <Text style={styles.meta} numberOfLines={1}>
              {[areaLabel, scheduleLabel].filter((part) => part !== undefined && part !== '').join(' · ')}
            </Text>
          </View>
          <View style={styles.footer}>
            <View style={styles.priceRow}>
              {/* One nested Text keeps amount + unit in a single paragraph:
                  Android clips separately-measured unit views at fractional
                  widths (the trailing word vanishes), and real text baselines
                  replace Yoga baseline alignment. */}
              {price !== undefined ? (
                <Text style={styles.price} numberOfLines={1}>
                  {price.amount}
                  {price.unit ? <Text style={styles.priceUnit}> {price.unit}</Text> : null}
                </Text>
              ) : null}
            </View>
            {program.rating !== undefined ? (
              <View style={styles.rating}>
                <Ionicons name="star" size={12} color={colors.brand.reward} />
                <Text style={styles.ratingText}>{program.rating.toFixed(1)}</Text>
              </View>
            ) : null}
          </View>
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
    width: 272,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    overflow: 'hidden',
    ...shadows.card,
  },
  image: {
    width: '100%',
    height: 136,
  },
  badge: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    flexDirection: 'row',
    gap: spacing.xs,
  },
  heart: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.overlay.surfaceTranslucent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: spacing.lg,
    gap: 3,
  },
  title: {
    ...typography.cardTitle,
    color: colors.text.primary,
    minHeight: 42,
  },
  provider: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  meta: {
    ...typography.supporting,
    color: colors.text.secondary,
    flexShrink: 1,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    flexShrink: 1,
  },
  price: {
    ...typography.price,
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
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
});
