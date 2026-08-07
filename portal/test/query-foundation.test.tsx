import { useQueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createQueryClient } from '../src/app/query-client';
import { AppProviders } from '../src/app/app';

describe('TanStack Query foundation', () => {
  test('createQueryClient applies production-sensible defaults', () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(30_000);
    expect(defaults.queries?.retry).toBe(1);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
    expect(defaults.mutations?.retry).toBe(0);
  });

  test('AppProviders makes a query client available to the tree', () => {
    function Probe() {
      const client = useQueryClient();
      return <p>{client ? 'query-client-present' : 'missing'}</p>;
    }
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    );
    expect(screen.getByText('query-client-present')).toBeInTheDocument();
  });

  test('AppProviders accepts an externally owned client (testability seam)', () => {
    const client = createQueryClient();
    function Probe() {
      return <p>{useQueryClient() === client ? 'same-client' : 'different'}</p>;
    }
    render(
      <AppProviders queryClient={client}>
        <Probe />
      </AppProviders>,
    );
    expect(screen.getByText('same-client')).toBeInTheDocument();
  });
});
