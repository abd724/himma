import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { fixtureOrganizations } from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const importPath = `/o/${fixtureOrganizations.blueWave.organizationId}/listings/import`;

function csvFile(content: string, name = 'catalogue.csv'): File {
  return new File([content], name, { type: 'text/csv' });
}

const MIXED_CSV = [
  'title_en,activity_type,setting,who_for,price_kind,price_aed',
  'Good Row Aqua,Aqua Fitness,Indoor,Everyone,Monthly,390',
  'Bad Row,Nope,Indoor,Everyone,Monthly,390',
].join('\n');

describe('bulk-import accessibility (jest-axe, W2-10)', () => {
  test('initial instructions and file selection', async () => {
    const page = renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [importPath] });
    await screen.findByText('Choose a CSV file');
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('column-mapping state', async () => {
    const user = userEvent.setup();
    const page = renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [importPath] });
    await screen.findByText('Choose a CSV file');
    await user.upload(screen.getByLabelText('Choose a CSV file'), csvFile(MIXED_CSV));
    await screen.findByRole('heading', { name: 'Match your columns' });
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('mixed validation report (errors + warnings + summary)', async () => {
    const user = userEvent.setup();
    const page = renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [importPath] });
    await screen.findByText('Choose a CSV file');
    await user.upload(screen.getByLabelText('Choose a CSV file'), csvFile(MIXED_CSV));
    await screen.findByRole('heading', { name: 'Match your columns' });
    await user.click(screen.getByRole('button', { name: 'Run the validation preview' }));
    await screen.findByRole('heading', { name: 'Validation preview' });
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('fully blocked file (file-level failure)', async () => {
    const user = userEvent.setup();
    const page = renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [importPath] });
    await screen.findByText('Choose a CSV file');
    await user.upload(screen.getByLabelText('Choose a CSV file'), csvFile('title_en\n"broken'));
    await screen.findByText(/unclosed quote/);
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('no-access surface', async () => {
    const page = renderPortal({ asIdentity: 'finance@bluewave.demo', initialEntries: [importPath] });
    await screen.findByText('Importing is managed by your catalogue team');
    expect(await axe(page.container)).toHaveNoViolations();
  });
});
