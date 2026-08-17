import { useEffect, useState } from 'react';

/**
 * Small input debounce (W2-12C1 final correction): the Listings search
 * field drives an AUTHORITATIVE server query, so keystrokes settle for a
 * beat before a request fires. No framework — one timer, one value.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
