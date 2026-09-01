/**
 * W6-1 — request/run correlation context (docs/37 §23).
 *
 * ONE AsyncLocalStorage carries the canonical correlation id through a unit
 * of work (an HTTP request today; a worker batch/scheduler tick when W6-2/
 * W6-3 arrive — the seam is deliberately runtime-role-neutral). Domain
 * services never receive a correlation parameter: the ONLY consumer is the
 * central audit helper (src/db/audit.ts) and the structured log bindings,
 * so closed domain signatures stay closed.
 *
 * The canonical id is ALWAYS server-generated (UUID). A client-supplied
 * `x-request-id` is never adopted as the canonical id — it may ride along
 * as a bounded, validated HINT for support correlation only.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  /** Server-generated canonical correlation id (UUID). */
  requestId: string;
  /** Validated client-supplied hint (never canonical, never audited). */
  clientRequestId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Canonical id format — exactly what `newCorrelationId` produces. */
const CANONICAL_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Bounded client-hint format; anything else is dropped, never truncated in. */
const CLIENT_HINT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function newCorrelationId(): string {
  return randomUUID();
}

export function isCanonicalCorrelationId(value: string): boolean {
  return CANONICAL_PATTERN.test(value);
}

/** Returns the validated client hint or undefined — never a modified value. */
export function validClientRequestIdHint(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return CLIENT_HINT_PATTERN.test(raw) ? raw : undefined;
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Callback form for Fastify hooks: `als.run(store, done)` propagates the
 * context through the remainder of the request lifecycle.
 */
export function enterRequestContext(context: RequestContext, done: () => void): void {
  storage.run(context, done);
}

/** The ambient canonical id, or undefined outside any unit of work. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
