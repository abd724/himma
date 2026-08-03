/**
 * Where the map came from. The map is one view of the active results
 * session, so the origin decides how `List` returns without ever stacking a
 * second Results route (docs/16 §3.8, docs/15 §4.3).
 */
export type MapOrigin = 'results' | 'discover' | 'category' | 'activity';

export const mapOrigins: MapOrigin[] = ['results', 'discover', 'category', 'activity'];

export function parseMapOrigin(value: unknown): MapOrigin {
  return typeof value === 'string' && (mapOrigins as string[]).includes(value)
    ? (value as MapOrigin)
    : 'discover';
}

export type ListDestination =
  /** A Results screen is already under the map — pop back onto it. */
  | { kind: 'back' }
  /** No Results screen below — dismiss the map and open the session's list. */
  | { kind: 'openResults' };

/**
 * `List` from a map opened on top of Results returns to that exact screen;
 * from any browsing surface it opens the session's list instead. Either way
 * exactly one Results route exists afterwards.
 */
export function listDestination(origin: MapOrigin): ListDestination {
  return origin === 'results' ? { kind: 'back' } : { kind: 'openResults' };
}

/**
 * Entering from Discover with no session yet creates a deterministic broad
 * one; an existing session (a search, a preset, a category) is preserved
 * exactly as it stands.
 */
export function needsBroadSession(origin: MapOrigin, sessionStarted: boolean): boolean {
  return origin === 'discover' && !sessionStarted;
}
