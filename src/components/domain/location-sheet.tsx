import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { colors, fontFamily, radii, shadows, spacing, typography } from '@/theme';
import type { Area, AreaId } from '@/types/domain';
import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  visible: boolean;
  areas: Area[];
  selectedId: AreaId;
  onSelect: (id: AreaId) => void;
  onClose: () => void;
}

/** Bottom-sheet area selector (HMS-001). Selection updates the whole feed. */
export function LocationSheet({ visible, areas, selectedId, onSelect, onClose }: Props) {
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
          accessibilityLabel="Close area selector"
          accessibilityRole="button"
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.xl }]}>
          <View style={styles.handle} />
          <Text style={styles.title} accessibilityRole="header">
            Choose your area
          </Text>
          {areas.map((area) => {
            const selected = area.id === selectedId;
            return (
              <PressableFeedback
                key={area.id}
                accessibilityRole="radio"
                accessibilityLabel={area.label}
                accessibilityState={{ selected }}
                onPress={() => {
                  onSelect(area.id);
                  onClose();
                }}
                style={styles.row}
              >
                <Text style={[styles.rowLabel, selected && styles.rowLabelSelected]}>
                  {area.label}
                </Text>
                {selected ? (
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
    fontFamily: fontFamily.extraBold,
    fontSize: 19,
    lineHeight: 25,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
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
