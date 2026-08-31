/**
 * RI-6 — the ONE gate for `?qa-*` review params (docs/19 §3 pattern).
 *
 * QA params drive deterministic review states (simulated failures, hidden
 * counts, fixture scenarios) and are DEVELOPMENT-ONLY behavior: in a
 * production build every `qa-*` value reads as inert, so a crafted
 * `himma://...?qa-fail=1` deep link (reachable once the scheme is live)
 * can never flip a customer screen into a simulated state. Source-locked:
 * screens read qa params only through this helper.
 */
export function qaParamActive(value: unknown): boolean {
  if (!__DEV__) return false;
  const single = Array.isArray(value) ? value[0] : value;
  return single === '1';
}
