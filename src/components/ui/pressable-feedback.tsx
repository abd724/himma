import { useReducedMotion } from '@/hooks/use-reduced-motion';
import type { PropsWithChildren } from 'react';
import {
  Pressable,
  type AccessibilityRole,
  type AccessibilityState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

interface Props {
  onPress?: () => void;
  /**
   * false lets children announce individually instead of merging into one
   * element — required when the pressable wraps a list of labelled rows
   * (nested accessible children are unreachable inside an accessible parent
   * on iOS).
   */
  accessible?: boolean;
  accessibilityLabel: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  hitSlop?: number;
}

/**
 * Standard press feedback: slight dim, plus a subtle scale when the OS
 * reduce-motion preference allows it. Inert destinations pass no onPress and
 * still give visible feedback — docs/09 §17.2.
 */
export function PressableFeedback({
  onPress,
  accessible,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  accessibilityHint,
  style,
  hitSlop,
  children,
}: PropsWithChildren<Props>) {
  const reducedMotion = useReducedMotion();

  return (
    <Pressable
      onPress={onPress ?? (() => {})}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      accessibilityHint={accessibilityHint}
      // RN-web omits these from accessibilityState; set explicitly so web
      // assistive tech (and Playwright role queries) see selection state.
      aria-selected={accessibilityState?.selected}
      aria-checked={accessibilityState?.checked}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        style,
        pressed && { opacity: 0.65 },
        pressed && !reducedMotion && { transform: [{ scale: 0.98 }] },
      ]}
    >
      {children}
    </Pressable>
  );
}
