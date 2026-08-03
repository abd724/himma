import { PressableFeedback } from '@/components/ui/pressable-feedback';
import type { MapAreaSummary } from '@/services/contracts/map';
import { colors, fontFamily, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  summary: MapAreaSummary;
  selected: boolean;
  onPress: () => void;
}

const countLabel = (count: number | undefined): string => {
  if (count === undefined) return 'Count unavailable';
  if (count === 0) return 'No activities yet';
  return `${count} ${count === 1 ? 'activity' : 'activities'}`;
};

/**
 * One labeled area node on the schematic canvas (docs/14 §7). Nodes carry no
 * coordinates and are laid out for browsing, not by real position; pins are
 * fictional provider markers. Selection is never colour-only — the node
 * gains a checkmark and a heavier border alongside the fill.
 */
export function AreaNode({ summary, selected, onPress }: Props) {
  const { area, programCount, providerCount, pins } = summary;
  const empty = programCount === 0;
  const providersLine =
    providerCount === undefined
      ? undefined
      : `${providerCount} ${providerCount === 1 ? 'provider' : 'providers'}`;

  return (
    <PressableFeedback
      accessibilityRole="checkbox"
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={`${area.label}, ${countLabel(programCount)}${
        providersLine === undefined ? '' : `, ${providersLine}`
      }`}
      accessibilityHint={selected ? 'Shows all areas again' : `Shows only ${area.label} in the list`}
      onPress={onPress}
      style={[styles.node, selected && styles.nodeSelected, empty && !selected && styles.nodeEmpty]}
    >
      <View style={styles.pinRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {pins.length > 0 ? (
          pins.map((pin) => (
            <View key={pin.providerId} style={[styles.pin, selected && styles.pinSelected]}>
              <Text style={[styles.pinText, selected && styles.pinTextSelected]}>{pin.initials}</Text>
            </View>
          ))
        ) : (
          <View style={[styles.pin, styles.pinEmpty]}>
            <Ionicons name="location-outline" size={14} color={colors.text.secondary} />
          </View>
        )}
        {selected ? (
          <View style={styles.check}>
            <Ionicons name="checkmark" size={14} color={colors.brand.primary} />
          </View>
        ) : null}
      </View>

      <Text style={[styles.count, selected && styles.textSelected]}>
        {programCount === undefined ? '—' : programCount}
      </Text>
      <Text style={[styles.label, selected && styles.textSelected]} numberOfLines={2}>
        {area.label}
      </Text>
      <Text style={[styles.meta, selected && styles.metaSelected]} numberOfLines={1}>
        {countLabel(programCount)}
      </Text>
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  node: {
    flexGrow: 1,
    flexBasis: '44%',
    minHeight: 132,
    gap: 2,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1.5,
    borderColor: colors.border.default,
  },
  nodeSelected: {
    backgroundColor: colors.brand.primary,
    borderColor: colors.brand.primary,
  },
  nodeEmpty: {
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  pinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: -6,
    marginBottom: spacing.sm,
  },
  pin: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brand.primarySoft,
    borderWidth: 1,
    borderColor: colors.background.elevated,
  },
  pinSelected: {
    backgroundColor: colors.text.inverse,
    borderColor: colors.brand.primary,
  },
  pinEmpty: {
    backgroundColor: colors.background.main,
  },
  pinText: {
    ...typography.caption,
    fontSize: 11,
    color: colors.brand.primary,
  },
  pinTextSelected: {
    color: colors.brand.primary,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    marginLeft: 'auto',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.text.inverse,
  },
  count: {
    ...typography.screenTitle,
    fontSize: 26,
    lineHeight: 32,
    color: colors.text.primary,
  },
  label: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  meta: {
    ...typography.caption,
    fontFamily: fontFamily.medium,
    color: colors.text.secondary,
  },
  textSelected: {
    color: colors.text.inverse,
  },
  metaSelected: {
    color: colors.text.inverse,
  },
});
