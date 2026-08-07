import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AccessibleOrganizationsProvider, type ShellOrganization } from '../organization/organization-context';
import { fixtureOrganizations } from '../services/mock/fixture-organizations';
import { AppErrorBoundary } from './app-error-boundary';
import { createQueryClient } from './query-client';

/**
 * Application providers, shared by the real entry point and tests.
 * The accessible-organization source defaults to the isolated shell fixture;
 * W2-2 swaps the source for real membership resolution at this single seam.
 */
export function AppProviders({
  children,
  queryClient,
  organizations = fixtureOrganizations,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
  organizations?: readonly ShellOrganization[];
}) {
  const [ownedClient] = useState(() => queryClient ?? createQueryClient());

  return (
    <AppErrorBoundary>
      <QueryClientProvider client={ownedClient}>
        <AccessibleOrganizationsProvider organizations={organizations}>
          {children}
        </AccessibleOrganizationsProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
