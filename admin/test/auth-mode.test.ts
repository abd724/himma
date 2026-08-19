import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAuthMode } from '../src/auth/auth-mode';
import { createAuthRuntime } from '../src/app/auth-runtime';
import type { AdminEnv } from '../src/api/env';

/** Test double of the env boundary (env.ts itself uses import.meta, which
 *  the CJS test transform cannot parse — same convention as the portal). */
function envOf(raw: Record<string, string | undefined>, isProduction: boolean): AdminEnv {
  const trimmed = (value: string | undefined) => {
    const v = value?.trim();
    return v ? v : null;
  };
  return {
    apiBaseUrl: trimmed(raw['VITE_API_BASE_URL']),
    authModeSetting: raw['VITE_ADMIN_AUTH_MODE'],
    isProduction,
    cognitoIssuer: trimmed(raw['VITE_COGNITO_ISSUER']),
    cognitoClientId: trimmed(raw['VITE_COGNITO_CLIENT_ID']),
  };
}

/**
 * W3-1 composition security (task §13/§29): production fail-closed mode
 * resolution, the live-never-fixtures rule, unconfigured-cannot-become-
 * admin, the live access port's own security behavior, and the structural
 * storage/fixture-isolation sweeps.
 */

const LIVE_ENV: AdminEnv = {
  apiBaseUrl: 'https://api.himma.test',
  authModeSetting: 'live',
  isProduction: true,
  cognitoIssuer: 'https://cognito-idp.me-south-1.amazonaws.com/me-south-1_test',
  cognitoClientId: 'client-123',
};

describe('mode resolution (fail-closed)', () => {
  test('development defaults to fixture; production defaults to UNCONFIGURED', () => {
    expect(resolveAuthMode({ configuredMode: undefined, isProduction: false })).toBe('fixture');
    expect(resolveAuthMode({ configuredMode: undefined, isProduction: true })).toBe('unconfigured');
    expect(resolveAuthMode({ configuredMode: 'anything-else', isProduction: true })).toBe(
      'unconfigured',
    );
  });

  test('the env boundary reads the ADMIN mode variable', () => {
    const env = envOf({ VITE_ADMIN_AUTH_MODE: 'live' }, true);
    expect(env.authModeSetting).toBe('live');
    // The provider portal's variable grants nothing here.
    expect(envOf({ VITE_PORTAL_AUTH_MODE: 'fixture' }, true).authModeSetting).toBeUndefined();
  });

  test('live with ANY missing/invalid config value fails the whole composition closed', async () => {
    const gaps: Partial<AdminEnv>[] = [
      { apiBaseUrl: null },
      { cognitoIssuer: null },
      { cognitoClientId: null },
      { cognitoIssuer: 'http://insecure.example' },
    ];
    for (const gap of gaps) {
      const runtime = createAuthRuntime({ ...LIVE_ENV, ...gap });
      expect(runtime.mode).toBe('unconfigured');
      await expect(runtime.adapter.bootstrap()).resolves.toEqual({ kind: 'unavailable' });
      await expect(runtime.accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
    }
  });

  test('an unconfigured production runtime can never become a fake administrator', async () => {
    const runtime = createAuthRuntime(
      envOf({}, true), // production, nothing configured
    );
    expect(runtime.mode).toBe('unconfigured');
    await expect(
      runtime.adapter.signIn({ email: 'ops@himma.demo', password: 'admin-demo' }),
    ).resolves.toEqual({ kind: 'failure' });
    await expect(runtime.accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
    // The W3-2 provider directory is equally fail-closed — no fixture data.
    await expect(runtime.providersPort.listOrganizations({ limit: 10 })).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(runtime.providersPort.getOrganization('any')).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(window.__himmaAdminAccessFixture).toBeUndefined();
  });

  test('live mode NEVER falls back to fixtures: no fixture controls installed; an API failure resolves unavailable', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('network unreachable'));
    try {
      const runtime = createAuthRuntime(LIVE_ENV);
      expect(runtime.mode).toBe('live');
      expect(window.__himmaAdminAccessFixture).toBeUndefined();
      // No session held → no fetch, unavailable — never fixture access.
      await expect(runtime.accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('structural sweeps (task §13/§29)', () => {
  const src = (relative: string) =>
    readFileSync(join(__dirname, '..', 'src', relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('the live auth + provider-read modules are structurally isolated from fixture code', () => {
    for (const module of [
      'auth/live/live-auth-runtime.ts',
      'auth/live/cognito-api.ts',
      'api/client.ts',
      'services/live/live-providers-port.ts',
      'services/live/live-verification-port.ts',
    ]) {
      expect(src(module)).not.toMatch(/services\/mock|fixture/i);
    }
  });

  test('the composition lock: only the fixture branch touches fixture code, and it installs controls only there', () => {
    const composition = readFileSync(join(__dirname, '..', 'src', 'app', 'auth-runtime.ts'), 'utf8');
    const liveBranch = composition.slice(
      composition.indexOf("if (mode === 'live')"),
      composition.indexOf("if (mode === 'fixture')"),
    );
    expect(liveBranch.length).toBeGreaterThan(0);
    expect(liveBranch).not.toMatch(/fixture/i);
  });

  test('no browser-readable token storage exists anywhere in the admin source', () => {
    const roots = [
      'auth',
      'api',
      'app',
      'services',
      'access',
      'shell',
      'pages',
      'providers',
      'verification',
      'hooks',
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry)) {
          files.push(full);
        }
      }
    };
    for (const root of roots) {
      walk(join(__dirname, '..', 'src', root));
    }
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });
});
