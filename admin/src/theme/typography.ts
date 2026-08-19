/**
 * Manrope hierarchy — docs/07 §5, adapted to a desktop-first SaaS density.
 * Weights map to the self-hosted @fontsource/manrope faces loaded in main.tsx.
 */
export const fontFamily = "'Manrope', 'Segoe UI', system-ui, -apple-system, sans-serif";

export const fontWeight = {
  regular: 400,
  medium: 500,
  semiBold: 600,
  bold: 700,
  extraBold: 800,
} as const;

/** Sizes/line-heights in px; consumed via the CSS custom properties. */
export const typography = {
  pageTitle: { fontSize: 24, lineHeight: 30, fontWeight: fontWeight.extraBold },
  sectionTitle: { fontSize: 18, lineHeight: 24, fontWeight: fontWeight.bold },
  cardTitle: { fontSize: 16, lineHeight: 22, fontWeight: fontWeight.bold },
  body: { fontSize: 14, lineHeight: 21, fontWeight: fontWeight.medium },
  supporting: { fontSize: 13, lineHeight: 19, fontWeight: fontWeight.medium },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: fontWeight.semiBold },
  navLabel: { fontSize: 14, lineHeight: 18, fontWeight: fontWeight.semiBold },
  railLabel: { fontSize: 10, lineHeight: 13, fontWeight: fontWeight.semiBold },
  microLabel: { fontSize: 11, lineHeight: 14, fontWeight: fontWeight.bold },
} as const;
