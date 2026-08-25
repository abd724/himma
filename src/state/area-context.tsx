import { homeFeedService } from '@/services/composition';
import type { Area, AreaId } from '@/types/domain';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

interface AreaContextValue {
  areas: Area[];
  /** Empty string until the real area list loads (headers show a neutral
   *  placeholder); then the first canonical area. */
  areaId: AreaId;
  setAreaId: (id: AreaId) => void;
  areaLabelById: Map<AreaId, string>;
}

const AreaContext = createContext<AreaContextValue | undefined>(undefined);

/**
 * App-level selected area — feeds headers and the location sheet. RI-2:
 * areas are REAL canonical backend rows (`/catalogue/areas` via the
 * composition); nothing renders a fixture area. The selected area is a
 * browsing context; server-side narrowing happens only through the
 * explicit area filter.
 */
export function AreaProvider({ children }: PropsWithChildren) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [areaId, setAreaId] = useState<AreaId>('');

  useEffect(() => {
    let cancelled = false;
    homeFeedService.getAreas().then(
      (loaded) => {
        if (cancelled) return;
        setAreas(loaded);
        setAreaId((current) => {
          if (current !== '' && loaded.some((area) => area.id === current)) return current;
          return loaded[0]?.id ?? '';
        });
      },
      () => {
        // Unreachable backend: leave the list empty; discovery screens
        // surface their own error states.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(
    () => ({
      areas,
      areaId,
      setAreaId,
      areaLabelById: new Map(areas.map((area) => [area.id, area.label])),
    }),
    [areas, areaId],
  );
  return <AreaContext.Provider value={value}>{children}</AreaContext.Provider>;
}

export function useAreaContext(): AreaContextValue {
  const value = useContext(AreaContext);
  if (value === undefined) throw new Error('useAreaContext requires AreaProvider');
  return value;
}
