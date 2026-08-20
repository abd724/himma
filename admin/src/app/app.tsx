import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { SessionProvider } from '../auth/session-context';
import type { AdminSessionState } from '../auth/session-machine';
import {
  createUnconfiguredAccessPort,
  createUnconfiguredAuthAdapter,
  createUnconfiguredModerationPort,
  createUnconfiguredProvidersPort,
  createUnconfiguredTaxonomyPort,
  createUnconfiguredVerificationPort,
} from '../auth/unconfigured';
import type { AdminProvidersReadPort } from '../providers/contract';
import type { AdminVerificationPort } from '../verification/contract';
import type { AdminModerationPort } from '../moderation/contract';
import type { AdminTaxonomyPort } from '../taxonomy/contract';
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
        providersPort: createUnconfiguredProvidersPort(),
        verificationPort: createUnconfiguredVerificationPort(),
        moderationPort: createUnconfiguredModerationPort(),
        taxonomyPort: createUnconfiguredTaxonomyPort(),
      },
  );

  return (
    <QueryClientProvider client={ownedClient}>
      <ProvidersPortContext.Provider value={runtime.providersPort}>
        <VerificationPortContext.Provider value={runtime.verificationPort}>
          <ModerationPortContext.Provider value={runtime.moderationPort}>
            <TaxonomyPortContext.Provider value={runtime.taxonomyPort}>
              <SessionProvider
                adapter={runtime.adapter}
                accessPort={runtime.accessPort}
                {...(initialSessionState ? { initialState: initialSessionState } : {})}
              >
                {children}
              </SessionProvider>
            </TaxonomyPortContext.Provider>
          </ModerationPortContext.Provider>
        </VerificationPortContext.Provider>
      </ProvidersPortContext.Provider>
    </QueryClientProvider>
  );
}

const ProvidersPortContext = createContext<AdminProvidersReadPort | null>(null);
const VerificationPortContext = createContext<AdminVerificationPort | null>(null);
const ModerationPortContext = createContext<AdminModerationPort | null>(null);
const TaxonomyPortContext = createContext<AdminTaxonomyPort | null>(null);

/** The composed provider-directory read port (fixture/live/unconfigured). */
export function useProvidersPort(): AdminProvidersReadPort {
  const port = useContext(ProvidersPortContext);
  if (port === null) {
    throw new Error('useProvidersPort requires AppProviders');
  }
  return port;
}

/** The composed moderation port (fixture/live/unconfigured). */
export function useModerationPort(): AdminModerationPort {
  const port = useContext(ModerationPortContext);
  if (port === null) {
    throw new Error('useModerationPort requires AppProviders');
  }
  return port;
}

/** The composed taxonomy administration port (fixture/live/unconfigured). */
export function useTaxonomyPort(): AdminTaxonomyPort {
  const port = useContext(TaxonomyPortContext);
  if (port === null) {
    throw new Error('useTaxonomyPort requires AppProviders');
  }
  return port;
}

/** The composed verification review port (fixture/live/unconfigured). */
export function useVerificationPort(): AdminVerificationPort {
  const port = useContext(VerificationPortContext);
  if (port === null) {
    throw new Error('useVerificationPort requires AppProviders');
  }
  return port;
}
