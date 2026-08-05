import { colors } from '@/theme';
import { Animated, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  /** The owning screen's scroll offset (native-driver Animated.Value). */
  scrollY: Animated.Value;
  /** Height of the edge-to-edge hero/cover the screen opens with. */
  heroHeight: number;
}

/**
 * Status-bar scrim for detail surfaces with edge-to-edge heroes (docs/12 §3):
 * scrolled page text must never collide with the clock, Dynamic Island, or
 * Android status icons. The approved hero presentation is untouched at rest —
 * the scrim (page background, safe-area height) fades in over the last 56 pt
 * before the hero's bottom reaches the status bar. `pointerEvents="none"` and
 * a native-driver opacity keep scrolling, taps, and edge-swipe navigation
 * untouched. Renders nothing when the top inset is zero (web preview).
 */
export function StatusBarScrim({ scrollY, heroHeight }: Props) {
  const insets = useSafeAreaInsets();
  if (insets.top <= 0) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.scrim,
        {
          height: insets.top,
          opacity: scrollY.interpolate({
            inputRange: [heroHeight - insets.top - 56, heroHeight - insets.top],
            outputRange: [0, 1],
            extrapolate: 'clamp',
          }),
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.background.main,
  },
});
