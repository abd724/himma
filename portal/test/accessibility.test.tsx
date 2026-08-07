import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { org1, renderPortal } from './support/render-portal';

describe('accessibility (jest-axe)', () => {
  test('shell + navigation on the dashboard have no violations', async () => {
    const { container } = renderPortal({ initialEntries: [`/o/${org1.id}`] });
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    expect(await axe(container)).toHaveNoViolations();
  });

  test('a backend-later placeholder page has no violations', async () => {
    const { container } = renderPortal({ initialEntries: [`/o/${org1.id}/finance`] });
    await screen.findByRole('heading', { level: 1, name: 'Finance' });
    expect(await axe(container)).toHaveNoViolations();
  });

  test('the open mobile drawer has no violations', async () => {
    const user = userEvent.setup();
    const { container } = renderPortal({ initialEntries: [`/o/${org1.id}`] });
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
    screen.getByRole('dialog', { name: 'Navigation' });
    expect(await axe(container)).toHaveNoViolations();
  });

  test('the open organization menu has no violations', async () => {
    const user = userEvent.setup();
    const { container } = renderPortal({ initialEntries: [`/o/${org1.id}`] });
    await user.click(await screen.findByRole('button', { name: new RegExp(org1.displayName) }));
    screen.getByRole('menu', { name: 'Switch organization' });
    expect(await axe(container)).toHaveNoViolations();
  });

  test('the not-found and organization-missing surfaces have no violations', async () => {
    const unknownRoute = renderPortal({ initialEntries: ['/completely/unknown'] });
    await screen.findByRole('heading', { level: 1, name: 'Page not found' });
    expect(await axe(unknownRoute.container)).toHaveNoViolations();
    unknownRoute.unmount();

    const unknownOrg = renderPortal({ initialEntries: ['/o/not-a-real-organization'] });
    await screen.findByRole('heading', { level: 1, name: "We can't find that organization" });
    expect(await axe(unknownOrg.container)).toHaveNoViolations();
  });
});
