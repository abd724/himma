/**
 * Provisional Orbit Indigo palette — docs/07_PROVISIONAL_BRAND_SYSTEM.md.
 * Semantic tokens only; screens must never use raw hex values.
 */
export const colors = {
  brand: {
    primary: '#5146E5',
    primaryPressed: '#4035C4',
    primarySoft: '#F0EEFF',
    accentWarm: '#FF7A66',
    reward: '#FFD86A',
  },
  background: {
    main: '#FBFAFF',
    elevated: '#FFFFFF',
  },
  text: {
    primary: '#20223A',
    secondary: '#6D7085',
    inverse: '#FFFFFF',
  },
  border: {
    default: '#E8E7F0',
  },
  status: {
    success: '#2DBA7F',
    error: '#DC4C5A',
  },
  overlay: {
    /** Scrim over photography so inverse text stays readable. */
    imageScrim: 'rgba(23, 20, 60, 0.78)',
    imageScrimMid: 'rgba(23, 20, 60, 0.42)',
    imageScrimClear: 'rgba(23, 20, 60, 0)',
    backdrop: 'rgba(32, 34, 58, 0.45)',
    surfaceTranslucent: 'rgba(255, 255, 255, 0.97)',
  },
} as const;

export type Colors = typeof colors;
