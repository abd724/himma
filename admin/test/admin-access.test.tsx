import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createFixtureAdminRuntime,
  FIXTURE_PASSWORD,
  FIXTURE_TOTP,
  fixtureCapabilities,
} from '../src/services/mock/fixture-admin';
import { renderAdmin } from './support/render-admin';

/**
 * W3-1 access flows over the deterministic fixture runtime: sign-in → MFA
 * → capability-aware shell; the denial matrix (task §8/§29); the W3-1
 * final baseline/step-up separation (ordinary bootstrap NEVER invokes
 * step-up; the D-W3-5 action-level seam stays exercisable); and the
 * revoked-role exit (task §19).
 */

describe('sign-in and MFA (task §14)', () => {
  test('an operations admin signs in, answers the TOTP challenge, and reaches the capability-aware shell', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByRole('heading', { name: 'Staff sign in' });

    await user.type(screen.getByLabelText('Work email'), 'ops@himma.demo');
    await user.type(screen.getByLabelText('Password'), FIXTURE_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByRole('heading', { name: 'Verify it’s you' });
    await user.type(screen.getByLabelText('Verification code'), FIXTURE_TOTP);
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await screen.findByRole('heading', { name: 'Welcome, Layla Operations' });
    const nav = screen.getByRole('navigation', { name: 'Admin navigation' });
    for (const label of [
      'Dashboard',
      'Providers',
      'Verification',
      'Catalogue moderation',
      'Revision moderation',
      'Taxonomy',
    ]) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    // Operations does NOT see role administration or audit.
    expect(within(nav).queryByRole('link', { name: 'Access administration' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Audit' })).toBeNull();
  });

  test('wrong credentials and wrong codes stay account-enumeration-safe (one class each), and a wrong code can be corrected', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByRole('heading', { name: 'Staff sign in' });

    // Unknown email and wrong password produce the SAME single message.
    await user.type(screen.getByLabelText('Work email'), 'ghost@himma.demo');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const failure = await screen.findByRole('alert');
    expect(failure.textContent).toMatch(/didn’t work/);

    await user.clear(screen.getByLabelText('Work email'));
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Work email'), 'ops@himma.demo');
    await user.type(screen.getByLabelText('Password'), FIXTURE_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Verify it’s you' });

    await user.type(screen.getByLabelText('Verification code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/wasn’t accepted/);

    await user.clear(screen.getByLabelText('Verification code'));
    await user.type(screen.getByLabelText('Verification code'), FIXTURE_TOTP);
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await screen.findByRole('heading', { name: /Welcome, Layla Operations/ });
  });
});

describe('bootstrap denial and access truth (task §8/§19)', () => {
  test('an authenticated identity with NO admin role lands on the truthful no-access screen — never the shell', async () => {
    renderAdmin({ asIdentity: 'none@himma.demo' });
    await screen.findByRole('heading', { name: 'This console is for Himma staff' });
    expect(screen.queryByRole('navigation', { name: 'Admin navigation' })).toBeNull();
  });

  test('revoking the final admin role removes access on the authoritative refresh — no stale admin shell', async () => {
    const runtime = createFixtureAdminRuntime();
    renderAdmin({ runtime, asIdentity: 'audit@himma.demo' });
    await screen.findByRole('heading', { name: 'Welcome, Aisha Audit' });
    runtime.controls.revokeAllRoles('audit@himma.demo');
    await screen.findByRole('heading', { name: 'This console is for Himma staff' });
    expect(screen.queryByRole('navigation', { name: 'Admin navigation' })).toBeNull();
  });

  test('session expiry exits the protected shell to the signed-out surface', async () => {
    const runtime = createFixtureAdminRuntime();
    renderAdmin({ runtime, asIdentity: 'ops@himma.demo' });
    await screen.findByRole('heading', { name: 'Welcome, Layla Operations' });
    runtime.controls.expireSession();
    await screen.findByRole('heading', { name: 'Staff sign in' });
    expect(screen.getByText('Your session ended. Sign in again to continue.')).toBeInTheDocument();
  });

  test('W3-1 final: a STALE recent factor no longer gates ordinary shell access — the MFA-assured admin bootstraps straight to the shell, no step-up screen (owner decision §5–§8)', async () => {
    // Seeded session = the hard-reload continuity shape: an established
    // MFA-assured session whose factor window has aged.
    renderAdmin({ asIdentity: 'stale@himma.demo' });
    await screen.findByRole('heading', { name: 'Welcome, Stefan Stale' });
    // Ordinary bootstrap never invoked the step-up surface.
    expect(screen.queryByRole('heading', { name: 'Confirm your identity' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Admin navigation' })).toBeInTheDocument();
  });

  test('the D-W3-5 step-up SEAM remains: an action-level demand resolves the dedicated screen and a fresh code re-resolves access — never a bypass (§10/§12.12)', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('ops@himma.demo');
    // Model a FUTURE high-risk operation answering step-up-required.
    runtime.controls.demandStepUp();
    renderAdmin({ runtime });
    await screen.findByRole('heading', { name: 'Confirm your identity' });
    expect(screen.queryByRole('navigation', { name: 'Admin navigation' })).toBeNull();

    await user.type(screen.getByLabelText('Verification code'), FIXTURE_TOTP);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('heading', { name: 'Welcome, Layla Operations' });
  });

  test('a transient access failure is retryable without losing the session', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('ops@himma.demo');
    runtime.controls.failNextAccessResolve();
    renderAdmin({ runtime });
    await screen.findByRole('heading', { name: 'We couldn’t check your access' });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Welcome, Layla Operations' });
  });
});

describe('capability-aware navigation and guards (task §16–§18, §30)', () => {
  test('an auditor sees ONLY read areas and is truthfully refused inside a gated operations area', async () => {
    renderAdmin({ asIdentity: 'audit@himma.demo', initialEntries: ['/providers'] });
    await screen.findByRole('heading', { name: 'This area isn’t part of your role' });
    const nav = screen.getByRole('navigation', { name: 'Admin navigation' });
    expect(within(nav).getByRole('link', { name: 'Access administration' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Audit' })).toBeInTheDocument();
    for (const hidden of ['Providers', 'Verification', 'Catalogue moderation', 'Taxonomy']) {
      expect(within(nav).queryByRole('link', { name: hidden })).toBeNull();
    }
  });

  test('a multi-role admin (operations + access_admin) sees the deduplicated union', async () => {
    renderAdmin({ asIdentity: 'duo@himma.demo' });
    await screen.findByRole('heading', { name: 'Welcome, Dana Duo' });
    const nav = screen.getByRole('navigation', { name: 'Admin navigation' });
    for (const label of ['Providers', 'Taxonomy', 'Access administration']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    // roles.view ≠ audit.read — Audit stays hidden without the auditor role.
    expect(within(nav).queryByRole('link', { name: 'Audit' })).toBeNull();
  });

  test('a support admin is valid with truthfully EMPTY W3-phase tools — nothing fabricated', async () => {
    renderAdmin({ asIdentity: 'support@himma.demo' });
    await screen.findByRole('heading', { name: 'Welcome, Samir Support' });
    await screen.findByRole('heading', { name: 'No operational areas yet' });
    const nav = screen.getByRole('navigation', { name: 'Admin navigation' });
    expect(within(nav).getAllByRole('link')).toHaveLength(1); // Dashboard only
  });

  test('placeholders are truthful: a future area names its W3 slice and shows no fake operational data', async () => {
    renderAdmin({ asIdentity: 'access@himma.demo', initialEntries: ['/access'] });
    await screen.findByRole('heading', { name: 'Access administration' });
    expect(screen.getByText(/Connected in W3-9/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b\d+ (cases|providers|pending|queue)\b/i);
  });

  test('the Verification nav area is live (W3-5): it lands on the provider review queue', async () => {
    renderAdmin({ asIdentity: 'ops@himma.demo', initialEntries: ['/verification'] });
    // The redirect lands on the queue view of the directory.
    await screen.findByRole('button', { name: 'Review queue' });
    expect(
      (await screen.findByRole('button', { name: 'Review queue' })).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  test('the fixture capability projection mirrors the backend module exactly', () => {
    expect(fixtureCapabilities(['operations'])).toEqual([
      'providers.operate',
      'catalogue.moderate',
      'taxonomy.manage',
    ]);
    expect(fixtureCapabilities(['access_admin'])).toEqual(['roles.administer', 'roles.view']);
    expect(fixtureCapabilities(['auditor'])).toEqual(['roles.view', 'audit.read']);
    expect(fixtureCapabilities(['support'])).toEqual([]);
    expect(fixtureCapabilities(['finance'])).toEqual([]);
    expect(fixtureCapabilities(['operations', 'access_admin'])).toEqual([
      'providers.operate',
      'catalogue.moderate',
      'taxonomy.manage',
      'roles.administer',
      'roles.view',
    ]);
  });

  test('sign out from the shell lands on the signed-out surface', async () => {
    const user = userEvent.setup();
    renderAdmin({ asIdentity: 'ops@himma.demo' });
    await screen.findByRole('heading', { name: 'Welcome, Layla Operations' });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Staff sign in' })).toBeInTheDocument(),
    );
    expect(screen.getByText('You’re signed out.')).toBeInTheDocument();
  });
});
