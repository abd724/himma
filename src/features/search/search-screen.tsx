import { Chip } from '@/components/ui/chip';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import type { SearchSuggestion, SuggestionKind } from '@/services/contracts/search';
import { searchService } from '@/services/mock/mock-search-service';
import { useAreaContext } from '@/state/area-context';
import { useParticipantContext } from '@/state/participant-context';
import { useResultsSession, type ResultsTab } from '@/state/results-session-context';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const kindMeta: Record<SuggestionKind, { icon: keyof typeof Ionicons.glyphMap; spoken: string }> = {
  activity: { icon: 'fitness-outline', spoken: 'activity' },
  provider: { icon: 'business-outline', spoken: 'provider' },
  category: { icon: 'grid-outline', spoken: 'category' },
  area: { icon: 'location-outline', spoken: 'area' },
};

const kindToTab: Record<SuggestionKind, string> = {
  activity: 'programs',
  provider: 'providers',
  category: 'categories',
  area: 'programs',
};

const groupTitles: { kind: SuggestionKind; title: string }[] = [
  { kind: 'activity', title: 'Activities' },
  { kind: 'provider', title: 'Providers' },
  { kind: 'category', title: 'Categories' },
  { kind: 'area', title: 'Areas' },
];

/**
 * HMA-009 — focused full-screen search (docs/14 §3.1). Keyboard-first,
 * participant-aware suggestions, deterministic mock service.
 */
export function SearchScreen() {
  const router = useRouter();
  const { participantId } = useParticipantContext();
  const { areaId } = useAreaContext();
  const resultsSession = useResultsSession();

  // Results' query pill reopens Search prefilled for refinement.
  const params = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(typeof params.q === 'string' ? params.q : '');
  const [recentsVersion, setRecentsVersion] = useState(0);

  const preSearch = useMemo(
    () => searchService.getPreSearchContent(),
    // Re-read when recents change (session-local service state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recentsVersion],
  );

  const suggestions = useMemo(
    () => searchService.getSuggestions({ query, participantId, areaId }),
    [query, participantId, areaId],
  );

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const submit = (rawQuery: string, tab: string = 'all') => {
    const value = rawQuery.trim();
    if (value.length === 0) return; // empty submission does nothing
    searchService.addRecentSearch(value);
    setRecentsVersion((version) => version + 1);
    // A new submitted search resets filters, sort, and pagination here, in
    // the event handler (docs/16 §3.8).
    resultsSession.newSearch(value, tab as ResultsTab);
    // Dismiss the search overlay first so Results pushes onto the Discover
    // tab stack (back then pops to the feed, never to another tab).
    if (router.canGoBack()) router.dismiss();
    router.push({ pathname: '/discover/results', params: { q: value, tab } });
  };

  const openSuggestion = (suggestion: SearchSuggestion) => {
    // Category and activity suggestions route to Results until the category
    // and activity-type pages land in the catalogue-pages commit (docs/17 §11).
    submit(suggestion.query, kindToTab[suggestion.kind]);
  };

  const typing = query.trim().length > 0;

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <View style={styles.field}>
            <Ionicons name="search-outline" size={18} color={colors.text.secondary} />
            <TextInput
              style={styles.input}
              value={query}
              onChangeText={setQuery}
              placeholder="Search activities or providers"
              placeholderTextColor={colors.text.secondary}
              returnKeyType="search"
              autoFocus
              accessibilityLabel="Search activities or providers"
              onSubmitEditing={() => submit(query)}
            />
            {typing ? (
              <PressableFeedback
                onPress={() => setQuery('')}
                accessibilityLabel="Clear search text"
                hitSlop={10}
              >
                <Ionicons name="close-circle" size={20} color={colors.text.secondary} />
              </PressableFeedback>
            ) : null}
          </View>
          <PressableFeedback onPress={close} accessibilityLabel="Cancel search" style={styles.cancel}>
            <Text style={styles.cancelLabel}>Cancel</Text>
          </PressableFeedback>
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          {typing ? (
            <>
              <SuggestionRowButton
                icon="search-outline"
                label={`Search for “${query.trim()}”`}
                accessibilityLabel={`Search for ${query.trim()}`}
                onPress={() => submit(query)}
              />
              {groupTitles.map(({ kind, title }) => {
                const rows = suggestions.filter((suggestion) => suggestion.kind === kind);
                if (rows.length === 0) return null;
                return (
                  <View key={kind}>
                    <Text style={styles.groupTitle}>{title}</Text>
                    {rows.map((suggestion) => (
                      <SuggestionRowButton
                        key={suggestion.id}
                        icon={kindMeta[suggestion.kind].icon}
                        label={suggestion.label}
                        sublabel={suggestion.sublabel}
                        accessibilityLabel={`${suggestion.label}, ${kindMeta[suggestion.kind].spoken}`}
                        onPress={() => openSuggestion(suggestion)}
                      />
                    ))}
                  </View>
                );
              })}
            </>
          ) : (
            <>
              {preSearch.recentSearches.length > 0 ? (
                <View>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.groupTitle}>Recent</Text>
                    <PressableFeedback
                      onPress={() => {
                        searchService.clearRecentSearches();
                        setRecentsVersion((version) => version + 1);
                      }}
                      accessibilityLabel="Clear recent searches"
                      hitSlop={10}
                      style={styles.clearButton}
                    >
                      <Text style={styles.clearLabel}>Clear</Text>
                    </PressableFeedback>
                  </View>
                  {preSearch.recentSearches.map((recent) => (
                    <SuggestionRowButton
                      key={recent}
                      icon="time-outline"
                      label={recent}
                      accessibilityLabel={`${recent}, recent search`}
                      onPress={() => submit(recent)}
                    />
                  ))}
                </View>
              ) : null}

              <View>
                <Text style={styles.groupTitle}>Popular searches</Text>
                {preSearch.popularSearches.map((popular) => (
                  <SuggestionRowButton
                    key={popular}
                    icon="trending-up"
                    label={popular}
                    accessibilityLabel={`${popular}, popular search`}
                    onPress={() => submit(popular)}
                  />
                ))}
              </View>

              <View>
                <Text style={styles.groupTitle}>Browse by category</Text>
                <View style={styles.chips}>
                  {preSearch.categoryShortcuts.map((entry) => (
                    <Chip
                      key={entry.id}
                      label={entry.label}
                      selected={false}
                      onPress={() => submit(entry.label, 'all')}
                      accessibilityHint={`Searches ${entry.label} activities`}
                    />
                  ))}
                </View>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

interface RowProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sublabel?: string;
  accessibilityLabel: string;
  onPress: () => void;
}

function SuggestionRowButton({ icon, label, sublabel, accessibilityLabel, onPress }: RowProps) {
  return (
    <PressableFeedback onPress={onPress} accessibilityLabel={accessibilityLabel} style={styles.row}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={17} color={colors.brand.primary} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {label}
        </Text>
        {sublabel ? (
          <Text style={styles.rowSublabel} numberOfLines={1}>
            {sublabel}
          </Text>
        ) : null}
      </View>
      <Ionicons name="arrow-forward" size={15} color={colors.border.default} />
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.search,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  input: {
    flex: 1,
    ...typography.searchInput,
    color: colors.text.primary,
    paddingVertical: 0,
  },
  cancel: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  cancelLabel: {
    ...typography.chip,
    color: colors.brand.primary,
  },
  content: {
    paddingBottom: spacing.section,
    gap: spacing.xl,
  },
  groupTitle: {
    ...typography.caption,
    color: colors.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: pagePadding,
    marginBottom: spacing.xs,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: pagePadding,
  },
  clearButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  clearLabel: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.brand.primary,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: pagePadding,
    paddingVertical: spacing.xs,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 1 },
  rowLabel: {
    ...typography.body,
    color: colors.text.primary,
  },
  rowSublabel: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.xs,
  },
});
