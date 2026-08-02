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
}

/** Image with a branded placeholder when the source is missing or fails. */
export function AppImage({ source, style, contentFit = 'cover' }: Props) {
  const [failed, setFailed] = useState(false);
  const showFallback = failed || source === undefined;

  if (showFallback) {
    return (
      <View style={[styles.fallback, style]} accessibilityElementsHidden>
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
