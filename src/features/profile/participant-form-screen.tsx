/**
 * RI-1 — add/edit participant (HMA-030 forms). One screen serves both:
 * `/account/participants/new` (create child) and
 * `/account/participants/[participantId]` (edit name/DOB; archive child).
 * DOB is entered as YYYY-MM-DD text for V1 (native date picker is a later
 * polish item); the backend remains the validation authority and its
 * typed refusals surface as customer-safe copy. Mutations apply only the
 * server-returned truth.
 */
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { FormError, FormField, PrimaryButton } from '@/features/auth/auth-form';
import { customerErrorCopy } from '@/services/http/error-copy';
import { useAuth } from '@/state/auth-context';
import { useProfiles } from '@/state/profiles-context';
import { colors, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export function ParticipantFormScreen() {
  const auth = useAuth();
  const profiles = useProfiles();
  const params = useLocalSearchParams<{ participantId?: string }>();
  const participantId = Array.isArray(params.participantId)
    ? params.participantId[0]
    : params.participantId;
  const existing =
    participantId === undefined
      ? undefined
      : profiles.profiles.find((profile) => profile.id === participantId);
  const creating = participantId === undefined;

  const [firstName, setFirstName] = useState(existing?.firstName ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(existing?.dateOfBirth ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status === 'guest') {
      router.replace('/auth/sign-in?next=/account/participants' as never);
    }
  }, [auth.status]);

  // Editing a profile that is not in the loaded list (foreign/unknown id):
  // nothing to show — return to the list, never fabricate a form.
  useEffect(() => {
    if (!creating && profiles.status === 'ready' && existing === undefined) {
      router.replace('/account/participants' as never);
    }
  }, [creating, profiles.status, existing]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        await profiles.createChild({ firstName: firstName.trim(), dateOfBirth });
      } else if (existing !== undefined) {
        await profiles.update(existing.id, {
          version: existing.version,
          ...(firstName.trim() !== existing.firstName ? { firstName: firstName.trim() } : {}),
          ...(dateOfBirth !== (existing.dateOfBirth ?? '') && dateOfBirth.length > 0
            ? { dateOfBirth }
            : {}),
        });
      }
      router.back();
    } catch (caught) {
      setError(customerErrorCopy(caught));
    } finally {
      setBusy(false);
    }
  };

  const archive = () => {
    if (existing === undefined || existing.kind === 'self') return;
    Alert.alert(
      `Archive ${existing.firstName}?`,
      'Their profile will be hidden from new bookings. Past bookings are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              setError(null);
              try {
                await profiles.archive(existing.id, existing.version);
                router.back();
              } catch (caught) {
                setError(customerErrorCopy(caught));
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  const title = creating
    ? 'Add a child'
    : existing?.kind === 'self'
      ? 'Your profile'
      : `Edit ${existing?.firstName ?? ''}`;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <PressableFeedback
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace('/account/participants' as never)
            }
            accessibilityLabel="Back"
            style={styles.backButton}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={22} color={colors.text.primary} />
          </PressableFeedback>
          <Text style={styles.title}>{title}</Text>
          <View style={styles.backButton} />
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <FormField
            label={creating || existing?.kind === 'child' ? "Child's name" : 'Name'}
            value={firstName}
            onChangeText={setFirstName}
            placeholder="First name"
            autoCapitalize="words"
            testID="participant-name"
          />
          <FormField
            label="Date of birth"
            value={dateOfBirth}
            onChangeText={setDateOfBirth}
            placeholder="YYYY-MM-DD"
            keyboardType={Platform.OS === 'web' ? undefined : 'numbers-and-punctuation'}
            testID="participant-dob"
          />
          {creating || existing?.kind === 'child' ? (
            <Text style={styles.note}>
              The date of birth is used to check age suitability for activities.
            </Text>
          ) : null}
          <FormError message={error} />
          <PrimaryButton
            label={creating ? 'Add child' : 'Save changes'}
            onPress={submit}
            busy={busy}
            disabled={firstName.trim().length === 0 || (creating && dateOfBirth.length === 0)}
            testID="participant-submit"
          />
          {!creating && existing !== undefined && existing.kind === 'child' ? (
            <PressableFeedback
              onPress={archive}
              accessibilityLabel={`Archive ${existing.firstName}`}
              style={styles.archiveButton}
              testID="participant-archive"
            >
              <Text style={styles.archiveLabel}>Archive this profile</Text>
            </PressableFeedback>
          ) : null}
        </ScrollView>
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
    gap: spacing.lg,
  },
  note: { ...typography.supporting, color: colors.text.secondary },
  archiveButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  archiveLabel: { ...typography.body, color: colors.status.error },
});
