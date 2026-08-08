import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createFixtureAuthRuntime,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const falcon = fixtureOrganizations.falcon;

const editPath = (ref: { organizationId: string }, programId: string) =>
  `/o/${ref.organizationId}/listings/${programId}/edit`;
const detailPath = (ref: { organizationId: string }, programId: string) =>
  `/o/${ref.organizationId}/listings/${programId}`;

/** W2-9 lifecycle vocabulary that must NOT exist anywhere on the editor. */
const LIFECYCLE_CONTROLS = /submit for review|publish|unpublish|pause|resume|archive listing|resubmit|send back for review|withdraw/i;

describe('listing editor page (W2-8)', () => {
  test('a draft edits directly: dirty-field save flows into the SHARED truth the W2-7 detail reads', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });

    const title = screen.getByLabelText('Title (English)');
    await user.clear(title);
    await user.type(title, 'Holiday Swim Camp Plus');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();

    // The same fixture truth serves the W2-7 read detail immediately.
    const detail = await runtime.listingsPort.loadListing(
      blueWave.organizationId,
      fixtureListings.holidayCamp,
    );
    if (detail.kind !== 'loaded') throw new Error(detail.kind);
    expect(detail.program.titleEn).toBe('Holiday Swim Camp Plus');
    expect(detail.program.listingState).toBe('draft'); // no lifecycle movement
  });

  test('the readiness panel mirrors the exact four canonical requirements and never submits anything', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    const panel = screen.getByRole('heading', { name: 'Ready for review?' }).closest('section')!;
    expect(within(panel).getByText('An English title')).toBeInTheDocument();
    expect(
      within(panel).getByText('A current activity type from the Himma catalogue'),
    ).toBeInTheDocument();
    // Holiday Swim Camp is the branchless draft — the branch rule is the gap.
    expect(within(panel).getByText('At least one active branch where it runs')).toBeInTheDocument();
    expect(within(panel).getByText('At least one active price option')).toBeInTheDocument();
    expect(within(panel).getAllByText('Missing')).toHaveLength(1);
    expect(within(panel).getAllByText('Done')).toHaveLength(3);
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument(); // information only
  });

  test('NO lifecycle action exists anywhere on the editor (W2-9 boundary)', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    const main = screen.getByRole('main');
    for (const control of [...within(main).queryAllByRole('button'), ...within(main).queryAllByRole('link')]) {
      expect(control.textContent ?? '').not.toMatch(LIFECYCLE_CONTROLS);
    }
  });

  test('a changes-requested listing is editable with the correction context; resubmission is truthfully a later milestone', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.aquaTherapy)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Aqua Therapy Sessions' });
    expect(
      screen.getByText(/Himma asked for changes before this listing can be approved/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getByText(/sending it back for review arrives in an upcoming portal update/)).toBeInTheDocument();
  });

  test.each([
    [fixtureListings.schoolTerm, 'School Term Program', /with Himma for review/],
    [fixtureListings.strokeClinic, 'Stroke Development Clinic', /reviewing this listing right now/],
    [fixtureListings.sunsetOpenWater, 'Sunset Open Water Program', /Archiving is final/],
  ])('locked states render a frozen read-only editor: %s', async (programId, title, copy) => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, programId)],
    });
    await screen.findByRole('heading', { level: 1, name: title });
    expect(screen.getByText(copy)).toBeInTheDocument();
    const main = screen.getByRole('main');
    // Zero mutation surface: no form fields, no save, nothing disabled-as-theater.
    expect(within(main).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(main).queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(within(main).getByRole('link', { name: 'View listing' })).toBeInTheDocument();
  });

  test('review-gated listing: protected fields are marked; saving one announces the Himma-review outcome and the live value stands', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Private Swim Coaching' });
    expect(
      screen.getByText(/Protected details — like descriptions, eligibility, and pricing — need Himma review/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Needs Himma review').length).toBeGreaterThan(0);

    const description = screen.getByLabelText('Description (English)');
    await user.clear(description);
    await user.type(description, 'Updated protected description.');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(/Sent to Himma for review: English description/),
    ).toBeInTheDocument();

    // The LIVE value stands until Himma approves (no silent hot-apply).
    const detail = await runtime.listingsPort.loadListing(
      blueWave.organizationId,
      fixtureListings.privateCoaching,
    );
    if (detail.kind !== 'loaded') throw new Error(detail.kind);
    expect(detail.program.descriptionEn).toBe('One-to-one stroke coaching tailored to your goals.');
    expect(detail.program.openRevision).not.toBeNull();
  });

  test('an open revision blocks further protected changes truthfully (fields read-only, honest copy)', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.juniorSquad)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Junior Swim Squad' });
    expect(
      screen.getAllByText(/A change is already awaiting Himma review/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByLabelText('Description (English)')).toBeDisabled();
    // Non-protected fields stay live.
    expect(screen.getByLabelText('Title (English)')).toBeEnabled();
  });

  test('pricing on a review-gated listing announces the review boundary before and after', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Private Swim Coaching' });
    const pricing = screen.getByRole('heading', { name: 'Pricing options' }).closest('section')!;
    expect(
      within(pricing).getByText(/any pricing change goes to Himma for review/),
    ).toBeInTheDocument();
    await user.click(within(pricing).getByRole('button', { name: 'Add price option' }));
    // The submit action names the truth on gated listings.
    expect(within(pricing).getByRole('button', { name: 'Send for review' })).toBeInTheDocument();
  });

  test('price options: add (AED→fils), reorder, and permanent archive with confirmation', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    const pricing = () => screen.getByRole('heading', { name: 'Pricing options' }).closest('section')!;

    // Add a monthly option with a fractional AED amount.
    await user.click(within(pricing()).getByRole('button', { name: 'Add price option' }));
    await user.type(within(pricing()).getByLabelText('Price (AED)'), '450.50');
    await user.type(within(pricing()).getByLabelText('Label (optional)'), 'Monthly pass');
    await user.click(within(pricing()).getByRole('button', { name: 'Save option' }));
    expect(await screen.findByText('Price option added.')).toBeInTheDocument();
    expect(within(pricing()).getByText('AED 450.50')).toBeInTheDocument();

    // Reorder via the keyboard-accessible controls.
    await user.click(
      within(pricing()).getByRole('button', { name: /Move down Monthly pass/ }),
    );
    expect(await screen.findByText('“Monthly pass” moved.')).toBeInTheDocument();

    // Archive is confirmed and clearly irreversible; the row stays as history.
    await user.click(within(pricing()).getByRole('button', { name: /Archive Monthly pass/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/can never be reactivated/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/“Monthly pass” was archived/)).toBeInTheDocument();
    expect(within(pricing()).getByText('Archived')).toBeInTheDocument();
    // No reactivation control exists for archived options.
    expect(
      within(pricing()).queryByRole('button', { name: /reactivate/i }),
    ).not.toBeInTheDocument();
  });

  test('a stale program save NEVER overwrites: conflict surface with reload keeping the user’s values', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });

    const title = screen.getByLabelText('Title (English)');
    await user.clear(title);
    await user.type(title, 'My Edited Title');
    // Another writer saves first.
    runtime.controls.simulateConcurrentListingEdit(
      blueWave.organizationId,
      fixtureListings.holidayCamp,
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(/Someone else saved this listing while you were editing/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reload latest version' }));
    // The user's edited value survives the reload (reconcile, not discard).
    expect(await screen.findByLabelText('Title (English)')).toHaveValue('My Edited Title');
    // And the next save applies cleanly against the fresh version.
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
  });

  test('offers: add with paid-trial amount tie and end with confirmation (ended = history)', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    const offers = () => screen.getByRole('heading', { name: 'Offers' }).closest('section')!;

    await user.click(within(offers()).getByRole('button', { name: 'Add offer' }));
    await user.selectOptions(within(offers()).getByLabelText('Kind'), 'paidTrial');
    await user.type(within(offers()).getByLabelText('Label'), 'Trial class');
    // Paid trial without an amount refuses client-side with honest copy.
    await user.click(within(offers()).getByRole('button', { name: 'Save offer' }));
    expect(
      await within(offers()).findByText(/A paid trial needs its price in AED/),
    ).toBeInTheDocument();
    await user.type(within(offers()).getByLabelText('Trial price (AED)'), '25.50');
    await user.click(within(offers()).getByRole('button', { name: 'Save offer' }));
    expect(await screen.findByText('Offer added.')).toBeInTheDocument();
    expect(within(offers()).getByText(/AED 25.50/)).toBeInTheDocument();

    await user.click(within(offers()).getByRole('button', { name: /End offer Trial class/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'End offer' }));
    expect(await screen.findByText(/“Trial class” has ended/)).toBeInTheDocument();
    expect(within(offers()).getByText('Ended')).toBeInTheDocument();
  });

  test('media metadata: description edit hot-applies on a published listing; no upload control anywhere', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });
    const photos = () => screen.getByRole('heading', { name: 'Photos' }).closest('section')!;
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(within(photos()).queryByRole('button', { name: /add|upload/i })).not.toBeInTheDocument();

    await user.click(
      within(photos()).getByRole('button', {
        name: /Edit description for Coach guiding an adult swimmer/,
      }),
    );
    const field = within(photos()).getByLabelText('Photo description');
    await user.clear(field);
    await user.type(field, 'Coach with adult beginners, main pool');
    await user.click(within(photos()).getByRole('button', { name: 'Save description' }));
    expect(await screen.findByText('Photo description saved.')).toBeInTheDocument();
    expect(
      within(photos()).getAllByText(/Coach with adult beginners, main pool/).length,
    ).toBeGreaterThan(0);
  });
});

describe('editor authority (roles, scope, suspension)', () => {
  test('a Branch Manager edits an in-scope listing but only their assigned branches carry association controls', async () => {
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.ladiesAqua)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Ladies Aqua Fitness' });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    const locations = screen.getByRole('heading', { name: 'Locations' }).closest('section')!;
    const marinaRow = within(locations).getByText('Dubai Marina pool').closest('li')!;
    expect(within(marinaRow).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    const bayRow = within(locations).getByText('Business Bay pool').closest('li')!;
    expect(within(bayRow).queryByRole('button')).not.toBeInTheDocument();
    expect(within(bayRow).getByText('Outside your branch scope')).toBeInTheDocument();
  });

  test('READABLE never implies EDITABLE: a some-in-scope listing renders the truthful scope surface with zero form controls', async () => {
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });
    expect(
      screen.getByText(/can’t be edited from your branch scope/),
    ).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(main).queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(within(main).getByRole('link', { name: 'View listing' })).toBeInTheDocument();
  });

  test('an out-of-read-scope listing is the SAME safe not-found surface on the editor route', async () => {
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.juniorSquad)], // Bay-only
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Listing not found' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Junior Swim Squad')).not.toBeInTheDocument();
  });

  test('a role without catalogue management never fetches the listing and sees the truthful no-access surface', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('finance@bluewave.demo');
    const spy = jest.spyOn(runtime.listingsPort, 'loadListing');
    renderPortal({
      runtime,
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [editPath(blueWave, fixtureListings.adultSwimming)],
    });
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Listings are managed by your catalogue team',
      }),
    ).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  test('a suspended organization reads its listing but the editor is completely non-mutating', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [editPath(falcon, fixtureListings.falconKickboxing)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Teen Kickboxing Fundamentals' });
    expect(
      screen.getByText(/currently suspended. Listings stay readable, but changes are unavailable/),
    ).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).queryByRole('button', { name: /save|add|remove|edit|archive|end/i })).not.toBeInTheDocument();
    expect(within(main).queryAllByRole('textbox')).toHaveLength(0);
  });
});

describe('editor entry points (index + detail)', () => {
  test('the index carries the Create entry for managers; the detail links the editor only where mutation authority truly exists', async () => {
    const index = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings`],
    });
    await screen.findByRole('list', { name: 'Listings' });
    expect(screen.getByRole('link', { name: 'Create listing' })).toHaveAttribute(
      'href',
      `/o/${blueWave.organizationId}/listings/new`,
    );
    index.unmount();

    const editable = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    expect(screen.getByRole('link', { name: 'Edit listing' })).toBeInTheDocument();
    editable.unmount();

    // Branch Manager on a readable-but-not-mutable listing: NO edit link.
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });
    expect(screen.queryByRole('link', { name: 'Edit listing' })).not.toBeInTheDocument();
  });

  test('a suspended organization gets no Create or Edit entry points', async () => {
    const index = renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [`/o/${falcon.organizationId}/listings`],
    });
    await screen.findByRole('list', { name: 'Listings' });
    expect(screen.queryByRole('link', { name: 'Create listing' })).not.toBeInTheDocument();
    index.unmount();

    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [detailPath(falcon, fixtureListings.falconKickboxing)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Teen Kickboxing Fundamentals' });
    expect(screen.queryByRole('link', { name: 'Edit listing' })).not.toBeInTheDocument();
  });
});
