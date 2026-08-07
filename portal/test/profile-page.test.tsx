import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UpdateProfileOutcome } from '../src/profile/contract';
import {
  createFixtureAuthRuntime,
  FIXTURE_INVITATIONS,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const profilePath = (ref: { organizationId: string }) => `/o/${ref.organizationId}/profile`;

async function openStorefrontTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Public storefront' }));
}

async function openPublicationTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Publication' }));
}

describe('business profile page (W2-4)', () => {
  test('an Owner gets the full edit experience with public/private separation', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });

    // Business tab: the PRIVATE record, read-only — no inputs, marked private.
    const businessPanel = await screen.findByRole('tabpanel', { name: 'Business information' });
    expect(within(businessPanel).getByText('Blue Wave Swimming LLC')).toBeInTheDocument();
    expect(within(businessPanel).getAllByText('Private').length).toBeGreaterThanOrEqual(2);
    expect(within(businessPanel).getByText('Live on Himma')).toBeInTheDocument();
    expect(businessPanel.querySelector('input, textarea, select')).toBeNull();

    // Storefront tab: the editable PUBLIC projection.
    await openStorefrontTab(user);
    expect(screen.getByLabelText('Display name')).toHaveValue('Blue Wave Swimming');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();

    // Media boundary is honest: no upload workflow of any kind (task §16).
    const page = screen.getByRole('tabpanel', { name: 'Public storefront' });
    expect(page.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
    expect(screen.getByText(/later production milestone/)).toBeInTheDocument();

    // No later-task workflow leaked in: no branch/team/listing management.
    expect(screen.queryByRole('button', { name: /add branch|new branch/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /listing/i })).not.toBeInTheDocument();
  });

  test('an Organization Manager can edit; the commercial seat stays owner-only', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  test('a coach gets a truthful read-only storefront with no mutation affordances', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'assistant@coral.demo',
      initialEntries: [profilePath(fixtureOrganizations.coral)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });

    // The coach cannot see the legal name (no org.legal.view).
    const businessPanel = await screen.findByRole('tabpanel', { name: 'Business information' });
    expect(within(businessPanel).queryByText(/LLC/)).not.toBeInTheDocument();

    await openStorefrontTab(user);
    const storefront = screen.getByRole('tabpanel', { name: 'Public storefront' });
    expect(storefront.querySelector('input, textarea, select')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/an owner or organization manager makes these changes/i),
    ).toBeInTheDocument();

    await openPublicationTab(user);
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    expect(
      screen.getByText('An owner or organization manager changes storefront publication.'),
    ).toBeInTheDocument();
  });

  test('the preview renders only the public projection — never private fields, never fabricated signals', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);

    const preview = screen.getByRole('region', { name: 'Storefront preview' });
    // Private organization identity never leaks into the customer preview.
    expect(within(preview).queryByText(/LLC/)).not.toBeInTheDocument();
    // Live org → the derived verified indicator is legitimate.
    expect(within(preview).getByText('Verified')).toBeInTheDocument();
    // No fake ratings, reviews, listing counts, opening hours, or booking.
    expect(preview.textContent).not.toMatch(/\b(ratings?|reviews?)\b|★/i);
    expect(preview.textContent).not.toMatch(/\d+\s*(listings?|programs?)/i);
    expect(preview.textContent).not.toMatch(/\b(open|opening|hours|closed)\b/i);
    expect(preview.textContent).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    expect(within(preview).queryByRole('button')).not.toBeInTheDocument();
  });

  test('editing a public field updates the preview live; saving persists and resets dirty state', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toHaveAttribute('aria-disabled', 'true'); // pristine

    const displayName = screen.getByLabelText('Display name');
    await user.clear(displayName);
    await user.type(displayName, 'Blue Wave Swim School');

    const preview = screen.getByRole('region', { name: 'Storefront preview' });
    expect(within(preview).getByText('Blue Wave Swim School')).toBeInTheDocument();
    expect(save).not.toHaveAttribute('aria-disabled'); // dirty

    await user.click(save);
    expect(await screen.findByText(/Saved — your storefront is up to date\./)).toBeInTheDocument();
    // A live organization is NOT sent back to onboarding.
    expect(screen.queryByRole('link', { name: 'Back to Getting started' })).not.toBeInTheDocument();
    await waitFor(() => expect(save).toHaveAttribute('aria-disabled', 'true'));

    // Persisted in the one fixture store.
    const stored = await view.fixture.profilePort.loadOrganizationView(
      fixtureOrganizations.blueWave.organizationId,
    );
    expect(stored.kind === 'loaded' && stored.view.profile.displayName).toBe(
      'Blue Wave Swim School',
    );
  });

  test('required display name blocks saving with clear copy; empty Arabic never blocks', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);

    const spy = jest.spyOn(view.fixture.profilePort, 'updateProfile');
    const displayName = screen.getByLabelText('Display name');
    await user.clear(displayName);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter the name customers will see.')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();

    // Fix the name; Arabic stays empty — saving succeeds (English-only launch).
    await user.type(displayName, 'Blue Wave Swimming');
    expect(screen.getByLabelText('About your business (Arabic) — optional')).toHaveValue('');
    await user.type(screen.getByLabelText('Public phone'), '9');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Saved — your storefront is up to date\./)).toBeInTheDocument();
  });

  test('duplicate submission fires exactly one port call', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);

    const gate: { release: (() => void) | null } = { release: null };
    const original = view.fixture.profilePort.updateProfile.bind(view.fixture.profilePort);
    const spy = jest
      .spyOn(view.fixture.profilePort, 'updateProfile')
      .mockImplementation(
        (...args) =>
          new Promise<UpdateProfileOutcome>((resolve) => {
            gate.release = () => void original(...args).then(resolve);
          }),
      );

    await user.type(screen.getByLabelText('Public phone'), '9');
    const save = screen.getByRole('button', { name: 'Save changes' });
    await user.click(save);
    // Second activation while saving is inert.
    await user.click(screen.getByRole('button', { name: 'Saving…' }));
    expect(spy).toHaveBeenCalledTimes(1);

    gate.release?.();
    expect(await screen.findByText(/Saved — your storefront is up to date\./)).toBeInTheDocument();
  });

  test('a stale save never overwrites: conflict copy, then reload keeps this editor’s edits', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);

    const displayName = screen.getByLabelText('Display name');
    await user.clear(displayName);
    await user.type(displayName, 'My Draft Name');

    // Another staff member saves first.
    view.fixture.controls.simulateConcurrentProfileEdit(
      fixtureOrganizations.blueWave.organizationId,
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText(/Someone else updated the storefront while you were editing/),
    ).toBeInTheDocument();
    // The store was NOT silently overwritten.
    const stored = await view.fixture.profilePort.loadOrganizationView(
      fixtureOrganizations.blueWave.organizationId,
    );
    expect(stored.kind === 'loaded' && stored.view.profile.displayName).toBe('Blue Wave Swimming');

    // Reload-and-reapply: latest base loads, this editor's edits are kept.
    await user.click(screen.getByRole('button', { name: 'Load the latest profile' }));
    expect(
      await screen.findByText(/latest profile is loaded and your edits are kept/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toHaveValue('My Draft Name');

    // Saving now succeeds against the fresh version.
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Saved — your storefront is up to date\./)).toBeInTheDocument();
    const after = await view.fixture.profilePort.loadOrganizationView(
      fixtureOrganizations.blueWave.organizationId,
    );
    expect(after.kind === 'loaded' && after.view.profile.displayName).toBe('My Draft Name');
  });

  test('a suspended organization renders read-only with no mutation controls', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [profilePath(fixtureOrganizations.falcon)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);

    const storefront = screen.getByRole('tabpanel', { name: 'Public storefront' });
    expect(storefront.querySelector('input, textarea, select')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(
      within(storefront).getByText(
        'This organization is currently suspended. Changes are unavailable.',
      ),
    ).toBeInTheDocument();

    await openPublicationTab(user);
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
  });

  test('a failed load renders the retryable error state and recovers', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.controls.failNextProfileLoad(fixtureOrganizations.blueWave.organizationId);
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    expect(
      await screen.findByText(/couldn’t load your business profile/),
    ).toBeInTheDocument();
    expect(document.querySelector('input, textarea')).toBeNull(); // no fake data

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('tab', { name: 'Public storefront' })).toBeInTheDocument();
  });

  test('a failed save keeps the edits and explains, then a retry succeeds', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);

    view.fixture.controls.failNextProfileSave(fixtureOrganizations.blueWave.organizationId);
    await user.type(screen.getByLabelText('Instagram'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(/couldn’t save your changes right now — your edits are still here/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Instagram')).toHaveValue('@bluewaveswimx');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Saved — your storefront is up to date\./)).toBeInTheDocument();
  });

  test('navigating away with unsaved edits warns; discard proceeds, keep editing stays', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);
    await user.type(screen.getByLabelText('Public phone'), '9');

    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Public phone')).toBeInTheDocument(); // still here

    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    const dialogAgain = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dialogAgain).getByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  test('switching organization with unsaved edits warns first', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);
    await user.type(screen.getByLabelText('Public phone'), '9');

    await user.click(screen.getByRole('button', { name: /Blue Wave Swimming/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Noor Learning Centre/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard changes' }));
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    expect(screen.getAllByText('Noor Learning Centre').length).toBeGreaterThan(0);
  });

  test('clean navigation never warns', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openStorefrontTab(user);

    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  test('completing the profile feeds onboarding readiness without touching verification or live', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('newowner@coral.demo');
    await runtime.invitationPort.accept(FIXTURE_INVITATIONS.foundingOwner);
    renderPortal({
      runtime,
      asIdentity: 'newowner@coral.demo',
      initialEntries: [profilePath(fixtureOrganizations.coral)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });

    // The incomplete draft: empty display name, still "Setting up".
    const businessPanel = await screen.findByRole('tabpanel', { name: 'Business information' });
    expect(within(businessPanel).getByText('Setting up')).toBeInTheDocument();

    await openStorefrontTab(user);
    const preview = screen.getByRole('region', { name: 'Storefront preview' });
    expect(within(preview).getByText('Add your display name')).toBeInTheDocument();
    // A non-live org never previews a verified badge.
    expect(within(preview).queryByText('Verified')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Display name'), 'Coral Kids Climbing');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Saved — your storefront is up to date\./)).toBeInTheDocument();

    // Still-onboarding orgs get the path back to the hub; it navigates clean.
    await user.click(screen.getByRole('link', { name: 'Back to Getting started' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await screen.findByRole('heading', { level: 1, name: 'Getting started' });

    // The shared canonical store: profile requirement now reads Done, but
    // verification/lifecycle is untouched (completion ≠ verification ≠ live).
    const profileRowHeading = screen.getByText('Business profile', { selector: 'p *, p' });
    const row = profileRowHeading.closest('li');
    expect(row && within(row).getByText('Done')).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Set up your workspace' }),
    ).toBeInTheDocument();
  });

  test('publication truth: published storefront on a non-live organization is not visible', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [profilePath(fixtureOrganizations.pearl)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openPublicationTab(user);

    const panel = screen.getByRole('tabpanel', { name: 'Publication' });
    expect(within(panel).getByText('Published')).toBeInTheDocument();
    expect(within(panel).getByText('Not live yet')).toBeInTheDocument();
    expect(within(panel).getByText('Not visible')).toBeInTheDocument();
    expect(
      within(panel).getByText(/appears to customers once Himma takes your organization live/),
    ).toBeInTheDocument();
    // No go-live control exists for providers, ever.
    expect(within(panel).queryByRole('button', { name: /go live/i })).not.toBeInTheDocument();

    // Unpublishing a NON-live storefront needs no confirmation (nothing is
    // publicly visible), acts immediately, and never touches the lifecycle.
    await user.click(within(panel).getByRole('button', { name: 'Unpublish storefront' }));
    expect(await within(panel).findByText('Not published')).toBeInTheDocument();
    expect(within(panel).getByText('Not live yet')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Publish storefront' }));
    expect(
      await within(panel).findByText(
        'Storefront published — it appears to customers once Himma takes your organization live.',
      ),
    ).toBeInTheDocument();
  });

  test('unpublishing a LIVE storefront asks for confirmation first', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await openPublicationTab(user);

    const panel = screen.getByRole('tabpanel', { name: 'Publication' });
    expect(within(panel).getByText('Visible')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Unpublish storefront' }));

    const dialog = await screen.findByRole('dialog', { name: 'Unpublish your storefront?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep it published' }));
    let stored = await view.fixture.profilePort.loadOrganizationView(
      fixtureOrganizations.blueWave.organizationId,
    );
    expect(stored.kind === 'loaded' && stored.view.profile.published).toBe(true);

    await user.click(within(panel).getByRole('button', { name: 'Unpublish storefront' }));
    const dialogAgain = await screen.findByRole('dialog', { name: 'Unpublish your storefront?' });
    await user.click(within(dialogAgain).getByRole('button', { name: 'Unpublish' }));
    expect(
      await within(panel).findByText(/customers can no longer see it/i),
    ).toBeInTheDocument();
    stored = await view.fixture.profilePort.loadOrganizationView(
      fixtureOrganizations.blueWave.organizationId,
    );
    expect(stored.kind === 'loaded' && stored.view.profile.published).toBe(false);
    // The lifecycle is untouched: the organization is still live.
    expect(stored.kind === 'loaded' && stored.view.organization.verificationState).toBe('live');
  });
});
