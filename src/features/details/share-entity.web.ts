import { buildShareUrl, type ShareEntityKind } from '@/features/details/share-url';

export type ShareOutcome = 'shared' | 'copied' | 'dismissed';

/**
 * Web preview counterpart of `share-entity.ts` — docs/09 §20.5: Web Share
 * when the browser offers it, otherwise a safe copy-link fallback. This
 * platform-split file is the only place browser APIs are allowed (docs/12 §2).
 */
export async function shareEntity(
  kind: ShareEntityKind,
  id: string,
  title: string,
): Promise<ShareOutcome> {
  const url = buildShareUrl(kind, id);
  const webNavigator = globalThis.navigator as Navigator | undefined;
  if (webNavigator?.share !== undefined) {
    try {
      await webNavigator.share({ title, text: `${title} on Himma`, url });
      return 'shared';
    } catch {
      return 'dismissed';
    }
  }
  if (webNavigator?.clipboard !== undefined) {
    try {
      await webNavigator.clipboard.writeText(url);
      return 'copied';
    } catch {
      return 'dismissed';
    }
  }
  return 'dismissed';
}
