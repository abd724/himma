/**
 * RI-4 — the acquisition payment/purchase status screen (HMA-022 applied
 * to the S6 purchase target; owner RI-4 §9). The LOCKED RI-3 status
 * machinery is reused verbatim — the same D-RI-5 server vocabulary, the
 * same bounded polling cadence, the same never-from-browser-return rule —
 * with only the target noun corrected (a pass is not a booking). On
 * `confirmed` the purchase read resolves the granted Entitlement and the
 * customer lands on their Pass.
 */
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { nextPoll } from '@/features/bookings/payment-polling';
import {
  PAYMENT_STATUS_COPY,
  type PaymentStatusPresentation,
} from '@/features/bookings/payment-status-copy';
import { pendingCheckoutStore } from '@/services/booking/pending-checkout';
import { entitlementsApi } from '@/services/composition';
import type { AcquisitionPaymentStatus } from '@/services/contracts/entitlements';
import { notifyPassesChanged } from '@/state/passes-events';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useForegroundRefresh } from '@/hooks/use-foreground-refresh';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** The locked RI-3 copy with the target noun corrected for passes. */
function passStatusCopy(status: AcquisitionPaymentStatus['status']): PaymentStatusPresentation {
  const base = PAYMENT_STATUS_COPY[status];
  switch (status) {
    case 'processing':
      return { ...base, body: 'Payment received — preparing your pass…' };
    case 'confirmed':
      return { ...base, title: 'Pass ready', body: 'Your pass is ready to use.' };
    case 'compensationPending':
      return {
        ...base,
        title: 'Pass unavailable',
        body: 'Your payment was received, but this pass could not be issued. Your payment is being returned.',
      };
    case 'compensated':
      return {
        ...base,
        body: 'Your payment has been returned because this pass could not be issued.',
      };
    default:
      return base;
  }
}

export function PurchaseStatusScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ purchaseId?: string }>();
  const purchaseId = typeof params.purchaseId === 'string' ? params.purchaseId : '';

  const [status, setStatus] = useState<AcquisitionPaymentStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [failures, setFailures] = useState(0);
  const attemptRef = useRef(0);
  const failuresRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmedHandled = useRef(false);
  const [pollRun, setPollRun] = useState(0);

  // RI-6: focus-scoped — only the FOCUSED screen instance polls (a stacked
  // duplicate after a deep-link return never runs a second loop).
  useFocusEffect(
    useCallback(() => {
    if (purchaseId === '') return;
    startedAtRef.current ??= Date.now();
    let cancelled = false;

    async function tick(): Promise<void> {
      let read: AcquisitionPaymentStatus | null = null;
      let failed = false;
      try {
        read = await entitlementsApi.acquisitionPaymentStatus(purchaseId);
      } catch {
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
          notifyPassesChanged();
          void pendingCheckoutStore.clear();
          // Resolve the granted Entitlement, then land on the Pass.
          const purchase = await entitlementsApi.getPurchase(purchaseId).catch(() => undefined);
          if (cancelled) return;
          const entitlementId = purchase?.entitlement?.entitlementId;
          router.replace(
            entitlementId !== undefined
              ? (`/passes/${entitlementId}?acquired=1` as never)
              : ('/bookings?view=passes' as never),
          );
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
    }, [purchaseId, pollRun]),
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

  const copy = status === null ? null : passStatusCopy(status.status);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/bookings?view=passes' as never);
          }}
        />
        <Text style={styles.heading} accessibilityRole="header">
          Payment status
        </Text>
      </View>

      <View style={styles.body} testID="purchase-status">
        {status === null || copy === null ? (
          <View style={styles.skeletonWrap}>
            <SkeletonBlock style={styles.skeleton} />
          </View>
        ) : (
          <View style={styles.card} accessibilityLiveRegion="polite">
            <View style={styles.cardIcon}>
              <Ionicons
                name={
                  copy.tone === 'success'
                    ? 'checkmark-circle'
                    : copy.tone === 'expired'
                      ? 'time-outline'
                      : copy.tone === 'compensation'
                        ? 'arrow-undo-circle-outline'
                        : 'card-outline'
                }
                size={30}
                color={
                  copy.tone === 'success'
                    ? colors.status.success
                    : copy.tone === 'expired'
                      ? colors.text.secondary
                      : colors.brand.primary
                }
              />
            </View>
            <Text style={styles.cardTitle}>{copy.title}</Text>
            <Text style={styles.cardBody}>{copy.body}</Text>
            {!copy.terminal && !paused ? (
              <ActivityIndicator color={colors.brand.primary} style={styles.spinner} />
            ) : null}
          </View>
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
            testID="purchase-check-again"
          >
            <Text style={styles.primaryActionLabel}>Check again</Text>
          </PressableFeedback>
        ) : null}

        {status?.status === 'compensationPending' || status?.status === 'compensated' ? (
          <Text style={styles.supportHint}>
            Returns usually appear on your statement within a few business days.
          </Text>
        ) : null}

        <PressableFeedback
          accessibilityLabel="Go to Passes"
          onPress={() => router.replace('/bookings?view=passes' as never)}
          style={styles.secondaryAction}
        >
          <Text style={styles.secondaryActionLabel}>Go to Passes</Text>
        </PressableFeedback>
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
