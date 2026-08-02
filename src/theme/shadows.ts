import { Platform, type ViewStyle } from 'react-native';

/** Restrained elevation — docs/07 §8. */
const shadow = (opacity: number, radius: number, height: number, elevation: number): ViewStyle =>
  Platform.select<ViewStyle>({
    web: { boxShadow: `0 ${height}px ${radius}px rgba(32, 34, 58, ${opacity})` } as ViewStyle,
    default: {
      shadowColor: '#20223A',
      shadowOpacity: opacity,
      shadowRadius: radius,
      shadowOffset: { width: 0, height },
      elevation,
    },
  })!;

export const shadows = {
  card: shadow(0.06, 12, 4, 2),
  dock: shadow(0.14, 24, 10, 10),
  sheet: shadow(0.16, 28, -6, 12),
} as const;
