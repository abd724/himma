import { describe, expect, test } from '@jest/globals';
import {
  favouriteKey,
  toggledFavourites,
  type FavouriteKey,
} from '@/state/favourites-context';

describe('Typed favourites (docs/20 §5)', () => {
  test('keys are namespaced by kind', () => {
    expect(favouriteKey('program', 'junior-swim-squad')).toBe('program:junior-swim-squad');
    expect(favouriteKey('provider', 'blue-wave')).toBe('provider:blue-wave');
  });

  test('toggling adds then removes a key without touching others', () => {
    const empty: ReadonlySet<FavouriteKey> = new Set();
    const withProgram = toggledFavourites(empty, 'program', 'ladies-strength');
    expect(withProgram.has('program:ladies-strength')).toBe(true);

    const withBoth = toggledFavourites(withProgram, 'provider', 'falcon');
    expect(withBoth.has('program:ladies-strength')).toBe(true);
    expect(withBoth.has('provider:falcon')).toBe(true);

    const removed = toggledFavourites(withBoth, 'program', 'ladies-strength');
    expect(removed.has('program:ladies-strength')).toBe(false);
    expect(removed.has('provider:falcon')).toBe(true);
  });

  test('kinds are isolated — the same id can be saved as program and provider', () => {
    let favourites: ReadonlySet<FavouriteKey> = new Set();
    favourites = toggledFavourites(favourites, 'program', 'blue-wave');
    favourites = toggledFavourites(favourites, 'provider', 'blue-wave');
    expect(favourites.has('program:blue-wave')).toBe(true);
    expect(favourites.has('provider:blue-wave')).toBe(true);

    favourites = toggledFavourites(favourites, 'program', 'blue-wave');
    expect(favourites.has('program:blue-wave')).toBe(false);
    expect(favourites.has('provider:blue-wave')).toBe(true);
  });

  test('migrated program call-site semantics are unchanged (toggle round-trip)', () => {
    // Pre-refactor behavior: toggling the same program id twice returns to
    // the original state. The keyed model must preserve that exactly.
    const start: ReadonlySet<FavouriteKey> = new Set(['program:beginner-calisthenics']);
    const once = toggledFavourites(start, 'program', 'reformer-pilates');
    const twice = toggledFavourites(once, 'program', 'reformer-pilates');
    expect([...twice].sort()).toEqual([...start].sort());
  });

  test('toggling never mutates the previous set (state-safe updates)', () => {
    const start: ReadonlySet<FavouriteKey> = new Set(['provider:falcon']);
    const next = toggledFavourites(start, 'provider', 'falcon');
    expect(start.has('provider:falcon')).toBe(true);
    expect(next.has('provider:falcon')).toBe(false);
  });
});
