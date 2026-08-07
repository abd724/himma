import { QueryClient } from '@tanstack/react-query';

/**
 * TanStack Query foundation (docs/29 §13). Production-sensible defaults;
 * domain queries arrive with their own tasks. The client is created per app
 * instance (never a module singleton) so tests own their cache lifecycle.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
