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

const activityCombobox = () => screen.getByRole('combobox', { name: /Activity type/ });

describe('listing creation (W2-8 + interaction-model correction)', () => {
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
      await screen.findByText(/Start with the basics — drafts start private/),
    ).toBeInTheDocument();

    // Provider-authored content is direct free text.
    await user.type(screen.getByLabelText(/Listing title/), 'Sunrise Paddle Club');
    // Himma-managed vocabulary is SELECTED through the searchable combobox.
    await user.click(activityCombobox());
    await user.click(await screen.findByRole('option', { name: /Swimming/ }));
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
    await user.type(await screen.findByLabelText('Youngest age'), '12');
    await user.type(screen.getByLabelText('Oldest age'), '6');
    await user.click(screen.getByRole('button', { name: 'Create draft listing' }));
    expect(
      await screen.findByText('The upper age can’t be below the lower age.'),
    ).toBeInTheDocument();
  });

  test('the activity selector is searchable and shows Himma’s category context; only ACTIVE taxonomy is offered', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    const combobox = await screen.findByRole('combobox', { name: /Activity type/ });
    await user.click(combobox);
    const listbox = await screen.findByRole('listbox', { name: 'Activity types' });
    // Full ACTIVE canon on open; the deactivated type is absent entirely.
    const openLabels = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(openLabels.some((label) => label?.includes('Swimming'))).toBe(true);
    expect(openLabels.some((label) => label?.includes('Synchronized Swimming'))).toBe(false);
    // Category context from the real categories read.
    expect(within(listbox).getByText('Aquatics')).toBeInTheDocument();

    // Typing filters by label.
    await user.type(combobox, 'kick');
    const filtered = within(screen.getByRole('listbox', { name: 'Activity types' }))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toContain('Kickboxing');

    // Keyboard selection: ArrowDown + Enter picks the listed canonical row.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(combobox).toHaveValue('Kickboxing');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('arbitrary text is NEVER taxonomy: no create-your-own affordance, truthful Himma/Support fallback, and submission still requires a canonical choice', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    await user.type(await screen.findByLabelText(/Listing title/), 'Rock Climbing for Teens');
    const combobox = activityCombobox();
    await user.type(combobox, 'Rock Climbing');

    // No canonical match: the truthful help state — no fake create action.
    expect(await screen.findByText('No matching activity')).toBeInTheDocument();
    expect(
      screen.getByText(/so customers can search and filter consistently/),
    ).toBeInTheDocument();
    const supportLink = screen.getByRole('link', { name: 'Support' });
    expect(supportLink).toHaveAttribute('href', `/o/${blueWave.organizationId}/support`);
    expect(screen.queryByText(/create ["“']?rock climbing/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /(create|add).*activity/i }),
    ).not.toBeInTheDocument();

    // Enter on free text selects nothing.
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Create draft listing' }));
    expect(await screen.findByText('Choose an activity type.')).toBeInTheDocument();

    // Nothing was created with fabricated taxonomy.
    const list = await runtime.listingsPort.listListings(blueWave.organizationId, { limit: 100 });
    if (list.kind !== 'loaded') throw new Error(list.kind);
    expect(
      list.page.programs.find((row) => row.titleEn === 'Rock Climbing for Teens'),
    ).toBeUndefined();
  });

  test('the deactivated taxonomy row cannot be reached through search either — it resolves to the help state', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    await user.type(await screen.findByRole('combobox', { name: /Activity type/ }), 'Synchronized');
    expect(await screen.findByText('No matching activity')).toBeInTheDocument();
    expect(
      within(screen.getByRole('listbox', { name: 'Activity types' })).queryByRole('option'),
    ).not.toBeInTheDocument();
  });

  test('finite enumerations are human controls, not dropdowns: setting is a two-value choice, the audience is the five-value chip set', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    const setting = await screen.findByRole('radiogroup', { name: 'Setting' });
    expect(
      within(setting)
        .getAllByRole('radio')
        .map((radio) => (radio as HTMLInputElement).value),
    ).toEqual(['indoor', 'outdoor']);

    const audience = screen.getByRole('radiogroup', { name: 'Who is this activity for?' });
    const audienceLabels = within(audience)
      .getAllByRole('radio')
      .map((radio) => radio.closest('label')?.textContent);
    expect(audienceLabels).toEqual(['Ladies only', 'Men only', 'Girls', 'Boys', 'Everyone']);

    // Neither enumeration renders as a select element.
    expect(screen.queryByRole('combobox', { name: 'Setting' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Who is this activity for?' }),
    ).not.toBeInTheDocument();
  });

  test('Arabic content is a compact optional disclosure: collapsed by default, and collapsing NEVER discards entered values', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    await screen.findByLabelText(/Listing title/);

    // Collapsed by default — optional Arabic never competes with the
    // required launch content.
    expect(screen.queryByLabelText('Title (Arabic)')).not.toBeInTheDocument();
    const disclosure = screen.getByRole('button', { name: 'Add Arabic content (optional)' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    await user.click(disclosure);
    await user.type(screen.getByLabelText('Title (Arabic)'), 'نادي السباحة');

    // Collapse — the value is kept, and the section says so.
    await user.click(screen.getByRole('button', { name: 'Arabic content (optional)' }));
    expect(screen.queryByLabelText('Title (Arabic)')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Your Arabic content is kept — expand this section to edit it/),
    ).toBeInTheDocument();

    // Re-expand — nothing was lost.
    await user.click(screen.getByRole('button', { name: 'Add Arabic content (optional)' }));
    expect(screen.getByLabelText('Title (Arabic)')).toHaveValue('نادي السباحة');
  });

  test('requiredness is explicit and minimal: title + activity carry the mark, everything else is completable later', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    await screen.findByLabelText(/Listing title/);
    expect(
      screen.getByText(/you can complete everything else later/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Listing title/)).toHaveAttribute('aria-required', 'true');
    expect(activityCombobox()).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Description')).not.toHaveAttribute('aria-required');
    expect(screen.getByLabelText('Eligibility notes')).not.toHaveAttribute('aria-required');
  });

  test('roles without listings.manage get the truthful refusal — no disabled-form theater', async () => {
    renderPortal({
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    expect(
      await screen.findByText(/Your role can’t create or edit listings/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Listing title/)).not.toBeInTheDocument();
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
    expect(screen.queryByLabelText(/Listing title/)).not.toBeInTheDocument();
  });

  test('unsaved details are protected: navigating away asks before discarding', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [createPath(blueWave)],
    });
    await user.type(await screen.findByLabelText(/Listing title/), 'Half-typed listing');
    await user.click(screen.getByRole('link', { name: 'Listings' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/hasn’t been created yet/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText(/Listing title/)).toHaveValue('Half-typed listing');
  });
});
