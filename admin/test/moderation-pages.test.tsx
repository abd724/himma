import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFixtureAdminRuntime } from '../src/services/mock/fixture-admin';
import { renderAdmin } from './support/render-admin';

/**
 * W3-6 catalogue/revision moderation over the deterministic fixture
 * runtime: the queue → workspace → decision journeys with the CERTIFIED
 * S4 semantics — approval rests at `approved` (no publish control exists),
 * request-changes returns the listing to the provider, revision approval
 * applies EXACTLY the provider's change-set while the listing stays
 * published, rejection leaves the listing untouched, and the two mutation
 * models never blur. Plus CAS refusals, the step-up seam, and guards.
 */

function opsRuntime() {
  const runtime = createFixtureAdminRuntime();
  runtime.seedSession('ops@himma.demo');
  return runtime;
}

describe('the moderation queue (task §2/§8)', () => {
  test('lists exactly the reviewable listings with provider identity; the state filter is server-driven', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    const listSpy = jest.spyOn(runtime.moderationPort, 'listListings');
    renderAdmin({ runtime, initialEntries: ['/moderation'] });
    await screen.findByRole('link', { name: 'Junior Swim Camp' });
    expect(screen.getByRole('link', { name: 'Sunset Sailing Basics' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Adult Tennis Clinic' })).toBeInTheDocument();
    // The published listing with an open revision is NOT in the listing
    // queue — revisions are their own model.
    expect(screen.queryByRole('link', { name: 'Junior Tennis Term' })).toBeNull();
    expect(screen.getByText('Aquava Swim School')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Review state'), 'submitted');
    await screen.findByRole('link', { name: 'Junior Swim Camp' });
    expect(screen.queryByRole('link', { name: 'Adult Tennis Clinic' })).toBeNull();
    expect(listSpy.mock.calls.at(-1)![0]).toEqual({ state: 'submitted' });
  });

  test('the revision queue lists provider-submitted protected changes, linking into the same workspace', async () => {
    const runtime = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/revisions'] });
    await screen.findByRole('link', { name: 'Junior Tennis Term' });
    expect(screen.getByText('Submitted', { selector: 'span' })).toBeInTheDocument();
  });
});

describe('listing review decisions (task §2/§6)', () => {
  test('start review → approve: the listing RESTS at approved — no publish control exists anywhere', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/moderation/listing-aquava-camp'] });
    await screen.findByRole('heading', { name: 'Junior Swim Camp' });
    expect(screen.getByText('Aquava Swim School', { exact: false })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start review' }));
    await screen.findByRole('button', { name: 'Approve listing' });
    await user.click(screen.getByRole('button', { name: 'Approve listing' }));
    await screen.findByText('Approved');
    // D-S4-2: publication remains the PROVIDER'S action.
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve listing' })).toBeNull();
  });

  test('request changes returns the listing to the provider with the machine reason code', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    const reviewSpy = jest.spyOn(runtime.moderationPort, 'reviewListing');
    renderAdmin({ runtime, initialEntries: ['/moderation/listing-marina-clinic'] });
    await screen.findByRole('heading', { name: 'Adult Tennis Clinic' });

    await user.type(
      screen.getByLabelText(/Reason code/),
      'incomplete_description',
    );
    // W3-8: the reviewer-authored PROVIDER-VISIBLE correction text.
    await user.type(
      screen.getByLabelText(/Message to the provider/),
      'Describe the weekly schedule.',
    );
    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await screen.findByText('Changes requested');
    expect(reviewSpy).toHaveBeenLastCalledWith('listing-marina-clinic', 'request_changes', {
      expectedVersion: 3,
      reasonCode: 'incomplete_description',
      providerMessage: 'Describe the weekly schedule.',
    });
  });

  test('stale CAS decisions are refused by the port without state change (fixture mirrors the backend)', async () => {
    const runtime = opsRuntime();
    await expect(
      runtime.moderationPort.reviewListing('listing-aquava-camp', 'start_review', {
        expectedVersion: 999,
      }),
    ).resolves.toEqual({ kind: 'staleVersion' });
    // Deciding from the wrong state is a lifecycle conflict, not a write.
    await expect(
      runtime.moderationPort.reviewListing('listing-aquava-camp', 'approve', {
        expectedVersion: 2,
      }),
    ).resolves.toEqual({ kind: 'lifecycleConflict' });
    const view = await runtime.moderationPort.getListing('listing-aquava-camp');
    if (view.kind !== 'loaded') throw new Error(view.kind);
    expect(view.view.program.listingState).toBe('submitted');
  });
});

describe('revision decisions (task §3/§6)', () => {
  test('the workspace shows current-vs-proposed truth; applying the revision changes EXACTLY those fields while the listing stays published', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/moderation/listing-marina-term'] });
    await screen.findByRole('heading', { name: 'Junior Tennis Term' });

    // Current vs proposed — never confusable.
    const revisionPanel = screen.getByRole('region', { name: 'Proposed change (revision)' });
    const descriptionRow = within(revisionPanel).getByText('Description (EN)').closest('tr')!;
    expect(
      within(descriptionRow).getByText('Term-long junior coaching, ages grouped by level.'),
    ).toBeInTheDocument();
    expect(
      within(descriptionRow).getByText('Term-long junior coaching with weekly match play.'),
    ).toBeInTheDocument();
    const ageRow = within(revisionPanel).getByText('Minimum age').closest('tr')!;
    expect(within(ageRow).getByText('6')).toBeInTheDocument();
    expect(within(ageRow).getByText('7')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start revision review' }));
    await screen.findByRole('button', { name: 'Apply revision' });
    await user.click(screen.getByRole('button', { name: 'Apply revision' }));

    // Applied atomically: the listing now carries the proposed values, the
    // revision is closed, and the listing REMAINED published throughout.
    await screen.findByText('Term-long junior coaching with weekly match play.');
    expect(screen.getByText(/Ages 7/)).toBeInTheDocument();
    expect(screen.getByText('Published', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Proposed change (revision)' })).toBeNull();
  });

  test('rejecting a revision leaves the listing untouched and closes the revision with the reason code', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    const decideSpy = jest.spyOn(runtime.moderationPort, 'decideRevision');
    renderAdmin({ runtime, initialEntries: ['/moderation/listing-marina-term'] });
    await screen.findByRole('heading', { name: 'Junior Tennis Term' });

    await user.click(screen.getByRole('button', { name: 'Start revision review' }));
    await screen.findByRole('button', { name: 'Reject revision' });
    await user.type(screen.getByLabelText(/Reason code/), 'unclear_change');
    await user.click(screen.getByRole('button', { name: 'Reject revision' }));

    await screen.findByText('Term-long junior coaching, ages grouped by level.');
    expect(screen.getByText(/Ages 6–14/)).toBeInTheDocument(); // unchanged
    expect(screen.queryByRole('region', { name: 'Proposed change (revision)' })).toBeNull();
    expect(decideSpy).toHaveBeenLastCalledWith('listing-marina-term', 'rev-marina-term-1', 'reject', {
      expectedVersion: 2,
      reasonCode: 'unclear_change',
    });
  });
});

describe('authorization and the step-up seam (task §4/§5)', () => {
  test('an access_admin (no catalogue.moderate) is refused the moderation area — the port is never called', async () => {
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('access@himma.demo');
    const spy = jest.spyOn(runtime.moderationPort, 'listListings');
    renderAdmin({ runtime, initialEntries: ['/moderation'] });
    await screen.findByRole('heading', { name: 'This area isn’t part of your role' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('an action-level step-up demand interrupts the decision; re-verification clears it and the decision then succeeds', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/moderation/listing-aquava-camp'] });
    await screen.findByRole('heading', { name: 'Junior Swim Camp' });

    runtime.controls.demandStepUp();
    await user.click(screen.getByRole('button', { name: 'Start review' }));
    await screen.findByText(/needs a fresh verification of your identity/);
    await user.type(screen.getByLabelText('Verification code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Confirm identity' }));
    await screen.findByText(/Identity re-verified/);

    await user.click(screen.getByRole('button', { name: 'Start review' }));
    await screen.findByRole('button', { name: 'Approve listing' });
  });
});
