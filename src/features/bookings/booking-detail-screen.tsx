/**
 * RI-3/RI-4 — booking detail (HMA-024; owner RI-3 §19/§20/§22; RI-4
 * §14–§15). Authoritative projection fields only. RI-4 adds the real
 * check-in entry: session Bookings issue their credential directly;
 * CampWeek/Cohort Bookings select the canonical occurrence first (0020).
 * An entitlement-reserved Booking reads "Included with pass" from the
 * SERVER flag — never inferred from AED 0. Cancellation remains
 * display-restraint (no customer cancellation domain exists).
 */
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import {
  bookingPriceLabel,
  bookingWhenLabel,
  categorizeBooking,
} from '@/features/bookings/booking-presentation';
import { programHref } from '@/features/details/detail-navigation';
import { issueForTarget } from '@/features/checkin/checkin-entry';
import { commerceApi, entitlementsApi } from '@/services/composition';
import type { CustomerBooking } from '@/services/contracts/commerce';
import { customerErrorCopy } from '@/services/http/error-copy';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function BookingDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ bookingId?: string }>();
  const bookingId = typeof params.bookingId === 'string' ? params.bookingId : '';

  const [booking, setBooking] = useState<CustomerBooking | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [checkInNote, setCheckInNote] = useState<string | null>(null);
  const lastCheckInAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    commerceApi.getBooking(bookingId).then(
      (result) => {
        if (cancelled) return;
        setBooking(result ?? null);
        setMissing(result === undefined);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bookingId, retried]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/bookings' as never);
  };

  const category = booking === null ? null : categorizeBooking(booking);

  /** RI-4 check-in entry: sessions issue directly; camp/cohort bookings
   *  pick the canonical occurrence first (the server requires it). */
  const startCheckIn = async () => {
    if (booking === null) return;
    const now = Date.now();
    if (now - lastCheckInAt.current < 700) return;
    lastCheckInAt.current = now;
    if (booking.unit.kind !== 'session') {
      router.push(`/bookings/check-in/${booking.bookingId}` as never);
      return;
    }
    setIssuing(true);
    setCheckInNote(null);
    try {
      const { href } = await issueForTarget(entitlementsApi, {
        kind: 'booking',
        bookingId: booking.bookingId,
      });
      router.push(href as never);
    } catch (error) {
      setCheckInNote(customerErrorCopy(error));
    } finally {
      setIssuing(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <Text style={styles.heading} accessibilityRole="header">
          Booking
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        showsVerticalScrollIndicator={false}
      >
        {missing ? (
          <EmptyFeedCard
            title="We can’t find that booking"
            message="Check My Bookings for your latest bookings."
            actionLabel="Go to My Bookings"
            onClearFilter={() => router.replace('/bookings' as never)}
          />
        ) : failed ? (
          <ErrorStateCard onRetry={() => setRetried((value) => !value)} />
        ) : booking === null ? (
          <SkeletonBlock style={styles.skeleton} />
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.title}>{booking.program.titleEn}</Text>
              <Text style={styles.meta}>
                {booking.provider.displayName}
                {booking.branch !== null ? ` · ${booking.branch.label}` : ''}
              </Text>
              {bookingWhenLabel(booking) !== '' ? (
                <Text style={styles.when}>{bookingWhenLabel(booking)}</Text>
              ) : null}
              <StatePill state={booking.state} />
            </View>

            <View style={styles.card}>
              <DetailRow label="Participant" value={booking.participant.firstName} />
              <DetailRow label="Price" value={bookingPriceLabel(booking)} />
              {booking.referenceCode !== null ? (
                <DetailRow label="Reference" value={booking.referenceCode} />
              ) : null}
              <DetailRow
                label="Booked on"
                value={new Date(booking.createdAt).toLocaleDateString('en-US', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              />
            </View>

            {/* RI-4: real check-in for confirmed bookings — server
                eligibility owns the truth; refusals map to plain copy
                (e.g. the ±60-minute window) and nothing is assumed from
                the device clock. Multi-occurrence (camp/cohort) bookings
                stay check-in-able across their whole span — day one
                starting never makes the remaining days "past". */}
            {booking.state === 'confirmed' &&
            (booking.unit.kind !== 'session' || category === 'upcoming') ? (
              <>
                <PressableFeedback
                  accessibilityLabel="Check in"
                  accessibilityState={{ disabled: issuing }}
                  disabled={issuing}
                  onPress={() => {
                    void startCheckIn();
                  }}
                  style={styles.primaryAction}
                  testID="booking-check-in"
                >
                  <Text style={styles.primaryActionLabel}>
                    {issuing ? 'Getting your code…' : 'Check in'}
                  </Text>
                </PressableFeedback>
                {checkInNote !== null ? (
                  <Text style={styles.checkInNote} accessibilityLiveRegion="polite">
                    {checkInNote}
                  </Text>
                ) : null}
              </>
            ) : null}

            {booking.coveredByEntitlement && booking.entitlementId !== null ? (
              <PressableFeedback
                accessibilityLabel="View your pass"
                onPress={() => router.push(`/passes/${booking.entitlementId}` as never)}
                style={styles.secondaryAction}
                testID="booking-view-pass"
              >
                <Text style={styles.secondaryActionLabel}>View your pass</Text>
              </PressableFeedback>
            ) : null}

            {category === 'pendingPayment' ? (
              <PressableFeedback
                accessibilityLabel="Check payment status"
                onPress={() => router.push(`/bookings/status/${booking.bookingId}` as never)}
                style={styles.primaryAction}
              >
                <Text style={styles.primaryActionLabel}>Check payment status</Text>
              </PressableFeedback>
            ) : null}

            <PressableFeedback
              accessibilityLabel="View activity"
              onPress={() => router.push(programHref(booking.program.id))}
              style={styles.secondaryAction}
            >
              <Text style={styles.secondaryActionLabel}>View activity</Text>
            </PressableFeedback>

            {/* No self-service cancellation domain exists yet — truthful
                bounded support copy, no mutating control (owner RI-3 §22). */}
            {category === 'upcoming' ? (
              <Text style={styles.supportNote}>
                Need to change or cancel? Contact the provider or Himma support — in-app
                cancellation is coming later.
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function StatePill({ state }: { state: string }) {
  const label =
    state === 'confirmed'
      ? 'Confirmed'
      : state === 'completed'
        ? 'Completed'
        : state === 'pending_payment'
          ? 'Awaiting payment'
          : 'Not completed';
  const positive = state === 'confirmed' || state === 'completed';
  return (
    <View style={[styles.pill, positive ? styles.pillPositive : styles.pillNeutral]}>
      <Text style={[styles.pillText, positive && styles.pillTextPositive]}>{label}</Text>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={2}>
        {value}
      </Text>
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
  skeleton: { height: 260, borderRadius: radii.card },
  card: {
    gap: spacing.xs,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  title: {
    ...typography.cardTitle,
    color: colors.text.primary,
  },
  meta: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  when: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  pill: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radii.chip,
  },
  pillPositive: { backgroundColor: colors.brand.primarySoft },
  pillNeutral: { backgroundColor: colors.border.default },
  pillText: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    color: colors.text.secondary,
  },
  pillTextPositive: { color: colors.brand.primary },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  detailLabel: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  detailValue: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
    flexShrink: 1,
    textAlign: 'right',
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
  supportNote: {
    ...typography.caption,
    color: colors.text.secondary,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  checkInNote: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
    textAlign: 'center',
  },
});
