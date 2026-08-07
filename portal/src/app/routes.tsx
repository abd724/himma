import { Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { ErrorSurface } from '../components/error-surface';
import { PortalShell } from '../layouts/portal-shell';
import {
  ActiveOrganizationProvider,
  useAccessibleOrganizations,
  useRouteOrganization,
} from '../organization/organization-context';
import { BookingsPage } from '../pages/bookings-page';
import { BranchesPage } from '../pages/branches-page';
import { BusinessProfilePage } from '../pages/business-profile-page';
import { DashboardPage } from '../pages/dashboard-page';
import { FinancePage } from '../pages/finance-page';
import { ListingsPage } from '../pages/listings-page';
import { NotFoundPage, OrganizationSectionNotFoundPage } from '../pages/not-found-page';
import { OrganizationMissingPage } from '../pages/organization-missing-page';
import { SchedulePage } from '../pages/schedule-page';
import { SettingsPage } from '../pages/settings-page';
import { SupportPage } from '../pages/support-page';
import { TeamPage } from '../pages/team-page';

/**
 * Entry routing: the portal's home is the first accessible organization's
 * dashboard. W2-2 replaces this with real session/membership resolution
 * (sign-in, org selection); the shell only needs a deterministic landing.
 */
function RootRedirect() {
  const organizations = useAccessibleOrganizations();
  const first = organizations[0];
  if (!first) {
    return <OrganizationMissingPage />;
  }
  return <Navigate to={`/o/${first.id}`} replace />;
}

/** Resolves `/o/:organizationId` and mounts the org-scoped shell. */
function OrganizationScope() {
  const organization = useRouteOrganization();
  if (!organization) {
    return <OrganizationMissingPage />;
  }
  return (
    <ActiveOrganizationProvider organization={organization}>
      <PortalShell>
        <Outlet />
      </PortalShell>
    </ActiveOrganizationProvider>
  );
}

/**
 * Route architecture (docs/29 §6): organization-scoped sections under
 * `/o/:organizationId/...` plus minimal application-level entry/not-found
 * routes. Access/auth routes (sign-in, invitation, MFA, step-up) are W2-2.
 */
export const portalRoutes: RouteObject[] = [
  {
    path: '/',
    errorElement: <ErrorSurface />,
    children: [
      { index: true, element: <RootRedirect /> },
      { path: 'o', element: <RootRedirect /> },
      {
        path: 'o/:organizationId',
        element: <OrganizationScope />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'listings', element: <ListingsPage /> },
          { path: 'schedule', element: <SchedulePage /> },
          { path: 'bookings', element: <BookingsPage /> },
          { path: 'branches', element: <BranchesPage /> },
          { path: 'team', element: <TeamPage /> },
          { path: 'profile', element: <BusinessProfilePage /> },
          { path: 'finance', element: <FinancePage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'support', element: <SupportPage /> },
          { path: '*', element: <OrganizationSectionNotFoundPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
