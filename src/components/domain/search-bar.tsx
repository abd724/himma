import { colors, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, TextInput, View } from 'react-native';

/**
 * Real focusable search entry. Submission is inert this milestone —
 * docs/09 §17.2.
 */
export function SearchBar() {
  return (
    <View style={styles.wrap}>
      <View style={styles.field}>
        <Ionicons name="search-outline" size={20} color={colors.text.secondary} />
        <TextInput
          style={styles.input}
          placeholder="Search activities, providers or classes"
          placeholderTextColor={colors.text.secondary}
          returnKeyType="search"
          accessibilityLabel="Search activities, providers or classes"
          onSubmitEditing={() => {}}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: pagePadding },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 52,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.search,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  input: {
    flex: 1,
    ...typography.searchInput,
    color: colors.text.primary,
    paddingVertical: 0,
  },
});
