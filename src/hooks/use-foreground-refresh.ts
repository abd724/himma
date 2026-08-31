/**
 * RI-6 — ONE bounded reconciliation when the app returns to the
 * foreground (owner items 15/22): screens that poll authoritative status
 * (payment, purchase, credential) re-read server truth exactly once per
 * background→active transition instead of trusting timers that slept with
 * the process. Web maps the same signal through react-native-web's
 * AppState (document visibility). Never a second polling loop — callers
 * feed the signal into their existing single-loop controller.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

export function useForegroundRefresh(onForeground: () => void): void {
  const callback = useRef(onForeground);
  useEffect(() => {
    callback.current = onForeground;
  });
  useEffect(() => {
    let last = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      const wasBackground = last === 'background' || last === 'inactive';
      last = next;
      if (next === 'active' && wasBackground) callback.current();
    });
    return () => subscription.remove();
  }, []);
}
