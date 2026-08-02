import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { pagePadding, radii, spacing } from '@/theme';
import { StyleSheet, View } from 'react-native';

/** Static feed placeholder shown before the first feed response — docs/11 §9. */
export function HomeSkeleton() {
  return (
    <View style={styles.container} accessibilityLabel="Loading your activities">
      <SkeletonBlock style={styles.search} />
      <View style={styles.chipRow}>
        <SkeletonBlock style={styles.chip} />
        <SkeletonBlock style={styles.chip} />
        <SkeletonBlock style={styles.chip} />
        <SkeletonBlock style={styles.chip} />
      </View>
      <SkeletonBlock style={styles.hero} />
      <View style={styles.tileRow}>
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonBlock key={index} style={styles.tile} />
        ))}
      </View>
      <SkeletonBlock style={styles.sectionTitle} />
      <View style={styles.cardRow}>
        <SkeletonBlock style={styles.card} />
        <SkeletonBlock style={styles.card} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: pagePadding,
    gap: spacing.xl,
  },
  search: { height: 52, borderRadius: radii.search },
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  chip: { flex: 1, height: 44, borderRadius: radii.chip },
  hero: { height: 216, borderRadius: radii.hero },
  tileRow: { flexDirection: 'row', gap: spacing.md },
  tile: { flex: 1, aspectRatio: 1, borderRadius: radii.tile },
  sectionTitle: { width: 180, height: 22 },
  cardRow: { flexDirection: 'row', gap: spacing.lg },
  card: { width: 272, height: 240, borderRadius: radii.card },
});
