import { LocationSheet } from '@/components/domain/location-sheet';
import { SearchEntryButton } from '@/components/domain/search-entry-button';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { useAreaContext } from '@/state/area-context';
import { colors, dockTokens, fontFamily, pagePadding, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Discover tab foundation — customer-facing structural shell consistent with
 * Home. The full feed (docs/14 §2) lands in the feat(discover) commit.
 */
export default function DiscoverScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { areas, areaId, setAreaId, areaLabelById } = useAreaContext();
  const [locationSheetOpen, setLocationSheetOpen] = useState(false);

  const contentBottomPadding =
    dockTokens.height + dockTokens.safeAreaOffset + insets.bottom + dockTokens.contentClearance;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.title} accessibilityRole="header">
              Discover
            </Text>
            <PressableFeedback
              onPress={() => setLocationSheetOpen(true)}
              accessibilityLabel={`Change area. Current area ${areaLabelById.get(areaId) ?? ''}, Abu Dhabi`}
              style={styles.location}
              hitSlop={8}
            >
              <Ionicons name="location-outline" size={15} color={colors.brand.primary} />
              <Text style={styles.locationText} numberOfLines={1}>
                {areaLabelById.get(areaId) ?? ''}, Abu Dhabi
              </Text>
              <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
            </PressableFeedback>
          </View>
          <IconButton icon="notifications-outline" accessibilityLabel="Notifications" />
        </View>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
          showsVerticalScrollIndicator={false}
        >
          <SearchEntryButton onPress={() => router.push('/search')} />
        </ScrollView>
      </SafeAreaView>

      <LocationSheet
        visible={locationSheetOpen}
        areas={areas}
        selectedId={areaId}
        onSelect={setAreaId}
        onClose={() => setLocationSheetOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  safeArea: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  headerLeft: { flexShrink: 1, gap: 2 },
  title: {
    ...typography.screenTitle,
    color: colors.text.primary,
    letterSpacing: -0.5,
  },
  location: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 24,
  },
  locationText: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  content: {
    paddingTop: spacing.xs,
    gap: spacing.xxl,
  },
});
