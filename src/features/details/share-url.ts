/**
 * Placeholder canonical web links for sharing — docs/09 §20.5. Always https
 * (never a himma:// custom scheme in shared content); the real customer web
 * surface will own these URLs later (docs/03 §5).
 */
export type ShareEntityKind = 'program' | 'provider';

export const SHARE_BASE_URL = 'https://himma.app';

export function buildShareUrl(kind: ShareEntityKind, id: string): string {
  return `${SHARE_BASE_URL}/${kind}/${id}`;
}
