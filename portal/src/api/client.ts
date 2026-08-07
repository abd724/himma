import { ApiNotConfiguredError } from './errors';

/**
 * Centralized API client boundary. Every future real request goes through one
 * client created here — no fetch calls elsewhere in the portal.
 *
 * W2-1 establishes the seam only: no domain calls, no endpoints, no
 * authentication material. W2-2+ extend `ApiClient` with typed request
 * helpers; W2-12 wires screens area-by-area (docs/29 §14) without redesign.
 */
export interface ApiClient {
  /** Base URL this client is bound to (per-environment configuration). */
  readonly baseUrl: string;
}

export interface ApiClientOptions {
  readonly baseUrl: string | null;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl } = options;
  if (!baseUrl) {
    throw new ApiNotConfiguredError();
  }
  return { baseUrl };
}
