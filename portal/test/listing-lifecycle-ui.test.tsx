import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createFixtureAuthRuntime,
  fixtureActivityTypes,
  fixtureBranches,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const noor = fixtureOrganizations.noor;
const pearl = fixtureOrganizations.pearl;

const detailPath = (ref: { organizationId: string }, programId: string) =>
  `/o/${ref.organizationId}/listings/${programId}`;
const revisionPath = (ref: { organizationId: string }, programId: string) =>
  `/o/${ref.organizationId}/listings/${programId}/revision`;

const LIFECYCLE_BUTTONS =
  /submit for review|resubmit for review|publish listing|resume publishing|pause listing|archive listing/i;

describe('listing lifecycle UX — submit path (W2-9)', () => {
  test('an incomplete draft offers NO submit control; the readiness list explains exactly what is missing', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Holiday Swim Camp' });
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Before it can be submitted for Himma review, this listing still needs:/),
    ).toBeInTheDocument();
    expect(screen.getByText('At least one active branch where it runs')).toBeInTheDocument();
  });

  test('a complete draft submits for an authorized role: success is announced only after the port confirms, and the state chip updates', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [detailPath(noor, fixtureListings.noorExamPrep)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Exam Prep Intensive' });
    expect(screen.getByText('This listing meets the submission requirements.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText('Submitted to Himma for review.')).toBeInTheDocument();
    expect(screen.getAllByText('Submitted for review').length).toBeGreaterThan(0);
    // The action is gone — Himma owns the next step.
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });

  test('a server-side completeness refusal renders the EXACT structured missing items (never invented)', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    renderPortal({
      runtime,
      asIdentity: 'director@himma.demo',
      initialEntries: [detailPath(noor, fixtureListings.noorExamPrep)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Exam Prep Intensive' });
    const submit = screen.getByRole('button', { name: 'Submit for review' });

    // The listing loses its only price option AFTER the page loaded — the
    // backend re-checks completeness at submit time and refuses.
    const detail = await runtime.listingsPort.loadListing(
      noor.organizationId,
      fixtureListings.noorExamPrep,
    );
    if (detail.kind !== 'loaded') throw new Error(detail.kind);
    const option = detail.program.priceOptions[0]!;
    const archived = await runtime.listingEditorPort.archivePriceOption(
      noor.organizationId,
      fixtureListings.noorExamPrep,
      option.id,
      option.version,
    );
    expect(archived.kind).toBe('optionArchived');

    await user.click(submit);
    expect(await screen.findByText(/isn’t ready yet\. It still needs:/)).toBeInTheDocument();
    // The structured missing item renders in the refusal (and the refreshed
    // readiness list now shows the same truth).
    expect(screen.getAllByText('At least one active price option').length).toBeGreaterThan(0);
    // Nothing moved.
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
  });

  test('changes requested: the REAL provider-safe correction feedback renders (W3-8), and resubmission works through the same action', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.aquaTherapy)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Aqua Therapy Sessions' });
    expect(screen.getAllByText('Changes requested').length).toBeGreaterThan(0);
    // W3-8: the reviewer-authored provider-safe message and the machine
    // reference — exactly the two layers the backend stores provider-
    // visibly; no internal reviewer identity or note vocabulary exists.
    const feedback = screen.getByRole('note', { name: 'What Himma asked to change' });
    expect(
      within(feedback).getByText(/Describe who leads each session and the qualifications/),
    ).toBeInTheDocument();
    expect(within(feedback).getByText('incomplete_description')).toBeInTheDocument();
    expect(within(feedback).getByText(/Reviewed on 14 June 2026/)).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main.textContent).not.toMatch(/internal note|reviewed by|reviewer name/i);

    await user.click(screen.getByRole('button', { name: 'Resubmit for review' }));
    expect(await screen.findByText('Resubmitted to Himma for review.')).toBeInTheDocument();
    // Back in review: the state changed; the historical feedback is no
    // longer presented as the current ask.
    expect(screen.queryByRole('note', { name: 'What Himma asked to change' })).toBeNull();
  });

  test('duplicate lifecycle submission executes exactly once (busy guard)', async () => {
    const runtime = createFixtureAuthRuntime();
    const spy = jest.spyOn(runtime.listingLifecyclePort, 'submitProgram');
    renderPortal({
      runtime,
      asIdentity: 'director@himma.demo',
      initialEntries: [detailPath(noor, fixtureListings.noorExamPrep)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Exam Prep Intensive' });
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    // Two rapid activations — the second lands while the first is in flight.
    fireEvent.click(submit);
    fireEvent.click(submit);
    await screen.findByText('Submitted to Himma for review.');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('Branch Manager: a readable-but-not-mutable complete draft gains NO submit action (read never implies mutate)', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    const created = await runtime.listingEditorPort.createProgram(blueWave.organizationId, {
      titleEn: 'Cross-branch Aqua Circuit',
      activityTypeId: fixtureActivityTypes.aquaFitness,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    if (created.kind !== 'programCreated') throw new Error(created.kind);
    await runtime.listingEditorPort.addBranchAssociation(
      blueWave.organizationId,
      created.program.id,
      fixtureBranches.blueWaveMarina,
    );
    await runtime.listingEditorPort.addBranchAssociation(
      blueWave.organizationId,
      created.program.id,
      fixtureBranches.blueWaveBay,
    );
    await runtime.listingEditorPort.addPriceOption(blueWave.organizationId, created.program.id, {
      kind: 'dropIn',
      amountFils: 5_000,
    });

    const first = renderPortal({
      runtime,
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [detailPath(blueWave, created.program.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Cross-branch Aqua Circuit' });
    // Readable, complete — but outside the every-rule mutation scope: the
    // readiness truth renders with NO submit control and no theater.
    expect(screen.getByText('This listing meets the submission requirements.')).toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryAllByRole('button')).toHaveLength(0);
    first.unmount();

    // A complete listing fully INSIDE the Marina-only scope IS submittable
    // by the same Branch Manager.
    const user = userEvent.setup();
    renderPortal({
      runtime,
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.aquaTherapy)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Aqua Therapy Sessions' });
    await user.click(screen.getByRole('button', { name: 'Resubmit for review' }));
    expect(await screen.findByText('Resubmitted to Himma for review.')).toBeInTheDocument();
  });
});

describe('listing lifecycle UX — publication authority (W2-9)', () => {
  test('approved ≠ published: the Owner sees the separation stated and an explicit Publish action; publishing announces and flips the chip', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Private Swim Coaching' });
    expect(screen.getAllByText('Approved — not published').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/approval and publication are separate steps/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Publish listing' }));
    expect(
      await screen.findByText(/Published\. Customers can find it subject to the visibility checks/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Published').length).toBeGreaterThan(0);
  });

  test('the Organization Manager holds publication authority too', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Private Swim Coaching' });
    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeInTheDocument();
  });

  test('the Listings Editor sees NO publish control on an approved listing — only the truthful explanation (no disabled theater)', async () => {
    renderPortal({
      asIdentity: 'flaky@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Private Swim Coaching' });
    const main = screen.getByRole('main');
    // Zero lifecycle buttons of any kind — not disabled ones.
    for (const button of within(main).queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(LIFECYCLE_BUTTONS);
    }
    expect(
      screen.getByText(/Publishing is a separate step that an Owner or Organization Manager takes/),
    ).toBeInTheDocument();
  });

  test('the Branch Manager sees NO publication control on a reachable paused listing — only the truthful explanation', async () => {
    // mastersTraining runs at Marina AND Bay: readable for the Marina scope
    // (some-rule), and publication authority is absent for the role anyway.
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.mastersTraining)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Masters Training' });
    const main = screen.getByRole('main');
    for (const button of within(main).queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(LIFECYCLE_BUTTONS);
    }
    expect(
      screen.getByText('An Owner or Organization Manager can resume publishing this listing.'),
    ).toBeInTheDocument();
  });

  test('published: pause asks first (visibility consequence), then pauses; paused exposes resume + archive to the Owner', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });

    await user.click(screen.getByRole('button', { name: 'Pause listing' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Customers will no longer find it on Himma/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Pause listing' }));

    expect(
      await screen.findByText(/Paused\. Customers can no longer find this listing/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
    // The paused state offers the canonical resume (the publish action) and
    // archive — to this authorized role.
    expect(screen.getByRole('button', { name: 'Resume publishing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive listing' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume publishing' }));
    expect(
      await screen.findByText(/Publishing resumed\. Customers can find it subject to the visibility checks/),
    ).toBeInTheDocument();
  });

  test('cancelling the pause dialog changes nothing and returns focus to the opener', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });
    const pause = screen.getByRole('button', { name: 'Pause listing' });
    await user.click(pause);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep it published' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getAllByText('Published').length).toBeGreaterThan(0);
    await waitFor(() => expect(pause).toHaveFocus());
  });

  test('archive is confirmed as PERMANENT, executes from published, and the archived listing offers no lifecycle control and no restore', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.adultSwimming)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' });

    await user.click(screen.getByRole('button', { name: 'Archive listing' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/final and can’t be reversed/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Archive permanently' }));

    expect(await screen.findByText(/Archived\. This listing is permanently retired\./)).toBeInTheDocument();
    expect(screen.getAllByText('Archived').length).toBeGreaterThan(0);
    const main = screen.getByRole('main');
    for (const button of within(main).queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(LIFECYCLE_BUTTONS);
    }
    expect(main.textContent).not.toMatch(/restore|reactivate|unarchive/i);
  });

  test('an already-archived listing renders terminal truth with zero lifecycle controls', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.sunsetOpenWater)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Sunset Open Water Program' });
    expect(screen.getByText(/Archiving is final/)).toBeInTheDocument();
    expect(screen.getByRole('main').textContent).not.toMatch(/restore|reactivate|unarchive/i);
    expect(within(screen.getByRole('main')).queryAllByRole('button')).toHaveLength(0);
  });

  test('organizationNotLive: the Owner of a verified-but-not-live organization sees the organization-level gate, never a completeness problem and never a doomed button', async () => {
    renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [detailPath(pearl, fixtureListings.pearlFreediving)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Freediving Foundations' });
    expect(
      screen.getByText(/Your organization isn’t live on Himma yet, so listings can’t be published/),
    ).toBeInTheDocument();
    // Not presented as listing incompleteness.
    expect(screen.queryByText(/still needs/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish listing' })).not.toBeInTheDocument();
    // The existing W2-3 verification surface is the referenced home.
    expect(screen.getByRole('link', { name: 'Check your verification status' })).toHaveAttribute(
      'href',
      `/o/${pearl.organizationId}/onboarding`,
    );
  });

  test('a stale lifecycle command never overwrites: current truth reconciles, the provider reviews, then retries deliberately', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Private Swim Coaching' });

    // Someone else edits the listing after this page loaded.
    runtime.controls.simulateConcurrentListingEdit(
      blueWave.organizationId,
      fixtureListings.privateCoaching,
    );
    await user.click(screen.getByRole('button', { name: 'Publish listing' }));
    expect(
      await screen.findByText(/This listing changed since you opened it\. The latest details are shown now/),
    ).toBeInTheDocument();
    // Nothing moved.
    expect(screen.getAllByText('Approved — not published').length).toBeGreaterThan(0);

    // After the reconciling refresh, a DELIBERATE retry uses current truth.
    await user.click(screen.getByRole('button', { name: 'Publish listing' }));
    expect(
      await screen.findByText(/Published\. Customers can find it subject to the visibility checks/),
    ).toBeInTheDocument();
  });

  test('suspended organization: reads stay, every lifecycle action is absent', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [detailPath(fixtureOrganizations.falcon, fixtureListings.falconKickboxing)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Teen Kickboxing Fundamentals' });
    expect(screen.getAllByText(/currently suspended/).length).toBeGreaterThan(0);
    const main = screen.getByRole('main');
    for (const button of within(main).queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(LIFECYCLE_BUTTONS);
    }
  });
});

describe('ProgramRevision provider UX (W2-9)', () => {
  test('an open revision: pending status page with submitted date, live-values truth, and ZERO decision controls', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [revisionPath(blueWave, fixtureListings.juniorSquad)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Pending review' });
    expect(screen.getByText('A protected change on this listing is with Himma for review.')).toBeInTheDocument();
    // The status appears as the header chip AND the status row.
    expect(screen.getAllByText('Waiting for review').length).toBeGreaterThan(0);
    expect(screen.getByText(/1 Aug 2026/)).toBeInTheDocument();
    expect(
      screen.getByText(/keep their current values until Himma finishes the review/),
    ).toBeInTheDocument();

    // The provider owns NO decision: no approve/reject/cancel/withdraw —
    // in fact no button at all — and no reviewer identity or notes.
    const main = screen.getByRole('main');
    expect(within(main).queryAllByRole('button')).toHaveLength(0);
    // No decision vocabulary (the page may truthfully say what happens WHEN
    // Himma approves — it may never offer approving/rejecting/withdrawing).
    expect(main.textContent).not.toMatch(
      /approve revision|reject|cancel review|withdraw|reviewer/i,
    );
  });

  test('no open revision: the quiet truth — decided revisions clear from the provider view without fabricated history', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [revisionPath(blueWave, fixtureListings.ladiesAqua)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Pending review' });
    expect(screen.getByText('No changes pending Himma review.')).toBeInTheDocument();
    expect(
      screen.getByText(/it clears from here — approved changes appear in the listing automatically/),
    ).toBeInTheDocument();
    // No invented decision history.
    expect(screen.getByRole('main').textContent).not.toMatch(/approved on|rejected|decision/i);
  });

  test('the detail links to the pending review; protected fields stay locked while it is open (editor truth unchanged)', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [detailPath(blueWave, fixtureListings.juniorSquad)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Junior Swim Squad' });
    expect(screen.getByRole('link', { name: 'View the pending review' })).toHaveAttribute(
      'href',
      `/o/${blueWave.organizationId}/listings/${fixtureListings.juniorSquad}/revision`,
    );
  });

  test('the revision route is safely not-found-shaped for unknown ids and roles without catalogue read fetch nothing', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [revisionPath(blueWave, '0198a2f0-5b7a-7000-8000-00000000dead')],
    });
    expect(await screen.findByText('Listing not found')).toBeInTheDocument();

    const runtime = createFixtureAuthRuntime();
    const spy = jest.spyOn(runtime.listingsPort, 'loadListing');
    renderPortal({
      runtime,
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [revisionPath(blueWave, fixtureListings.juniorSquad)],
    });
    expect(
      await screen.findByText('Listings are managed by your catalogue team'),
    ).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});
