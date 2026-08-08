import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProgramDetailRecord } from '../src/catalogue/contract';
import {
  completenessGaps,
  formatAedFromFils,
  publicVisibility,
} from '../src/pages/listings/listing-domain';
import type { OrganizationView } from '../src/profile/contract';
import {
  createFixtureAuthRuntime,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const falcon = fixtureOrganizations.falcon;

const detailPath = (ref: { organizationId: string }, programId: string) =>
  `/o/${ref.organizationId}/listings/${programId}`;

const MUTATION_CONTROLS =
  /save|submit|publish|unpublish|pause|resume|archive|upload|create|delete|add (option|branch|offer|photo)|edit/i;

describe('listing detail (W2-7, read-oriented)', () => {
  test('a multi-option Program renders as ONE listing with its ProgramPriceOptions underneath — fils shown as AED, archived option apart, no Program.price', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' }),
    ).toBeInTheDocument();

    const pricing = screen.getByRole('list', { name: 'Pricing options' });
    const rows = within(pricing).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // Integer-fils → AED display; deterministic (sortHint, id) order.
    expect(within(rows[0]!).getByText('Monthly')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('AED 450')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('3 months')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('AED 1,200')).toBeInTheDocument();
    // Archive-only retirement stays visible and truthful.
    expect(within(rows[2]!).getByText('AED 60')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Archived')).toBeInTheDocument();
    // The “From …” line is a derived display convenience over ACTIVE options.
    expect(screen.getByText('From AED 450')).toBeInTheDocument();
  });

  test('offers render apart from pricing options, with kind, window, and state truth', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.mastersTraining)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Masters Training' });
    const offers = screen.getByRole('list', { name: 'Offers' });
    expect(within(offers).getByText('Founding members offer')).toBeInTheDocument();
    expect(within(offers).getByText(/Discount/)).toBeInTheDocument();
    expect(within(offers).getByText('Ended')).toBeInTheDocument();
    expect(
      screen.getByText(/they’re separate from the pricing options above/),
    ).toBeInTheDocument();
    // An offer is never a price-option row.
    const pricing = screen.getByRole('list', { name: 'Pricing options' });
    expect(within(pricing).queryByText('Founding members offer')).not.toBeInTheDocument();
  });

  test('branch associations render the shared branch truth: active, deactivated branch, and removed association', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });
    const branches = screen.getByRole('list', { name: 'Branches this listing runs at' });
    const rows = within(branches).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Dubai Marina pool')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Active')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Al Sufouh training pool')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('No longer offered here')).toBeInTheDocument();
  });

  test('an active association to a DEACTIVATED branch is named truthfully', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.sunsetOpenWater)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Sunset Open Water Program' });
    const branches = screen.getByRole('list', { name: 'Branches this listing runs at' });
    expect(within(branches).getByText('Branch deactivated')).toBeInTheDocument();
  });

  test('media renders reference metadata honestly — no previews, no upload controls (Class-C gap carried)', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });
    const media = screen.getByRole('list', { name: 'Listing photos' });
    const rows = within(media).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0]!).getByText('Coach guiding an adult swimmer in the training pool'),
    ).toBeInTheDocument();
    expect(within(rows[1]!).getByText('No photo description provided')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Removed')).toBeInTheDocument();
    expect(screen.getByText(/Photo previews aren’t available in the portal yet/)).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  test('Approved is clearly NOT Published', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Private Swim Coaching' });
    expect(screen.getAllByText('Approved — not published').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/approval and publication are separate steps/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Customers can find this listing/)).not.toBeInTheDocument();
  });

  test('Paused is reversible; Archived is terminal — and they say so', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.mastersTraining)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Masters Training' });
    expect(screen.getByText(/Pausing is reversible/)).toBeInTheDocument();

    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.sunsetOpenWater)],
    });
    const archived = await screen.findAllByText(/Archiving is final/);
    expect(archived.length).toBeGreaterThan(0);
    expect(screen.getByText('Archived 30 Jul 2026')).toBeInTheDocument();
  });

  test('a fully published, live, storefront-published, active-branch listing shows the truthful visibility statement', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });
    expect(screen.getByText('Customers can find this listing on Himma.')).toBeInTheDocument();
  });

  test('a published listing of a non-live organization is NOT claimed visible — the blocked gate is named', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [detailPath(falcon, fixtureListings.falconKickboxing)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Teen Kickboxing Fundamentals' });
    expect(screen.getByText('Customers can’t see this listing yet.')).toBeInTheDocument();
    expect(screen.getByText(/Not met — the organization is live on Himma/)).toBeInTheDocument();
    expect(screen.getByText(/Met — the listing is published/)).toBeInTheDocument();
  });

  test('readiness mirrors the exact S4 completeness rules, read-only', async () => {
    // Missing branch (branchless draft).
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    expect(screen.getByText(/this listing still needs/)).toBeInTheDocument();
    expect(screen.getByText('At least one active branch where it runs')).toBeInTheDocument();

    // Missing active price option.
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.aquaExpress)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Aqua Fitness Express' });
    expect(screen.getByText('At least one active price option')).toBeInTheDocument();

    // Deactivated taxonomy.
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.synchroSquad)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Synchro Performance Squad' });
    expect(
      screen.getByText(
        'A current activity type (its previous one is no longer in the Himma catalogue)',
      ),
    ).toBeInTheDocument();

    // A complete changes-requested listing is ready to resubmit (later).
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.aquaTherapy)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Aqua Therapy Sessions' });
    expect(screen.getByText(/meets the submission requirements/)).toBeInTheDocument();
    expect(screen.getAllByText('Changes requested').length).toBeGreaterThan(0);
  });

  test('an open ProgramRevision shows as read-only pending state; none shows the quiet truth', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.juniorSquad)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Junior Swim Squad' });
    expect(screen.getByText('Changes pending Himma review.')).toBeInTheDocument();
    expect(screen.getByText(/Submitted 1 Aug 2026/)).toBeInTheDocument();

    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.ladiesAqua)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Ladies Aqua Fitness' });
    expect(screen.getByText('No changes pending Himma review.')).toBeInTheDocument();
  });

  test('W2-7 exposes ZERO mutation controls and no internal DTO fields anywhere on the detail', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });
    const main = screen.getByRole('main');
    for (const button of within(main).queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(MUTATION_CONTROLS);
    }
    expect(within(main).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(main).queryAllByRole('combobox')).toHaveLength(0);
    // No uuid, version, or internal metadata is ever rendered (every
    // fixture uuid shares this prefix).
    expect(main.textContent).not.toMatch(/0198a2f0/);
    expect(main.textContent).not.toMatch(/sensitiveFieldsVersion|version/i);
  });

  test('eligibility renders canonical presentation wording (gender codes never leak)', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.ladiesAqua)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Ladies Aqua Fitness' });
    expect(screen.getByText('Ladies only')).toBeInTheDocument();
    expect(screen.getByText('Ages 16+')).toBeInTheDocument();
    expect(screen.getByText('All levels')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main.textContent).not.toMatch(/\bwomen\b/);
  });

  test('a branch-scoped manager’s direct URL to an out-of-scope listing renders the SAME safe not-found surface as an unknown id', async () => {
    const outOfScope = renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.juniorSquad)],
    });
    await screen.findByRole('heading', { level: 2, name: 'Listing not found' });
    expect(screen.queryByText('Junior Swim Squad')).not.toBeInTheDocument();
    const outOfScopeMain = outOfScope.container.querySelector('main')?.textContent ?? '';
    outOfScope.unmount();

    const unknown = renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [detailPath(blueWave, '0198a2f0-5b7a-7000-8000-000000000000')],
    });
    await screen.findByRole('heading', { level: 2, name: 'Listing not found' });
    expect(unknown.container.querySelector('main')?.textContent ?? '').toBe(outOfScopeMain);
    unknown.unmount();

    // In-scope listing: reads normally; the assigned branch is marked.
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.ladiesAqua)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Ladies Aqua Fitness' });
    expect(screen.getByText('Assigned to you')).toBeInTheDocument();
  });

  test('unknown ids and a foreign organization’s listing render ONE byte-identical safe not-found surface', async () => {
    const unknown = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, '0198a2f0-5b7a-7000-8000-000000000000')],
    });
    await screen.findByRole('heading', { level: 2, name: 'Listing not found' });
    const unknownMain = unknown.container.querySelector('main')?.textContent ?? '';
    unknown.unmount();

    const foreign = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.noorAfterSchool)],
    });
    await screen.findByRole('heading', { level: 2, name: 'Listing not found' });
    const foreignMain = foreign.container.querySelector('main')?.textContent ?? '';

    expect(foreignMain).toBe(unknownMain);
    expect(foreignMain).not.toContain('After-School');
  });

  test('a non-listing path segment (e.g. /listings/new) is safely not-found — no editor exists in W2-7', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings/new`],
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'Listing not found' })).toBeInTheDocument();
  });

  test('a role without catalogue.read never fetches a listing by URL', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('finance@bluewave.demo');
    const detailSpy = jest.spyOn(runtime.listingsPort, 'loadListing');
    renderPortal({
      runtime,
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Listings are managed by your catalogue team',
      }),
    ).toBeInTheDocument();
    expect(detailSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('Adult Beginner Swimming')).not.toBeInTheDocument();
  });

  test('a transient detail failure renders a retryable error, and retry recovers', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    runtime.controls.failNextListingDetailLoad(blueWave.organizationId);
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    expect(
      await screen.findByText("We couldn’t load this listing. Try again in a moment."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' }),
    ).toBeInTheDocument();
  });
});

describe('public visibility predicate + completeness (every gate, unit level)', () => {
  const baseView = {
    organization: { verificationState: 'live' },
    profile: { published: true },
  } as unknown as OrganizationView;

  const baseProgram = {
    listingState: 'published',
    titleEn: 'Program',
    activityType: { active: true },
    branches: [{ branchId: 'b1', label: 'B1', branchActive: true, associationActive: true, version: 1 }],
    priceOptions: [{ id: 'o1', state: 'active', kind: 'monthly', amountFils: 1000 }],
  } as unknown as ProgramDetailRecord;

  const withView = (overrides: Record<string, unknown>) =>
    ({ ...baseView, ...overrides }) as unknown as OrganizationView;
  const withProgram = (overrides: Record<string, unknown>) =>
    ({ ...baseProgram, ...overrides }) as unknown as ProgramDetailRecord;

  test('visible only when ALL four canonical gates hold', () => {
    expect(publicVisibility(baseView, baseProgram).visible).toBe(true);
    expect(
      publicVisibility(withView({ organization: { verificationState: 'verified' } }), baseProgram)
        .visible,
    ).toBe(false);
    expect(
      publicVisibility(withView({ profile: { published: false } }), baseProgram).visible,
    ).toBe(false);
    expect(publicVisibility(baseView, withProgram({ listingState: 'paused' })).visible).toBe(false);
    expect(
      publicVisibility(
        baseView,
        withProgram({
          branches: [
            { branchId: 'b1', label: 'B1', branchActive: false, associationActive: true, version: 1 },
          ],
        }),
      ).visible,
    ).toBe(false);
    expect(
      publicVisibility(
        baseView,
        withProgram({
          branches: [
            { branchId: 'b1', label: 'B1', branchActive: true, associationActive: false, version: 1 },
          ],
        }),
      ).visible,
    ).toBe(false);
  });

  test('completeness mirrors the backend vocabulary exactly', () => {
    expect(completenessGaps(baseProgram)).toEqual([]);
    expect(completenessGaps(withProgram({ titleEn: '  ' }))).toEqual(['title']);
    expect(completenessGaps(withProgram({ activityType: { active: false } }))).toEqual([
      'activeTaxonomy',
    ]);
    expect(completenessGaps(withProgram({ branches: [] }))).toEqual(['activeBranch']);
    expect(
      completenessGaps(withProgram({ priceOptions: [{ id: 'o1', state: 'archived' }] })),
    ).toEqual(['activePriceOption']);
  });

  test('fils→AED formatting is exact', () => {
    expect(formatAedFromFils(45_000)).toBe('AED 450');
    expect(formatAedFromFils(120_000)).toBe('AED 1,200');
    expect(formatAedFromFils(2_550)).toBe('AED 25.50');
  });
});
