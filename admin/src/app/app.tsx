import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { SessionProvider } from '../auth/session-context';
import type { AdminSessionState } from '../auth/session-machine';
import {
  createUnconfiguredAccessPort,
  createUnconfiguredAuthAdapter,
} from '../auth/unconfigured';
import type { AuthRuntime } from './auth-runtime';

/**
 * Application providers, shared by the real entry point and tests. With no
 * runtime supplied the default is the UNCONFIGURED fail-closed pair, so
 * nothing can accidentally grant admin access.
 * `initialSessionState` is a TEST-ONLY seam, never wired to configuration.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
      mutations: { retry: 0 },
    },
  });
}

export function AppProviders({
  children,
  queryClient,
  authRuntime,
  initialSessionState,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
  authRuntime?: AuthRuntime;
  initialSessionState?: AdminSessionState;
}) {
  const [ownedClient] = useState(() => queryClient ?? createQueryClient());
  const [runtime] = useState<AuthRuntime>(
    () =>
      authRuntime ?? {
        mode: 'unconfigured',
        adapter: createUnconfiguredAuthAdapter(),
        accessPort: createUnconfiguredAccessPort(),
      },
  );

  return (
    <QueryClientProvider client={ownedClient}>
      <SessionProvider
        adapter={runtime.adapter}
        accessPort={runtime.accessPort}
        {...(initialSessionState ? { initialState: initialSessionState } : {})}
      >
        {children}
      </SessionProvider>
    </QueryClientProvider>
  );
}
