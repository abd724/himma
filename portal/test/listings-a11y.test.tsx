import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import {
  createFixtureAuthRuntime,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const falcon = fixtureOrganizations.falcon;
const sunrise = fixtureOrganizations.sunrise;

describe('listings accessibility (jest-axe, W2-7)', () => {
  test('populated index with filters engaged (owner)', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings`],
    });
    await screen.findByRole('list', { name: 'Listings' });
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'published');
    await user.type(screen.getByLabelText('Search by title'), 'swim');
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('branch-scoped index and the suspended read-only index', async () => {
    const scoped = renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings`],
    });
    await screen.findByRole('list', { name: 'Listings' });
    expect(await axe(scoped.container)).toHaveNoViolations();
    scoped.unmount();

    const suspended = renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [`/o/${falcon.organizationId}/listings`],
    });
    await screen.findByRole('list', { name: 'Listings' });
    expect(await axe(suspended.container)).toHaveNoViolations();
  });

  test('no-access surface and truthful empty state', async () => {
    const noAccess = renderPortal({
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings`],
    });
    await screen.findByRole('heading', {
      level: 2,
      name: 'Listings are managed by your catalogue team',
    });
    expect(await axe(noAccess.container)).toHaveNoViolations();
    noAccess.unmount();

    const empty = renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [`/o/${sunrise.organizationId}/listings`],
    });
    await screen.findByRole('heading', { level: 2, name: 'No listings yet' });
    expect(await axe(empty.container)).toHaveNoViolations();
  });

  test('full listing detail: status, visibility, pricing, branches, media, offers, revision', async () => {
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings/${fixtureListings.adultSwimming}`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('blocked-visibility detail, readiness detail, and pending-revision detail', async () => {
    const blocked = renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [`/o/${falcon.organizationId}/listings/${fixtureListings.falconKickboxing}`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Teen Kickboxing Fundamentals' });
    expect(await axe(blocked.container)).toHaveNoViolations();
    blocked.unmount();

    const readiness = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings/${fixtureListings.holidayCamp}`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    expect(await axe(readiness.container)).toHaveNoViolations();
    readiness.unmount();

    const revision = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings/${fixtureListings.juniorSquad}`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Junior Swim Squad' });
    expect(await axe(revision.container)).toHaveNoViolations();
  });

  test('not-found and transient-error states', async () => {
    const notFound = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [
        `/o/${blueWave.organizationId}/listings/0198a2f0-5b7a-7000-8000-000000000000`,
      ],
    });
    await screen.findByRole('heading', { level: 2, name: 'Listing not found' });
    expect(await axe(notFound.container)).toHaveNoViolations();
    notFound.unmount();

    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    runtime.controls.failNextListingsLoad(blueWave.organizationId);
    const failed = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings`],
    });
    await screen.findByText("We couldn’t load your listings. Try again in a moment.");
    expect(await axe(failed.container)).toHaveNoViolations();
  });
});
