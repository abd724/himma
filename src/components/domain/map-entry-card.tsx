import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, fontFamily, pagePadding, radii, shadows, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  onPress: () => void;
}

/**
 * Full-width entry into the map view (docs/14 §2.11). The illustration is a
 * deliberately abstract arrangement of area nodes and pins — no geographic
 * imagery and no invented Abu Dhabi map (docs/14 §7).
 */
export function MapEntryCard({ onPress }: Props) {
  return (
    <View style={styles.wrap}>
      <PressableFeedback
        onPress={onPress}
        accessibilityLabel="Explore on the map. Browse activities by area"
        accessibilityHint="Opens the map"
        style={styles.card}
      >
        <View style={styles.canvas} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[styles.node, styles.nodeLarge, { top: 14, left: 18 }]} />
          <View style={[styles.node, { top: 44, left: 52 }]} />
          <View style={[styles.node, styles.nodeAccent, { top: 24, left: 74 }]} />
          <View style={[styles.node, { top: 60, left: 22 }]} />
          <Ionicons name="location" size={18} color={colors.brand.primary} style={styles.pin} />
        </View>
        <View style={styles.body}>
          <Text style={styles.title}>Explore on the map</Text>
          <Text style={styles.subtitle} numberOfLines={2}>
            See activities area by area and pick what’s close.
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.text.secondary} />
      </PressableFeedback>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: pagePadding },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    ...shadows.card,
  },
  canvas: {
    width: 104,
    height: 84,
    borderRadius: radii.image,
    backgroundColor: colors.brand.primarySoft,
    overflow: 'hidden',
  },
  node: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.brand.primary,
    opacity: 0.35,
  },
  nodeLarge: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  nodeAccent: {
    backgroundColor: colors.brand.accentWarm,
    opacity: 0.5,
  },
  pin: {
    position: 'absolute',
    top: 34,
    left: 42,
  },
  body: { flex: 1, gap: 2 },
  title: {
    ...typography.cardTitle,
    fontFamily: fontFamily.extraBold,
    color: colors.text.primary,
  },
  subtitle: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
});
