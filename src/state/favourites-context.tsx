import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

/**
 * One favourites system for both entity kinds — docs/20 §5. Typed keys keep
 * `program:x` and `provider:x` isolated inside a single set; no second
 * favourites provider ever.
 */
export type FavouriteKind = 'program' | 'provider';
export type FavouriteKey = `${FavouriteKind}:${string}`;

export function favouriteKey(kind: FavouriteKind, id: string): FavouriteKey {
  return `${kind}:${id}`;
}

/** Pure toggle core — exported for direct unit testing. */
export function toggledFavourites(
  current: ReadonlySet<FavouriteKey>,
  kind: FavouriteKind,
  id: string,
): ReadonlySet<FavouriteKey> {
  const key = favouriteKey(kind, id);
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

interface FavouritesContextValue {
  favourites: ReadonlySet<FavouriteKey>;
  isFavourite: (kind: FavouriteKind, id: string) => boolean;
  toggleFavourite: (kind: FavouriteKind, id: string) => void;
}

const FavouritesContext = createContext<FavouritesContextValue | undefined>(undefined);

/**
 * App-level favourite programs and providers. Session-local mock state —
 * persistence arrives with the account milestone.
 */
export function FavouritesProvider({ children }: PropsWithChildren) {
  const [favourites, setFavourites] = useState<ReadonlySet<FavouriteKey>>(new Set());
  const value = useMemo(
    () => ({
      favourites,
      isFavourite: (kind: FavouriteKind, id: string) => favourites.has(favouriteKey(kind, id)),
      toggleFavourite: (kind: FavouriteKind, id: string) =>
        setFavourites((current) => toggledFavourites(current, kind, id)),
    }),
    [favourites],
  );
  return <FavouritesContext.Provider value={value}>{children}</FavouritesContext.Provider>;
}

export function useFavourites(): FavouritesContextValue {
  const value = useContext(FavouritesContext);
  if (value === undefined) throw new Error('useFavourites requires FavouritesProvider');
  return value;
}
