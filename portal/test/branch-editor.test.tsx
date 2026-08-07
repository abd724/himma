import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FIXTURE_INVITATIONS,
  createFixtureAuthRuntime,
  fixtureBranches,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const coral = fixtureOrganizations.coral;
const noor = fixtureOrganizations.noor;

const branchPath = (ref: { organizationId: string }, branchId: string) =>
  `/o/${ref.organizationId}/branches/${branchId}`;

async function coralOwnerRuntime() {
  const runtime = createFixtureAuthRuntime();
  runtime.seedSession('newowner@coral.demo');
  await runtime.invitationPort.accept(FIXTURE_INVITATIONS.foundingOwner);
  return runtime;
}

describe('branch create (W2-5)', () => {
  test('an Owner creates a branch: area from the taxonomy, shared store updated, readiness completed, lifecycle unmoved', async () => {
    const user = userEvent.setup();
    const runtime = await coralOwnerRuntime();
    const createSpy = jest.spyOn(runtime.branchPort, 'createBranch');
    renderPortal({
      runtime,
      asIdentity: 'newowner@coral.demo',
      initialEntries: [`/o/${coral.organizationId}/branches/new`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Add branch' });
    // The onboarding tie is explained for a first branch.
    expect(await screen.findByText(/completes the branch requirement/i)).toBeInTheDocument();

    await user.type(await screen.findByLabelText('Branch name'), 'Climbing hall');
    // The area picker offers ONLY the active taxonomy — no free text field.
    const areaSelect = screen.getByLabelText('Area');
    expect(areaSelect.tagName).toBe('SELECT');
    expect(
      within(areaSelect as HTMLElement)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).not.toContain('Al Sufouh');
    await user.selectOptions(areaSelect, 'Al Barsha');
    await user.type(screen.getByLabelText('Address line'), 'Wall Street Climbing, Unit 3');
    await user.click(screen.getByRole('button', { name: 'Add branch' }));

    // Success navigates to the list with the new branch present.
    const list = await screen.findByRole('list', { name: 'Branches' });
    expect(within(list).getByText('Climbing hall')).toBeInTheDocument();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(coral.organizationId, {
      label: 'Climbing hall',
      areaLabel: 'Al Barsha',
      addressLine: 'Wall Street Climbing, Unit 3',
      city: null,
    });

    // The SHARED fixture truth moved: readiness complete, lifecycle unmoved.
    const snapshot = await runtime.onboardingPort.loadSnapshot(coral.organizationId);
    if (snapshot.kind !== 'loaded') {
      throw new Error('expected snapshot');
    }
    expect(snapshot.snapshot.branches.some((branch) => branch.active)).toBe(true);
    expect(snapshot.snapshot.organization.verificationState).toBe('draft');
  });

  test('client validation blocks an empty submission before any port call', async () => {
    const user = userEvent.setup();
    const runtime = await coralOwnerRuntime();
    const createSpy = jest.spyOn(runtime.branchPort, 'createBranch');
    renderPortal({
      runtime,
      asIdentity: 'newowner@coral.demo',
      initialEntries: [`/o/${coral.organizationId}/branches/new`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Add branch' });
    await screen.findByLabelText('Branch name');
    await user.click(screen.getByRole('button', { name: 'Add branch' }));
    expect(await screen.findByText('Enter a name for this branch.')).toBeInTheDocument();
    expect(screen.getByText('Choose the area this branch is in.')).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('duplicate submission is suppressed while a create is in flight', async () => {
    const user = userEvent.setup();
    const runtime = await coralOwnerRuntime();
    const original = runtime.branchPort.createBranch.bind(runtime.branchPort);
    let resolveCreate: (() => void) | undefined;
    const createSpy = jest
      .spyOn(runtime.branchPort, 'createBranch')
      .mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          resolveCreate = resolve;
        });
        return original(...args);
      });
    renderPortal({
      runtime,
      asIdentity: 'newowner@coral.demo',
      initialEntries: [`/o/${coral.organizationId}/branches/new`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Add branch' });
    await user.type(await screen.findByLabelText('Branch name'), 'Climbing hall');
    await user.selectOptions(screen.getByLabelText('Area'), 'Al Barsha');
    const submitButton = screen.getByRole('button', { name: 'Add branch' });
    await user.click(submitButton);
    await user.click(screen.getByRole('button', { name: 'Adding…' }));
    resolveCreate?.();
    await screen.findByRole('list', { name: 'Branches' });
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  test('a transient create failure keeps the details and explains itself', async () => {
    const user = userEvent.setup();
    const runtime = await coralOwnerRuntime();
    runtime.controls.failNextBranchMutation(coral.organizationId);
    renderPortal({
      runtime,
      asIdentity: 'newowner@coral.demo',
      initialEntries: [`/o/${coral.organizationId}/branches/new`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Add branch' });
    await user.type(await screen.findByLabelText('Branch name'), 'Climbing hall');
    await user.selectOptions(screen.getByLabelText('Area'), 'Al Barsha');
    await user.click(screen.getByRole('button', { name: 'Add branch' }));
    expect(await screen.findByText(/couldn’t add this branch right now/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Branch name')).toHaveValue('Climbing hall');
  });

  test('roles without branch.create get the truthful surface, never a disabled form', async () => {
    renderPortal({
      asIdentity: 'assistant@coral.demo',
      initialEntries: [`/o/${coral.organizationId}/branches/new`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Add branch' });
    expect(await screen.findByText(/your role can’t add branches/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Branch name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add branch' })).not.toBeInTheDocument();
  });

  test('a suspended organization cannot reach the create form', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [`/o/${fixtureOrganizations.falcon.organizationId}/branches/new`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Add branch' });
    expect((await screen.findAllByText(/currently suspended/i)).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByLabelText('Branch name')).not.toBeInTheDocument();
  });

  test('an area-taxonomy outage blocks the form honestly and retry recovers', async () => {
    const user = userEvent.setup();
    const runtime = await coralOwnerRuntime();
    runtime.controls.failNextAreaLoad();
    renderPortal({
      runtime,
      asIdentity: 'newowner@coral.demo',
      initialEntries: [`/o/${coral.organizationId}/branches/new`],
    });
    expect(await screen.findByText(/couldn’t load the list of areas/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Area')).toBeInTheDocument();
  });
});

describe('branch edit (W2-5)', () => {
  test('an Owner saves a dirty-field-only PATCH carrying the branch version', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    const updateSpy = jest.spyOn(runtime.branchPort, 'updateBranch');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveMarina)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });

    const nameField = await screen.findByLabelText('Branch name');
    await user.clear(nameField);
    await user.type(nameField, 'Dubai Marina flagship pool');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/saved — this branch is up to date/i)).toBeInTheDocument();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(
      blueWave.organizationId,
      fixtureBranches.blueWaveMarina,
      1,
      { label: 'Dubai Marina flagship pool' },
    );
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina flagship pool' });
  });

  test('a stale conflict never overwrites: reload keeps this editor’s edits and re-arms the save', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveMarina)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });

    const nameField = await screen.findByLabelText('Branch name');
    await user.clear(nameField);
    await user.type(nameField, 'My renamed pool');
    // Another writer saves first.
    runtime.controls.simulateConcurrentBranchEdit(
      blueWave.organizationId,
      fixtureBranches.blueWaveMarina,
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/someone else updated this branch/i)).toBeInTheDocument();
    // No silent overwrite happened in the store.
    const view = await runtime.profilePort.loadOrganizationView(blueWave.organizationId);
    if (view.kind !== 'loaded') {
      throw new Error('expected view');
    }
    expect(view.view.branches[0]?.label).toBe('Dubai Marina pool');

    await user.click(screen.getByRole('button', { name: 'Load the latest branch' }));
    expect(await screen.findByText(/your edits are kept below/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Branch name')).toHaveValue('My renamed pool');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/saved — this branch is up to date/i)).toBeInTheDocument();
  });

  test('a historical area label is preserved, shown as no longer offered, and never silently rewritten', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    const updateSpy = jest.spyOn(runtime.branchPort, 'updateBranch');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveSufouh)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Al Sufouh training pool' });

    const areaSelect = (await screen.findByLabelText('Area')) as HTMLSelectElement;
    expect(areaSelect.value).toBe('Al Sufouh');
    const historicalOption = within(areaSelect).getByRole('option', {
      name: 'Al Sufouh (no longer offered)',
    }) as HTMLOptionElement;
    expect(historicalOption.disabled).toBe(true);

    // Editing an unrelated field does NOT rewrite the historical area.
    const nameField = screen.getByLabelText('Branch name');
    await user.clear(nameField);
    await user.type(nameField, 'Al Sufouh archive pool');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/saved — this branch is up to date/i);
    expect(updateSpy).toHaveBeenCalledWith(
      blueWave.organizationId,
      fixtureBranches.blueWaveSufouh,
      1,
      { label: 'Al Sufouh archive pool' },
    );
  });

  test('a branch-scoped manager edits the assigned branch but not others — and holds no deactivation control', async () => {
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveMarina)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });
    expect(await screen.findByLabelText('Branch name')).toBeInTheDocument();
    // branch.deactivate is not held: no deactivation affordance at all.
    expect(screen.queryByRole('button', { name: /deactivate/i })).not.toBeInTheDocument();
  });

  test('an unassigned branch renders read-only for a scoped manager, with the scope explained', async () => {
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveBay)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Bay pool' });
    expect(await screen.findByText(/isn’t assigned to you/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Branch name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    // The read-only record still shows real fields.
    expect(screen.getByText('Business Bay')).toBeInTheDocument();
  });

  test('read-only roles get the record, not a form, and no operational fabrications', async () => {
    renderPortal({
      asIdentity: 'frontdesk@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveMarina)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });
    expect(
      await screen.findByText(/an owner or organization manager makes changes here/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Branch name')).not.toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main.textContent).not.toMatch(/booking|staff|revenue|occupancy|schedule|capacity/i);
  });

  test('unknown ids and another organization’s branch id render ONE safe not-found shape', async () => {
    const unknown = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchPath(blueWave, '0198a2f0-5b7a-7000-8000-2b6c3e8f7aff')],
    });
    await screen.findByRole('heading', { level: 1, name: 'Branch not found' });
    const unknownText = screen.getByRole('main').textContent;
    unknown.unmount();

    // Noor's REAL branch id inside Blue Wave's scope: identical surface, and
    // nothing about the foreign branch (name, area) leaks.
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.noorBarsha)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Branch not found' });
    expect(screen.getByRole('main').textContent).toBe(unknownText);
    expect(screen.getByRole('main').textContent).not.toMatch(/Al Barsha centre|Noor/);
  });

  test('unsaved edits guard in-app navigation until explicitly discarded', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveMarina)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });
    await user.type(await screen.findByLabelText('Branch name'), ' East');

    await user.click(screen.getByRole('link', { name: 'Business Profile' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Branch name')).toHaveValue('Dubai Marina pool East');

    await user.click(screen.getByRole('link', { name: 'Business Profile' }));
    const dialogAgain = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dialogAgain).getByRole('button', { name: 'Discard changes' }));
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
  });

  test('switching organizations with dirty branch edits warns first', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveMarina)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });
    await user.type(await screen.findByLabelText('Branch name'), ' East');

    await user.click(screen.getByRole('button', { name: /Blue Wave Swimming/ }));
    await user.click(
      within(screen.getByRole('menu', { name: 'Switch organization' })).getByRole(
        'menuitemradio',
        { name: /Noor Learning Centre/ },
      ),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }),
    ).toBeInTheDocument();
  });
});

describe('branch deactivation (W2-5)', () => {
  test('deactivation is explicit, confirmed, generic about consequences, and never a delete', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveMarina)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });

    // No delete vocabulary anywhere.
    expect(screen.queryByRole('button', { name: /delete|remove/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deactivate branch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Dubai Marina pool?' });
    // Generic consequence truth — no fabricated affected-listing counts.
    expect(within(dialog).getByText(/can become unavailable/i)).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/\d+\s*listing/i);
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate branch' }));

    expect(await screen.findByText(/this branch is deactivated/i)).toBeInTheDocument();
    const view = await runtime.profilePort.loadOrganizationView(blueWave.organizationId);
    if (view.kind !== 'loaded') {
      throw new Error('expected view');
    }
    const marina = view.view.branches.find(
      (branch) => branch.id === fixtureBranches.blueWaveMarina,
    );
    expect(marina?.active).toBe(false);
    // Deactivate-only truth: the row still exists; nothing was deleted.
    expect(view.view.branches).toHaveLength(3);
  });

  test('deactivating the ONLY active branch says so and flips the onboarding requirement back', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    renderPortal({
      runtime,
      asIdentity: 'director@himma.demo',
      initialEntries: [branchPath(noor, fixtureBranches.noorBarsha)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Al Barsha centre' });
    await user.click(screen.getByRole('button', { name: 'Deactivate branch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Al Barsha centre?' });
    expect(within(dialog).getByText(/only active branch/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate branch' }));
    await screen.findByText(/this branch is deactivated/i);

    const snapshot = await runtime.onboardingPort.loadSnapshot(noor.organizationId);
    if (snapshot.kind !== 'loaded') {
      throw new Error('expected snapshot');
    }
    expect(snapshot.snapshot.branches.some((branch) => branch.active)).toBe(false);
  });

  test('a stale deactivation is refused and offers the reload path — nothing changes', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveMarina)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });
    runtime.controls.simulateConcurrentBranchEdit(
      blueWave.organizationId,
      fixtureBranches.blueWaveMarina,
    );
    await user.click(screen.getByRole('button', { name: 'Deactivate branch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Dubai Marina pool?' });
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate branch' }));
    expect(await screen.findByText(/changed since you loaded it/i)).toBeInTheDocument();
    const view = await runtime.profilePort.loadOrganizationView(blueWave.organizationId);
    if (view.kind !== 'loaded') {
      throw new Error('expected view');
    }
    expect(
      view.view.branches.find((branch) => branch.id === fixtureBranches.blueWaveMarina)?.active,
    ).toBe(true);
  });

  test('a deactivated branch offers NO reactivation and explains the one-way truth', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchPath(blueWave, fixtureBranches.blueWaveSufouh)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Al Sufouh training pool' });
    expect(await screen.findByText(/can’t be reactivated from the portal/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reactivate|^activate/i })).not.toBeInTheDocument();
    // Already inactive → no deactivation panel either.
    expect(screen.queryByRole('button', { name: 'Deactivate branch' })).not.toBeInTheDocument();
  });
});
