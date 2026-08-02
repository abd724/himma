import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { IconButton } from '@/components/ui/icon-button';
import { colors, pagePadding, radii, spacing, typography } from '@/theme';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * HMA-010 Results — structural transition route receiving {q, tab}. The
 * customer-safe loading presentation below is replaced by the full Results
 * experience in the feat(results) commit.
 */
export default function ResultsRoute() {
  const router = useRouter();
  const { q } = useLocalSearchParams<{ q?: string; tab?: string }>();

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/discover');
  };

  return (
    <SafeAreaView edges={['top']} style={styles.root}>
      <View style={styles.header}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {typeof q === 'string' && q.length > 0 ? q : 'Results'}
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={styles.body} accessibilityLabel="Loading results">
        <SkeletonBlock style={styles.chipRow} />
        <SkeletonBlock style={styles.card} />
        <SkeletonBlock style={styles.card} />
        <SkeletonBlock style={styles.card} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  title: {
    flex: 1,
    ...typography.sectionTitle,
    color: colors.text.primary,
    textAlign: 'center',
  },
  headerSpacer: { width: 44 },
  body: {
    paddingHorizontal: pagePadding,
    gap: spacing.lg,
  },
  chipRow: { height: 44, borderRadius: radii.chip },
  card: { height: 96, borderRadius: radii.card },
});
