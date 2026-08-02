import { areas } from '@/data/mock/catalogue';
import type { Area, AreaId } from '@/types/domain';
import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

interface AreaContextValue {
  areas: Area[];
  areaId: AreaId;
  setAreaId: (id: AreaId) => void;
  areaLabelById: Map<AreaId, string>;
}

const AreaContext = createContext<AreaContextValue | undefined>(undefined);

/** App-level selected area — feeds headers and "Near me" ranking everywhere. */
export function AreaProvider({ children }: PropsWithChildren) {
  const [areaId, setAreaId] = useState<AreaId>('khalifa-city');
  const value = useMemo(
    () => ({
      areas,
      areaId,
      setAreaId,
      areaLabelById: new Map(areas.map((area) => [area.id, area.label])),
    }),
    [areaId],
  );
  return <AreaContext.Provider value={value}>{children}</AreaContext.Provider>;
}

export function useAreaContext(): AreaContextValue {
  const value = useContext(AreaContext);
  if (value === undefined) throw new Error('useAreaContext requires AreaProvider');
  return value;
}
