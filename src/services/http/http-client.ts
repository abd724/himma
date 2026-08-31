/**
 * RI-1 — the ONE bounded customer HTTP client (docs/34 §7 RI-1).
 *
 * Follows the certified backend conventions exactly: bearer access-token
 * auth (never cookies on the app channel), typed error envelopes
 * (`{code, message}`), JSON bodies, abort support. Screens never call
 * `fetch` — they consume typed service contracts whose HTTP adapters go
 * through this client. Backend outcome codes are DIAGNOSTIC identifiers
 * here; customer-facing copy is mapped separately (error-copy.ts), never
 * auto-surfaced.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Network-level failure (offline, refused, timeout) — no HTTP response. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('network request failed');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export interface HttpClientDeps {
  baseUrl: string;
  /** Returns the CURRENT access token, or null when signed out. */
  getAccessToken: () => string | null;
  /** Notified once when an authenticated request comes back 401. */
  onUnauthorized?: () => void;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /**
   * RI-6 — every request carries a bounded deadline so a black-holed
   * connection (captive portal, dead route) surfaces as a typed
   * `NetworkError` instead of hanging a screen (or app startup) forever.
   */
  defaultTimeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  /** Attach the bearer token (default true). */
  auth?: boolean;
  signal?: AbortSignal;
  /** Per-request deadline override (RI-6). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export interface HttpClient {
  request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, options?: RequestOptions): Promise<T>;
}

export function createHttpClient(deps: HttpClientDeps): HttpClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async request<T>(
      method: 'GET' | 'POST' | 'PATCH',
      path: string,
      options: RequestOptions = {},
    ): Promise<T> {
      const auth = options.auth ?? true;
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      let bearerPresented = false;
      if (auth) {
        const token = deps.getAccessToken();
        if (token !== null) {
          headers.authorization = `Bearer ${token}`;
          bearerPresented = true;
        }
      }
      // Bounded deadline (RI-6): our own controller enforces the timeout;
      // a caller-provided signal aborts it too so explicit cancellation
      // still surfaces as an AbortError.
      const timeoutMs = options.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const forwardAbort = () => controller.abort();
      options.signal?.addEventListener('abort', forwardAbort, { once: true });
      let response: Response;
      try {
        response = await fetchImpl(`${deps.baseUrl}${path}`, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        if (options.signal?.aborted && error instanceof Error && error.name === 'AbortError') {
          throw error; // the CALLER cancelled — never a network failure
        }
        // Includes our own deadline abort: a hung request is a network
        // failure the customer can retry, never an eternal spinner.
        throw new NetworkError(error);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', forwardAbort);
      }
      if (!response.ok) {
        let code = 'requestFailed';
        let message = `Request failed (${response.status})`;
        try {
          const parsed = (await response.json()) as { code?: string; message?: string };
          if (typeof parsed.code === 'string') code = parsed.code;
          if (typeof parsed.message === 'string') message = parsed.message;
        } catch {
          // Non-JSON error body: keep the generic envelope.
        }
        // RI-6: only a request that actually PRESENTED a bearer can
        // invalidate the session — a 401 on a token-less request (e.g. a
        // screen racing app-launch restoration) proves nothing about the
        // stored session and must never destroy it.
        if (response.status === 401 && bearerPresented) deps.onUnauthorized?.();
        throw new ApiError(response.status, code, message);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    },
  };
}
