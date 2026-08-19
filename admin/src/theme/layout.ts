/**
 * Responsive layout constants — docs/29 §12.
 * Breakpoints classify the three validated viewport classes:
 * narrow (<768) → drawer · tablet (768–1119) → compact rail · desktop (≥1120) → full sidebar.
 */
export const layout = {
  breakpointTablet: 768,
  breakpointDesktop: 1120,
  sidebarWidth: 264,
  railWidth: 84,
  topBarHeight: 64,
  contentMaxWidth: 1040,
  focusRingWidth: 2,
} as const;
