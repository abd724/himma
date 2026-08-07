import { useQuery } from '@tanstack/react-query';
import { usePortalPorts } from '../../app/ports-context';

/** Canonical ACTIVE area taxonomy (mirrors `GET /catalogue/areas`). */
export function useAreas() {
  const { areaPort } = usePortalPorts();
  return useQuery({
    queryKey: ['areas'],
    queryFn: () => areaPort.listAreas(),
  });
}
