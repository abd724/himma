import { colors } from '@/theme';
import { Stack } from 'expo-router';

/**
 * Anchor the stack on the Discover feed so deep entries (results handoff,
 * cold deep links) always have the feed beneath them — back never skips
 * to another tab (docs/15 §4.3, docs/16 §6).
 */
export const unstable_settings = { initialRouteName: 'index', anchor: 'index' };

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
