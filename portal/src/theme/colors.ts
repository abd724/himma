/**
 * Provisional Orbit Indigo palette — docs/07_PROVISIONAL_BRAND_SYSTEM.md.
 * Same named brand values as the customer app's theme (kept conceptually in
 * sync by hand until a shared token package is justified — recorded in
 * docs/29 §13). Semantic tokens only; components must never use raw hex.
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
    backdrop: 'rgba(32, 34, 58, 0.45)',
  },
} as const;

export type Colors = typeof colors;
