import { AppImage } from '@/components/ui/app-image';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { demoImage } from '@/data/mock/images';
import { colors, radii, shadows, spacing, typography } from '@/theme';
import type { Category } from '@/types/domain';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  category: Category;
  /** Shown only when an EXACT count is known — never estimated. */
  programCount?: number;
  /** Opens the category page (docs/15 §4.2). */
  onPress?: () => void;
}

/**
 * Compact category row for Results — adapted from the Home tile for list
 * comparison.
 */
export function CategoryResultRow({ category, programCount, onPress }: Props) {
  return (
    <PressableFeedback
      accessibilityLabel={
        programCount !== undefined
          ? `${category.label} category, ${programCount} activities`
          : `${category.label} category`
      }
      onPress={onPress}
      style={styles.card}
    >
      <AppImage source={demoImage(category.imageKey)} style={styles.thumbnail} />
      <View style={styles.info}>
        <Text style={styles.label} numberOfLines={1}>
          {category.label}
        </Text>
        {programCount !== undefined ? (
          <Text style={styles.count}>{programCount} activities</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.text.secondary} />
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    ...shadows.card,
  },
  thumbnail: {
    width: 48,
    height: 48,
    borderRadius: radii.image,
    backgroundColor: colors.brand.primarySoft,
  },
  info: { flex: 1, gap: 1 },
  label: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  count: {
    ...typography.caption,
    color: colors.text.secondary,
  },
});
