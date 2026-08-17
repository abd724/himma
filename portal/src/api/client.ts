import { ApiNotConfiguredError } from './errors';

/**
 * Centralized API client boundary. Every real request goes through the one
 * client created here — no fetch calls elsewhere in the portal.
 *
 * W2-1 established the seam; W2-12A adds the typed JSON transport used by
 * the live auth adapter and provider-access bootstrap. Requests carry an
 * optional bearer ACCESS token supplied per call by the auth boundary — the
 * client itself never stores token material, and tokens never appear in
 * URLs, query strings, or thrown errors.
 */

export interface ApiJsonResponse {
  /** HTTP status; 0 when the request never produced a response (network). */
  readonly status: number;
  /** Typed outcome code from the backend error envelope, when present. */
  readonly code: string | null;
  /** Parsed JSON body (null when absent or unparseable). */
  readonly body: unknown;
  /** True when the request failed before any HTTP response existed. */
  readonly networkFailure: boolean;
}

export interface ApiRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Bearer ACCESS token for authenticated calls — header-only, never URL. */
  readonly accessToken?: string;
}

export interface ApiClient {
  /** Base URL this client is bound to (per-environment configuration). */
  readonly baseUrl: string;
  /** JSON request against a backend route path (must start with '/'). */
  request(path: string, options?: ApiRequestOptions): Promise<ApiJsonResponse>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  readonly baseUrl: string | null;
  /** Test seam only; defaults to the platform fetch. */
  readonly fetchImpl?: FetchLike;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl } = options;
  if (!baseUrl) {
    throw new ApiNotConfiguredError();
  }
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const root = baseUrl.replace(/\/+$/, '');

  return {
    baseUrl: root,
    async request(path, requestOptions = {}) {
      if (!path.startsWith('/')) {
        throw new Error('API paths must be absolute route paths');
      }
      const headers: Record<string, string> = { accept: 'application/json' };
      if (requestOptions.body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      if (requestOptions.accessToken !== undefined) {
        headers.authorization = `Bearer ${requestOptions.accessToken}`;
      }
      let response: Response;
      try {
        response = await fetchImpl(`${root}${path}`, {
          method: requestOptions.method ?? 'GET',
          headers,
          ...(requestOptions.body !== undefined
            ? { body: JSON.stringify(requestOptions.body) }
            : {}),
        });
      } catch {
        return { status: 0, code: null, body: null, networkFailure: true };
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const code =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { code?: unknown }).code === 'string'
          ? (body as { code: string }).code
          : null;
      return { status: response.status, code, body, networkFailure: false };
    },
  };
}
