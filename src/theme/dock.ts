import { colors } from './colors';

/**
 * Floating navigation dock tokens — docs/04 §2.
 * The dock is a detached rounded capsule; every visual value lives here
 * so a rebrand never edits the component.
 */
export const dockTokens = {
  background: colors.overlay.surfaceTranslucent,
  border: colors.border.default,
  activePillBackground: colors.brand.primary,
  activeIconColor: colors.text.inverse,
  activeLabelColor: colors.text.inverse,
  inactiveIconColor: colors.text.secondary,
  inactiveLabelColor: colors.text.secondary,
  radius: 34,
  activePillRadius: 25,
  height: 68,
  /** Gap between the dock and the bottom safe-area edge. */
  safeAreaOffset: 10,
  horizontalMargin: 20,
  /** Extra scroll padding so content never hides behind the dock. */
  contentClearance: 24,
} as const;
