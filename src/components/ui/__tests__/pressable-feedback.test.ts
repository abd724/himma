import { describe, expect, test } from '@jest/globals';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { createElement, type ComponentProps } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

/**
 * Native accessibility contract of the shared pressable — Commit 17
 * accessibility correction. Rendered through the real RN Pressable (native
 * jest environment), the host element must carry the merged contract:
 * `accessibilityState.disabled` for assistive tech (which keeps the dimmed
 * control reachable on native), `disabled` consumed by Pressability so
 * click/Enter/Space/native press never activate while unready, and the
 * explicit tabIndex recording focus intent. Web `aria-disabled`/native
 * disabled-attribute derivation is asserted against the real browser in
 * scripts/qa/checkout-review.mjs. react-test-renderer ships with
 * jest-expo; no new dependency.
 */

type HostProps = {
  accessibilityRole?: string;
  accessibilityState?: Record<string, unknown>;
  tabIndex?: number;
  focusable?: boolean;
};

function hostProps(props: ComponentProps<typeof PressableFeedback>): HostProps {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(PressableFeedback, props));
  });
  const tree = renderer!.toJSON();
  act(() => renderer!.unmount());
  if (tree === null || Array.isArray(tree)) throw new Error('expected a single host element');
  return tree.props as HostProps;
}

describe('PressableFeedback disabled contract (native accessibility state)', () => {
  test('unready: accessibilityState.disabled reaches the host with focus intent recorded', () => {
    const props = hostProps({
      accessibilityLabel: 'Continue to payment, Booking price, 85 dirhams per session',
      accessibilityState: { disabled: true },
      disabled: true,
      onPress: () => {},
    });
    expect(props.accessibilityRole).toBe('button');
    expect(props.accessibilityState).toMatchObject({ disabled: true });
    // Focusable while unready — the named blocker stays reachable.
    expect(props.tabIndex).toBe(0);
    expect(props.focusable).toBe(true);
  });

  test('unready: RN merges the disabled prop into accessibilityState even alone', () => {
    const props = hostProps({ accessibilityLabel: 'CTA', disabled: true });
    expect(props.accessibilityState).toMatchObject({ disabled: true });
  });

  test('ready: enabled semantics with the same state contract', () => {
    const props = hostProps({
      accessibilityLabel: 'Continue to payment, Booking price, 85 dirhams per session',
      accessibilityState: { disabled: false },
      disabled: false,
      onPress: () => {},
    });
    expect(props.accessibilityState).toMatchObject({ disabled: false });
    expect(props.tabIndex).toBe(0);
  });

  test('controls without the disabled contract are unchanged', () => {
    const props = hostProps({ accessibilityLabel: 'Full policy' });
    expect(props.accessibilityState?.disabled).toBeUndefined();
  });

  test('selection state parity is preserved alongside the disabled contract', () => {
    const props = hostProps({
      accessibilityLabel: 'Card payment',
      accessibilityRole: 'radio',
      accessibilityState: { checked: true, selected: true },
    });
    expect(props.accessibilityRole).toBe('radio');
    expect(props.accessibilityState).toMatchObject({ checked: true, selected: true });
  });
});
