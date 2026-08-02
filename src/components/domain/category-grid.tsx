import { AppImage } from '@/components/ui/app-image';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { demoImage } from '@/data/mock/images';
import { colors, pagePadding, radii, spacing, typography } from '@/theme';
import type { Category } from '@/types/domain';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Fixed four-column grid: all eight categories visible with zero interaction
 * cost — chosen over a scrolling grid for scanability at 390 pt (docs/11 §4.6).
 */
export function CategoryGrid({ categories }: { categories: Category[] }) {
  return (
    <View style={styles.grid}>
      {categories.map((category) => (
        <PressableFeedback
          key={category.id}
          accessibilityLabel={`${category.label} category`}
          style={styles.cell}
        >
          <AppImage source={demoImage(category.imageKey)} style={styles.tile} />
          <Text style={styles.label} numberOfLines={1}>
            {category.label}
          </Text>
        </PressableFeedback>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: pagePadding - spacing.xs,
    rowGap: spacing.lg,
  },
  cell: {
    width: '25%',
    paddingHorizontal: spacing.xs,
    alignItems: 'center',
    gap: 6,
  },
  tile: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radii.tile,
    backgroundColor: colors.brand.primarySoft,
  },
  label: {
    ...typography.caption,
    color: colors.text.primary,
  },
});
