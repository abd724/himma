import { CategoryGrid } from '@/components/domain/category-grid';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { CataloguePageHeader } from '@/features/catalogue/catalogue-page-header';
import type { AllCategoriesListing } from '@/services/contracts/catalogue';
import { collectionFilterSelection } from '@/services/contracts/filters';
import { catalogueService } from '@/services/composition';
import { useResultsSession } from '@/state/results-session-context';
import { useTaxonomy } from '@/state/use-taxonomy';
import { colors, dockTokens, pagePadding, radii, spacing } from '@/theme';
import type { BrowseEntry } from '@/types/domain';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * HMA-011 — the complete visual catalogue: 11 categories in supply-aware
 * order plus the Kids & Teens and Camps browse lenses (docs/15 §3). Category
 * tiles enter the taxonomy; lens tiles resolve to preset Results.
 */
export function AllCategoriesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const session = useResultsSession();
  const { taxonomy } = useTaxonomy();

  const [listing, setListing] = useState<AllCategoriesListing | null>(null);

  useEffect(() => {
    let cancelled = false;
    catalogueService.getAllCategories().then((result) => {
      if (!cancelled) setListing(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const entries: BrowseEntry[] =
    listing === null
      ? []
      : [
          ...listing.categories.map(({ category }) => ({
            id: category.id,
            label: category.label,
            imageKey: category.imageKey,
            target: { kind: 'category', categoryId: category.id } as const,
          })),
          ...listing.lenses.map((lens) => ({
            id: lens.collectionId,
            label: lens.label,
            imageKey: lens.imageKey,
            target: { kind: 'collection', collectionId: lens.collectionId } as const,
          })),
        ];

  const onPressEntry = (entry: BrowseEntry) => {
    if (entry.target.kind === 'category') {
      router.push(`/discover/category/${entry.target.categoryId}`);
      return;
    }
    if (entry.target.kind === 'collection') {
      const targetId = entry.target.collectionId;
      const collection = (taxonomy?.collections ?? []).find((c) => c.id === targetId);
      if (collection === undefined) return;
      session.newSearch('', 'programs');
      session.setFilters(collectionFilterSelection(collection));
      router.push('/discover/results');
    }
  };

  const contentBottomPadding =
    dockTokens.height + dockTokens.safeAreaOffset + insets.bottom + dockTokens.contentClearance;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <CataloguePageHeader title="All categories" onBack={() => router.back()} />
        <ScrollView
          style={styles.safeArea}
          contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
          showsVerticalScrollIndicator={false}
        >
          {listing === null ? (
            <View style={styles.skeletonGrid}>
              {Array.from({ length: 12 }, (_, index) => (
                <SkeletonBlock key={index} style={styles.skeletonTile} />
              ))}
            </View>
          ) : (
            <CategoryGrid
              categories={entries}
              onPressEntry={onPressEntry}
              labelLines={2}
              columns={3}
            />
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  safeArea: { flex: 1 },
  content: {
    paddingTop: spacing.xs,
  },
  skeletonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: pagePadding - spacing.xs,
    rowGap: spacing.lg,
  },
  skeletonTile: {
    width: '22%',
    aspectRatio: 1,
    marginHorizontal: '1.5%',
    borderRadius: radii.tile,
  },
});
