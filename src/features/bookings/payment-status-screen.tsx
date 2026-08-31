/**
 * RI-3 — the converged payment/Booking status screen (HMA-022; owner RI-3
 * §15/§16/§18). READS the certified customer projection only: browser
 * return, deep links, and query params carry ZERO commercial authority
 * here — the D-RI-5 copy is selected exclusively by the server status.
 */
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { nextPoll } from '@/features/bookings/payment-polling';
import { PAYMENT_STATUS_COPY } from '@/features/bookings/payment-status-copy';
import { programHref } from '@/features/details/detail-navigation';
import { commerceApi } from '@/services/composition';
import { pendingCheckoutStore } from '@/services/booking/pending-checkout';
import type { CustomerPaymentStatus } from '@/services/contracts/commerce';
import { notifyBookingsChanged } from '@/state/bookings-events';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useForegroundRefresh } from '@/hooks/use-foreground-refresh';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function PaymentStatusScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ bookingId?: string }>();
  const bookingId = typeof params.bookingId === 'string' ? params.bookingId : '';

  const [status, setStatus] = useState<CustomerPaymentStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [failures, setFailures] = useState(0);
  const [missing, setMissing] = useState(false);
  const [programId, setProgramId] = useState<string | null>(null);
  const [programTitle, setProgramTitle] = useState<string | null>(null);
  const attemptRef = useRef(0);
  const failuresRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmedHandled = useRef(false);
  const [pollRun, setPollRun] = useState(0);

  // Booking context (title, program link target) — display only.
  useEffect(() => {
    let cancelled = false;
    commerceApi.getBooking(bookingId).then(
      (booking) => {
        if (cancelled) return;
        if (booking === undefined) {
          setMissing(true);
          return;
        }
        setProgramId(booking.program.id);
        setProgramTitle(booking.program.titleEn);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  // The bounded reconciliation loop (cadence in payment-polling.ts).
  // RI-6: focus-scoped — only the FOCUSED screen instance polls (a stacked
  // duplicate after a deep-link return never runs a second loop).
  useFocusEffect(
    useCallback(() => {
    if (bookingId === '') return;
    startedAtRef.current ??= Date.now();
    let cancelled = false;

    async function tick(): Promise<void> {
      let read: CustomerPaymentStatus | null = null;
      let failed = false;
      try {
        read = await commerceApi.paymentStatus(bookingId);
      } catch {
        // Transient failure NEVER becomes "payment failed" — keep the
        // last known truth and back off.
        failed = true;
      }
      if (cancelled) return;
      attemptRef.current += 1;
      if (read !== null) {
        setStatus(read);
        failuresRef.current = 0;
        setFailures(0);
        if (read.status === 'confirmed' && !confirmedHandled.current) {
          confirmedHandled.current = true;
          notifyBookingsChanged();
          void pendingCheckoutStore.clear();
          router.replace(`/bookings/confirmed/${bookingId}` as never);
          return;
        }
      } else if (failed) {
        failuresRef.current += 1;
        setFailures(failuresRef.current);
      }
      const plan = nextPoll({
        attempt: attemptRef.current,
        elapsedMs: Date.now() - (startedAtRef.current ?? Date.now()),
        lastStatus: read,
        consecutiveFailures: failuresRef.current,
      });
      if (plan.kind === 'stop') return;
      if (plan.kind === 'pause') {
        setPaused(true);
        return;
      }
      timerRef.current = setTimeout(() => {
        void tick();
      }, plan.delayMs);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bookingId, pollRun]),
  );

  const resume = () => {
    startedAtRef.current = Date.now();
    attemptRef.current = 0;
    failuresRef.current = 0;
    setPaused(false);
    setPollRun((run) => run + 1);
  };

  // RI-6 — returning from the external browser (or any background) runs
  // ONE fresh reconciliation of the same single polling loop: timers that
  // slept with the process never stall the truth, and a lapsed budget
  // resumes without a manual tap.
  useForegroundRefresh(resume);

  const copy = status === null ? null : PAYMENT_STATUS_COPY[status.status];
  const showRecheck = status?.status === 'expired';
  const showSupportHint =
    status?.status === 'compensationPending' || status?.status === 'compensated';

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/bookings' as never);
          }}
        />
        <Text style={styles.heading} accessibilityRole="header">
          Payment status
        </Text>
      </View>

      <View style={styles.body} testID="payment-status">
        {missing ? (
          <StatusCard
            icon="help-circle-outline"
            iconColor={colors.text.secondary}
            title="We can’t find that booking"
            body="Check My Bookings for your latest bookings."
          />
        ) : status === null || copy === null ? (
          <View style={styles.skeletonWrap}>
            <SkeletonBlock style={styles.skeleton} />
          </View>
        ) : (
          <StatusCard
            icon={
              copy.tone === 'success'
                ? 'checkmark-circle'
                : copy.tone === 'expired'
                  ? 'time-outline'
                  : copy.tone === 'compensation'
                    ? 'arrow-undo-circle-outline'
                    : 'card-outline'
            }
            iconColor={
              copy.tone === 'success'
                ? colors.status.success
                : copy.tone === 'expired'
                  ? colors.text.secondary
                  : colors.brand.primary
            }
            title={copy.title}
            body={copy.body}
            spinning={!copy.terminal && !paused}
            subtitle={programTitle ?? undefined}
          />
        )}

        {failures >= 2 ? (
          <Text style={styles.connectionNote} accessibilityLiveRegion="polite">
            Connection problem — we’ll keep checking.
          </Text>
        ) : null}

        {paused ? (
          <PressableFeedback
            accessibilityLabel="Check again"
            onPress={resume}
            style={styles.primaryAction}
            testID="payment-check-again"
          >
            <Text style={styles.primaryActionLabel}>Check again</Text>
          </PressableFeedback>
        ) : null}

        {showRecheck && programId !== null ? (
          <PressableFeedback
            accessibilityLabel="Recheck availability"
            onPress={() => router.replace(programHref(programId))}
            style={styles.primaryAction}
          >
            <Text style={styles.primaryActionLabel}>Recheck availability</Text>
          </PressableFeedback>
        ) : null}

        {showSupportHint ? (
          <Text style={styles.supportHint}>
            Returns usually appear on your statement within a few business days.
          </Text>
        ) : null}

        <PressableFeedback
          accessibilityLabel="Go to My Bookings"
          onPress={() => router.replace('/bookings' as never)}
          style={styles.secondaryAction}
        >
          <Text style={styles.secondaryActionLabel}>Go to My Bookings</Text>
        </PressableFeedback>
      </View>
    </View>
  );
}

function StatusCard({
  icon,
  iconColor,
  title,
  body,
  subtitle,
  spinning,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  title: string;
  body: string;
  subtitle?: string;
  spinning?: boolean;
}) {
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <View style={styles.cardIcon}>
        <Ionicons name={icon} size={30} color={iconColor} />
      </View>
      <Text style={styles.cardTitle}>{title}</Text>
      {subtitle !== undefined ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
      <Text style={styles.cardBody}>{body}</Text>
      {spinning === true ? (
        <ActivityIndicator color={colors.brand.primary} style={styles.spinner} />
      ) : null}
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
  skeletonWrap: { gap: spacing.md },
  skeleton: { height: 220, borderRadius: radii.card },
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
  cardSubtitle: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  cardBody: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
    maxWidth: 300,
  },
  spinner: { marginTop: spacing.sm },
  connectionNote: {
    ...typography.caption,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  supportHint: {
    ...typography.caption,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  primaryAction: {
    minHeight: 52,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionLabel: {
    ...typography.chip,
    fontSize: 16,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
  secondaryAction: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryActionLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
});
