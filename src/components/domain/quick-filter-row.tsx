import { Chip } from '@/components/ui/chip';
import type { QuickFilter, QuickFilterId } from '@/services/contracts/home-feed';
import { colors, pagePadding, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

const filterIcons: Record<QuickFilterId, keyof typeof Ionicons.glyphMap> = {
  today: 'today-outline',
  weekend: 'calendar-outline',
  'near-me': 'navigate-outline',
  'ladies-only': 'woman-outline',
  camps: 'bonfire-outline',
  offers: 'pricetag-outline',
};

interface Props {
  filters: QuickFilter[];
  activeId?: QuickFilterId;
  onToggle: (id: QuickFilterId) => void;
}

/**
 * Single-select quick filters that genuinely re-filter the feed in place.
 * The active state is carried by fill, weight, a checkmark, and a context
 * line — never color alone (docs/11 §6).
 */
export function QuickFilterRow({ filters, activeId, onToggle }: Props) {
  const active = filters.find((filter) => filter.id === activeId);

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {filters.map((filter) => (
          <Chip
            key={filter.id}
            label={filter.label}
            icon={filterIcons[filter.id]}
            selected={filter.id === activeId}
            onPress={() => onToggle(filter.id)}
            accessibilityHint={
              filter.id === activeId ? 'Clears this filter' : filter.activeDescription
            }
          />
        ))}
      </ScrollView>
      {active ? (
        <View style={styles.contextLine} accessibilityLiveRegion="polite">
          <Ionicons name="funnel-outline" size={13} color={colors.brand.primary} />
          <Text style={styles.contextText}>{active.activeDescription}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: pagePadding,
    gap: spacing.sm,
  },
  contextLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.md,
  },
  contextText: {
    ...typography.supporting,
    fontFamily: typography.caption.fontFamily,
    color: colors.brand.primary,
  },
});
