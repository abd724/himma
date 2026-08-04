import { colors } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { Image, type ImageStyle } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';

interface Props {
  source?: ImageSourcePropType;
  style?: StyleProp<ViewStyle>;
  /** Passed to expo-image; defaults to cover. */
  contentFit?: 'cover' | 'contain';
  /**
   * Meaningful spoken label for standalone imagery (detail heroes, covers).
   * Omit for decorative images inside already-labelled cards — they stay
   * hidden from screen readers.
   */
  accessibilityLabel?: string;
}

/** Image with a branded placeholder when the source is missing or fails. */
export function AppImage({ source, style, contentFit = 'cover', accessibilityLabel }: Props) {
  const [failed, setFailed] = useState(false);
  const showFallback = failed || source === undefined;

  if (showFallback) {
    return (
      <View
        style={[styles.fallback, style]}
        accessibilityElementsHidden={accessibilityLabel === undefined}
        accessibilityLabel={accessibilityLabel}
      >
        <Ionicons name="image-outline" size={28} color={colors.brand.primary} />
      </View>
    );
  }

  return (
    <Image
      source={source}
      style={StyleSheet.flatten(style) as ImageStyle}
      contentFit={contentFit}
      transition={0}
      onError={() => setFailed(true)}
      accessibilityLabel={accessibilityLabel}
      accessible={accessibilityLabel !== undefined}
      accessibilityIgnoresInvertColors
    />
  );
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
