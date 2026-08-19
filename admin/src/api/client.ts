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
  /**
   * Cookie-channel call (docs/26 §4.7(9) session continuity): sends the
   * browser's HttpOnly auth-path cookies with the request. Used ONLY by
   * the auth boundary (/auth/session, /auth/csrf, /auth/refresh,
   * /auth/logout) — domain calls stay bearer-only.
   */
  readonly withCredentials?: boolean;
  /** Double-submit CSRF value echoed as the x-csrf-token header. */
  readonly csrfToken?: string;
}

/** Binary (document) response — W3-5 evidence retrieval. The body is a
 *  Blob held in memory only; nothing is ever written to browser storage. */
export interface ApiBinaryResponse {
  readonly status: number;
  readonly code: string | null;
  readonly blob: Blob | null;
  readonly contentType: string | null;
  /** Display filename from Content-Disposition (sanitized server-side). */
  readonly filename: string | null;
  readonly networkFailure: boolean;
}

export interface ApiClient {
  /** Base URL this client is bound to (per-environment configuration). */
  readonly baseUrl: string;
  /** JSON request against a backend route path (must start with '/'). */
  request(path: string, options?: ApiRequestOptions): Promise<ApiJsonResponse>;
  /** Authorized binary GET (W3-5 evidence documents) — bearer-only. */
  requestBinary(
    path: string,
    options: { accessToken: string },
  ): Promise<ApiBinaryResponse>;
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
      if (requestOptions.csrfToken !== undefined) {
        headers['x-csrf-token'] = requestOptions.csrfToken;
      }
      let response: Response;
      try {
        response = await fetchImpl(`${root}${path}`, {
          method: requestOptions.method ?? 'GET',
          headers,
          ...(requestOptions.withCredentials === true ? { credentials: 'include' } : {}),
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

    async requestBinary(path, requestOptions) {
      if (!path.startsWith('/')) {
        throw new Error('API paths must be absolute route paths');
      }
      let response: Response;
      try {
        response = await fetchImpl(`${root}${path}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${requestOptions.accessToken}` },
        });
      } catch {
        return {
          status: 0,
          code: null,
          blob: null,
          contentType: null,
          filename: null,
          networkFailure: true,
        };
      }
      if (!response.ok) {
        let code: string | null = null;
        try {
          const body = (await response.json()) as { code?: unknown };
          code = typeof body.code === 'string' ? body.code : null;
        } catch {
          code = null;
        }
        return {
          status: response.status,
          code,
          blob: null,
          contentType: null,
          filename: null,
          networkFailure: false,
        };
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') ?? '';
      const match = /filename="([^"]*)"/.exec(disposition);
      return {
        status: response.status,
        code: null,
        blob,
        contentType: response.headers.get('content-type'),
        filename: match?.[1] ?? null,
        networkFailure: false,
      };
    },
  };
}
