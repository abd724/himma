import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import {
  createFixtureAuthRuntime,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const pearl = fixtureOrganizations.pearl;

const detailPath = (ref: { organizationId: string }, programId: string) =>
  `/o/${ref.organizationId}/listings/${programId}`;

describe('lifecycle + dashboard accessibility (jest-axe, W2-9)', () => {
  test('approved listing with the Owner publication action', async () => {
    const page = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.privateCoaching)],
    });
    await screen.findByRole('button', { name: 'Publish listing' });
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('published listing with pause/archive and the pause confirmation dialog open', async () => {
    const user = userEvent.setup();
    const page = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    await user.click(await screen.findByRole('button', { name: 'Pause listing' }));
    await screen.findByRole('dialog');
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('incomplete draft (readiness explanation, no action)', async () => {
    const page = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.holidayCamp)],
    });
    await screen.findByText(/Before it can be submitted for Himma review/);
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('approved listing as a Listings Editor (awaiting-publisher truth)', async () => {
    const page = renderPortal({
      asIdentity: 'flaky@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.privateCoaching)],
    });
    await screen.findByText(/Publishing is a separate step/);
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('organizationNotLive publication gate', async () => {
    const page = renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [detailPath(pearl, fixtureListings.pearlFreediving)],
    });
    await screen.findByText(/Your organization isn’t live on Himma yet/);
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('stale-conflict announcement after a lifecycle command', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    const page = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.privateCoaching)],
    });
    const publish = await screen.findByRole('button', { name: 'Publish listing' });
    // The concurrent edit lands AFTER this page loaded its version.
    runtime.controls.simulateConcurrentListingEdit(
      blueWave.organizationId,
      fixtureListings.privateCoaching,
    );
    await user.click(publish);
    await screen.findByText(/This listing changed since you opened it/);
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('revision status page — pending and none', async () => {
    const pending = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`${detailPath(blueWave, fixtureListings.juniorSquad)}/revision`],
    });
    await screen.findByText('A protected change on this listing is with Himma for review.');
    expect(await axe(pending.container)).toHaveNoViolations();
    pending.unmount();

    const none = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`${detailPath(blueWave, fixtureListings.ladiesAqua)}/revision`],
    });
    await screen.findByText('No changes pending Himma review.');
    expect(await axe(none.container)).toHaveNoViolations();
  });

  test('dashboard — populated Owner view (KPIs, attention/awaiting, overview, recent)', async () => {
    const page = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}`],
    });
    await screen.findByRole('list', { name: 'Key numbers' });
    await screen.findByRole('list', { name: 'Listings by status' });
    await screen.findByRole('heading', { name: 'Awaiting Himma' });
    await screen.findByRole('heading', { name: 'Recently updated' });
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('dashboard — scope-limited role and partial catalogue failure', async () => {
    const limited = renderPortal({
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}`],
    });
    await screen.findByText(/Your role’s dashboard covers organization status/);
    expect(await axe(limited.container)).toHaveNoViolations();
    limited.unmount();

    const runtime = createFixtureAuthRuntime();
    runtime.controls.failNextListingsLoad(blueWave.organizationId);
    const failed = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}`],
    });
    const heading = await screen.findByRole('heading', { name: 'Needs your attention' });
    const card = heading.closest('section')!;
    await waitFor(() =>
      expect(within(card).getByText(/We couldn’t check your catalogue/)).toBeInTheDocument(),
    );
    expect(await axe(failed.container)).toHaveNoViolations();
  });
});
