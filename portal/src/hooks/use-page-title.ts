import { useEffect } from 'react';

/** Keeps the document title in step with the current page heading. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Himma Provider Portal`;
  }, [title]);
}
