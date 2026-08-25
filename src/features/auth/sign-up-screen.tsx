/**
 * RI-1 — Create account (HMA-003, bounded V1 form). Real email/password
 * sign-up through the dev identity gateway → certified first-login
 * (PostgreSQL account + self participant created atomically server-side).
 */
import { PressableFeedback } from '@/components/ui/pressable-feedback';
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

export function SignUpScreen() {
  const auth = useAuth();
  const params = useLocalSearchParams<{ next?: string }>();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signUp({
        email: email.trim(),
        password,
        ...(name.trim().length > 0 ? { displayName: name.trim() } : {}),
      });
      const next = Array.isArray(params.next) ? params.next[0] : params.next;
      if (typeof next === 'string' && next.startsWith('/')) router.replace(next as never);
      else if (router.canGoBack()) router.back();
      else router.replace('/');
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
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>
            One account for you and the children you book for.
          </Text>
          <FormField
            label="Your name"
            value={name}
            onChangeText={setName}
            placeholder="How should we greet you?"
            autoCapitalize="words"
            autoComplete="name"
            testID="sign-up-name"
          />
          <FormField
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoComplete="email"
            testID="sign-up-email"
          />
          <FormField
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="At least 8 characters"
            secureTextEntry
            autoComplete="new-password"
            testID="sign-up-password"
          />
          <FormError message={error} />
          <PrimaryButton
            label="Create account"
            onPress={submit}
            busy={busy}
            disabled={email.trim().length === 0 || password.length === 0}
            testID="sign-up-submit"
          />
          <View style={styles.switchRow}>
            <Text style={styles.switchText}>Already have an account?</Text>
            <PressableFeedback
              onPress={() =>
                router.replace({
                  pathname: '/auth/sign-in',
                  params: params.next !== undefined ? { next: params.next } : {},
                } as never)
              }
              accessibilityLabel="Sign in"
              hitSlop={8}
            >
              <Text style={styles.switchLink}>Sign in</Text>
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
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
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
  title: { ...typography.screenTitle, color: colors.text.primary },
  subtitle: {
    ...typography.body,
    color: colors.text.secondary,
    marginBottom: spacing.sm,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 44,
  },
  switchText: { ...typography.body, color: colors.text.secondary },
  switchLink: { ...typography.body, color: colors.brand.primary },
});
