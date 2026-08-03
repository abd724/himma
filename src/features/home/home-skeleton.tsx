import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { pagePadding, radii, spacing } from '@/theme';
import { StyleSheet, View } from 'react-native';

/**
 * Static feed placeholder shown before the first feed response — docs/11 §9,
 * shapes matching the docs/18 §4 hierarchy: lead card, week strip, rails.
 */
export function HomeSkeleton() {
  return (
    <View style={styles.container} accessible accessibilityLabel="Loading your activities">
      <SkeletonBlock style={styles.sectionTitle} />
      <SkeletonBlock style={styles.leadCard} />
      <SkeletonBlock style={styles.sectionTitle} />
      <SkeletonBlock style={styles.weekStrip} />
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
  sectionTitle: { width: 180, height: 22 },
  leadCard: { height: 116, borderRadius: radii.card },
  weekStrip: { height: 148, borderRadius: radii.card },
  cardRow: { flexDirection: 'row', gap: spacing.lg },
  card: { width: 272, height: 240, borderRadius: radii.card },
});
