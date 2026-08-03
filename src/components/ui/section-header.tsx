import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, pagePadding, spacing, typography } from '@/theme';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  title: string;
  /** Optional trailing action, e.g. "View all" (inert this milestone). */
  actionLabel?: string;
  onActionPress?: () => void;
}

export function SectionHeader({ title, actionLabel, onActionPress }: Props) {
  return (
    <View style={styles.row}>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {actionLabel ? (
        <PressableFeedback accessibilityLabel={`${actionLabel}: ${title}`} onPress={onActionPress} hitSlop={14}>
          <Text style={styles.action}>{actionLabel}</Text>
        </PressableFeedback>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: pagePadding,
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.text.primary,
    letterSpacing: -0.3,
  },
  action: {
    ...typography.chip,
    color: colors.brand.primary,
  },
});
