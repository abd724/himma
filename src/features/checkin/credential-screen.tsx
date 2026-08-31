/**
 * RI-4 — the check-in code screen (docs/35 §9; owner RI-4 §16–§22).
 *
 * Shows the large 8-digit code (4-4 grouping) with its server expiry,
 * participant/activity context, and the scheduled occurrence where the
 * credential carries one. The code is SECRET material: it lives in the
 * in-memory store only (never a route param, never persisted, never
 * logged); after a reload only metadata exists and recovery is EXPLICIT
 * regeneration of the named credential — the app never fabricates a code
 * and never hammers initial issuance hoping for the old secret.
 *
 * State is SERVER truth: a bounded poll (3 s while live, stops on
 * terminal/timeout/blur) lets the customer observe a provider redemption
 * as "Checked in" — success is never assumed because the provider saw the
 * code. The countdown is presentation over the server `expiresAt`; expiry
 * actions revalidate server-side.
 */
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import {
  credentialHref,
  issueForTarget,
  type CheckInTarget,
} from '@/features/checkin/checkin-entry';
import { nextCredentialPoll } from '@/features/checkin/credential-polling';
import {
  clearStashedCredential,
  stashedCredential,
} from '@/features/checkin/credential-store';
import { displayCodeGroups, displayTime } from '@/features/passes/passes-presentation';
import { entitlementsApi } from '@/services/composition';
import type { CredentialStatus } from '@/services/contracts/entitlements';
import { customerErrorCopy } from '@/services/http/error-copy';
import { ApiError } from '@/services/http/http-client';
import { notifyBookingsChanged } from '@/state/bookings-events';
import { notifyPassesChanged } from '@/state/passes-events';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useForegroundRefresh } from '@/hooks/use-foreground-refresh';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function remainingLabel(expiresAt: string, now: Date): string {
  const remainingMs = new Date(expiresAt).getTime() - now.getTime();
  if (remainingMs <= 0) return '0:00';
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function CredentialScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    credentialId?: string;
    booking?: string;
    entitlement?: string;
    date?: string;
    time?: string;
  }>();
  const credentialId = typeof params.credentialId === 'string' ? params.credentialId : '';
  // The regeneration TARGET rides the route as identifiers only.
  const target: CheckInTarget | null =
    typeof params.booking === 'string'
      ? {
          kind: 'booking',
          bookingId: params.booking,
          ...(typeof params.date === 'string' && typeof params.time === 'string'
            ? { occurrence: { date: params.date, startTime: params.time } }
            : {}),
        }
      : typeof params.entitlement === 'string'
        ? { kind: 'entitlement', entitlementId: params.entitlement }
        : null;

  const stashed = stashedCredential(credentialId);
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [now, setNow] = useState(new Date());
  const [regenerating, setRegenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const consumedHandled = useRef(false);
  const [pollEpoch, setPollEpoch] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const failuresRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bounded SERVER-state observation while the screen is focused.
  useFocusEffect(
    useCallback(() => {
      startedAtRef.current = Date.now();
      failuresRef.current = 0;
      let cancelled = false;

      async function tick(): Promise<void> {
        let read: CredentialStatus | null = null;
        try {
          read = (await entitlementsApi.credentialStatus(credentialId)) ?? null;
          failuresRef.current = 0;
        } catch {
          failuresRef.current += 1;
        }
        if (cancelled) return;
        if (read !== null) {
          setStatus(read);
          if (read.state === 'used' && !consumedHandled.current) {
            // Provider redemption became SERVER truth: the pass balance and
            // any related booking context re-read fresh projections.
            consumedHandled.current = true;
            clearStashedCredential(credentialId);
            notifyPassesChanged();
            notifyBookingsChanged();
          }
        }
        const plan = nextCredentialPoll({
          elapsedMs: Date.now() - (startedAtRef.current ?? Date.now()),
          lastStatus: read,
          consecutiveFailures: failuresRef.current,
        });
        if (plan.kind === 'stop') return;
        timerRef.current = setTimeout(() => {
          void tick();
        }, plan.delayMs);
      }

      void tick();
      return () => {
        cancelled = true;
        if (timerRef.current !== null) clearTimeout(timerRef.current);
      };
      // pollEpoch deliberately restarts the bounded loop on app foreground.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [credentialId, pollEpoch]),
  );

  // RI-6 — app resume runs ONE fresh authoritative status read (the same
  // single bounded loop restarts): a code that expired or was redeemed
  // while the app was backgrounded shows its true state immediately; no
  // background timer is ever the authority.
  useForegroundRefresh(() => setPollEpoch((epoch) => epoch + 1));

  // Presentation countdown only — the SERVER expiry owns the truth; the
  // poll surfaces the effective `expired` state.
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  /** EXPLICIT regeneration of the NAMED credential (S6-2 rules B–H). */
  const regenerate = async () => {
    if (target === null || regenerating) return;
    setRegenerating(true);
    setActionError(null);
    try {
      const { outcome } = await issueForTarget(entitlementsApi, target, credentialId);
      if (outcome.kind === 'issued') {
        consumedHandled.current = false;
        router.replace(credentialHref(outcome.credential.credentialId, target) as never);
        return;
      }
      // A concurrent replacement won the race — reload truth, offer again.
      router.replace(credentialHref(outcome.credential.credentialId, target) as never);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'staleVersion') {
        // The named credential is no longer current — re-read server truth
        // instead of silently superseding whatever is live now.
        setActionError('This code was already replaced. Pull up your newest code and try again.');
        const fresh = await entitlementsApi.credentialStatus(credentialId).catch(() => null);
        if (fresh != null) setStatus(fresh);
      } else {
        setActionError(customerErrorCopy(error));
      }
    } finally {
      setRegenerating(false);
    }
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/bookings' as never);
  };

  const effectiveState: CredentialStatus['state'] | null =
    status === null
      ? null
      : status.state === 'live' && new Date(status.expiresAt).getTime() <= now.getTime()
        ? 'expired'
        : status.state;
  const hasSecret = stashed?.displayCode !== undefined;
  const occurrence = status?.occurrence;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <Text style={styles.heading} accessibilityRole="header">
          Check in
        </Text>
      </View>

      <View style={styles.body} testID="credential-screen">
        {status === null ? (
          <SkeletonBlock style={styles.skeleton} />
        ) : effectiveState === 'used' ? (
          <View style={styles.card} accessibilityLiveRegion="polite" testID="credential-used">
            <View style={styles.cardIcon}>
              <Ionicons name="checkmark-circle" size={34} color={colors.status.success} />
            </View>
            <Text style={styles.cardTitle}>Checked in</Text>
            <Text style={styles.cardBody}>
              {status.redeemedAt !== undefined
                ? `Confirmed by the venue at ${new Date(status.redeemedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. Enjoy your session!`
                : 'Confirmed by the venue. Enjoy your session!'}
            </Text>
            <PressableFeedback
              accessibilityLabel="Done"
              onPress={goBack}
              style={styles.primaryAction}
              testID="credential-done"
            >
              <Text style={styles.primaryActionLabel}>Done</Text>
            </PressableFeedback>
          </View>
        ) : effectiveState === 'expired' || effectiveState === 'superseded' ? (
          <View style={styles.card} accessibilityLiveRegion="polite" testID="credential-stale">
            <View style={styles.cardIcon}>
              <Ionicons
                name={effectiveState === 'expired' ? 'time-outline' : 'swap-horizontal'}
                size={30}
                color={colors.text.secondary}
              />
            </View>
            <Text style={styles.cardTitle}>
              {effectiveState === 'expired' ? 'This code expired' : 'This code was replaced'}
            </Text>
            <Text style={styles.cardBody}>
              {effectiveState === 'expired'
                ? 'Codes last 10 minutes. Generate a fresh one when you’re at the venue.'
                : 'A newer code exists for this check-in.'}
            </Text>
            {target !== null ? (
              <PressableFeedback
                accessibilityLabel="Generate a new code"
                accessibilityState={{ disabled: regenerating }}
                disabled={regenerating}
                onPress={() => {
                  void regenerate();
                }}
                style={[styles.primaryAction, regenerating && styles.primaryActionDisabled]}
                testID="credential-regenerate"
              >
                <Text style={styles.primaryActionLabel}>
                  {regenerating ? 'Generating…' : 'Generate a new code'}
                </Text>
              </PressableFeedback>
            ) : null}
          </View>
        ) : (
          <View style={styles.card} testID="credential-live">
            {hasSecret ? (
              <>
                <Text style={styles.codeLabel}>Show this code at the desk</Text>
                <Text
                  style={styles.code}
                  accessibilityLabel={`Check-in code ${stashed!.displayCode!.split('').join(' ')}`}
                  testID="credential-code"
                >
                  {displayCodeGroups(stashed!.displayCode!)}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.cardTitle}>Your code is active</Text>
                <Text style={styles.cardBody}>
                  For security we can’t show it again on this device. Generate a new code to
                  check in — the old one stops working.
                </Text>
              </>
            )}
            <Text style={styles.expiry} accessibilityLiveRegion="polite">
              Expires in {remainingLabel(status.expiresAt, now)}
            </Text>
            {occurrence !== undefined ? (
              <Text style={styles.occurrence} testID="credential-occurrence">
                For{' '}
                {new Date(`${occurrence.date}T00:00:00`).toLocaleDateString('en-US', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'short',
                })}{' '}
                · {displayTime(occurrence.startTime)}
              </Text>
            ) : null}
            {target !== null ? (
              <PressableFeedback
                accessibilityLabel={hasSecret ? 'Replace this code' : 'Generate a new code'}
                accessibilityState={{ disabled: regenerating }}
                disabled={regenerating}
                onPress={() => {
                  void regenerate();
                }}
                style={[
                  hasSecret ? styles.secondaryAction : styles.primaryAction,
                  regenerating && styles.primaryActionDisabled,
                ]}
                testID="credential-regenerate"
              >
                <Text style={hasSecret ? styles.secondaryActionLabel : styles.primaryActionLabel}>
                  {regenerating
                    ? 'Generating…'
                    : hasSecret
                      ? 'Replace this code'
                      : 'Generate a new code'}
                </Text>
              </PressableFeedback>
            ) : null}
          </View>
        )}

        {actionError !== null ? (
          <Text style={styles.actionError} accessibilityLiveRegion="polite">
            {actionError}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: pagePadding,
    paddingBottom: spacing.md,
  },
  heading: {
    ...typography.sectionTitle,
    letterSpacing: -0.3,
    color: colors.text.primary,
    flex: 1,
  },
  body: {
    flex: 1,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.xl,
    gap: spacing.lg,
  },
  skeleton: { height: 260, borderRadius: radii.card },
  card: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  cardIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  cardTitle: {
    ...typography.cardTitle,
    fontFamily: fontFamily.extraBold,
    color: colors.text.primary,
    textAlign: 'center',
  },
  cardBody: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
    maxWidth: 300,
  },
  codeLabel: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  code: {
    fontFamily: fontFamily.extraBold,
    fontSize: 44,
    lineHeight: 54,
    letterSpacing: 2,
    color: colors.text.primary,
  },
  expiry: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  occurrence: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  primaryAction: {
    marginTop: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionDisabled: { opacity: 0.6 },
  primaryActionLabel: {
    ...typography.chip,
    fontSize: 16,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
  secondaryAction: {
    marginTop: spacing.sm,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryActionLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  actionError: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
    textAlign: 'center',
  },
});
