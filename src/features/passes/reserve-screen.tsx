/**
 * RI-4 — entitlement reservation (docs/35 §7/§8/§13): "Book a session"
 * with a pass. The real backend chain runs unchanged — Session selection →
 * zero-total reservation quote (entitlement-bound) → the certified S5
 * hold → `confirmEntitlementReservation` → a confirmed Booking. No payment
 * page, no payment language, no "AED 0 purchase": the session is INCLUDED
 * WITH THE PASS.
 *
 * Truth rules: the session list is the authenticated Entitlement-specific
 * server projection (never locally filtered search results); SEAT
 * availability and CREDIT availability display separately; a stable
 * idempotency key per (entitlement, session) intent makes every retry a
 * replay; refusals map to customer copy and re-read server truth.
 */
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { newIdempotencyKey } from '@/features/booking/commerce-session';
import { entitlementsApi, commerceApi } from '@/services/composition';
import type {
  CustomerEntitlement,
  FiniteBalance,
  ReservableSession,
} from '@/services/contracts/entitlements';
import { customerErrorCopy } from '@/services/http/error-copy';
import { ApiError } from '@/services/http/http-client';
import { notifyBookingsChanged } from '@/state/bookings-events';
import { notifyPassesChanged } from '@/state/passes-events';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function isoDate(daysAhead: number): string {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

export function ReserveScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ entitlementId?: string }>();
  const entitlementId = typeof params.entitlementId === 'string' ? params.entitlementId : '';

  const [entitlement, setEntitlement] = useState<CustomerEntitlement | null>(null);
  const [sessions, setSessions] = useState<ReservableSession[] | null>(null);
  const [finite, setFinite] = useState<FiniteBalance | null>(null);
  const [failed, setFailed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reserved, setReserved] = useState<{ bookingId: string } | null>(null);
  const [reloads, setReloads] = useState(0);
  // One STABLE key per (entitlement, session) reservation intent — a retry
  // replays the same confirmation, never a second commitment.
  const confirmKeys = useRef(new Map<string, string>());
  const lastPressAt = useRef(0);

  const load = useCallback(() => {
    let cancelled = false;
    Promise.all([
      entitlementsApi.getEntitlement(entitlementId),
      entitlementsApi.listReservableSessions(entitlementId, {
        from: isoDate(0),
        to: isoDate(55),
      }),
    ]).then(
      ([detail, reservable]) => {
        if (cancelled) return;
        setEntitlement(detail ?? null);
        setSessions(reservable.sessions);
        setFinite(reservable.finite ?? null);
        setFailed(false);
        setRefusal(null);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError) {
          setRefusal(customerErrorCopy(error));
          return;
        }
        setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entitlementId]);

  useEffect(() => load(), [load, reloads]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(`/passes/${entitlementId}` as never);
  };

  /** The full certified chain in one intent: quote → hold → confirm. */
  const reserve = async (sessionId: string) => {
    const now = Date.now();
    if (now - lastPressAt.current < 700) return;
    lastPressAt.current = now;
    if (entitlement === null) return;
    setBusy(true);
    setRefusal(null);
    try {
      const quote = await entitlementsApi.requestReservationQuote(entitlementId, sessionId);
      // The hold intent is (session, quote) — the certified idempotency
      // digest includes the quote, so the key binds to the same signature.
      const holdKeySignature = `hold|${entitlementId}|${sessionId}|${quote.quoteId}`;
      let holdKey = confirmKeys.current.get(holdKeySignature);
      if (holdKey === undefined) {
        holdKey = newIdempotencyKey();
        confirmKeys.current.set(holdKeySignature, holdKey);
      }
      const hold = await commerceApi.claimHold({
        unitKind: 'session',
        unitId: sessionId,
        participantId: entitlement.participant.id,
        quoteId: quote.quoteId,
        idempotencyKey: holdKey,
      });
      const confirmSignature = `confirm|${hold.holdId}`;
      let confirmKey = confirmKeys.current.get(confirmSignature);
      if (confirmKey === undefined) {
        confirmKey = newIdempotencyKey();
        confirmKeys.current.set(confirmSignature, confirmKey);
      }
      const reservation = await entitlementsApi.confirmReservation(hold.holdId, confirmKey);
      notifyBookingsChanged();
      notifyPassesChanged();
      setReserved({ bookingId: reservation.bookingId });
    } catch (error) {
      if (error instanceof ApiError) {
        setRefusal(customerErrorCopy(error));
        // Availability truth may have moved — re-read the projection.
        setReloads((value) => value + 1);
      } else {
        setRefusal(customerErrorCopy(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const contentReady = entitlement !== null && sessions !== null;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <Text style={styles.heading} accessibilityRole="header">
          Book a session
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        showsVerticalScrollIndicator={false}
      >
        {reserved !== null ? (
          <View style={styles.successCard} testID="reservation-confirmed">
            <View style={styles.successIcon}>
              <Ionicons name="checkmark-circle" size={30} color={colors.status.success} />
            </View>
            <Text style={styles.successTitle}>Session booked</Text>
            <Text style={styles.successBody}>
              Included with your pass — no payment needed. You’ll find it in your bookings.
            </Text>
            <PressableFeedback
              accessibilityLabel="View booking"
              onPress={() => router.replace(`/bookings/${reserved.bookingId}` as never)}
              style={styles.primaryAction}
              testID="reservation-view-booking"
            >
              <Text style={styles.primaryActionLabel}>View booking</Text>
            </PressableFeedback>
            <PressableFeedback
              accessibilityLabel="Back to pass"
              onPress={() => router.replace(`/passes/${entitlementId}` as never)}
              style={styles.linkAction}
            >
              <Text style={styles.linkActionLabel}>Back to pass</Text>
            </PressableFeedback>
          </View>
        ) : failed ? (
          <ErrorStateCard onRetry={() => setReloads((value) => value + 1)} />
        ) : !contentReady ? (
          <SkeletonBlock style={styles.skeleton} />
        ) : (
          <>
            {/* Credit availability — SEPARATE from seat availability: a
                session can have open seats while the pass has no bookable
                credits (docs/35 §8). */}
            {finite !== null ? (
              <View style={styles.creditBanner} testID="reserve-credits">
                <Text style={styles.creditText}>
                  {finite.availableToReserve === 0
                    ? 'No visits available to book right now — your remaining visits are reserved or used.'
                    : `${finite.availableToReserve} of ${finite.usesTotal} ${
                        finite.usesTotal === 1 ? 'visit' : 'visits'
                      } available to book`}
                </Text>
              </View>
            ) : null}

            {refusal !== null ? (
              <Text style={styles.refusal} accessibilityLiveRegion="polite">
                {refusal}
              </Text>
            ) : null}

            {sessions.length === 0 ? (
              <EmptyFeedCard
                title="No sessions to book right now"
                message="Sessions covered by this pass appear here when the provider schedules them."
                actionLabel="Back to pass"
                onClearFilter={goBack}
              />
            ) : (
              <View style={styles.sessionList} accessibilityRole="radiogroup">
                {sessions.map((session) => {
                  const start = new Date(session.startAt);
                  const selectable =
                    session.availability !== 'full' && session.availability !== 'closed';
                  const dayLabel = start.toLocaleDateString('en-US', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                  });
                  const timeLabel = start.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  });
                  return (
                    <PressableFeedback
                      key={session.sessionId}
                      accessibilityRole="radio"
                      accessibilityState={{
                        selected: selectedId === session.sessionId,
                        disabled: !selectable,
                      }}
                      accessibilityLabel={`${dayLabel}, ${timeLabel}${
                        session.availability === 'full' ? ', full' : ''
                      }`}
                      disabled={!selectable}
                      onPress={() => setSelectedId(session.sessionId)}
                      style={[
                        styles.sessionRow,
                        selectedId === session.sessionId && styles.sessionRowSelected,
                        !selectable && styles.sessionRowDisabled,
                      ]}
                      testID={`reserve-session-${session.sessionId}`}
                    >
                      <View style={styles.sessionText}>
                        <Text style={styles.sessionDay}>{dayLabel}</Text>
                        <Text style={styles.sessionTime}>{timeLabel}</Text>
                      </View>
                      <Text style={styles.sessionAvailability}>
                        {session.availability === 'full'
                          ? 'Full'
                          : session.availability === 'fewLeft' && session.spotsLeft !== undefined
                            ? `${session.spotsLeft} places left`
                            : ''}
                      </Text>
                    </PressableFeedback>
                  );
                })}
              </View>
            )}

            {sessions.length > 0 ? (
              <PressableFeedback
                accessibilityLabel="Reserve with your pass"
                accessibilityState={{
                  disabled:
                    busy || selectedId === null || (finite !== null && finite.availableToReserve === 0),
                }}
                disabled={
                  busy || selectedId === null || (finite !== null && finite.availableToReserve === 0)
                }
                onPress={() => {
                  if (selectedId !== null) void reserve(selectedId);
                }}
                style={[
                  styles.primaryAction,
                  (busy ||
                    selectedId === null ||
                    (finite !== null && finite.availableToReserve === 0)) &&
                    styles.primaryActionDisabled,
                ]}
                testID="reserve-cta"
              >
                <Text style={styles.primaryActionLabel}>
                  {busy ? 'Reserving…' : 'Reserve — included with your pass'}
                </Text>
              </PressableFeedback>
            ) : null}
          </>
        )}
      </ScrollView>
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
  skeleton: { height: 320, borderRadius: radii.card },
  creditBanner: {
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  creditText: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  refusal: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
    textAlign: 'center',
  },
  sessionList: { gap: spacing.sm },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  sessionRowSelected: {
    borderColor: colors.brand.primary,
    backgroundColor: colors.brand.primarySoft,
  },
  sessionRowDisabled: { opacity: 0.5 },
  sessionText: { gap: 2 },
  sessionDay: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  sessionTime: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  sessionAvailability: {
    ...typography.caption,
    fontFamily: fontFamily.semiBold,
    color: colors.text.secondary,
  },
  successCard: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  successIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: {
    ...typography.cardTitle,
    fontFamily: fontFamily.extraBold,
    color: colors.text.primary,
  },
  successBody: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
    maxWidth: 300,
  },
  primaryAction: {
    minHeight: 52,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionDisabled: { backgroundColor: colors.border.default },
  primaryActionLabel: {
    ...typography.chip,
    fontSize: 16,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
  linkAction: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkActionLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
});
