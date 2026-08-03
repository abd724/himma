import { buildShareUrl, type ShareEntityKind } from '@/features/details/share-url';
import { Share } from 'react-native';

export type ShareOutcome = 'shared' | 'copied' | 'dismissed';

/**
 * Native share sheet (docs/09 §20.5). iOS reads `url`, Android reads
 * `message`, so the link travels on both. The `.web.ts` counterpart handles
 * Web Share and the copy-link fallback.
 */
export async function shareEntity(
  kind: ShareEntityKind,
  id: string,
  title: string,
): Promise<ShareOutcome> {
  const url = buildShareUrl(kind, id);
  try {
    const result = await Share.share({ message: `${title} on Himma — ${url}`, url, title });
    return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
  } catch {
    return 'dismissed';
  }
}
