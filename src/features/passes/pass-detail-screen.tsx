/**
 * RI-4 — Pass/Membership detail (HMA-026; docs/35 §8/§13). Server truth
 * verbatim: the four finite balances (with the reserved-vs-bookable
 * distinction stated truthfully), validity/status, purchased methods and
 * schedule summary, next reserved session, and a bounded attendance
 * history. Actions: "Book a session" (reservation-permitted products) and
 * walk-in "Check in" (walk-in products) — both gated by the SERVER status;
 * no manual consumption of any kind exists.
 */
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import { issueForTarget } from '@/features/checkin/checkin-entry';
import {
  finiteCommitmentLine,
  finiteHeadline,
  methodsLine,
  scheduleSummaryLines,
  statusPresentation,
  validityLine,
} from '@/features/passes/passes-presentation';
import { programHref } from '@/features/details/detail-navigation';
import { entitlementsApi } from '@/services/composition';
import type {
  CustomerEntitlement,
  EntitlementAttendanceRow,
} from '@/services/contracts/entitlements';
import { customerErrorCopy } from '@/services/http/error-copy';
import { subscribePassesChanged } from '@/state/passes-events';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function PassDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ entitlementId?: string; acquired?: string }>();
  const entitlementId = typeof params.entitlementId === 'string' ? params.entitlementId : '';
  const justAcquired = params.acquired === '1';

  const [entitlement, setEntitlement] = useState<CustomerEntitlement | null>(null);
  const [attendance, setAttendance] = useState<EntitlementAttendanceRow[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const lastActionAt = useRef(0);

  const load = useCallback(() => {
    let cancelled = false;
    Promise.all([
      entitlementsApi.getEntitlement(entitlementId),
      entitlementsApi.listAttendance(entitlementId, { limit: 10 }).catch(() => null),
    ]).then(
      ([result, history]) => {
        if (cancelled) return;
        setEntitlement(result ?? null);
        setMissing(result === undefined);
        setAttendance(history?.attendance ?? []);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entitlementId]);

  useFocusEffect(
    useCallback(() => {
      const cancel = load();
      const unsubscribe = subscribePassesChanged(() => {
        cancel();
        load();
      });
      return () => {
        cancel();
        unsubscribe();
      };
    }, [load]),
  );

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/bookings?view=passes' as never);
  };

  /** Walk-in check-in: the real S6 issuance; secrets stay in memory. */
  const startWalkInCheckIn = async () => {
    if (entitlement === null) return;
    const now = Date.now();
    if (now - lastActionAt.current < 700) return;
    lastActionAt.current = now;
    setIssuing(true);
    setActionError(null);
    try {
      const { href } = await issueForTarget(entitlementsApi, {
        kind: 'entitlement',
        entitlementId: entitlement.entitlementId,
      });
      router.push(href as never);
    } catch (error) {
      setActionError(customerErrorCopy(error));
    } finally {
      setIssuing(false);
    }
  };

  const status = entitlement === null ? null : statusPresentation(entitlement.status);
  const active = entitlement?.status === 'active';
  const scheduleLines = entitlement === null ? [] : scheduleSummaryLines(entitlement.scheduleTerms);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={goBack} />
        <Text style={styles.heading} accessibilityRole="header">
          Pass
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        showsVerticalScrollIndicator={false}
      >
        {missing ? (
          <EmptyFeedCard
            title="We can’t find that pass"
            message="Check Passes & Memberships for your current passes."
            actionLabel="Go to Passes"
            onClearFilter={() => router.replace('/bookings?view=passes' as never)}
          />
        ) : failed ? (
          <ErrorStateCard onRetry={() => load()} />
        ) : entitlement === null || status === null ? (
          <SkeletonBlock style={styles.skeleton} />
        ) : (
          <>
            {justAcquired ? (
              <View style={styles.acquiredBanner} testID="pass-acquired">
                <Ionicons name="checkmark-circle" size={18} color={colors.status.success} />
                <Text style={styles.acquiredText}>Your pass is ready to use.</Text>
              </View>
            ) : null}

            <View style={styles.card} testID="pass-detail">
              <Text style={styles.title}>{entitlement.productLabel}</Text>
              <Text style={styles.meta}>
                {entitlement.program.titleEn} · {entitlement.provider.displayName}
              </Text>
              {entitlement.branch !== null ? (
                <Text style={styles.meta}>{entitlement.branch.label} only</Text>
              ) : null}
              <View
                style={[styles.pill, status.tone === 'positive' ? styles.pillPositive : styles.pillNeutral]}
              >
                <Text style={[styles.pillText, status.tone === 'positive' && styles.pillTextPositive]}>
                  {status.label}
                </Text>
              </View>
            </View>

            {/* The SERVER balance truths (docs/35 §8) — reserved credits are
                stated separately from newly bookable availability, never
                conflated. Unlimited products show no counter at all. */}
            <View style={styles.card}>
              {entitlement.usageKind === 'unlimited' ? (
                <Text style={styles.balanceHeadline} testID="pass-balance">
                  Unlimited visits
                </Text>
              ) : entitlement.finite !== undefined ? (
                <>
                  <Text style={styles.balanceHeadline} testID="pass-balance">
                    {finiteHeadline(entitlement.finite)}
                  </Text>
                  {finiteCommitmentLine(entitlement.finite) !== null ? (
                    <Text style={styles.balanceDetail}>
                      {finiteCommitmentLine(entitlement.finite)}
                    </Text>
                  ) : null}
                </>
              ) : null}
              <DetailRow label="Participant" value={entitlement.participant.firstName} />
              <DetailRow label="Validity" value={validityLine(entitlement)} />
              <DetailRow label="How it works" value={methodsLine(entitlement)} />
              {scheduleLines.length > 0 ? (
                <DetailRow label="Schedule" value={scheduleLines.join('\n')} />
              ) : null}
              {entitlement.nextReservedSessionAt !== null ? (
                <DetailRow
                  label="Next reserved session"
                  value={new Date(entitlement.nextReservedSessionAt).toLocaleString('en-US', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                />
              ) : null}
            </View>

            {actionError !== null ? (
              <Text style={styles.actionError} accessibilityLiveRegion="polite">
                {actionError}
              </Text>
            ) : null}

            {/* Fulfillment actions — server-permitted methods only; both
                disabled once the SERVER says the pass is not active. */}
            {entitlement.reservationRequired && active ? (
              <PressableFeedback
                accessibilityLabel="Book a session with this pass"
                onPress={() =>
                  router.push(`/passes/reserve/${entitlement.entitlementId}` as never)
                }
                style={styles.primaryAction}
                testID="pass-reserve"
              >
                <Text style={styles.primaryActionLabel}>Book a session</Text>
              </PressableFeedback>
            ) : null}
            {entitlement.walkInAllowed && active ? (
              <PressableFeedback
                accessibilityLabel="Check in with this pass"
                accessibilityState={{ disabled: issuing }}
                disabled={issuing}
                onPress={() => {
                  void startWalkInCheckIn();
                }}
                style={[
                  entitlement.reservationRequired ? styles.secondaryActionSolid : styles.primaryAction,
                  issuing && styles.actionDisabled,
                ]}
                testID="pass-checkin"
              >
                <Text
                  style={
                    entitlement.reservationRequired
                      ? styles.secondaryActionSolidLabel
                      : styles.primaryActionLabel
                  }
                >
                  {issuing ? 'Getting your code…' : 'Check in'}
                </Text>
              </PressableFeedback>
            ) : null}
            {!active ? (
              <Text style={styles.inactiveNote}>
                {entitlement.status === 'exhausted'
                  ? 'This pass has been fully used. You can buy a new one from the activity page.'
                  : 'This pass has expired. You can buy a new one from the activity page.'}
              </Text>
            ) : null}

            <PressableFeedback
              accessibilityLabel="View activity"
              onPress={() => router.push(programHref(entitlement.program.id))}
              style={styles.linkAction}
            >
              <Text style={styles.linkActionLabel}>View activity</Text>
            </PressableFeedback>

            {attendance !== null && attendance.length > 0 ? (
              <View style={styles.card}>
                <Text style={styles.blockLabel} accessibilityRole="header">
                  Visit history
                </Text>
                {attendance.map((row) => (
                  <View key={row.attendanceId} style={styles.historyRow}>
                    <Text style={styles.historyWhen}>
                      {new Date(row.sessionStartAt ?? row.occurredAt).toLocaleString('en-US', {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </Text>
                    <Text style={styles.historyMeta} numberOfLines={1}>
                      {row.program.titleEn}
                      {row.branch !== null ? ` · ${row.branch.label}` : ''}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
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
  acquiredBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  acquiredText: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  title: { ...typography.cardTitle, color: colors.text.primary },
  meta: { ...typography.supporting, color: colors.text.secondary },
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
  balanceHeadline: {
    ...typography.cardTitle,
    fontSize: 20,
    lineHeight: 26,
    color: colors.text.primary,
  },
  balanceDetail: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
  detailRow: { gap: 2 },
  detailLabel: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.text.secondary,
  },
  detailValue: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  actionError: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
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
  secondaryActionSolid: {
    minHeight: 52,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryActionSolidLabel: {
    ...typography.chip,
    fontSize: 16,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  actionDisabled: { opacity: 0.6 },
  inactiveNote: {
    ...typography.caption,
    color: colors.text.secondary,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
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
  blockLabel: {
    ...typography.caption,
    fontFamily: fontFamily.bold,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.text.secondary,
  },
  historyRow: { gap: 2 },
  historyWhen: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  historyMeta: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
});
