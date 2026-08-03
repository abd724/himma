import { AppImage } from '@/components/ui/app-image';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { demoImage } from '@/data/mock/images';
import { colors, pagePadding, radii, spacing, typography } from '@/theme';
import type { BrowseEntry } from '@/types/domain';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  categories: BrowseEntry[];
  /**
   * Activated tiles route through here (collection lenses this milestone);
   * tiles whose destinations don't exist yet stay inert with press feedback
   * when the handler ignores them (docs/09 §17.2).
   */
  onPressEntry?: (entry: BrowseEntry) => void;
}

/**
 * Fixed four-column grid: all eight categories visible with zero interaction
 * cost — chosen over a scrolling grid for scanability at 390 pt (docs/11 §4.6).
 */
export function CategoryGrid({ categories, onPressEntry }: Props) {
  return (
    <View style={styles.grid}>
      {categories.map((category) => (
        <PressableFeedback
          key={category.id}
          accessibilityLabel={`${category.label} category`}
          onPress={onPressEntry === undefined ? undefined : () => onPressEntry(category)}
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
