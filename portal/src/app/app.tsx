import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { SessionProvider } from '../auth/session-context';
import type { PortalSessionState } from '../auth/session-machine';
import {
  createUnconfiguredAccessPort,
  createUnconfiguredAuthAdapter,
} from '../auth/unconfigured-adapter';
import { AppErrorBoundary } from './app-error-boundary';
import type { AuthRuntime } from './auth-runtime';
import { createQueryClient } from './query-client';

/**
 * Application providers, shared by the real entry point and tests.
 * The entry point composes the environment-resolved auth runtime
 * (main.tsx); with no runtime supplied the default is the UNCONFIGURED
 * fail-closed pair, so nothing can accidentally grant access.
 * `initialSessionState` is a TEST-ONLY seam, never wired to configuration.
 */
export function AppProviders({
  children,
  queryClient,
  authRuntime,
  initialSessionState,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
  authRuntime?: AuthRuntime;
  initialSessionState?: PortalSessionState;
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
    <AppErrorBoundary>
      <QueryClientProvider client={ownedClient}>
        <SessionProvider
          adapter={runtime.adapter}
          accessPort={runtime.accessPort}
          {...(initialSessionState ? { initialState: initialSessionState } : {})}
        >
          {children}
        </SessionProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
