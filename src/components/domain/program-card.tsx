import { AppImage } from '@/components/ui/app-image';
import { Badge } from '@/components/ui/badge';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { demoImage } from '@/data/mock/images';
import { colors, fontFamily, radii, shadows, spacing, typography } from '@/theme';
import type { PriceModel, Program } from '@/types/domain';
import { isLadiesOnly } from '@/utils/eligibility';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

export function formatPrice(price: PriceModel): { amount: string; unit: string } {
  const aed = (value: number) => `AED ${value.toLocaleString('en-US')}`;
  switch (price.kind) {
    case 'dropIn':
      return { amount: aed(price.amount), unit: 'per session' };
    case 'monthly':
      return { amount: aed(price.amount), unit: '/month' };
    case 'term':
      return { amount: aed(price.amount), unit: 'per term' };
    case 'camp':
      return { amount: aed(price.amountPerWeek), unit: '/week' };
    case 'package':
      return { amount: aed(price.amount), unit: `for ${price.sessions} sessions` };
    case 'freeTrial':
      return { amount: 'Free', unit: 'trial' };
  }
}

interface Props {
  program: Program;
  providerName: string;
  areaLabel: string;
  isFavourite: boolean;
  onToggleFavourite: (programId: string) => void;
}

/** Program-first card — docs/11 §7. Card body tap is inert this milestone. */
export function ProgramCard({ program, providerName, areaLabel, isFavourite, onToggleFavourite }: Props) {
  const price = formatPrice(program.price);
  const badge = program.offer
    ? { label: program.offer.label, variant: 'offer' as const }
    : isLadiesOnly(program.eligibility)
      ? { label: 'Ladies only', variant: 'eligibility' as const }
      : undefined;

  // The favourite toggle is a sibling of the card pressable, not a child —
  // nested interactive controls are invalid on web and confuse screen readers.
  return (
    <View style={styles.card}>
      <PressableFeedback
        accessibilityLabel={`${program.title} by ${providerName}. ${areaLabel}. ${program.scheduleLabel}. ${price.amount} ${price.unit}. Rated ${program.rating.toFixed(1)}`}
      >
        <View>
          <AppImage source={demoImage(program.imageKey)} style={styles.image} />
          {badge ? (
            <View style={styles.badge}>
              <Badge label={badge.label} variant={badge.variant} />
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
              {areaLabel} · {program.scheduleLabel}
            </Text>
          </View>
          <View style={styles.footer}>
            <View style={styles.priceRow}>
              <Text style={styles.price}>{price.amount}</Text>
              <Text style={styles.priceUnit}>{price.unit}</Text>
            </View>
            <View style={styles.rating}>
              <Ionicons name="star" size={13} color={colors.brand.reward} />
              <Text style={styles.ratingText}>{program.rating.toFixed(1)}</Text>
            </View>
          </View>
        </View>
      </PressableFeedback>
      <PressableFeedback
        accessibilityLabel={
          isFavourite
            ? `Remove ${program.title} from favourites`
            : `Add ${program.title} to favourites`
        }
        accessibilityState={{ selected: isFavourite }}
        onPress={() => onToggleFavourite(program.id)}
        style={styles.heart}
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
