/**
 * Fastify foundation: the app builds, the health route responds with its
 * schema-validated shape, and unknown routes return a typed 404.
 */
import { buildApp } from '../src/app/build-app';

describe('fastify foundation', () => {
  it('serves the internal health check', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/internal/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('returns 404 for unknown routes', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
