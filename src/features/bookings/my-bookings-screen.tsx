/**
 * RI-3/RI-4 — My Bookings (HMA-006; owner RI-3 §20) over the certified
 * own-booking list, now paired with the REAL Passes & Memberships area
 * (RI-4): one screen, two segments — Bookings = scheduled activities,
 * Passes = purchased reusable access. Truthful sections only: pending
 * payments needing a status check, upcoming confirmed, past, and quiet
 * not-completed history. No cancellation/refund UI (no such customer
 * domain exists).
 */
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import {
  bookingPriceLabel,
  bookingWhenLabel,
  sectionBookings,
} from '@/features/bookings/booking-presentation';
import { commerceApi } from '@/services/composition';
import type { CustomerBooking } from '@/services/contracts/commerce';
import { useAuth } from '@/state/auth-context';
import { subscribeBookingsChanged } from '@/state/bookings-events';
import { PassesList } from '@/features/passes/passes-list';
import { colors, dockTokens, fontFamily, pagePadding, radii, shadows, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

export function MyBookingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  const params = useLocalSearchParams<{ view?: string }>();

  const [bookings, setBookings] = useState<CustomerBooking[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The segment derives from the route param unless the customer tapped a
  // tab SINCE that param value arrived — no state-sync effect needed
  // (react-hooks v6: setState never runs inside an effect here).
  const paramSegment: 'bookings' | 'passes' = params.view === 'passes' ? 'passes' : 'bookings';
  const [selection, setSelection] = useState<{
    forParam: string | undefined;
    segment: 'bookings' | 'passes';
  } | null>(null);
  const segment =
    selection !== null && selection.forParam === params.view ? selection.segment : paramSegment;

  const load = useCallback(() => {
    let cancelled = false;
    commerceApi.listBookings({ limit: 100 }).then(
      (result) => {
        if (cancelled) return;
        setBookings(result.bookings);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Fresh server truth on every focus and on booking-change signals.
  useFocusEffect(
    useCallback(() => {
      if (auth.status !== 'authenticated') return;
      const cancel = load();
      const unsubscribe = subscribeBookingsChanged(() => {
        cancel();
        load();
      });
      return () => {
        cancel();
        unsubscribe();
      };
    }, [auth.status, load]),
  );

  const contentBottomPadding =
    dockTokens.height + dockTokens.safeAreaOffset + insets.bottom + dockTokens.contentClearance;

  const sections = bookings === null ? null : sectionBookings(bookings);

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <Text style={styles.heading} accessibilityRole="header">
          {segment === 'passes' ? 'Passes & Memberships' : 'Bookings'}
        </Text>
        {auth.status === 'authenticated' ? (
          <View style={styles.segments} accessibilityRole="tablist">
            {(
              [
                { id: 'bookings' as const, label: 'Bookings' },
                { id: 'passes' as const, label: 'Passes' },
              ]
            ).map((entry) => (
              <PressableFeedback
                key={entry.id}
                accessibilityRole="tab"
                accessibilityLabel={entry.label}
                accessibilityState={{ selected: segment === entry.id }}
                onPress={() => setSelection({ forParam: params.view, segment: entry.id })}
                style={[styles.segment, segment === entry.id && styles.segmentActive]}
                testID={`bookings-segment-${entry.id}`}
              >
                <Text
                  style={[styles.segmentLabel, segment === entry.id && styles.segmentLabelActive]}
                >
                  {entry.label}
                </Text>
              </PressableFeedback>
            ))}
          </View>
        ) : null}
        <ScrollView
          style={styles.safeArea}
          contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
          showsVerticalScrollIndicator={false}
        >
          {auth.status === 'restoring' ? (
            <BookingsSkeleton />
          ) : auth.status === 'authenticated' && segment === 'passes' ? (
            <PassesList />
          ) : auth.status !== 'authenticated' ? (
            <View style={styles.guestCard} testID="bookings-guest">
              <View style={styles.guestIcon}>
                <Ionicons name="calendar-outline" size={26} color={colors.brand.primary} />
              </View>
              <Text style={styles.guestTitle}>Your bookings live here</Text>
              <Text style={styles.guestMessage}>
                Sign in to see and manage everything you’ve booked.
              </Text>
              <PressableFeedback
                accessibilityLabel="Sign in"
                style={styles.primaryAction}
                onPress={() => router.push('/auth/sign-in?next=/bookings' as never)}
                testID="bookings-sign-in"
              >
                <Text style={styles.primaryActionLabel}>Sign in</Text>
              </PressableFeedback>
            </View>
          ) : failed ? (
            <ErrorStateCard onRetry={() => load()} />
          ) : sections === null ? (
            <BookingsSkeleton />
          ) : bookings !== null && bookings.length === 0 ? (
            <EmptyFeedCard
              title="No bookings yet"
              message="When you book an activity, it appears here."
              actionLabel="Browse activities"
              onClearFilter={() => router.push('/discover')}
            />
          ) : (
            <>
              {sections.pendingPayment.length > 0 ? (
                <Section title="Needs attention">
                  {sections.pendingPayment.map((booking) => (
                    <BookingRow
                      key={booking.bookingId}
                      booking={booking}
                      statusLine="Payment status"
                      statusTone="pending"
                      onPress={() =>
                        router.push(`/bookings/status/${booking.bookingId}` as never)
                      }
                    />
                  ))}
                </Section>
              ) : null}

              {sections.upcoming.length > 0 ? (
                <Section title="Upcoming">
                  {sections.upcoming.map((booking) => (
                    <BookingRow
                      key={booking.bookingId}
                      booking={booking}
                      onPress={() => router.push(`/bookings/${booking.bookingId}` as never)}
                    />
                  ))}
                </Section>
              ) : null}

              {sections.past.length > 0 ? (
                <Section title="Past">
                  {sections.past.map((booking) => (
                    <BookingRow
                      key={booking.bookingId}
                      booking={booking}
                      onPress={() => router.push(`/bookings/${booking.bookingId}` as never)}
                    />
                  ))}
                </Section>
              ) : null}

              {sections.notCompleted.length > 0 ? (
                <Section title="Not completed">
                  {sections.notCompleted.map((booking) => (
                    <BookingRow
                      key={booking.bookingId}
                      booking={booking}
                      statusLine="This booking didn’t complete"
                      statusTone="quiet"
                      onPress={() => router.push(`/bookings/${booking.bookingId}` as never)}
                    />
                  ))}
                </Section>
              ) : null}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.sectionList}>{children}</View>
    </View>
  );
}

function BookingRow({
  booking,
  statusLine,
  statusTone,
  onPress,
}: {
  booking: CustomerBooking;
  statusLine?: string;
  statusTone?: 'pending' | 'quiet';
  onPress: () => void;
}) {
  const when = bookingWhenLabel(booking);
  return (
    <PressableFeedback
      accessibilityLabel={`${booking.program.titleEn}, ${booking.provider.displayName}${
        when !== '' ? `, ${when}` : ''
      }${statusLine !== undefined ? `, ${statusLine}` : ''}`}
      onPress={onPress}
      style={styles.row}
      testID={`booking-row-${booking.bookingId}`}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {booking.program.titleEn}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {booking.provider.displayName}
          {booking.branch !== null ? ` · ${booking.branch.label}` : ''}
        </Text>
        {when !== '' ? <Text style={styles.rowWhen}>{when}</Text> : null}
        {statusLine !== undefined ? (
          <Text style={[styles.rowStatus, statusTone === 'quiet' && styles.rowStatusQuiet]}>
            {statusLine}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowEnd}>
        <Text style={styles.rowPrice}>{bookingPriceLabel(booking)}</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.text.secondary} />
      </View>
    </PressableFeedback>
  );
}

function BookingsSkeleton() {
  return (
    <View style={styles.skeletons}>
      <SkeletonBlock style={styles.skeletonRow} />
      <SkeletonBlock style={styles.skeletonRow} />
      <SkeletonBlock style={styles.skeletonRow} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background.main },
  safeArea: { flex: 1 },
  heading: {
    ...typography.screenTitle,
    color: colors.text.primary,
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  segments: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: pagePadding,
    paddingBottom: spacing.md,
  },
  segment: {
    minHeight: 44,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.chip,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: {
    backgroundColor: colors.brand.primary,
    borderColor: colors.brand.primary,
  },
  segmentLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  segmentLabelActive: { color: colors.text.inverse },
  content: {
    gap: spacing.xl,
    paddingTop: spacing.xs,
  },
  section: { gap: spacing.sm },
  sectionTitle: {
    ...typography.sectionTitle,
    fontSize: 18,
    lineHeight: 24,
    color: colors.text.primary,
    paddingHorizontal: pagePadding,
  },
  sectionList: {
    paddingHorizontal: pagePadding,
    gap: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    ...shadows.card,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: {
    ...typography.cardTitle,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text.primary,
  },
  rowMeta: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  rowWhen: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  rowStatus: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  rowStatusQuiet: {
    color: colors.text.secondary,
  },
  rowEnd: {
    alignItems: 'flex-end',
    gap: 6,
  },
  rowPrice: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.text.primary,
  },
  guestCard: {
    marginHorizontal: pagePadding,
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  guestIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  guestTitle: {
    ...typography.cardTitle,
    fontFamily: fontFamily.extraBold,
    color: colors.text.primary,
    textAlign: 'center',
  },
  guestMessage: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
    maxWidth: 280,
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
  skeletons: {
    paddingHorizontal: pagePadding,
    gap: spacing.md,
  },
  skeletonRow: { height: 104, borderRadius: radii.card },
});
