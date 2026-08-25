import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, pagePadding, radii, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  title: string;
  body: string;
}

/**
 * Lightweight guest setup invitation — docs/18 §9 A. RI-1: routes to the
 * REAL sign-in flow. Never an add-child prompt (docs/09 §19.6).
 */
export function HomeActionCard({ title, body }: Props) {
  return (
    <View style={styles.wrap}>
      <PressableFeedback
        accessibilityLabel={`${title}. ${body}`}
        style={styles.card}
        onPress={() => router.push('/auth/sign-in?next=/' as never)}
      >
        <View style={styles.info}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.body}>{body}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.brand.primary} />
      </PressableFeedback>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: pagePadding },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.brand.primarySoft,
  },
  info: { flex: 1, gap: 2 },
  title: {
    ...typography.cardTitle,
    color: colors.text.primary,
  },
  body: {
    ...typography.supporting,
    color: colors.text.secondary,
  },
});
