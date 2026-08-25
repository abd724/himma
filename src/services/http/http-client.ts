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
}

export interface RequestOptions {
  body?: unknown;
  /** Attach the bearer token (default true). */
  auth?: boolean;
  signal?: AbortSignal;
}

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
      if (auth) {
        const token = deps.getAccessToken();
        if (token !== null) headers.authorization = `Bearer ${token}`;
      }
      let response: Response;
      try {
        response = await fetchImpl(`${deps.baseUrl}${path}`, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new NetworkError(error);
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
        if (response.status === 401 && auth) deps.onUnauthorized?.();
        throw new ApiError(response.status, code, message);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    },
  };
}
