import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

interface FavouritesContextValue {
  favourites: ReadonlySet<string>;
  toggleFavourite: (programId: string) => void;
}

const FavouritesContext = createContext<FavouritesContextValue | undefined>(undefined);

/**
 * App-level favourite program ids. Session-local mock state — persistence
 * arrives with the account milestone.
 */
export function FavouritesProvider({ children }: PropsWithChildren) {
  const [favourites, setFavourites] = useState<ReadonlySet<string>>(new Set());
  const value = useMemo(
    () => ({
      favourites,
      toggleFavourite: (programId: string) =>
        setFavourites((current) => {
          const next = new Set(current);
          if (next.has(programId)) next.delete(programId);
          else next.add(programId);
          return next;
        }),
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
