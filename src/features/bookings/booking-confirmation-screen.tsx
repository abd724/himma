/**
 * RI-3 — booking confirmation (HMA-023; owner RI-3 §19). Shows ONLY
 * authoritative fields from the certified own-booking projection:
 * reference, participant, program, provider, branch, date/time, amount.
 * No QR/check-in, no attendance, no package credits, no invoice, no
 * review prompt — those domains do not exist yet (S6+).
 */
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import {
  bookingPriceLabel,
  bookingWhenLabel,
} from '@/features/bookings/booking-presentation';
import { commerceApi } from '@/services/composition';
import type { CustomerBooking } from '@/services/contracts/commerce';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function BookingConfirmationScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ bookingId?: string }>();
  const bookingId = typeof params.bookingId === 'string' ? params.bookingId : '';

  const [booking, setBooking] = useState<CustomerBooking | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    commerceApi.getBooking(bookingId).then(
      (result) => {
        if (cancelled) return;
        setBooking(result ?? null);
        setMissing(result === undefined || result.state !== 'confirmed');
      },
      () => {
        if (!cancelled) setMissing(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  const done = () => router.replace('/bookings' as never);

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.section, paddingBottom: insets.bottom + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {missing ? (
          <View style={styles.card}>
            <Text style={styles.title}>We can’t show that confirmation</Text>
            <Text style={styles.supporting}>Check My Bookings for your latest bookings.</Text>
            <PressableFeedback
              accessibilityLabel="Go to My Bookings"
              onPress={done}
              style={styles.primaryAction}
            >
              <Text style={styles.primaryActionLabel}>Go to My Bookings</Text>
            </PressableFeedback>
          </View>
        ) : booking === null ? (
          <SkeletonBlock style={styles.skeleton} />
        ) : (
          <View style={styles.card} testID="booking-confirmed">
            <View style={styles.badge}>
              <Ionicons name="checkmark" size={34} color={colors.text.inverse} />
            </View>
            <Text style={styles.title} accessibilityRole="header">
              Booking confirmed
            </Text>
            {booking.referenceCode !== null ? (
              <Text style={styles.reference} testID="booking-reference">
                {booking.referenceCode}
              </Text>
            ) : null}

            <View style={styles.details}>
              <DetailRow label="Activity" value={booking.program.titleEn} />
              <DetailRow label="Provider" value={booking.provider.displayName} />
              {booking.branch !== null ? (
                <DetailRow label="Location" value={booking.branch.label} />
              ) : null}
              <DetailRow label="When" value={bookingWhenLabel(booking)} />
              <DetailRow label="Participant" value={booking.participant.firstName} />
              <DetailRow label="Price" value={bookingPriceLabel(booking)} />
            </View>

            <PressableFeedback
              accessibilityLabel="Go to My Bookings"
              onPress={done}
              style={styles.primaryAction}
              testID="confirmation-done"
            >
              <Text style={styles.primaryActionLabel}>Go to My Bookings</Text>
            </PressableFeedback>
            <PressableFeedback
              accessibilityLabel="Keep browsing"
              onPress={() => router.replace('/discover')}
              style={styles.secondaryAction}
            >
              <Text style={styles.secondaryActionLabel}>Keep browsing</Text>
            </PressableFeedback>
          </View>
        )}
      </ScrollView>
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
  content: {
    paddingHorizontal: pagePadding,
    gap: spacing.lg,
  },
  skeleton: { height: 380, borderRadius: radii.card },
  card: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  badge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.status.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.text.primary,
    textAlign: 'center',
  },
  reference: {
    ...typography.cardTitle,
    fontFamily: fontFamily.extraBold,
    letterSpacing: 1,
    color: colors.brand.primary,
  },
  supporting: {
    ...typography.supporting,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  details: {
    alignSelf: 'stretch',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border.default,
  },
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
    alignSelf: 'stretch',
    marginTop: spacing.lg,
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
