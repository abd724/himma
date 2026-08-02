import { AppImage } from '@/components/ui/app-image';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { demoImage } from '@/data/mock/images';
import { colors, radii, shadows, spacing, typography } from '@/theme';
import type { Category } from '@/types/domain';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  category: Category;
  programCount: number;
}

/**
 * Compact category row for Results — adapted from the Home tile for list
 * comparison. Inert until category pages land in the catalogue-pages commit.
 */
export function CategoryResultRow({ category, programCount }: Props) {
  return (
    <PressableFeedback
      accessibilityLabel={`${category.label} category, ${programCount} activities`}
      style={styles.card}
    >
      <AppImage source={demoImage(category.imageKey)} style={styles.thumbnail} />
      <View style={styles.info}>
        <Text style={styles.label} numberOfLines={1}>
          {category.label}
        </Text>
        <Text style={styles.count}>{programCount} activities</Text>
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
