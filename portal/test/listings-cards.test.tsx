import { fireEvent, screen, within } from '@testing-library/react';
import {
  createFixtureAuthRuntime,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const listingsPath = `/o/${blueWave.organizationId}/listings`;

async function findRow(title: string) {
  const list = await screen.findByRole('list', { name: 'Listings' });
  const link = await within(list).findByRole('link', { name: new RegExp(title) });
  return link;
}

describe('listings index cards (W2-11 owner visual correction)', () => {
  test('a listing with media renders its thumbnail; a listing without media renders the intentional placeholder', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath] });
    const withImage = await findRow('Adult Beginner Swimming');
    const image = await within(withImage).findByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('src', '/fixture-media/pool-lanes.jpg');
    // Decorative: the adjacent title already names the listing.
    expect(image).toHaveAttribute('alt', '');

    // Holiday Swim Camp has no media → the deliberate placeholder, never a
    // broken image and never a fake photograph.
    const withoutImage = await findRow('Holiday Swim Camp');
    expect(within(withoutImage).queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
    expect(withoutImage.querySelector('img')).toBeNull();
    expect(withoutImage.querySelector('svg')).not.toBeNull();
  });

  test('an image that fails to load falls back safely to the placeholder', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath] });
    const row = await findRow('Adult Beginner Swimming');
    const image = await within(row).findByRole('presentation', { hidden: true });
    fireEvent.error(image);
    expect(within(row).queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
    expect(row.querySelector('svg')).not.toBeNull();
  });

  test('row price summaries follow the binding D-S4-1 derivation: free wins, else lowest ACTIVE option, else the honest no-price state — one listing per Program', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath] });

    // Multi-option listing prices from its LOWEST ACTIVE option (Monthly
    // 450; the archived Drop-in 60 never resurfaces) and stays ONE row.
    const adult = await findRow('Adult Beginner Swimming');
    expect(await within(adult).findByText(/From AED 450/)).toBeInTheDocument();
    expect(within(adult).queryByText(/AED 60/)).not.toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Listings' });
    expect(within(list).getAllByRole('link', { name: /Adult Beginner Swimming/ })).toHaveLength(1);

    // An active FREE option outranks the paid term option — "Free", never a
    // range, never an average.
    const junior = await findRow('Junior Swim Squad');
    expect(await within(junior).findByText(/^Free ·/)).toBeInTheDocument();
    expect(within(junior).queryByText(/From AED/)).not.toBeInTheDocument();

    // No active option → the readiness truth, not a fabricated price.
    // (Aqua Fitness Express sits on the second page.)
    fireEvent.click(screen.getByRole('button', { name: 'Load more listings' }));
    const express = await findRow('Aqua Fitness Express');
    expect(await within(express).findByText(/No pricing yet/)).toBeInTheDocument();
  });

  test('branch summaries stay concise and truthful: single label, "+ N more", and the unplaced-draft state', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath] });
    const masters = await findRow('Masters Training');
    expect(await within(masters).findByText(/Dubai Marina pool \+ 1 more/)).toBeInTheDocument();
    const ladies = await findRow('Ladies Aqua Fitness');
    expect(await within(ladies).findByText(/Aqua Fitness · Dubai Marina pool$/)).toBeInTheDocument();
    const camp = await findRow('Holiday Swim Camp');
    expect(await within(camp).findByText(/No branch yet/)).toBeInTheDocument();
  });

  test('rows are whole-row links to the DETAIL route with a meaningful accessible name and no nested interactive control', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath] });
    const row = await findRow('Adult Beginner Swimming');
    expect(row).toHaveAttribute(
      'href',
      `/o/${blueWave.organizationId}/listings/${fixtureListings.adultSwimming}`,
    );
    // Never straight to /edit; detail stays the primary surface.
    expect(row.getAttribute('href')).not.toMatch(/\/edit$/);
    // The accessible name carries the row's meaning (title + status).
    expect(row).toHaveAccessibleName(/Adult Beginner Swimming.*Published/);
    // No nested buttons/links inside the row link (valid interactive tree;
    // native link semantics keep it fully keyboard operable).
    expect(within(row).queryAllByRole('button')).toHaveLength(0);
    expect(row.querySelector('a')).toBeNull();
  });

  test('card truth rides the authoritative list read itself: no catalogue read → forbidden; a Branch Manager receives only reachable rows, each carrying its card', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('finance@bluewave.demo');
    expect(
      (await runtime.listingsPort.listListings(blueWave.organizationId)).kind,
    ).toBe('forbidden');

    runtime.seedSession('manager@bluewave.demo');
    const scoped = await runtime.listingsPort.listListings(blueWave.organizationId);
    if (scoped.kind !== 'loaded') throw new Error(scoped.kind);
    const ids = scoped.page.programs.map((row) => row.id);
    expect(ids).toContain(fixtureListings.adultSwimming); // reachable (Marina + Bay)
    expect(ids).not.toContain(fixtureListings.privateCoaching); // Bay-only — out of Marina scope
    for (const row of scoped.page.programs) {
      expect(row.priceSummary.kind).toMatch(/^(free|from|none)$/);
      expect(typeof row.branchSummary.activeCount).toBe('number');
      expect(typeof row.activityType.labelEn).toBe('string');
    }
  });

  test('the unconfigured production port resolves nothing (placeholders everywhere, fail closed)', async () => {
    const { createUnconfiguredListingsPort } = await import('../src/auth/unconfigured-adapter');
    const outcome = await createUnconfiguredListingsPort().listListings(blueWave.organizationId);
    expect(outcome.kind).toBe('unavailable');
  });

  test('every lifecycle badge keeps its exact approved wording on the enriched rows', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath] });
    const list = await screen.findByRole('list', { name: 'Listings' });
    for (const label of [
      'Published',
      'Approved — not published',
      'Draft',
      'Submitted for review',
      'In review',
      'Changes requested',
      'Paused',
      'Archived',
    ]) {
      expect(within(list).getAllByText(label).length).toBeGreaterThan(0);
    }
  });
});
