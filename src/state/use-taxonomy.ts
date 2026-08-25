/**
 * RI-2 — real public taxonomy for screens (categories, activity types,
 * areas, collections) from the composition's shared cache. One fetch is
 * deduplicated across all consumers; until it resolves, lists are empty
 * and `ready` is false so surfaces hold their skeletons instead of
 * flashing wrong content.
 */
import { taxonomyCache } from '@/services/composition';
import type { Taxonomy } from '@/services/api/taxonomy-cache';
import { useEffect, useState } from 'react';

export interface TaxonomyState {
  ready: boolean;
  /** True when the load failed — consumers may retry via `reload`. */
  failed: boolean;
  taxonomy: Taxonomy | undefined;
  reload: () => void;
}

export function useTaxonomy(): TaxonomyState {
  const [taxonomy, setTaxonomy] = useState<Taxonomy | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    taxonomyCache.get().then(
      (value) => {
        if (!cancelled) {
          setTaxonomy(value);
          setFailed(false);
        }
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return {
    ready: taxonomy !== undefined,
    failed,
    taxonomy,
    reload: () => {
      setFailed(false);
      setAttempt((value) => value + 1);
    },
  };
}
