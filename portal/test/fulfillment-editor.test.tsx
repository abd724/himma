import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fixtureListings, fixtureOrganizations } from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

/**
 * Fulfillment terms editor (W2-13 §4–7) over the semantic fixture: the
 * block renders only for the entitlement kinds (package/membership) on
 * active options, terms save through the real supersede-and-insert port
 * with the truthful "future purchases only" note, membership stays
 * commercial vocabulary only (finite/unlimited decided HERE), the
 * validation mirror refuses impossible combinations, and a membership
 * price option can be created at AED 0 (the S6-1 zero-price acquisition
 * path).
 */

const blueWave = fixtureOrganizations.blueWave;
const editPath = (programId: string) =>
  `/o/${blueWave.organizationId}/listings/${programId}/edit`;

describe('fulfillment terms on entitlement price options', () => {
  test('the package option carries a Fulfillment block; capacity options carry none', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.privateCoaching)],
    });
    const heading = await screen.findByRole('heading', { name: 'Fulfillment — 8 sessions' });
    expect(heading).toBeInTheDocument();
    // Exactly ONE fulfillment block on this listing — its only option is
    // the package; a capacity option would never grow one.
    expect(screen.getAllByRole('heading', { name: /^Fulfillment — / })).toHaveLength(1);
    expect(await screen.findByText(/No fulfillment terms yet/)).toBeInTheDocument();
  });

  test('setting package terms saves an immutable revision and states the future-purchases-only rule', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { name: 'Fulfillment — 8 sessions' });
    await screen.findByText(/No fulfillment terms yet/);
    await user.click(screen.getByRole('button', { name: 'Set terms' }));

    const form = screen.getByRole('form', { name: 'Fulfillment terms for 8 sessions' });
    // The historical-terms rule is stated BEFORE saving, not after.
    expect(
      within(form).getByText(/Changes apply to future purchases only/),
    ).toBeInTheDocument();
    // A package's total IS its sessions count — no visits input renders.
    expect(
      within(form).getByText(/A package is a fixed number of visits/),
    ).toBeInTheDocument();
    expect(within(form).queryByLabelText('Visits included')).not.toBeInTheDocument();

    await user.type(within(form).getByLabelText(/Valid for \(days\)/), '90');
    await user.click(within(form).getByRole('button', { name: 'Save terms' }));

    expect(
      await screen.findByText(/Fulfillment terms saved\. They apply to future purchases only/),
    ).toBeInTheDocument();
    // The active revision is re-read from the port — never assumed.
    expect(
      await screen.findByText(/One visit per package session, valid 90 days from purchase/),
    ).toBeInTheDocument();
  });

  test('a change supersedes: saving new terms replaces the ACTIVE revision the editor shows', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { name: 'Fulfillment — 8 sessions' });
    await user.click(await screen.findByRole('button', { name: 'Set terms' }));
    let form = screen.getByRole('form', { name: 'Fulfillment terms for 8 sessions' });
    await user.type(within(form).getByLabelText(/Valid for \(days\)/), '60');
    await user.click(within(form).getByRole('button', { name: 'Save terms' }));
    await screen.findByText(/valid 60 days from purchase/);

    await user.click(screen.getByRole('button', { name: 'Change terms' }));
    form = screen.getByRole('form', { name: 'Fulfillment terms for 8 sessions' });
    const days = within(form).getByLabelText(/Valid for \(days\)/);
    await user.clear(days);
    await user.type(days, '120');
    await user.click(within(form).getByRole('button', { name: 'Save terms' }));
    await waitFor(() =>
      expect(screen.getByText(/valid 120 days from purchase/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/valid 60 days from purchase/)).not.toBeInTheDocument();
  });

  test('membership is created as COMMERCIAL vocabulary at AED 0, and its fulfillment decides finite vs unlimited', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.holidayCamp)],
    });
    await screen.findByRole('heading', { level: 1, name: /Holiday Swim Camp/ });

    // Add a membership price option priced at AED 0 — legal for the
    // entitlement kinds (zero-price acquisition), refused for capacity.
    await user.click(await screen.findByRole('button', { name: 'Add price option' }));
    await user.click(screen.getByRole('radio', { name: 'Membership' }));
    await user.type(screen.getByLabelText(/Price \(AED\)/), '0');
    await user.type(screen.getByLabelText(/Label \(optional\)/), 'Founders pass');
    await user.click(screen.getByRole('button', { name: 'Save option' }));
    await screen.findByText('Price option added.');

    // The new membership option grows its own fulfillment block, where the
    // finite/unlimited decision lives (D-S6-3 — never in the kind).
    await screen.findByRole('heading', { name: 'Fulfillment — Founders pass' });
    await user.click(
      within(
        screen.getByRole('heading', { name: 'Fulfillment — Founders pass' }).closest('section')!,
      ).getByRole('button', { name: 'Set terms' }),
    );
    const form = screen.getByRole('form', { name: 'Fulfillment terms for Founders pass' });
    expect(within(form).getByLabelText(/Access/)).toBeInTheDocument();

    // The validation mirror: unlimited access with no validity is refused
    // BEFORE the server would refuse it.
    await user.selectOptions(within(form).getByLabelText(/Access/), 'unlimited');
    await user.selectOptions(within(form).getByLabelText(/Validity/), 'fixedEndDate');
    await user.selectOptions(within(form).getByLabelText(/Validity/), 'daysFromConfirmation');
    await user.click(within(form).getByRole('button', { name: 'Save terms' }));
    expect(
      await within(form).findByText(/Enter how many days the purchase stays valid/),
    ).toBeInTheDocument();

    await user.type(within(form).getByLabelText(/Valid for \(days\)/), '30');
    await user.click(within(form).getByRole('button', { name: 'Save terms' }));
    await screen.findByText(/Fulfillment terms saved/);
    expect(await screen.findByText(/Unlimited visits, valid 30 days from purchase/)).toBeInTheDocument();
  });

  test('a limited membership requires a whole number of visits — the finite mirror', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.holidayCamp)],
    });
    await user.click(await screen.findByRole('button', { name: 'Add price option' }));
    await user.click(screen.getByRole('radio', { name: 'Membership' }));
    await user.type(screen.getByLabelText(/Price \(AED\)/), '600');
    await user.type(screen.getByLabelText(/Label \(optional\)/), '10-visit pass');
    await user.click(screen.getByRole('button', { name: 'Save option' }));
    await screen.findByText('Price option added.');

    const section = screen
      .getByRole('heading', { name: 'Fulfillment — 10-visit pass' })
      .closest('section')!;
    await user.click(within(section).getByRole('button', { name: 'Set terms' }));
    const form = screen.getByRole('form', { name: 'Fulfillment terms for 10-visit pass' });
    await user.type(within(form).getByLabelText(/Valid for \(days\)/), '90');
    await user.click(within(form).getByRole('button', { name: 'Save terms' }));
    expect(
      await within(form).findByText(/A limited membership needs a whole number of visits/),
    ).toBeInTheDocument();

    await user.type(within(form).getByLabelText('Visits included'), '10');
    await user.click(within(form).getByRole('button', { name: 'Save terms' }));
    await screen.findByText(/Fulfillment terms saved/);
    expect(await screen.findByText(/10 visits, valid 90 days from purchase/)).toBeInTheDocument();
  });

  test('choosing NO attendance method is refused — a purchase must be usable somehow', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [editPath(fixtureListings.privateCoaching)],
    });
    await screen.findByRole('heading', { name: 'Fulfillment — 8 sessions' });
    await user.click(await screen.findByRole('button', { name: 'Set terms' }));
    const form = screen.getByRole('form', { name: 'Fulfillment terms for 8 sessions' });
    await user.type(within(form).getByLabelText(/Valid for \(days\)/), '90');
    await user.click(
      within(form).getByLabelText(/Walk-in — show a check-in code at the desk/),
    );
    await user.click(within(form).getByRole('button', { name: 'Save terms' }));
    expect(
      await within(form).findByText(/Choose at least one way to attend/),
    ).toBeInTheDocument();
  });
});
