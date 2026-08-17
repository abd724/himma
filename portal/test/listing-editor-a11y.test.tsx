import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import {
  createFixtureAuthRuntime,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;

const editPath = (programId: string) =>
  `/o/${blueWave.organizationId}/listings/${programId}/edit`;

describe('listing editor accessibility (jest-axe, W2-8)', () => {
  test('create form', async () => {
    const page = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings/new`],
    });
    await screen.findByLabelText(/Listing title/);
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('create form with the activity combobox open (results and no-results states) and the Arabic disclosure expanded', async () => {
    const user = userEvent.setup();
    const page = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings/new`],
    });
    const combobox = await screen.findByRole('combobox', { name: /Activity type/ });
    await user.click(combobox);
    await screen.findByRole('listbox', { name: 'Activity types' });
    expect(await axe(page.container)).toHaveNoViolations();

    await user.type(combobox, 'zzz-no-such-activity');
    await screen.findByText('No matching activity');
    expect(await axe(page.container)).toHaveNoViolations();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Add Arabic content (optional)' }));
    await screen.findByLabelText('Title (Arabic)');
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('standard draft editor (details, locations, pricing, media, offers, readiness)', async () => {
    const page = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('price-option inline form open', async () => {
    const user = userEvent.setup();
    const page = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    await user.click(screen.getByRole('button', { name: 'Add price option' }));
    await screen.findByLabelText('Price (AED)');
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('offer inline form open', async () => {
    const user = userEvent.setup();
    const page = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    await user.click(screen.getByRole('button', { name: 'Add offer' }));
    await screen.findByLabelText('Label');
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('archive confirmation dialog', async () => {
    const user = userEvent.setup();
    const page = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });
    const pricing = screen.getByRole('heading', { name: 'Pricing options' }).closest('section')!;
    await user.click(within(pricing).getAllByRole('button', { name: /Archive/ })[0]!);
    await screen.findByRole('dialog');
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('review-gated editor with protected-field marking and pending-revision block', async () => {
    const gated = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Private Swim Coaching' });
    expect(await axe(gated.container)).toHaveNoViolations();
    gated.unmount();

    const pending = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.juniorSquad)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Junior Swim Squad' });
    expect(await axe(pending.container)).toHaveNoViolations();
  });

  test('stale-conflict surface', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    const page = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    const title = screen.getByLabelText(/Listing title/);
    await user.clear(title);
    await user.type(title, 'Conflicted title');
    runtime.controls.simulateConcurrentListingEdit(
      blueWave.organizationId,
      fixtureListings.holidayCamp,
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/Someone else saved this listing while you were editing/);
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('read-only editor states: submitted/in-review lock, archived freeze, out-of-scope surface', async () => {
    const submitted = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.schoolTerm)],
    });
    await screen.findByRole('heading', { level: 1, name: 'School Term Program' });
    expect(await axe(submitted.container)).toHaveNoViolations();
    submitted.unmount();

    const archived = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.sunsetOpenWater)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Sunset Open Water Program' });
    expect(await axe(archived.container)).toHaveNoViolations();
    archived.unmount();

    const outOfScope = renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [editPath(fixtureListings.adultSwimming)],
    });
    await screen.findByText(/can’t be edited from your branch scope/);
    expect(await axe(outOfScope.container)).toHaveNoViolations();
  });
});
