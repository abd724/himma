import { IconButton } from '@/components/ui/icon-button';
import { colors, pagePadding, spacing, typography } from '@/theme';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  title: string;
  /** Small context line under the title, e.g. the parent category. */
  subtitle?: string;
  onBack: () => void;
}

/** Shared header for catalogue browsing pages — back + screen title. */
export function CataloguePageHeader({ title, subtitle, onBack }: Props) {
  return (
    <View style={styles.row}>
      <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={onBack} />
      <View style={styles.titles}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  titles: {
    flex: 1,
    gap: 1,
  },
  title: {
    ...typography.screenTitle,
    fontSize: 22,
    lineHeight: 28,
    color: colors.text.primary,
  },
  subtitle: {
    ...typography.caption,
    color: colors.text.secondary,
  },
});
