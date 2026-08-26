/**
 * RI-3 — the authoritative-hold countdown (owner RI-3 §8). Presentation
 * ONLY: it renders the server's `expiresAt` against the device clock and
 * signals `onExpired` once — the caller then asks the SERVER; no booking
 * mutation ever trusts this timer.
 */
import { colors, fontFamily, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

function remainingMs(expiresAt: string): number {
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function HoldCountdown({
  expiresAt,
  checking,
  onExpired,
}: {
  expiresAt: string;
  checking: boolean;
  onExpired: () => void;
}) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
    const update = () => {
      const left = remainingMs(expiresAt);
      setRemaining(left);
      if (left <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpired();
      }
    };
    // Async first paint of the number (never a sync set in the effect).
    const immediate = setTimeout(update, 0);
    const interval = setInterval(update, 1000);
    return () => {
      clearTimeout(immediate);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  const label = checking
    ? 'Checking your held spot…'
    : remaining === null
      ? 'Your spot is held'
      : remaining <= 0
        ? 'Checking your held spot…'
        : `Your spot is held for ${formatCountdown(remaining)}`;
  const urgent = !checking && remaining !== null && remaining > 0 && remaining <= 60_000;

  return (
    <View
      style={[styles.bar, urgent && styles.barUrgent]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
      testID="hold-countdown"
    >
      <Ionicons
        name="time-outline"
        size={16}
        color={urgent ? colors.status.error : colors.brand.primary}
      />
      <Text style={[styles.label, urgent && styles.labelUrgent]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 40,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  barUrgent: {
    backgroundColor: colors.status.errorSoft,
  },
  label: {
    ...typography.supporting,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
  labelUrgent: {
    color: colors.status.error,
  },
});
