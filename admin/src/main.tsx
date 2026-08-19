import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
import './theme/tokens.css';
import './theme/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { adminEnv } from './api/env';
import { AppProviders } from './app/app';
import { createAuthRuntime } from './app/auth-runtime';
import { adminRoutes } from './app/routes';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root container');
}

const router = createBrowserRouter(adminRoutes);
// Fail-closed composition: production resolves to the unconfigured runtime
// unless fixture mode is explicitly opted in; live is always explicit.
const authRuntime = createAuthRuntime(adminEnv());

createRoot(container).render(
  <StrictMode>
    <AppProviders authRuntime={authRuntime}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
