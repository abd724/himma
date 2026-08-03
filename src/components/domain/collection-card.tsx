import { AppImage } from '@/components/ui/app-image';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { demoImage } from '@/data/mock/images';
import { colors, fontFamily, radii, shadows, spacing, typography } from '@/theme';
import type { Collection } from '@/types/domain';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  collection: Collection;
  /** Deterministic result count for the current context (from the service). */
  programCount: number;
  onPress: () => void;
}

/**
 * Editorial entry into a preset Results view — wide image card with a scrim,
 * title, and count line (docs/14 §6). Deliberately smaller than the hero
 * (no CTA button) and wider than category tiles. Filtering lives in the
 * collection's data preset, never in this component.
 */
export function CollectionCard({ collection, programCount, onPress }: Props) {
  const countLine = `${programCount} ${programCount === 1 ? 'activity' : 'activities'}`;
  return (
    <PressableFeedback
      onPress={onPress}
      accessibilityLabel={`${collection.title} collection, ${countLine}`}
      accessibilityHint="Opens matching activities"
      style={styles.card}
    >
      <AppImage source={demoImage(collection.imageKey)} style={styles.image} />
      <LinearGradient
        colors={[
          colors.overlay.imageScrimClear,
          colors.overlay.imageScrimMid,
          colors.overlay.imageScrim,
        ]}
        locations={[0, 0.45, 0.9]}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.content}>
        {collection.seasonalLabel !== undefined ? (
          <Text style={styles.eyebrow}>{collection.seasonalLabel}</Text>
        ) : null}
        <Text style={styles.title} numberOfLines={2}>
          {collection.title}
        </Text>
        <Text style={styles.count} numberOfLines={1}>
          {countLine}
        </Text>
      </View>
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 300,
    height: 140,
    borderRadius: radii.card,
    overflow: 'hidden',
    backgroundColor: colors.brand.primarySoft,
    ...shadows.card,
  },
  image: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  content: {
    flex: 1,
    justifyContent: 'flex-end',
    padding: spacing.lg,
    gap: 1,
  },
  eyebrow: {
    ...typography.caption,
    color: colors.brand.reward,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: {
    ...typography.cardTitle,
    fontFamily: fontFamily.extraBold,
    fontSize: 18,
    lineHeight: 23,
    color: colors.text.inverse,
  },
  count: {
    ...typography.caption,
    fontFamily: fontFamily.semiBold,
    color: colors.text.inverse,
    opacity: 0.92,
  },
});
