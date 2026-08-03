import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { sortOptions, type SortId } from '@/services/contracts/filters';
import { colors, fontFamily, radii, shadows, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  visible: boolean;
  selected: SortId;
  onSelect: (sort: SortId) => void;
  onClose: () => void;
}

/** HMS-004 — single-select sort sheet, same hand-built modal pattern. */
export function SortSheet({ visible, selected, onSelect, onClose }: Props) {
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reducedMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityLabel="Close sort options"
          accessibilityRole="button"
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.xl }]}>
          <View style={styles.handle} />
          <Text style={styles.title} accessibilityRole="header">
            Sort by
          </Text>
          {sortOptions.map((option) => {
            const isSelected = option.id === selected;
            return (
              <PressableFeedback
                key={option.id}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ selected: isSelected, checked: isSelected }}
                onPress={() => {
                  onSelect(option.id);
                  onClose();
                }}
                style={styles.row}
              >
                <Text style={[styles.rowLabel, isSelected && styles.rowLabelSelected]}>
                  {option.label}
                </Text>
                {isSelected ? (
                  <Ionicons name="checkmark-circle" size={22} color={colors.brand.primary} />
                ) : (
                  <Ionicons name="ellipse-outline" size={22} color={colors.border.default} />
                )}
              </PressableFeedback>
            );
          })}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.overlay.backdrop,
  },
  sheet: {
    backgroundColor: colors.background.elevated,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    ...shadows.sheet,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.default,
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 50,
  },
  rowLabel: {
    ...typography.body,
    color: colors.text.primary,
  },
  rowLabelSelected: {
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
});
