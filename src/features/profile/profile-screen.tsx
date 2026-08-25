/**
 * RI-1 — Profile tab (HMA-008, bounded V1 scope): real signed-in identity,
 * participant management entry, sign out. Guests see the sign-in entry —
 * public browsing stays available without an account. Everything else in
 * the approved HMA-008 inventory (payment methods, credits, gifts,
 * referrals, notifications, deletion, support center) is deferred to its
 * owning slice and deliberately NOT rendered as dead UI.
 */
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { PrimaryButton } from '@/features/auth/auth-form';
import { useAuth } from '@/state/auth-context';
import { useProfiles } from '@/state/profiles-context';
import { colors, dockTokens, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

export function ProfileScreen() {
  const auth = useAuth();
  const profiles = useProfiles();
  const insets = useSafeAreaInsets();
  const [signingOut, setSigningOut] = useState(false);

  const contentBottomPadding =
    dockTokens.height + dockTokens.safeAreaOffset + insets.bottom + dockTokens.contentClearance;

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await auth.logout();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
      >
        <Text style={styles.title}>Profile</Text>

        {auth.status === 'restoring' ? (
          <View style={styles.centerCard}>
            <ActivityIndicator color={colors.brand.primary} />
          </View>
        ) : auth.status === 'guest' ? (
          <View style={styles.card}>
            <View style={styles.guestIcon}>
              <Ionicons name="person-circle-outline" size={28} color={colors.brand.primary} />
            </View>
            <Text style={styles.cardTitle}>Sign in to Himma</Text>
            <Text style={styles.cardBody}>
              Manage your family profiles and book activities across providers.
            </Text>
            {auth.restoreUnavailable ? (
              <Text style={styles.warning}>
                We couldn&apos;t reach Himma to restore your session. Check your connection and
                try again.
              </Text>
            ) : null}
            <PrimaryButton
              label="Sign in"
              onPress={() => router.push('/auth/sign-in?next=/profile' as never)}
              testID="profile-sign-in"
            />
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle} testID="profile-display-name">
                {auth.profile?.account?.displayName ?? 'Customer'}
              </Text>
              {auth.profile?.account?.contactEmail != null ? (
                <Text style={styles.cardBody} testID="profile-email">
                  {auth.profile.account.contactEmail}
                </Text>
              ) : null}
            </View>

            <PressableFeedback
              onPress={() => router.push('/account/participants' as never)}
              accessibilityLabel="Participants"
              style={styles.row}
              testID="profile-participants-row"
            >
              <Ionicons name="people-outline" size={20} color={colors.brand.primary} />
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>Participants</Text>
                <Text style={styles.rowSub}>
                  {profiles.status === 'ready'
                    ? `${profiles.profiles.length} profile${profiles.profiles.length === 1 ? '' : 's'}`
                    : 'You and the children you book for'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.border.default} />
            </PressableFeedback>

            <PressableFeedback
              onPress={signOut}
              accessibilityLabel="Sign out"
              style={styles.row}
              testID="profile-sign-out"
            >
              <Ionicons name="log-out-outline" size={20} color={colors.status.error} />
              <View style={styles.rowBody}>
                <Text style={[styles.rowTitle, { color: colors.status.error }]}>
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </Text>
              </View>
            </PressableFeedback>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  content: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    gap: spacing.lg,
  },
  title: { ...typography.screenTitle, color: colors.text.primary },
  centerCard: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.background.elevated,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.xl,
    gap: spacing.sm,
  },
  guestIcon: { marginBottom: spacing.xs },
  cardTitle: { ...typography.cardTitle, color: colors.text.primary },
  cardBody: { ...typography.body, color: colors.text.secondary },
  warning: { ...typography.supporting, color: colors.status.error },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.background.elevated,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { ...typography.cardTitle, color: colors.text.primary },
  rowSub: { ...typography.supporting, color: colors.text.secondary },
});
