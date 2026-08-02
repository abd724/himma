import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * Search route container (HMA-009) — the approved full-screen foundation:
 * focused input, Cancel return, keyboard handling. Suggestions, recents, and
 * results arrive in the feat(search) commit.
 */
export default function SearchScreen() {
  const router = useRouter();
  // Cold deep links have no stack to pop — fall back to the Home tab root.
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <View style={styles.field}>
            <Ionicons name="search-outline" size={20} color={colors.text.secondary} />
            <TextInput
              style={styles.input}
              placeholder="Search activities, providers or classes"
              placeholderTextColor={colors.text.secondary}
              returnKeyType="search"
              autoFocus
              accessibilityLabel="Search activities, providers or classes"
              onSubmitEditing={() => {}}
            />
          </View>
          <PressableFeedback
            onPress={close}
            accessibilityLabel="Cancel search"
            style={styles.cancel}
            hitSlop={8}
          >
            <Ionicons name="close" size={22} color={colors.text.primary} />
          </PressableFeedback>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 52,
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
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
});
