import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAuthMode } from '../src/auth/auth-mode';
import { createAuthRuntime } from '../src/app/auth-runtime';
import type { PortalEnv } from '../src/api/env';

describe('resolveAuthMode (production fail-closed)', () => {
  test('development defaults to fixture mode', () => {
    expect(resolveAuthMode({ configuredMode: undefined, isProduction: false })).toBe('fixture');
  });

  test('a production build with no configuration is UNCONFIGURED (fail-closed), never fixture', () => {
    expect(resolveAuthMode({ configuredMode: undefined, isProduction: true })).toBe('unconfigured');
    expect(resolveAuthMode({ configuredMode: '', isProduction: true })).toBe('unconfigured');
  });

  test('fixture mode in production requires the explicit opt-in switch', () => {
    expect(resolveAuthMode({ configuredMode: 'fixture', isProduction: true })).toBe('fixture');
  });

  test('live mode is an EXPLICIT selection in any environment', () => {
    expect(resolveAuthMode({ configuredMode: 'live', isProduction: true })).toBe('live');
    expect(resolveAuthMode({ configuredMode: 'live', isProduction: false })).toBe('live');
  });

  test('unknown configuration values fail closed in every environment', () => {
    expect(resolveAuthMode({ configuredMode: 'production', isProduction: true })).toBe(
      'unconfigured',
    );
    expect(resolveAuthMode({ configuredMode: 'nonsense', isProduction: false })).toBe(
      'unconfigured',
    );
  });
});

const LIVE_ENV: PortalEnv = {
  apiBaseUrl: 'https://api.example.test',
  authModeSetting: 'live',
  isProduction: true,
  cognitoIssuer: 'https://cognito-idp.me-central-1.amazonaws.com/me-central-1_TestPool',
  cognitoClientId: 'client-abc123',
};

describe('createAuthRuntime live-mode composition (fail-closed)', () => {
  test('complete live configuration composes the LIVE runtime', () => {
    const runtime = createAuthRuntime(LIVE_ENV);
    expect(runtime.mode).toBe('live');
  });

  test('live mode with ANY missing configuration value fails CLOSED to the unconfigured runtime', () => {
    for (const gap of [
      { apiBaseUrl: null },
      { cognitoIssuer: null },
      { cognitoClientId: null },
      { cognitoIssuer: 'http://insecure.example.test/pool' },
    ] as const) {
      const runtime = createAuthRuntime({ ...LIVE_ENV, ...gap });
      expect(runtime.mode).toBe('unconfigured');
    }
  });

  test('live mode NEVER falls back to fixtures: no fixture controls are installed and every port fails closed without a backend', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('network unreachable'));
    try {
      const runtime = createAuthRuntime(LIVE_ENV);
      expect(window.__himmaPortalAccessFixture).toBeUndefined();
      // Authorized domain reads without a session resolve unavailable
      // without ever fetching; the PUBLIC taxonomy reads (live since
      // W2-12C1) reach the network and fail closed to unavailable when the
      // backend is unreachable — never to fixture data.
      await expect(runtime.profilePort.loadOrganizationView('any')).resolves.toEqual({
        kind: 'unavailable',
      });
      await expect(runtime.categoryPort.listCategories()).resolves.toEqual({
        kind: 'unavailable',
      });
      await expect(runtime.activityTypePort.listActivityTypes()).resolves.toEqual({
        kind: 'unavailable',
      });
      await expect(
        runtime.listingsPort.listListings('any', { limit: 10 }),
      ).resolves.toEqual({ kind: 'unavailable' });
      // The live lifecycle port (W2-12C3) is session-gated: without a
      // held session it resolves unavailable and never fetches.
      await expect(
        runtime.listingLifecyclePort.submitProgram('any', 'p', 1),
      ).resolves.toEqual({ kind: 'unavailable' });
      // Bulk import stays fail-closed unconfigured (a later task).
      await expect(runtime.bulkImportPort.dryRun('any', [])).resolves.toEqual({
        kind: 'unavailable',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('W2-12D composition lock: in the LIVE branch the ONLY unconfigured adapter is bulk import — every backend-capable port is live-wired', () => {
    const source = readFileSync(
      join(__dirname, '../src/app/auth-runtime.ts'),
      'utf8',
    );
    const liveBranch = source.slice(
      source.indexOf("if (mode === 'live')"),
      source.indexOf("if (mode === 'fixture')"),
    );
    expect(liveBranch.length).toBeGreaterThan(0);
    const unconfigured = liveBranch.match(/createUnconfigured\w+/g) ?? [];
    expect(unconfigured).toEqual(['createUnconfiguredBulkImportPort']);
  });

  test('W2-12D fetch discipline retained after the composition lock', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('network unreachable'));
    try {
      const runtime = createAuthRuntime(LIVE_ENV);
      await expect(runtime.areaPort.listAreas()).resolves.toEqual({ kind: 'unavailable' });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('the unconfigured runtime bootstrap stays fail-closed (no session can ever be granted)', async () => {
    const runtime = createAuthRuntime({ ...LIVE_ENV, cognitoClientId: null });
    await expect(runtime.adapter.bootstrap()).resolves.toEqual({ kind: 'unavailable' });
    await expect(
      runtime.adapter.signIn({ email: 'a@b.test', password: 'x' }),
    ).resolves.toEqual({ kind: 'failure' });
    await expect(runtime.accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
  });
});
