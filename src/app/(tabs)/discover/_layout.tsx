import { colors } from '@/theme';
import { Stack } from 'expo-router';

/**
 * Discover tab stack. Catalogue browsing surfaces (categories, category,
 * activity type, results) land here in later commits so the dock stays
 * visible across them — docs/16 §6, docs/17 §2.
 */
export default function DiscoverLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background.main },
      }}
    />
  );
}
