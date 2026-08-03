import { AppImage } from '@/components/ui/app-image';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { demoImage } from '@/data/mock/images';
import type { HeroContent } from '@/services/contracts/home-feed';
import { colors, fontFamily, pagePadding, radii, spacing, typography } from '@/theme';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  hero: HeroContent;
  /** Activated once its Results destination exists; inert otherwise. */
  onPressAction?: () => void;
}

/** Seasonal feature for adults and families together — docs/11 §4.5. */
export function HeroCard({ hero, onPressAction }: Props) {
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <AppImage source={demoImage(hero.imageKey)} style={styles.image} />
        <LinearGradient
          colors={[
            colors.overlay.imageScrimClear,
            colors.overlay.imageScrimMid,
            colors.overlay.imageScrim,
          ]}
          locations={[0, 0.35, 0.8]}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.content}>
          <Text style={styles.eyebrow}>{hero.eyebrow}</Text>
          <Text style={styles.title}>{hero.title}</Text>
          <Text style={styles.subtitle}>{hero.subtitle}</Text>
          <PressableFeedback accessibilityLabel={hero.actionLabel} onPress={onPressAction} style={styles.cta}>
            <Text style={styles.ctaLabel}>{hero.actionLabel}</Text>
          </PressableFeedback>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: pagePadding },
  card: {
    height: 216,
    borderRadius: radii.hero,
    overflow: 'hidden',
  },
  image: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  content: {
    flex: 1,
    justifyContent: 'flex-end',
    padding: spacing.xl,
    gap: spacing.xs,
  },
  eyebrow: {
    ...typography.caption,
    color: colors.brand.reward,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  title: {
    ...typography.heroTitle,
    color: colors.text.inverse,
    letterSpacing: -0.5,
  },
  subtitle: {
    ...typography.supporting,
    color: colors.text.inverse,
    opacity: 0.92,
    maxWidth: '92%',
  },
  cta: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    backgroundColor: colors.background.elevated,
    borderRadius: radii.button,
    minHeight: 44,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.brand.primary,
  },
});
