import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { pagePadding, radii, spacing } from '@/theme';
import { StyleSheet, View } from 'react-native';

/**
 * Static feed placeholder in Discover's section shapes — category tiles,
 * collection rail, card carousel (docs/16 §2). Header, search entry, and
 * chips render immediately above it.
 */
export function DiscoverSkeleton() {
  return (
    <View style={styles.container} accessibilityLabel="Loading activities">
      <View style={styles.tileRow}>
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonBlock key={index} style={styles.tile} />
        ))}
      </View>
      <View style={styles.rail}>
        <SkeletonBlock style={styles.collection} />
        <SkeletonBlock style={styles.collection} />
      </View>
      <SkeletonBlock style={styles.sectionTitle} />
      <View style={styles.rail}>
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
  tileRow: { flexDirection: 'row', gap: spacing.md },
  tile: { flex: 1, aspectRatio: 1, borderRadius: radii.tile },
  rail: { flexDirection: 'row', gap: spacing.lg },
  collection: { width: 300, height: 140, borderRadius: radii.card },
  sectionTitle: { width: 180, height: 22 },
  card: { width: 272, height: 240, borderRadius: radii.card },
});
