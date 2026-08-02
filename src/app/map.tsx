import { IconButton } from '@/components/ui/icon-button';
import { colors, pagePadding, radii, spacing, typography } from '@/theme';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * Map route container (HMA-016). Neutral structural canvas only — the
 * schematic area-node map arrives in the feat(map) commit.
 */
export default function MapScreen() {
  const router = useRouter();
  // Cold deep links have no stack to pop — fall back to Discover (docs/16 §6).
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/discover');
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
      <View style={styles.header}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <Text style={styles.title} accessibilityRole="header">
          Map
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={styles.canvas} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.text.primary,
  },
  headerSpacer: { width: 44 },
  canvas: {
    flex: 1,
    margin: pagePadding,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
});
