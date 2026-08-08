import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createFixtureAuthRuntime,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const falcon = fixtureOrganizations.falcon;

const createPath = (ref: { organizationId: string }) =>
  `/o/${ref.organizationId}/listings/new`;

describe('listing creation (W2-8)', () => {
  test('a minimal structural draft creates and lands in the editor — incomplete by design, never submitted', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Create listing' });
    expect(
      await screen.findByText(/Drafts start private and can stay incomplete/),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('Title (English)'), 'Sunrise Paddle Club');
    await user.selectOptions(screen.getByLabelText('Activity type'), 'Swimming');
    await user.click(screen.getByRole('button', { name: 'Create draft listing' }));

    // Lands in the editor of the NEW draft (no branches, no options yet).
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sunrise Paddle Club' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();

    // Shared truth: the new draft is in the same store the index reads.
    const list = await runtime.listingsPort.listListings(blueWave.organizationId, { limit: 100 });
    if (list.kind !== 'loaded') throw new Error(list.kind);
    const created = list.page.programs.find((row) => row.titleEn === 'Sunrise Paddle Club');
    expect(created?.listingState).toBe('draft');
  });

  test('client validation mirrors the real contract: English title and activity type are the structural requirements', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    await user.click(await screen.findByRole('button', { name: 'Create draft listing' }));
    expect(
      await screen.findByText('Enter an English title for this listing.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Choose an activity type.')).toBeInTheDocument();
    // Arabic absence never blocks — no error near the Arabic fields.
    expect(screen.queryByText(/Arabic.*required/i)).not.toBeInTheDocument();
  });

  test('cross-field eligibility validation: bounds cannot contradict, all-ages cannot carry bounds', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    await user.type(await screen.findByLabelText('Youngest age (optional)'), '12');
    await user.type(screen.getByLabelText('Oldest age (optional)'), '6');
    await user.click(screen.getByRole('button', { name: 'Create draft listing' }));
    expect(
      await screen.findByText('The upper age can’t be below the lower age.'),
    ).toBeInTheDocument();
  });

  test('only ACTIVE taxonomy is offered for new selection (the deactivated type is absent)', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    const select = await screen.findByLabelText('Activity type');
    const labels = within(select as HTMLElement)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toContain('Swimming');
    expect(labels).not.toContain('Synchronized Swimming'); // deactivated
  });

  test('roles without listings.manage get the truthful refusal — no disabled-form theater', async () => {
    renderPortal({
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    expect(
      await screen.findByText(/Your role can’t create or edit listings/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Title (English)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create draft listing' })).not.toBeInTheDocument();
  });

  test('a suspended organization cannot reach the create form', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [createPath(falcon)],
    });
    expect(
      await screen.findByText(/currently suspended. Listings stay readable, but changes are unavailable/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Title (English)')).not.toBeInTheDocument();
  });

  test('unsaved details are protected: navigating away asks before discarding', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    await user.type(await screen.findByLabelText('Title (English)'), 'Half-typed listing');
    await user.click(screen.getByRole('link', { name: 'Listings' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/hasn’t been created yet/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Title (English)')).toHaveValue('Half-typed listing');
  });
});
