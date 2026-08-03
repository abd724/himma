/**
 * How a submitted search reaches Results — docs/16 §3.8, docs/17 §11.
 *
 * Search is a root-level overlay; submitting dismisses it and lands on
 * `/discover/results`. When Search was opened FROM Results (the query pill
 * or zero-state "Try another search"), the discover stack's top is already
 * a Results route rendering the same shared session — pushing would stack a
 * second, identical Results screen, so native back/swipe-back would land on
 * a stale duplicate. Replacing keeps exactly one Results route, mirroring
 * the map's origin rules in `map-navigation.ts`.
 */
export type SearchOrigin = 'results' | undefined;

export function resultsNavigationAction(origin: SearchOrigin): 'replace' | 'push' {
  return origin === 'results' ? 'replace' : 'push';
}
