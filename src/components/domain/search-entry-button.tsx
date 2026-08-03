import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text } from 'react-native';

interface Props {
  onPress: () => void;
}

/**
 * Search-bar-styled navigation control: same visual as Home's search field,
 * but a pressable that pushes the Search route. The real text input lives
 * only on the Search screen — docs/17 §4.
 */
export function SearchEntryButton({ onPress }: Props) {
  return (
    <PressableFeedback
      onPress={onPress}
      accessibilityLabel="Search activities, providers or classes"
      accessibilityHint="Opens search"
      style={styles.field}
    >
      <Ionicons name="search-outline" size={20} color={colors.text.secondary} />
      <Text style={styles.placeholder} numberOfLines={1}>
        Search activities, providers or classes
      </Text>
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    marginHorizontal: pagePadding,
    borderRadius: radii.search,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  placeholder: {
    flex: 1,
    ...typography.searchInput,
    color: colors.text.secondary,
  },
});
