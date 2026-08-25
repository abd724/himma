/**
 * RI-1 — HTTP client conventions: bearer attachment, typed error mapping,
 * network-failure wrapping, 401 notification, JSON handling.
 */
import { describe, expect, it } from '@jest/globals';
import { ApiError, createHttpClient, NetworkError } from '@/services/http/http-client';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fetchDouble(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return responder(String(input), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('http client', () => {
  it('attaches the bearer for authenticated requests and never for auth:false', async () => {
    const { impl, calls } = fetchDouble(() => json(200, { ok: true }));
    const client = createHttpClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => 'token-1',
      fetchImpl: impl,
    });
    await client.request('GET', '/me');
    await client.request('POST', '/dev/identity/signin', { body: { a: 1 }, auth: false });
    const headers0 = calls[0].init.headers as Record<string, string>;
    const headers1 = calls[1].init.headers as Record<string, string>;
    expect(headers0.authorization).toBe('Bearer token-1');
    expect(headers1.authorization).toBeUndefined();
    expect(headers1['content-type']).toBe('application/json');
    expect(calls[1].init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('maps typed error envelopes into ApiError and notifies on authenticated 401s', async () => {
    let unauthorized = 0;
    const { impl } = fetchDouble(() =>
      json(401, { code: 'sessionExpired', message: 'Session expired' }),
    );
    const client = createHttpClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => 'token-1',
      onUnauthorized: () => {
        unauthorized += 1;
      },
      fetchImpl: impl,
    });
    const failure = await client.request('GET', '/me').catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(401);
    expect((failure as ApiError).code).toBe('sessionExpired');
    expect(unauthorized).toBe(1);
  });

  it('an unauthenticated 401 does NOT trigger the unauthorized notification', async () => {
    let unauthorized = 0;
    const { impl } = fetchDouble(() => json(401, { code: 'invalidCredentials', message: 'no' }));
    const client = createHttpClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => null,
      onUnauthorized: () => {
        unauthorized += 1;
      },
      fetchImpl: impl,
    });
    await client
      .request('POST', '/dev/identity/signin', { body: {}, auth: false })
      .catch(() => undefined);
    expect(unauthorized).toBe(0);
  });

  it('wraps transport failures in NetworkError', async () => {
    const { impl } = fetchDouble(() => {
      throw new TypeError('Failed to fetch');
    });
    const client = createHttpClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => null,
      fetchImpl: impl,
    });
    await expect(client.request('GET', '/search')).rejects.toBeInstanceOf(NetworkError);
  });

  it('tolerates non-JSON error bodies with the generic envelope', async () => {
    const { impl } = fetchDouble(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const client = createHttpClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => null,
      fetchImpl: impl,
    });
    const failure = await client.request('GET', '/me').catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('requestFailed');
  });
});
