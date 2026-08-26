/**
 * RI-3 — the hosted-checkout RETURN landing (owner RI-3 §15/§17).
 *
 * Browser return is NAVIGATION ONLY: nothing here — path, query params,
 * `outcome`, deep-link — carries commercial authority. The screen only
 * recovers WHICH booking to read from the locally persisted pending-
 * checkout record, then hands off to the status screen (server truth).
 *
 * Lost-response recovery (W5-5): when the pending record has no bookingId
 * (the initiation response was lost), the SAME stable idempotency key
 * re-initiates — the certified replay returns the same checkout while the
 * Himma hold lives; a dead hold yields the truthful typed refusal and the
 * stale redirect is NEVER re-presented.
 */
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { commerceApi } from '@/services/composition';
import { pendingCheckoutStore } from '@/services/booking/pending-checkout';
import { ApiError } from '@/services/http/http-client';
import { useAuth } from '@/state/auth-context';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function CheckoutReturnScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  const [fallback, setFallback] = useState<'none' | 'noPending' | 'expired'>('none');

  useEffect(() => {
    if (auth.status === 'restoring') return;
    let cancelled = false;

    async function resolve(): Promise<void> {
      const pending = await pendingCheckoutStore.load();
      if (cancelled) return;
      if (pending === null || auth.status !== 'authenticated') {
        setFallback('noPending');
        return;
      }
      if (pending.bookingId !== undefined) {
        router.replace(`/bookings/status/${pending.bookingId}` as never);
        return;
      }
      // Response was lost before the bookingId arrived: recover the SAME
      // commercial intent with the SAME key (never a fresh intent).
      try {
        const checkout = await commerceApi.initiateCheckout({
          holdId: pending.holdId,
          quoteId: pending.quoteId,
          idempotencyKey: pending.idempotencyKey,
        });
        if (cancelled) return;
        await pendingCheckoutStore.save({ ...pending, bookingId: checkout.bookingId });
        router.replace(`/bookings/status/${checkout.bookingId}` as never);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError) {
          // The hold died or the checkout concluded — plain truth; the
          // status of any created booking lives in My Bookings.
          await pendingCheckoutStore.clear();
          setFallback('expired');
          return;
        }
        setFallback('noPending');
      }
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [auth.status, router]);

  return (
    <View style={styles.root}>
      <View style={[styles.body, { paddingTop: insets.top + spacing.section }]}>
        {fallback === 'none' ? (
          <SkeletonBlock style={styles.skeleton} />
        ) : (
          <View style={styles.card}>
            <Text style={styles.title}>
              {fallback === 'expired' ? 'This checkout has ended' : 'Welcome back'}
            </Text>
            <Text style={styles.bodyText}>
              {fallback === 'expired'
                ? 'The checkout window closed. Check My Bookings for the latest status of your bookings.'
                : 'Check My Bookings for the latest status of your bookings.'}
            </Text>
            <PressableFeedback
              accessibilityLabel="Go to My Bookings"
              onPress={() => router.replace('/bookings' as never)}
              style={styles.primaryAction}
            >
              <Text style={styles.primaryActionLabel}>Go to My Bookings</Text>
            </PressableFeedback>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  body: {
    flex: 1,
    paddingHorizontal: pagePadding,
  },
  skeleton: { height: 180, borderRadius: radii.card },
  card: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  title: {
    ...typography.cardTitle,
    fontFamily: fontFamily.extraBold,
    color: colors.text.primary,
    textAlign: 'center',
  },
  bodyText: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
    maxWidth: 300,
  },
  primaryAction: {
    marginTop: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
});
