/**
 * RI-1 — Sign in (HMA-003, bounded V1 form). Real email/password against
 * the certified backend flow; Apple/Google are presented fail-closed
 * (D-RI-3: genuine provider configuration is an operational prerequisite —
 * success is never simulated). On success the screen returns to where the
 * customer came from (`next` param or back), preserving the flow context.
 */
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SOCIAL_SIGN_IN_AVAILABLE } from '@/services/composition';
import { customerErrorCopy } from '@/services/http/error-copy';
import { useAuth } from '@/state/auth-context';
import { colors, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FormError, FormField, PrimaryButton } from './auth-form';

function afterAuthReturn(next: string | undefined) {
  if (typeof next === 'string' && next.startsWith('/')) {
    router.replace(next as never);
    return;
  }
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export function SignInScreen() {
  const auth = useAuth();
  const params = useLocalSearchParams<{ next?: string }>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signIn(email.trim(), password);
      afterAuthReturn(Array.isArray(params.next) ? params.next[0] : params.next);
    } catch (caught) {
      setError(customerErrorCopy(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <PressableFeedback
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            accessibilityLabel="Back"
            style={styles.backButton}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={22} color={colors.text.primary} />
          </PressableFeedback>
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>
            Sign in to book activities for you and your family.
          </Text>
          <FormField
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoComplete="email"
            testID="sign-in-email"
          />
          <FormField
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="Your password"
            secureTextEntry
            autoComplete="current-password"
            testID="sign-in-password"
          />
          <FormError message={error} />
          <PrimaryButton
            label="Sign in"
            onPress={submit}
            busy={busy}
            disabled={email.trim().length === 0 || password.length === 0}
            testID="sign-in-submit"
          />
          {/* D-RI-3: real Apple/Google arrive as operational configuration on
              the certified identity architecture; until then the options are
              honestly unavailable — never simulated. */}
          {!SOCIAL_SIGN_IN_AVAILABLE.apple && !SOCIAL_SIGN_IN_AVAILABLE.google ? (
            <Text style={styles.socialNote}>
              Sign in with Apple and Google are coming soon.
            </Text>
          ) : null}
          <View style={styles.switchRow}>
            <Text style={styles.switchText}>New to Himma?</Text>
            <PressableFeedback
              onPress={() =>
                router.replace({
                  pathname: '/auth/sign-up',
                  params: params.next !== undefined ? { next: params.next } : {},
                } as never)
              }
              accessibilityLabel="Create an account"
              hitSlop={8}
            >
              <Text style={styles.switchLink}>Create an account</Text>
            </PressableFeedback>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  flex: { flex: 1 },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  backButton: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  content: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.section,
    gap: spacing.lg,
  },
  title: {
    ...typography.screenTitle,
    color: colors.text.primary,
  },
  subtitle: {
    ...typography.body,
    color: colors.text.secondary,
    marginBottom: spacing.sm,
  },
  socialNote: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 44,
  },
  switchText: {
    ...typography.body,
    color: colors.text.secondary,
  },
  switchLink: {
    ...typography.body,
    color: colors.brand.primary,
  },
});
