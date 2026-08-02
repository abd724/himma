import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';

interface Props {
  icon: keyof typeof Ionicons.glyphMap;
  accessibilityLabel: string;
  onPress?: () => void;
  size?: number;
}

/** 44×44 circular icon button with a screen-reader label. */
export function IconButton({ icon, accessibilityLabel, onPress, size = 22 }: Props) {
  return (
    <PressableFeedback accessibilityLabel={accessibilityLabel} onPress={onPress} style={styles.button}>
      <Ionicons name={icon} size={size} color={colors.text.primary} />
    </PressableFeedback>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
});
