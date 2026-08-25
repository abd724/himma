import { IconButton } from '@/components/ui/icon-button';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, fontFamily, pagePadding, spacing, typography } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  areaLabel: string;
  onPressLocation: () => void;
  /** RI-1: real account display name, or null for a guest. */
  profileName: string | null;
  onPressProfile: () => void;
}

export function HomeHeader({ areaLabel, onPressLocation, profileName, onPressProfile }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.left}>
        <Text style={styles.wordmark} accessibilityRole="header">
          Himma
        </Text>
        <PressableFeedback
          onPress={onPressLocation}
          accessibilityLabel={`Change area. Current area ${areaLabel}, Abu Dhabi`}
          style={styles.location}
          hitSlop={10}
        >
          <Ionicons name="location-outline" size={15} color={colors.brand.primary} />
          <Text style={styles.locationText} numberOfLines={1}>
            {areaLabel}, Abu Dhabi
          </Text>
          <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
        </PressableFeedback>
      </View>
      <View style={styles.actions}>
        <IconButton icon="notifications-outline" accessibilityLabel="Notifications" />
        <PressableFeedback
          accessibilityLabel={
            profileName === null ? 'Profile. Sign in' : `Profile, signed in as ${profileName}`
          }
          style={styles.avatar}
          onPress={onPressProfile}
        >
          {profileName === null ? (
            <Ionicons name="person-outline" size={16} color={colors.brand.primary} />
          ) : (
            <Text style={styles.avatarInitial}>{profileName.slice(0, 1).toUpperCase()}</Text>
          )}
        </PressableFeedback>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: pagePadding,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.background.main,
  },
  left: { flexShrink: 1, gap: 2 },
  wordmark: {
    fontFamily: fontFamily.extraBold,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.8,
    color: colors.brand.primary,
  },
  location: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 24,
  },
  locationText: {
    ...typography.supporting,
    fontFamily: fontFamily.semiBold,
    color: colors.text.primary,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brand.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontFamily: fontFamily.extraBold,
    fontSize: 17,
    color: colors.brand.primary,
  },
});
