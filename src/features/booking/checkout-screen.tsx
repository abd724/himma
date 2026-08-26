import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { AppImage } from '@/components/ui/app-image';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { bookingHref, bookingStepHref } from '@/features/booking/booking-navigation';
import {
  checkoutReadiness,
  checkoutReducer,
  ctaPressAllowed,
  initialCheckoutUiState,
  type CheckoutReadiness,
} from '@/features/booking/checkout-state';
import { PaymentMethodRow } from '@/features/booking/payment-method-row';
import { HoldCountdown } from '@/features/booking/hold-countdown';
import { summaryParticipantBlock } from '@/features/booking/summary-presentation';
import { demoImage } from '@/data/mock/images';
import { composeCheckoutPage } from '@/services/api/real-commerce-services';
import { commerceApi } from '@/services/composition';
import { pendingCheckoutStore } from '@/services/booking/pending-checkout';
import { customerErrorCopy } from '@/services/http/error-copy';
import { ApiError } from '@/services/http/http-client';
import { notifyBookingsChanged } from '@/state/bookings-events';
import { useBookingSession } from '@/state/booking-session-context';
import { useParticipantContext } from '@/state/participant-context';
import { colors, fontFamily, pagePadding, radii, shadows, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Checkout — docs/22 §4, owner decisions docs/09 §22. One screen over the
 * re-derived BookingSummary: order recap, `Booking price` breakdown (no
 * `Total`, no VAT, no fees, no discount arithmetic), the cancellation-policy
 * summary displayed with no acceptance claim, the generic `Card payment`
 * contract method for paid bookings (Commit 17 — no card details of any
 * kind), and a readiness-gated, production-styled, inert CTA (`Continue to
 * payment` / `Confirm booking`) that is never unready without a named
 * reason. Nothing here reserves, pays, or confirms anything (docs/08 §14,
 * docs/09 §22.11).
 */
export function CheckoutScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ programId?: string; 'qa-fail'?: string }>();
  const programId = typeof params.programId === 'string' ? params.programId : '';

  const { participants } = useParticipantContext();
  const {
    summary,
    hold,
    commerce,
    forgetHold,
    releaseHold,
  } = useBookingSession();

  // The flow's stored summary carries THE authoritative quote (one quote:
  // summary → hold → checkout). Missing state = cold link/reload — the
  // summary step re-derives; nothing is silently re-priced here.
  const page = useMemo(
    () => (summary === null ? null : (composeCheckoutPage(summary, participants) ?? null)),
    [summary, participants],
  );
  // True once THIS screen owns the next navigation (confirmation/status/
  // expiry) — the missing-state redirect below must never race it.
  const navigationOwned = useRef(false);
  const [holdStateForRedirect, setHoldStateForRedirect] = useState<'live' | 'checking' | 'expired'>(
    'live',
  );
  useEffect(() => {
    if (navigationOwned.current || holdStateForRedirect !== 'live') return;
    if (summary === null || hold === undefined || page === null) {
      navigationOwned.current = true;
      router.replace(bookingStepHref(programId, 'summary'));
    }
  }, [summary, hold, page, holdStateForRedirect, programId, router]);

  // Checkout-local UI state (docs/22 §5/§11): the method selection only.
  const [uiState, dispatchUi] = useReducer(checkoutReducer, initialCheckoutUiState);
  const lastCtaPressAt = useRef(0);
  const [busy, setBusy] = useState(false);
  const [ctaError, setCtaError] = useState<string | null>(null);
  const holdState = holdStateForRedirect;
  const setHoldState = setHoldStateForRedirect;

  // Back returns to the Booking Summary — the hold (checkout window)
  // survives; backing out past the summary releases it there.
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(bookingStepHref(programId, 'summary'));
  };
  const editBooking = goBack;

  /**
   * Effective hold expiry (owner §8/§18). The countdown is presentation;
   * on zero the SERVER is asked. Stronger financial truth dominates: if a
   * checkout was initiated, the payment projection is read FIRST — money
   * may already be processing/confirmed/compensating.
   */
  const onCountdownEnd = async () => {
    if (hold === undefined) return;
    setHoldState('checking');
    try {
      const pending = await pendingCheckoutStore.load();
      if (pending !== null && pending.holdId === hold.holdId && pending.bookingId !== undefined) {
        try {
          const payment = await commerceApi.paymentStatus(pending.bookingId);
          if (payment.status !== 'awaitingPayment' && payment.status !== 'expired') {
            navigationOwned.current = true;
            router.replace(`/bookings/status/${pending.bookingId}` as never);
            return;
          }
        } catch {
          // Fall through to the hold read — never invent payment truth.
        }
      }
      const status = await commerceApi.holdStatus(hold.holdId);
      if (status.state === 'active') {
        setHoldState('live');
        return;
      }
    } catch {
      // Unreachable server: do NOT claim expiry from the device clock
      // alone — surface the check state and let the customer retry.
    }
    setHoldState('expired');
    forgetHold();
  };

  const recheckAvailability = () => {
    navigationOwned.current = true;
    void releaseHold();
    router.dismissTo(bookingHref(programId));
  };

  /** Free path — the certified atomic confirmation; no payment machinery. */
  const confirmFreeBooking = async () => {
    if (hold === undefined) return;
    setBusy(true);
    setCtaError(null);
    try {
      const booking = await commerceApi.confirmFree(
        hold.holdId,
        commerce.confirmKeyFor(hold.holdId),
      );
      navigationOwned.current = true;
      forgetHold();
      notifyBookingsChanged();
      await pendingCheckoutStore.clear();
      router.replace(`/bookings/confirmed/${booking.bookingId}` as never);
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError) {
        if (error.code === 'holdExpired' || error.code === 'holdNotActive') {
          setHoldState('expired');
          forgetHold();
          return;
        }
        if (error.code === 'quoteExpired') {
          // Server TTL authority: back to the summary, which re-quotes and
          // SHOWS the fresh total before any further commitment.
          navigationOwned.current = true;
          void releaseHold();
          router.replace(bookingStepHref(programId, 'summary'));
          return;
        }
        if (error.code === 'alreadyConfirmed' || error.code === 'alreadyBooked') {
          navigationOwned.current = true;
          notifyBookingsChanged();
          router.replace('/bookings' as never);
          return;
        }
      }
      setCtaError(customerErrorCopy(error));
    }
  };

  /** Paid path — the certified W5-5 initiation: identifiers + the STABLE
   *  checkout key only; the pending record is persisted BEFORE the call so
   *  a lost response/reload recovers the SAME commercial intent. */
  const startPayment = async () => {
    if (hold === undefined || summary === null || summary.quote === undefined) return;
    setBusy(true);
    setCtaError(null);
    const idempotencyKey = commerce.checkoutKeyFor(hold.holdId);
    const pendingBase = {
      programId,
      holdId: hold.holdId,
      quoteId: summary.quote.quoteId,
      idempotencyKey,
      createdAt: new Date().toISOString(),
    };
    try {
      await pendingCheckoutStore.save(pendingBase);
      const checkout = await commerceApi.initiateCheckout({
        holdId: hold.holdId,
        quoteId: summary.quote.quoteId,
        idempotencyKey,
      });
      await pendingCheckoutStore.save({
        ...pendingBase,
        bookingId: checkout.bookingId,
        holdExpiresAt: checkout.holdExpiresAt,
      });
      // Hosted checkout is NAVIGATION: the browser/app goes to the
      // provider's page; truth returns only via the status read.
      if (Platform.OS === 'web') {
        (globalThis as { location?: { assign: (url: string) => void } }).location?.assign(
          checkout.redirectUrl,
        );
      } else {
        navigationOwned.current = true;
        await Linking.openURL(checkout.redirectUrl);
        router.replace(`/bookings/status/${checkout.bookingId}` as never);
      }
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError) {
        if (error.code === 'holdExpired' || error.code === 'holdNotActive') {
          setHoldState('expired');
          forgetHold();
          return;
        }
        if (error.code === 'quoteExpired') {
          navigationOwned.current = true;
          void releaseHold();
          router.replace(bookingStepHref(programId, 'summary'));
          return;
        }
        if (error.code === 'checkoutAlreadyActive' || error.code === 'checkoutConcluded') {
          navigationOwned.current = true;
          const pending = await pendingCheckoutStore.load();
          if (pending?.bookingId !== undefined) {
            router.replace(`/bookings/status/${pending.bookingId}` as never);
            return;
          }
          router.replace('/bookings' as never);
          return;
        }
      }
      setCtaError(customerErrorCopy(error));
    }
  };

  const participantBlock =
    page === null ? undefined : summaryParticipantBlock(page.summary.participant, participants);
  const readiness: CheckoutReadiness =
    page === null ? { ready: false } : checkoutReadiness(page, uiState);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <Text style={styles.heading} accessibilityRole="header">
          Checkout
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{
          // CTA-bar clearance applies only while the bar renders (it is
          // absent during loading and expiry states).
          paddingBottom:
            page !== null && holdState !== 'expired'
              ? 132 + insets.bottom + spacing.xl
              : insets.bottom + spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {holdState === 'expired' ? (
          /* Truthful effective expiry (owner §8): the seat is no longer
             presented as reserved, nothing re-claims silently, and the
             customer returns to REAL availability. */
          <View style={styles.stateWrap} testID="hold-expired">
            <EmptyFeedCard
              title="Your held spot expired"
              message="The 10-minute checkout window ended, so the spot was released. Availability may have changed."
              actionLabel="Recheck availability"
              onClearFilter={recheckAvailability}
            />
          </View>
        ) : page === null || participantBlock === undefined ? (
          <CheckoutSkeleton />
        ) : (
          <View style={styles.content}>
            {/* The authoritative 10-minute hold countdown (presentation
                only — on zero the SERVER decides; owner §8/§18). */}
            {hold !== undefined ? (
              <HoldCountdown
                expiresAt={hold.expiresAt}
                checking={holdState === 'checking'}
                onExpired={() => {
                  void onCountdownEnd();
                }}
              />
            ) : null}
            {/* Order recap — docs/22 §4.2: condensed, single edit action. */}
            <View style={styles.recapCard}>
              <View style={styles.recapProgramRow}>
                <AppImage source={demoImage(page.summary.program.imageKey)} style={styles.thumbnail} />
                <View style={styles.recapProgramText}>
                  <Text style={styles.recapTitle} numberOfLines={2}>
                    {page.summary.program.title}
                  </Text>
                  <View style={styles.providerRow}>
                    <Text style={styles.recapMeta} numberOfLines={1}>
                      {page.summary.provider.name}
                    </Text>
                    {page.summary.provider.verified ? (
                      <Ionicons
                        name="shield-checkmark"
                        size={13}
                        color={colors.brand.primary}
                        accessibilityLabel="Verified provider"
                      />
                    ) : null}
                  </View>
                  <Text style={styles.recapMeta} numberOfLines={1}>
                    {page.summary.program.areaLabel ?? ''}
                    {page.summary.branch === undefined ? '' : ` · ${page.summary.branch.label}`}
                  </Text>
                </View>
              </View>
              <View style={styles.recapDivider} />
              <View
                accessible
                accessibilityLabel={`${participantBlock.accessibilityLabel}${
                  page.guardianContextLine === undefined
                    ? ''
                    : `, ${page.guardianContextLine.toLowerCase()}`
                }`}
              >
                <Text style={styles.recapLine}>
                  {participantBlock.displayName}
                  {participantBlock.detailLine === undefined
                    ? ''
                    : ` · ${participantBlock.detailLine}`}
                </Text>
                {/* Guardian context display only — no consent mechanics
                    exist this milestone (docs/09 §22.8). */}
                {page.guardianContextLine === undefined ? null : (
                  <Text style={styles.recapSupporting}>{page.guardianContextLine}</Text>
                )}
              </View>
              <View style={styles.recapDivider} />
              <View>
                <Text style={styles.recapLine}>{page.summary.option.title}</Text>
                {page.summary.selectionLines.map((line) => (
                  <Text key={line} style={styles.recapSupporting}>
                    {line}
                  </Text>
                ))}
              </View>
              <PressableFeedback
                accessibilityRole="button"
                accessibilityLabel="Edit booking"
                onPress={editBooking}
                style={styles.editAction}
              >
                <Text style={styles.editActionLabel}>Edit booking</Text>
              </PressableFeedback>
            </View>

            {/* Price breakdown — docs/22 §6: Booking price, never Total. */}
            <View style={styles.block}>
              <Text style={styles.blockLabel} accessibilityRole="header">
                Price
              </Text>
              {page.price.lines.map((line) => (
                <View key={line.id} style={styles.priceRow}>
                  <Text style={styles.blockLine}>{line.label}</Text>
                  <Text style={styles.priceValue}>{line.value}</Text>
                </View>
              ))}
              {page.price.offerLine === undefined ? null : (
                <View style={styles.offerRow}>
                  <Ionicons name="pricetag-outline" size={14} color={colors.brand.primary} />
                  <Text style={styles.offerText}>{page.price.offerLine}</Text>
                </View>
              )}
              <View
                style={styles.bookingPriceRow}
                accessible
                accessibilityLabel={page.price.spokenBookingPriceLabel}
              >
                <Text style={styles.bookingPriceText}>{page.price.bookingPriceLabel}</Text>
              </View>
            </View>

            {/* Cancellation policy — renders only when a policy genuinely
                exists (the certified snapshot arrives at confirmation; D-8
                content remains a launch gate). */}
            {page.summary.policy !== undefined ? (
              <View style={styles.block}>
                <Text style={styles.blockLabel} accessibilityRole="header">
                  Cancellation policy
                </Text>
                <Text style={styles.blockTitle}>{page.summary.policy.title}</Text>
                {page.summary.policy.summaryLines.map((line) => (
                  <Text key={line} style={styles.blockLine}>
                    {line}
                  </Text>
                ))}
              </View>
            ) : null}

            {/* Payment method — paid bookings only (docs/22 §4.5, §7.5):
                one generic selectable contract method with radio semantics;
                no card details exist or are implied. Absent for free. */}
            {page.paymentRequired && page.paymentMethods.length > 0 ? (
              <View style={styles.block}>
                <Text style={styles.blockLabel} accessibilityRole="header">
                  Payment method
                </Text>
                <View accessibilityRole="radiogroup" style={styles.methodList}>
                  {page.paymentMethods.map((method) => (
                    <PaymentMethodRow
                      key={method.id}
                      method={method}
                      selected={method.id === uiState.paymentMethodId}
                      onSelect={() =>
                        dispatchUi({ type: 'selectMethod', paymentMethodId: method.id })
                      }
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {/* Support contract row — HMA-032 pattern; inert. */}
            <PressableFeedback
              accessibilityRole="button"
              accessibilityLabel="Something wrong with your booking?"
              style={styles.supportRow}
            >
              <Ionicons name="help-circle-outline" size={18} color={colors.text.secondary} />
              <Text style={styles.supportText}>Something wrong with your booking?</Text>
            </PressableFeedback>
          </View>
        )}
      </ScrollView>

      {page === null || holdState === 'expired' ? null : (
        <View style={[styles.ctaBar, { paddingBottom: insets.bottom + spacing.md }]}>
          {/* The polite live region announces readiness blockers and their
              resolution (docs/22 §9/§12) — never unready without a reason. */}
          <View style={styles.ctaStatus} accessibilityLiveRegion="polite">
            {/* The named blocker wraps in full — the reason the CTA is not
                ready is never truncated (docs/22 §9). The ready-state price
                line keeps the established 2-line cap (full label in the
                price block and the accessible CTA label). */}
            <Text style={styles.ctaStatusText} numberOfLines={readiness.ready ? 2 : undefined}>
              {ctaError ?? (readiness.ready ? page.price.bookingPriceLabel : readiness.blocker)}
            </Text>
          </View>
          {/* Production-styled, duplicate-press-protected (700 ms guard —
              the mechanics ship real, docs/22 §13), and truthful: even when
              ready, the press is the inert contract — no navigation, dialog,
              success, failure, reservation, or payment (docs/09 §22.11).
              Unready: `disabled` exposes aria-disabled="true" (plus the
              browser's native disabled semantics on web-button hosts) and
              blocks click/Enter/Space/native press at the Pressable layer;
              accessibilityState carries the native state contract, and the
              adjacent polite live region names the blocker. */}
          <PressableFeedback
            accessibilityRole="button"
            accessibilityLabel={page.spokenCtaLabel}
            accessibilityState={{ disabled: !readiness.ready || busy }}
            disabled={!readiness.ready || busy}
            testID="checkout-cta"
            onPress={() => {
              // Defense in depth behind the Pressable-layer block: the pure
              // gate re-checks readiness and the duplicate-press window;
              // the STABLE idempotency keys make even a slipped-through
              // duplicate a harmless replay (owner §10).
              if (busy) return;
              if (!ctaPressAllowed(readiness, lastCtaPressAt.current, Date.now())) return;
              lastCtaPressAt.current = Date.now();
              if (page.paymentRequired) void startPayment();
              else void confirmFreeBooking();
            }}
            style={[styles.ctaButton, (!readiness.ready || busy) && styles.ctaButtonDisabled]}
          >
            <Text
              style={[
                styles.ctaButtonLabel,
                (!readiness.ready || busy) && styles.ctaButtonLabelDisabled,
              ]}
              maxFontSizeMultiplier={1.4}
            >
              {busy
                ? page.paymentRequired
                  ? 'Starting payment…'
                  : 'Confirming…'
                : page.ctaLabel}
            </Text>
          </PressableFeedback>
        </View>
      )}
    </View>
  );
}

function CheckoutSkeleton() {
  return (
    <View style={styles.content}>
      <SkeletonBlock style={styles.skeletonCard} />
      <SkeletonBlock style={styles.skeletonRow} />
      <SkeletonBlock style={styles.skeletonRow} />
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
  content: {
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  stateWrap: { paddingTop: spacing.xl },
  issueWrap: { paddingTop: spacing.xl, paddingHorizontal: pagePadding },
  recapCard: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  recapProgramRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  thumbnail: {
    width: 64,
    height: 64,
    borderRadius: radii.image,
  },
  recapProgramText: { flex: 1, gap: 2 },
  recapTitle: {
    ...typography.cardTitle,
    color: colors.text.primary,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  recapMeta: {
    ...typography.supporting,
    color: colors.text.secondary,
    flexShrink: 1,
  },
  recapDivider: {
    height: 1,
    backgroundColor: colors.border.default,
    opacity: 0.6,
  },
  recapLine: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  recapSupporting: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  editAction: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  editActionLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  block: {
    gap: spacing.xs,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  blockLabel: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.text.secondary,
  },
  blockTitle: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  blockLine: {
    ...typography.supporting,
    color: colors.text.secondary,
    flexShrink: 1,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  priceValue: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  offerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  offerText: {
    ...typography.supporting,
    color: colors.brand.primary,
    flexShrink: 1,
  },
  bookingPriceRow: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border.default,
  },
  bookingPriceText: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  inlineAction: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  inlineActionLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  methodList: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  supportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  supportText: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.secondary,
  },
  ctaBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.md,
    backgroundColor: colors.background.elevated,
    borderTopWidth: 1,
    borderTopColor: colors.border.default,
    ...shadows.sheet,
  },
  ctaStatus: { flex: 1 },
  ctaStatusText: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  ctaButton: {
    minHeight: 52,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaButtonDisabled: {
    backgroundColor: colors.border.default,
  },
  ctaButtonLabel: {
    ...typography.chip,
    fontSize: 16,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
  ctaButtonLabelDisabled: {
    color: colors.text.secondary,
  },
  skeletonCard: { height: 200, borderRadius: radii.card },
  skeletonRow: { height: 120, borderRadius: radii.card },
});
