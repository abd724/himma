import { useRouter } from 'expo-router';
import { useRef } from 'react';

/**
 * Detail-route navigation policy — docs/20 §2.3. Detail surfaces are
 * root-level pushes (dock hidden structurally, like /search and /map), so
 * back always returns to the exact origin and the Results session survives
 * untouched beneath the push.
 */
export type DetailHref = `/program/${string}` | `/provider/${string}`;

export function programHref(programId: string): `/program/${string}` {
  return `/program/${programId}`;
}

export function providerHref(providerId: string): `/provider/${string}` {
  return `/provider/${providerId}`;
}

/**
 * Program ↔ Provider round-trips reuse the screen beneath instead of growing
 * the stack: navigating to the route directly under the current one goes
 * back; anything else pushes. Distinct targets are legitimate stack growth.
 */
export function crossLinkAction(
  previousHref: string | undefined,
  target: DetailHref,
): 'back' | 'push' {
  return previousHref === target ? 'back' : 'push';
}

/** One navigation action never pushes two copies of a detail route. */
const DOUBLE_TAP_WINDOW_MS = 700;

/**
 * `openProvider` joins this hook in the storefront commit — typed routes
 * reject `/provider/*` until that route file exists (docs/20 §13).
 */
export function useDetailNavigation() {
  const router = useRouter();
  const lastPushAt = useRef(0);

  return {
    openProgram: (programId: string) => {
      const now = Date.now();
      if (now - lastPushAt.current < DOUBLE_TAP_WINDOW_MS) return;
      lastPushAt.current = now;
      router.push(programHref(programId));
    },
  };
}
