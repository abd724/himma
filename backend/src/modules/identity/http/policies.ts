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

import {
  isActiveCapability,
  type ProviderCapability,
} from '../../provider/provider-capabilities';

export const ROUTE_POLICIES = [
  /** No authentication of any kind; must be declared deliberately. */
  'public',
  /** Auth-flow entry points that cannot require a bearer token yet. */
  'unauthenticatedAuthFlow',
  /** Requires a live, verified customer session. */
  'authenticatedCustomer',
  /** authenticatedCustomer + recent provider authentication (§3.10). */
  'stepUpRequired',
  /** Live session + MFA assurance + ≥1 active Himma admin role (B2-5).
   *  Route handlers still check the specific role; deny-by-default holds. */
  'admin',
  /** Provider-private management (docs/27 §7–§8, S3-3): live session +
   *  active staff_membership for the addressed `:organizationId` (resolved
   *  fresh from PostgreSQL; cross-org is not-found-shaped) + the D-S3-5 MFA
   *  baseline + the route's declared ACTIVE capability + the suspended-org
   *  mutation refusal. Requires `providerCapability` in the route config. */
  'provider',
  /** `provider` + the Slice-2 recent-step-up window — the D-S3-5
   *  higher-risk set (staff invitations/revocations, role/scope changes,
   *  ownership-sensitive actions). */
  'providerStepUp',
] as const;

export type RoutePolicy = (typeof ROUTE_POLICIES)[number];

const PROVIDER_POLICIES: readonly RoutePolicy[] = ['provider', 'providerStepUp'];

export function isProviderPolicy(policy: RoutePolicy): boolean {
  return PROVIDER_POLICIES.includes(policy);
}

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
    /** Required on provider policies: the ACTIVE capability this route
     *  needs. Reserved (future) capabilities are unrepresentable here —
     *  registration refuses anything outside the Slice-3-active set. */
    providerCapability?: ProviderCapability;
  }
}

/** Reads a route's declared policy at request time (always present — the
 *  onRoute guard refused registration otherwise). */
export function policyOf(config: unknown): RoutePolicy | undefined {
  return (config as { authPolicy?: RoutePolicy } | undefined)?.authPolicy;
}

/** Reads a provider route's declared capability at request time. */
export function providerCapabilityOf(config: unknown): ProviderCapability | undefined {
  return (config as { providerCapability?: ProviderCapability } | undefined)
    ?.providerCapability;
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
    // Provider routes must additionally declare exactly which ACTIVE
    // capability they need (docs/27 §6/§13.2); a reserved/unknown
    // capability or a missing declaration refuses registration, and the
    // capability slot is meaningless anywhere else — declaring it on a
    // non-provider policy is a wiring mistake refused just as loudly.
    const capability = providerCapabilityOf(route.config);
    if (isProviderPolicy(policy)) {
      if (capability === undefined) {
        throw new Error(
          `Route ${String(route.method)} ${route.url} declares the "${policy}" policy without a providerCapability — deny-by-default refuses registration (docs/27 §13.2).`,
        );
      }
      if (!isActiveCapability(capability)) {
        throw new Error(
          `Route ${String(route.method)} ${route.url} declares capability "${String(capability)}", which is not a Slice-3-ACTIVE provider capability — reserved capabilities cannot become executable (docs/27 §6).`,
        );
      }
    } else if (capability !== undefined) {
      throw new Error(
        `Route ${String(route.method)} ${route.url} declares providerCapability "${String(capability)}" on the non-provider policy "${policy}".`,
      );
    }
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      app.routePolicyInventory.push({ method, url: route.url, policy });
    }
  });
}
