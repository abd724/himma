import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFixtureAdminRuntime } from '../src/services/mock/fixture-admin';
import { renderAdmin } from './support/render-admin';

/**
 * W3-7 taxonomy administration (AD-06) over the deterministic fixture
 * runtime: the four DISTINCT resource types with the CERTIFIED S4
 * semantics — inactive rows stay administrable, slugs are immutable (no
 * edit path exists), retirement is deactivation / collection state (no
 * delete control exists anywhere), activity types keep their parent for
 * life, CAS staleness refuses without partial change, and mutations honour
 * the action-level step-up seam while the read stays baseline.
 */

function opsRuntime() {
  const runtime = createFixtureAdminRuntime();
  runtime.seedSession('ops@himma.demo');
  return runtime;
}

describe('the taxonomy workspace (four distinct resource types)', () => {
  test('categories load by default, inactive rows included, with slug identity and status', async () => {
    renderAdmin({ runtime: opsRuntime(), initialEntries: ['/taxonomy'] });
    await screen.findByRole('button', { name: 'Water Sports' });
    expect(screen.getByRole('button', { name: 'Retired Category' })).toBeInTheDocument();
    const retiredRow = screen.getByRole('button', { name: 'Retired Category' }).closest('tr')!;
    expect(within(retiredRow).getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByText('water-sports')).toBeInTheDocument();
    // No destructive or unsupported controls exist anywhere.
    expect(screen.queryByRole('button', { name: /delete|remove|reorder/i })).toBeNull();
  });

  test('activity types show their lifetime parent category; areas and collections keep their own identities', async () => {
    const user = userEvent.setup();
    renderAdmin({ runtime: opsRuntime(), initialEntries: ['/taxonomy'] });
    await screen.findByRole('button', { name: 'Water Sports' });

    await user.click(screen.getByRole('button', { name: 'Activity types' }));
    await screen.findByRole('button', { name: 'Swimming' });
    const squashRow = screen.getByRole('button', { name: 'Squash' }).closest('tr')!;
    expect(within(squashRow).getByText('Racquet Sports')).toBeInTheDocument();
    expect(within(squashRow).getByText('Inactive')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Areas' }));
    await screen.findByRole('button', { name: 'Dubai Marina' });
    expect(screen.getByRole('button', { name: 'Old Town' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collections' }));
    await screen.findByRole('button', { name: 'Summer Camps' });
    const campsRow = screen.getByRole('button', { name: 'Summer Camps' }).closest('tr')!;
    expect(within(campsRow).getByText('published')).toBeInTheDocument();
    expect(within(campsRow).getByText('Featured')).toBeInTheDocument();
  });
});

describe('creation and editing (certified mutable fields only)', () => {
  test('creates a category through the port and shows it in the table', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    const createSpy = jest.spyOn(runtime.taxonomyPort, 'createCategory');
    renderAdmin({ runtime, initialEntries: ['/taxonomy'] });
    await screen.findByRole('button', { name: 'Water Sports' });

    await user.type(screen.getByLabelText('Slug (permanent identifier)'), 'martial-arts');
    await user.type(screen.getByLabelText('Label (English)'), 'Martial Arts');
    await user.click(screen.getByRole('button', { name: 'Create category' }));
    await screen.findByRole('button', { name: 'Martial Arts' });
    expect(createSpy).toHaveBeenLastCalledWith({ slug: 'martial-arts', labelEn: 'Martial Arts' });
  });

  test('a duplicate slug is the distinct typed conflict, never a silent overwrite', async () => {
    const user = userEvent.setup();
    renderAdmin({ runtime: opsRuntime(), initialEntries: ['/taxonomy'] });
    await screen.findByRole('button', { name: 'Water Sports' });
    await user.type(screen.getByLabelText('Slug (permanent identifier)'), 'water-sports');
    await user.type(screen.getByLabelText('Label (English)'), 'Duplicate');
    await user.click(screen.getByRole('button', { name: 'Create category' }));
    await screen.findByText(/already used by another item/);
  });

  test('editing exposes NO slug input — the stable identifier is explicitly immutable', async () => {
    const user = userEvent.setup();
    renderAdmin({ runtime: opsRuntime(), initialEntries: ['/taxonomy'] });
    await screen.findByRole('button', { name: 'Water Sports' });
    await user.click(screen.getByRole('button', { name: 'Water Sports' }));
    const editor = await screen.findByRole('form', { name: 'Edit Water Sports' });
    expect(within(editor).getByText(/stable identifier, cannot be changed/)).toBeInTheDocument();
    // Exactly the mutable fields: label + sort — no slug field exists.
    expect(within(editor).queryByLabelText(/slug/i)).toBeNull();
    await user.clear(within(editor).getByLabelText('Label (English)'));
    await user.type(within(editor).getByLabelText('Label (English)'), 'Water & Beach Sports');
    await user.click(within(editor).getByRole('button', { name: 'Save category' }));
    await screen.findByRole('button', { name: 'Water & Beach Sports' });
  });

  test('an activity type editor pins the parent category for life', async () => {
    const user = userEvent.setup();
    renderAdmin({ runtime: opsRuntime(), initialEntries: ['/taxonomy?type=activity-types'] });
    await user.click(await screen.findByRole('button', { name: 'Swimming' }));
    const editor = await screen.findByRole('form', { name: 'Edit Swimming' });
    expect(within(editor).getByText(/fixed at creation, cannot be\s+changed/)).toBeInTheDocument();
    expect(within(editor).queryByLabelText(/category/i)).toBeNull();
  });

  test('deactivation retires an item in place — it stays administrable, nothing disappears', async () => {
    const user = userEvent.setup();
    renderAdmin({ runtime: opsRuntime(), initialEntries: ['/taxonomy?type=areas'] });
    await user.click(await screen.findByRole('button', { name: 'Dubai Marina' }));
    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));
    const row = (await screen.findByRole('button', { name: 'Dubai Marina' })).closest('tr')!;
    await within(row).findByText('Inactive');
  });

  test('a collection edits its editorial fields and lifecycle state (archive, never delete)', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    const updateSpy = jest.spyOn(runtime.taxonomyPort, 'updateCollection');
    renderAdmin({ runtime, initialEntries: ['/taxonomy?type=collections'] });
    await user.click(await screen.findByRole('button', { name: 'Summer Camps' }));
    const editor = await screen.findByRole('form', { name: 'Edit Summer Camps' });
    await user.selectOptions(within(editor).getByLabelText('Lifecycle state'), 'archived');
    await user.click(within(editor).getByRole('button', { name: 'Save collection' }));
    const row = (await screen.findByRole('button', { name: 'Summer Camps' })).closest('tr')!;
    await within(row).findByText('archived');
    expect(updateSpy).toHaveBeenLastCalledWith('coll-summer-camps', {
      expectedVersion: 2,
      patch: {
        titleEn: 'Summer Camps',
        subtitleEn: 'Full-day and half-day camps across the city.',
        audience: 'children',
        featured: true,
        seasonalLabel: 'Summer',
        state: 'archived',
      },
    });
  });

  test('a STALE edit is refused without partial change and the view refreshes', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/taxonomy?type=areas'] });
    await user.click(await screen.findByRole('button', { name: 'Dubai Marina' }));
    const editor = await screen.findByRole('form', { name: 'Edit Dubai Marina' });
    // A concurrent administrator bumps the version behind this editor.
    await runtime.taxonomyPort.updateArea('area-dubai-marina', {
      expectedVersion: 1,
      patch: { sortHint: 15 },
    });
    await user.clear(within(editor).getByLabelText('Label (English)'));
    await user.type(within(editor).getByLabelText('Label (English)'), 'Marina District');
    await user.click(within(editor).getByRole('button', { name: 'Save area' }));
    await screen.findByText(/changed while you were editing it/);
    // The stale label never landed.
    expect(screen.queryByRole('button', { name: 'Marina District' })).toBeNull();
  });
});

describe('fixture semantics mirror the certified backend exactly', () => {
  test('a ghost parent category is the typed invalidTaxonomy refusal', async () => {
    const runtime = opsRuntime();
    await expect(
      runtime.taxonomyPort.createActivityType({
        slug: 'ghost-type',
        categoryId: 'cat-never-existed',
        labelEn: 'Ghost',
      }),
    ).resolves.toEqual({ kind: 'invalidTaxonomy' });
  });

  test('the port surface has NO delete/reorder/slug-change operation in any mode', () => {
    const runtime = opsRuntime();
    const methods = Object.keys(runtime.taxonomyPort).sort();
    expect(methods).toEqual(
      [
        'getTaxonomy',
        'createArea',
        'updateArea',
        'createCategory',
        'updateCategory',
        'createActivityType',
        'updateActivityType',
        'createCollection',
        'updateCollection',
      ].sort(),
    );
  });

  test('D-W3-5 ruling: only AVAILABILITY changes honour the step-up demand — reads, creation, and metadata edits stay baseline', async () => {
    const runtime = opsRuntime();
    runtime.controls.demandStepUp();
    await expect(runtime.taxonomyPort.getTaxonomy()).resolves.toMatchObject({ kind: 'loaded' });
    // Ordinary administration proceeds under the open demand (baseline).
    await expect(
      runtime.taxonomyPort.createArea({ slug: 'ruling-area', labelEn: 'Ruling Area' }),
    ).resolves.toEqual({ kind: 'completed' });
    await expect(
      runtime.taxonomyPort.updateArea('area-dubai-marina', {
        expectedVersion: 1,
        patch: { labelEn: 'Dubai Marina West', sortHint: 11 },
      }),
    ).resolves.toEqual({ kind: 'completed' });
    // Availability changes are interrupted — areas and collections alike.
    await expect(
      runtime.taxonomyPort.updateArea('area-dubai-marina', {
        expectedVersion: 2,
        patch: { active: false },
      }),
    ).resolves.toEqual({ kind: 'stepUpRequired' });
    await expect(
      runtime.taxonomyPort.updateCollection('coll-summer-camps', {
        expectedVersion: 2,
        patch: { state: 'archived' },
      }),
    ).resolves.toEqual({ kind: 'stepUpRequired' });
  });
});

describe('authorization and the step-up seam', () => {
  test('an access_admin (no taxonomy.manage) is refused the area — the port is never called', async () => {
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('access@himma.demo');
    const spy = jest.spyOn(runtime.taxonomyPort, 'getTaxonomy');
    renderAdmin({ runtime, initialEntries: ['/taxonomy'] });
    await screen.findByRole('heading', { name: 'This area isn’t part of your role' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('an action-level step-up demand interrupts a change; re-verification clears it and the change then succeeds', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/taxonomy?type=areas'] });
    await user.click(await screen.findByRole('button', { name: 'Dubai Marina' }));
    await screen.findByRole('form', { name: 'Edit Dubai Marina' });

    runtime.controls.demandStepUp();
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await screen.findByText(/needs a fresh verification of your identity/);
    await user.type(screen.getByLabelText('Verification code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Confirm identity' }));
    await screen.findByText(/Identity re-verified/);

    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    const row = (await screen.findByRole('button', { name: 'Dubai Marina' })).closest('tr')!;
    await within(row).findByText('Inactive');
  });

  test('a backend outage is a truthful error state with retry — never fixture fallback', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    runtime.controls.setProvidersOutage(true);
    renderAdmin({ runtime, initialEntries: ['/taxonomy'] });
    // The query layer retries once before surfacing the failure.
    await screen.findByText(/couldn’t load the taxonomy/, undefined, { timeout: 4000 });
    runtime.controls.setProvidersOutage(false);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Water Sports' });
  });
});
