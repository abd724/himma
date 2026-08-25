import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { AppImage } from '@/components/ui/app-image';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import {
  bookingHref,
  bookingStepHref,
  checkoutStepAccess,
} from '@/features/booking/booking-navigation';
import {
  checkoutReadiness,
  checkoutReducer,
  ctaPressAllowed,
  initialCheckoutUiState,
  type CheckoutReadiness,
} from '@/features/booking/checkout-state';
import { CheckoutIssueCard } from '@/features/booking/checkout-issue-card';
import { checkoutIssueRecovery } from '@/features/booking/checkout-revalidation';
import { PaymentMethodRow } from '@/features/booking/payment-method-row';
import { summaryParticipantBlock } from '@/features/booking/summary-presentation';
import { programHref } from '@/features/details/detail-navigation';
import { demoImage } from '@/data/mock/images';
import type { BookingOptionsPage } from '@/services/contracts/booking';
import type { CheckoutPage } from '@/services/contracts/checkout';
import { bookingService, checkoutService } from '@/services/composition';
import { useAreaContext } from '@/state/area-context';
import { useBookingSession } from '@/state/booking-session-context';
import { useParticipantContext } from '@/state/participant-context';
import { colors, fontFamily, pagePadding, radii, shadows, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useReducer, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
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
  const { areaId, areaLabelById } = useAreaContext();
  const { draft, qaRevalidate } = useBookingSession();
  // Redirect decisions read the draft at response time, not render time.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const [page, setPage] = useState<CheckoutPage | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  // Checkout-local UI state (docs/22 §5/§11): the method selection only.
  // Leaving checkout unmounts the screen and discards it structurally.
  const [uiState, dispatchUi] = useReducer(checkoutReducer, initialCheckoutUiState);
  const lastCtaPressAt = useRef(0);
  // A 'rederive' recovery action clears the QA review state and re-derives
  // the page from the live draft (docs/22 §7.10 — no silent repair; the
  // re-derived page is the current truth).
  const [reviewed, setReviewed] = useState(false);

  const simulateFailure = params['qa-fail'] === '1' && !retried;
  const simulateRevalidate = reviewed ? undefined : qaRevalidate;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      bookingService.getBookingOptions({
        programId,
        // Preselection is irrelevant here; the draft already owns the choice.
        participantId: 'everyone',
        participants,
        areaId,
        simulateFailure,
      }),
      checkoutService.getCheckoutPage({
        draft: draftRef.current,
        participants,
        areaId,
        simulateFailure,
        qaRevalidate: simulateRevalidate,
      }),
    ]).then(
      ([optionsPage, checkoutPage]: [BookingOptionsPage | undefined, CheckoutPage | undefined]) => {
        if (cancelled) return;
        if (optionsPage === undefined) {
          setMissing(true);
          setFailed(false);
          return;
        }
        // Invalid or incomplete drafts never render — each failure redirects
        // to the step that owns the fix (docs/22 §3.3). A cold link's empty
        // draft lands on the flow start, which re-runs the skip rule.
        const access = checkoutStepAccess(optionsPage, draftRef.current);
        if (access === 'redirect-selection' || checkoutPage === undefined) {
          router.replace(bookingHref(programId));
          return;
        }
        if (access === 'redirect-participant') {
          router.replace(bookingStepHref(programId, 'participant'));
          return;
        }
        // A re-derived page starts with clean checkout-local state
        // (docs/22 §5): every derived value reflects the current order.
        dispatchUi({ type: 'reset' });
        setPage(checkoutPage);
        setMissing(false);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [programId, participants, areaId, simulateFailure, simulateRevalidate, router]);

  // Back returns to the Booking Summary — checkout is only ever pushed from
  // it (docs/22 §3.3); the replace fallback covers stackless edge cases.
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(bookingStepHref(programId, 'summary'));
  };
  const browse = () => router.replace('/discover');
  // The summary owns Change participant / Change session — Edit booking just
  // returns there (docs/22 §4.2, no duplicate edit affordances).
  const editBooking = goBack;

  const participantBlock =
    page === null ? undefined : summaryParticipantBlock(page.summary.participant, participants);
  // The single readiness rule for the CTA (docs/22 §9): free bookings are
  // ready; paid bookings need the contract method selected.
  const readiness: CheckoutReadiness =
    page === null ? { ready: false } : checkoutReadiness(page, uiState);
  // One unresolved issue at a time owns the screen — docs/22 §7.10.2: every
  // code maps to a recovery action; nothing renders that could advance.
  const issue = page !== null && !page.validation.ok ? page.validation.issues[0] : undefined;
  const recoverFromIssue = () => {
    if (issue === undefined) return;
    const recovery = checkoutIssueRecovery(issue.code);
    switch (recovery.target) {
      case 'rederive':
        setReviewed(true);
        return;
      case 'flow-start':
        router.replace(bookingHref(programId));
        return;
      case 'participant':
        router.replace(bookingStepHref(programId, 'participant'));
        return;
      case 'program':
        router.replace(programHref(programId));
        return;
    }
  };

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
          // absent during loading, recovery, and revalidation states).
          paddingBottom:
            page !== null && issue === undefined
              ? 132 + insets.bottom + spacing.xl
              : insets.bottom + spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {page === null && !missing && !failed ? (
          <CheckoutSkeleton />
        ) : missing ? (
          <View style={styles.stateWrap}>
            <EmptyFeedCard
              title="This program is no longer offered."
              message="It may have ended or moved. Browse current activities instead."
              actionLabel="Browse activities"
              onClearFilter={browse}
            />
          </View>
        ) : failed ? (
          <View style={styles.stateWrap}>
            <ErrorStateCard onRetry={() => setRetried(true)} />
          </View>
        ) : issue !== undefined ? (
          /* Revalidation review state — docs/22 §7.10, docs/09 §22.10:
             typed, honest, recoverable, on the dedicated CheckoutIssueCard
             (owner-directed redesign). The reassurance row states plainly
             that nothing was performed; the single action re-derives the
             page or returns to the step that owns the fix. No CTA bar and
             no payment controls render while an issue is unresolved. */
          <View style={styles.issueWrap}>
            <CheckoutIssueCard
              code={issue.code}
              priceComparison={issue.priceComparison}
              onRecover={recoverFromIssue}
            />
          </View>
        ) : page === null || participantBlock === undefined ? null : (
          <View style={styles.content}>
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
                    {areaLabelById.get(page.summary.program.areaId ?? '') ?? page.summary.program.areaLabel ?? ''}
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

            {/* Cancellation policy — displayed only; no acceptance is claimed
                and nothing is gated on legal text (docs/09 §22.7). */}
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
              {/* Inert contract row — future HMS-008 (details-page precedent). */}
              <PressableFeedback
                accessibilityRole="button"
                accessibilityLabel="Full policy"
                style={styles.inlineAction}
              >
                <Text style={styles.inlineActionLabel}>Full policy</Text>
              </PressableFeedback>
            </View>

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

      {page === null || issue !== undefined ? null : (
        <View style={[styles.ctaBar, { paddingBottom: insets.bottom + spacing.md }]}>
          {/* The polite live region announces readiness blockers and their
              resolution (docs/22 §9/§12) — never unready without a reason. */}
          <View style={styles.ctaStatus} accessibilityLiveRegion="polite">
            {/* The named blocker wraps in full — the reason the CTA is not
                ready is never truncated (docs/22 §9). The ready-state price
                line keeps the established 2-line cap (full label in the
                price block and the accessible CTA label). */}
            <Text style={styles.ctaStatusText} numberOfLines={readiness.ready ? 2 : undefined}>
              {readiness.ready ? page.price.bookingPriceLabel : readiness.blocker}
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
            accessibilityState={{ disabled: !readiness.ready }}
            disabled={!readiness.ready}
            onPress={() => {
              // Defense in depth behind the Pressable-layer block: the pure
              // gate re-checks readiness and the duplicate-press window.
              if (!ctaPressAllowed(readiness, lastCtaPressAt.current, Date.now())) return;
              lastCtaPressAt.current = Date.now();
              // Inert contract boundary: nothing happens past this line.
            }}
            style={[styles.ctaButton, !readiness.ready && styles.ctaButtonDisabled]}
          >
            <Text
              style={[styles.ctaButtonLabel, !readiness.ready && styles.ctaButtonLabelDisabled]}
              maxFontSizeMultiplier={1.4}
            >
              {page.ctaLabel}
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
