import { render, screen } from '@testing-library/react';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AppProviders } from '../src/app/app';
import { portalRoutes } from '../src/app/routes';

const portalRoot = join(__dirname, '..');

function grepSrc(pattern: string, extraArgs = ''): string {
  return execSync(`grep -rniE "${pattern}" src ${extraArgs} || true`, {
    cwd: portalRoot,
    encoding: 'utf8',
  }).trim();
}

/** Drops comment-only lines — prose may say "no JWT", code may not have one. */
function codeLines(grepOutput: string): string[] {
  return grepOutput
    .split('\n')
    .filter(Boolean)
    .filter((line) => !/^\S+:\d+:\s*(\*|\/\/|\/\*)/.test(line));
}

describe('fixture and token-handling safety (task §4, §16, §25)', () => {
  test('no JWT/bearer/token strings exist anywhere in portal source', () => {
    // Semantic outcomes only: no fake tokens, no bearer handling, no JWT
    // material anywhere in the frontend (the adapter owns all of it later).
    expect(grepSrc('eyJ[A-Za-z0-9]')).toBe('');
    expect(codeLines(grepSrc('jwt'))).toEqual([]);
    expect(codeLines(grepSrc('bearer'))).toEqual([]);
  });

  test('no web-storage or indexeddb auth persistence exists in portal source', () => {
    expect(grepSrc('localStorage|sessionStorage|indexedDB')).toBe('');
  });

  test('no password literal is stored anywhere except the one documented demo constant', () => {
    const stored = grepSrc("password\\s*[:=]\\s*[\\'\\\"]", '--include=*.ts --include=*.tsx');
    const offending = stored
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.includes('FIXTURE_PASSWORD ='));
    expect(offending).toEqual([]);
  });

  test('with no configured runtime the application fails CLOSED into the unavailable surface', async () => {
    // AppProviders' default is the unconfigured adapter pair — the exact
    // behavior a production build gets when auth is not configured.
    const router = createMemoryRouter(portalRoutes, { initialEntries: ['/'] });
    render(
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: "Sign-in isn't available yet" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  test('the unconfigured sign-in route is equally closed', async () => {
    const router = createMemoryRouter(portalRoutes, { initialEntries: ['/sign-in'] });
    render(
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: "Sign-in isn't available yet" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });
});
