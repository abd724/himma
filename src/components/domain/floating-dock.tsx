import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { dockTokens, shadows, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type DockDestinationId = 'home' | 'discover' | 'bookings' | 'saved' | 'profile';

interface DockDestination {
  id: DockDestinationId;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
}

const destinations: DockDestination[] = [
  { id: 'home', label: 'Home', icon: 'home-outline', activeIcon: 'home' },
  { id: 'discover', label: 'Discover', icon: 'compass-outline', activeIcon: 'compass' },
  { id: 'bookings', label: 'Bookings', icon: 'calendar-outline', activeIcon: 'calendar' },
  { id: 'saved', label: 'Saved', icon: 'heart-outline', activeIcon: 'heart' },
  { id: 'profile', label: 'Profile', icon: 'person-outline', activeIcon: 'person' },
];

interface Props {
  activeId: DockDestinationId;
  /** Absent for destinations that are inert this milestone. */
  onPressDestination?: (id: DockDestinationId) => void;
}

/**
 * Floating navigation dock — docs/04 §2. A detached rounded capsule with an
 * internal active-destination pill. Never an edge-to-edge tab bar. The active
 * pill stays on the active destination; inert destinations only give press
 * feedback (docs/11 §8).
 */
export function FloatingDock({ activeId, onPressDestination }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[styles.dock, { bottom: insets.bottom + dockTokens.safeAreaOffset }]}
      accessibilityRole="tablist"
    >
      {destinations.map((destination) => {
        const active = destination.id === activeId;
        return (
          <PressableFeedback
            key={destination.id}
            accessibilityRole="tab"
            accessibilityLabel={destination.label}
            accessibilityState={{ selected: active }}
            onPress={
              onPressDestination ? () => onPressDestination(destination.id) : undefined
            }
            style={[styles.item, active && styles.activePill]}
          >
            <Ionicons
              name={active ? destination.activeIcon : destination.icon}
              size={active ? 20 : 22}
              color={active ? dockTokens.activeIconColor : dockTokens.inactiveIconColor}
            />
            {/* The capsule height is fixed, so dock labels cap font scaling
                per docs/12 §4 instead of clipping at large Dynamic Type. */}
            <Text
              style={[styles.label, active ? styles.activeLabel : styles.inactiveLabel]}
              maxFontSizeMultiplier={1.3}
            >
              {destination.label}
            </Text>
          </PressableFeedback>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    left: dockTokens.horizontalMargin,
    right: dockTokens.horizontalMargin,
    height: dockTokens.height,
    borderRadius: dockTokens.radius,
    backgroundColor: dockTokens.background,
    borderWidth: 1,
    borderColor: dockTokens.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    ...shadows.dock,
  },
  item: {
    minWidth: 48,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 6,
  },
  activePill: {
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 16,
    height: dockTokens.activePillRadius * 2,
    borderRadius: dockTokens.activePillRadius,
    backgroundColor: dockTokens.activePillBackground,
  },
  label: {
    ...typography.dockLabel,
  },
  activeLabel: {
    color: dockTokens.activeLabelColor,
    fontSize: 13,
    lineHeight: 17,
  },
  inactiveLabel: {
    color: dockTokens.inactiveLabelColor,
  },
});
