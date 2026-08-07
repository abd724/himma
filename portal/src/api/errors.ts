/**
 * Typed application-error boundary (mapping location).
 *
 * The backend responds with a typed outcome vocabulary (docs/29 §11 —
 * `mfaRequired`, `stepUpRequired`, `staleVersion`, `organizationSuspended`,
 * `programIncomplete` with `missing[]`, …). When real API integration begins
 * (W2-12), the response→UI-state mapping lives HERE, stays 1:1 with the
 * backend's http-outcomes vocabulary, and nowhere else. Until then only the
 * transport-level shapes exist.
 */
export class PortalApiError extends Error {
  constructor(
    message: string,
    /** HTTP status of the failed response, if one was received. */
    readonly status: number | null,
    /** Typed outcome code from the backend error envelope, when present. */
    readonly outcomeCode: string | null,
  ) {
    super(message);
    this.name = 'PortalApiError';
  }
}

export class ApiNotConfiguredError extends Error {
  constructor() {
    super('The Himma API is not configured in this environment.');
    this.name = 'ApiNotConfiguredError';
  }
}
