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
  /**
   * A not-ready control: blocks click/Enter/Space/native press activation
   * at the Pressable layer and exposes `aria-disabled="true"` on web —
   * RN-web derives that attribute only from this prop, never from
   * accessibilityState, and for button hosts it adds the native `disabled`
   * attribute alongside (stronger browser-enforced semantics; assistive
   * tech reaches the control in browse mode as dimmed, and callers keep the
   * named not-ready reason in an adjacent polite live region — docs/22 §9).
   * Callers still pass accessibilityState.disabled alongside for the native
   * state contract, which keeps the control reachable by native assistive
   * tech. The explicit tabIndex records focus intent for host elements the
   * browser does not natively remove from the tab order.
   */
  disabled?: boolean;
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
  disabled,
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
      disabled={disabled}
      // With the disabled contract in play, the explicit tabIndex prevents
      // RN-web's tabIndex -1 fallback; on native-button hosts the browser's
      // own disabled semantics govern focus while unready.
      tabIndex={disabled !== undefined ? 0 : undefined}
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
