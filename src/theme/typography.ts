/** Manrope hierarchy — docs/07 §5. Sizes in logical pixels. */
export const fontFamily = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semiBold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
  extraBold: 'Manrope_800ExtraBold',
} as const;

export const typography = {
  heroTitle: { fontFamily: fontFamily.extraBold, fontSize: 28, lineHeight: 34 },
  screenTitle: { fontFamily: fontFamily.extraBold, fontSize: 24, lineHeight: 30 },
  sectionTitle: { fontFamily: fontFamily.extraBold, fontSize: 20, lineHeight: 26 },
  cardTitle: { fontFamily: fontFamily.bold, fontSize: 16, lineHeight: 21 },
  body: { fontFamily: fontFamily.medium, fontSize: 15, lineHeight: 21 },
  supporting: { fontFamily: fontFamily.medium, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fontFamily.semiBold, fontSize: 12, lineHeight: 16 },
  price: { fontFamily: fontFamily.extraBold, fontSize: 15, lineHeight: 20 },
  chip: { fontFamily: fontFamily.semiBold, fontSize: 14, lineHeight: 18 },
  dockLabel: { fontFamily: fontFamily.semiBold, fontSize: 11, lineHeight: 14 },
} as const;
