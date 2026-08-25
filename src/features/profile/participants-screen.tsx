/**
 * RI-1 — Participants (HMA-030, bounded V1 scope): the authenticated
 * parent's real profiles from PostgreSQL — self + children — with add /
 * edit / archive. Guests are routed to sign-in; every mutation is
 * server-confirmed (no optimistic fiction); archived children leave the
 * list but history is retained server-side.
 */
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { PrimaryButton } from '@/features/auth/auth-form';
import type { ParticipantProfile } from '@/services/contracts/identity';
import { useAuth } from '@/state/auth-context';
import { useProfiles } from '@/state/profiles-context';
import { colors, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

function ParticipantRow({ profile }: { profile: ParticipantProfile }) {
  return (
    <PressableFeedback
      onPress={() => router.push(`/account/participants/${profile.id}` as never)}
      accessibilityLabel={`Edit ${profile.kind === 'self' ? 'your profile' : profile.firstName}`}
      style={styles.row}
      testID={`participant-row-${profile.kind === 'self' ? 'self' : profile.firstName}`}
    >
      <View style={styles.rowIcon}>
        <Ionicons
          name={profile.kind === 'self' ? 'person-outline' : 'happy-outline'}
          size={20}
          color={colors.brand.primary}
        />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>
          {profile.kind === 'self' ? `${profile.firstName} (You)` : profile.firstName}
        </Text>
        {profile.dateOfBirth !== null ? (
          <Text style={styles.rowSub}>Born {profile.dateOfBirth}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.border.default} />
    </PressableFeedback>
  );
}

export function ParticipantsScreen() {
  const auth = useAuth();
  const profiles = useProfiles();

  // Auth-required surface: guests go to the real sign-in flow and return.
  useEffect(() => {
    if (auth.status === 'guest') {
      router.replace('/auth/sign-in?next=/account/participants' as never);
    }
  }, [auth.status]);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <PressableFeedback
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/profile' as never))}
          accessibilityLabel="Back"
          style={styles.backButton}
          hitSlop={8}
        >
          <Ionicons name="chevron-back" size={22} color={colors.text.primary} />
        </PressableFeedback>
        <Text style={styles.title}>Participants</Text>
        <View style={styles.backButton} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {profiles.status === 'loading' || auth.status === 'restoring' ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.brand.primary} />
          </View>
        ) : profiles.status === 'error' ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>
              We couldn&apos;t load your participants. Check your connection and try again.
            </Text>
            <PrimaryButton label="Try again" onPress={() => profiles.reload()} />
          </View>
        ) : (
          <>
            {profiles.profiles.map((profile) => (
              <ParticipantRow key={profile.id} profile={profile} />
            ))}
            <PrimaryButton
              label="Add a child"
              onPress={() => router.push('/account/participants/new' as never)}
              testID="add-child"
            />
            <Text style={styles.note}>
              Bookings are made per participant. A child profile needs a date of birth so we can
              check age suitability.
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  backButton: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  title: { ...typography.sectionTitle, color: colors.text.primary },
  content: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.section,
    gap: spacing.md,
  },
  center: {
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  errorText: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.background.elevated,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { ...typography.cardTitle, color: colors.text.primary },
  rowSub: { ...typography.supporting, color: colors.text.secondary },
  note: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
});
