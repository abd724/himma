import { useEffect, useState } from 'react';

/** Debounce for server-driven search inputs (the W2-12C1 portal pattern —
 *  the SERVER filters; this only limits request chatter while typing). */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
