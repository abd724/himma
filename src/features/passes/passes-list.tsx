/**
 * RI-4 — Passes & Memberships list (HMA-006 "Package or membership status";
 * docs/35 §8/§13) over the certified `GET /customer/entitlements`
 * projection. Every card fact is SERVER truth verbatim: finite balances are
 * the four derived truths (never computed locally), unlimited passes show
 * "Unlimited" and no counter, and status comes from the server — never the
 * device clock.
 */
import { EmptyFeedCard } from '@/components/domain/empty-feed-card';
import { ErrorStateCard } from '@/components/domain/error-state-card';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { SkeletonBlock } from '@/components/ui/skeleton-block';
import {
  finiteHeadline,
  statusPresentation,
  validityLine,
} from '@/features/passes/passes-presentation';
import { entitlementsApi } from '@/services/composition';
import type { CustomerEntitlement } from '@/services/contracts/entitlements';
import { useAuth } from '@/state/auth-context';
import { subscribePassesChanged } from '@/state/passes-events';
import { colors, fontFamily, pagePadding, radii, shadows, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

export function PassesList() {
  const router = useRouter();
  const auth = useAuth();
  const [entitlements, setEntitlements] = useState<CustomerEntitlement[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    entitlementsApi.listEntitlements({ limit: 100 }).then(
      (result) => {
        if (cancelled) return;
        setEntitlements(result.entitlements);
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

  // Fresh server truth on focus and on pass-change signals (acquisition,
  // reservation, server-confirmed check-in) — never optimistic.
  useFocusEffect(
    useCallback(() => {
      if (auth.status !== 'authenticated') return;
      const cancel = load();
      const unsubscribe = subscribePassesChanged(() => {
        cancel();
        load();
      });
      return () => {
        cancel();
        unsubscribe();
      };
    }, [auth.status, load]),
  );

  if (auth.status !== 'authenticated') return null;
  if (failed) return <ErrorStateCard onRetry={() => load()} />;
  if (entitlements === null) {
    return (
      <View style={styles.skeletons}>
        <SkeletonBlock style={styles.skeletonRow} />
        <SkeletonBlock style={styles.skeletonRow} />
      </View>
    );
  }
  if (entitlements.length === 0) {
    return (
      <EmptyFeedCard
        title="No passes yet"
        message="Packs and memberships you buy appear here, ready to use."
        actionLabel="Browse activities"
        onClearFilter={() => router.push('/discover')}
      />
    );
  }

  const active = entitlements.filter((entitlement) => entitlement.status === 'active');
  const inactive = entitlements.filter((entitlement) => entitlement.status !== 'active');

  return (
    <View style={styles.list}>
      {active.map((entitlement) => (
        <PassRow key={entitlement.entitlementId} entitlement={entitlement} />
      ))}
      {inactive.length > 0 ? (
        <Text style={styles.sectionTitle} accessibilityRole="header">
          Past passes
        </Text>
      ) : null}
      {inactive.map((entitlement) => (
        <PassRow key={entitlement.entitlementId} entitlement={entitlement} />
      ))}
    </View>
  );
}

function PassRow({ entitlement }: { entitlement: CustomerEntitlement }) {
  const router = useRouter();
  const status = statusPresentation(entitlement.status);
  const balance =
    entitlement.usageKind === 'unlimited'
      ? 'Unlimited'
      : entitlement.finite !== undefined
        ? finiteHeadline(entitlement.finite)
        : '';
  return (
    <PressableFeedback
      accessibilityLabel={`${entitlement.productLabel}, ${entitlement.program.titleEn}, ${entitlement.provider.displayName}, ${balance}, ${status.label}`}
      onPress={() => router.push(`/passes/${entitlement.entitlementId}` as never)}
      style={styles.row}
      testID={`pass-row-${entitlement.entitlementId}`}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {entitlement.productLabel}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {entitlement.program.titleEn} · {entitlement.provider.displayName}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          For {entitlement.participant.firstName} · {validityLine(entitlement)}
        </Text>
        <Text style={styles.rowBalance}>{balance}</Text>
      </View>
      <View style={styles.rowEnd}>
        <View style={[styles.pill, status.tone === 'positive' ? styles.pillPositive : styles.pillNeutral]}>
          <Text style={[styles.pillText, status.tone === 'positive' && styles.pillTextPositive]}>
            {status.label}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.text.secondary} />
      </View>
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: pagePadding,
    gap: spacing.md,
  },
  sectionTitle: {
    ...typography.sectionTitle,
    fontSize: 18,
    lineHeight: 24,
    color: colors.text.primary,
    paddingTop: spacing.md,
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
  rowBalance: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
    marginTop: 2,
  },
  rowEnd: { alignItems: 'flex-end', gap: 8 },
  pill: {
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
  skeletons: {
    paddingHorizontal: pagePadding,
    gap: spacing.md,
  },
  skeletonRow: { height: 120, borderRadius: radii.card },
});
