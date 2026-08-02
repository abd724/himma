import { colors } from '@/theme';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

/** Static loading placeholder block (no shimmer, so reduced motion is respected). */
export function SkeletonBlock({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.block, style]} />;
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.border.default,
    borderRadius: 12,
  },
});
