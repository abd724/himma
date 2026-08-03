import { useNavigationContainerRef, useRouter } from 'expo-router';
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

/**
 * The detail href a root navigation-state entry represents, if any.
 * Non-detail routes (tabs, search, map) yield undefined — they never
 * participate in the cross-link back policy.
 */
export function detailHrefForRoute(
  name: string | undefined,
  params: unknown,
): DetailHref | undefined {
  const record =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)
      : undefined;
  if (name === 'program/[programId]' && typeof record?.programId === 'string') {
    return programHref(record.programId);
  }
  if (name === 'provider/[providerId]' && typeof record?.providerId === 'string') {
    return providerHref(record.providerId);
  }
  return undefined;
}

interface NavigationRouteLike {
  name?: string;
  params?: unknown;
  state?: NavigationStateLike;
}

interface NavigationStateLike {
  index?: number;
  routes?: NavigationRouteLike[];
}

/**
 * The app's real root stack. expo-router wraps everything in a synthetic
 * `__root` route, so the stack holding `(tabs)` and the detail routes lives
 * one level below the container's root state.
 */
export function rootStackRoutes(
  state: NavigationStateLike | undefined,
): NavigationRouteLike[] | undefined {
  let current = state;
  while (
    current?.routes !== undefined &&
    current.routes.length === 1 &&
    current.routes[0].name === '__root'
  ) {
    current = current.routes[0].state;
  }
  return current?.routes;
}

/** One navigation action never pushes two copies of a detail route. */
const DOUBLE_TAP_WINDOW_MS = 700;

export function useDetailNavigation() {
  const router = useRouter();
  // Press-time state read: covered detail screens are frozen by
  // react-native-screens, so a render-captured navigation state goes stale
  // and would mis-resolve the round-trip policy.
  const navigationRef = useNavigationContainerRef();
  const lastPushAt = useRef(0);

  const open = (target: DetailHref) => {
    const now = Date.now();
    if (now - lastPushAt.current < DOUBLE_TAP_WINDOW_MS) return;
    lastPushAt.current = now;
    // Route directly beneath the current one — a Program ↔ Provider
    // round-trip resolves as back instead of stacking a third route.
    const routes = rootStackRoutes(
      navigationRef.isReady() ? navigationRef.getRootState() : undefined,
    );
    const beneath =
      routes !== undefined && routes.length >= 2 ? routes[routes.length - 2] : undefined;
    if (crossLinkAction(detailHrefForRoute(beneath?.name, beneath?.params), target) === 'back') {
      router.back();
      return;
    }
    router.push(target);
  };

  return {
    openProgram: (programId: string) => open(programHref(programId)),
    openProvider: (providerId: string) => open(providerHref(providerId)),
  };
}
