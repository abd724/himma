/**
 * Route-policy registry with STRUCTURAL deny-by-default (docs/26 §6) — B2-4.
 *
 * Every route must declare exactly one policy in its Fastify route config;
 * a route without a declaration aborts application startup — no route can
 * become public because authentication wiring was forgotten. Public status
 * is always explicit (including the health route). B2-4 carries no
 * provider/admin business authorization: the only categories are the
 * customer-slice foundation ones plus the step-up gate; role policies are a
 * later-slice extension of this registry, not an improvisation.
 */
import type { FastifyInstance } from 'fastify';

export const ROUTE_POLICIES = [
  /** No authentication of any kind; must be declared deliberately. */
  'public',
  /** Auth-flow entry points that cannot require a bearer token yet. */
  'unauthenticatedAuthFlow',
  /** Requires a live, verified customer session. */
  'authenticatedCustomer',
  /** authenticatedCustomer + recent provider authentication (§3.10). */
  'stepUpRequired',
] as const;

export type RoutePolicy = (typeof ROUTE_POLICIES)[number];

export interface RoutePolicyEntry {
  method: string;
  url: string;
  policy: RoutePolicy;
}

declare module 'fastify' {
  interface FastifyInstance {
    routePolicyInventory: RoutePolicyEntry[];
  }
  interface FastifyContextConfig {
    authPolicy?: RoutePolicy;
  }
}

/** Reads a route's declared policy at request time (always present — the
 *  onRoute guard refused registration otherwise). */
export function policyOf(config: unknown): RoutePolicy | undefined {
  return (config as { authPolicy?: RoutePolicy } | undefined)?.authPolicy;
}

export function installRoutePolicyGuard(app: FastifyInstance): void {
  app.decorate('routePolicyInventory', [] as RoutePolicyEntry[]);
  app.addHook('onRoute', (route) => {
    const policy = policyOf(route.config);
    if (policy === undefined) {
      throw new Error(
        `Route ${String(route.method)} ${route.url} has no authPolicy declaration — ` +
          'deny-by-default refuses registration (docs/26 §6).',
      );
    }
    if (!ROUTE_POLICIES.includes(policy)) {
      throw new Error(
        `Route ${String(route.method)} ${route.url} declares unknown authPolicy "${String(policy)}".`,
      );
    }
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      app.routePolicyInventory.push({ method, url: route.url, policy });
    }
  });
}
