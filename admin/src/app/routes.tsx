import { Navigate, useLocation } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import { useSession } from '../auth/session-context';
import { canAccessPath } from './nav-model';
import { AccessGate } from '../shell/access-gate';
import { AdminShell } from '../shell/admin-shell';
import { DashboardPage } from '../pages/dashboard-page';
import { ProvidersIndexPage } from '../pages/providers/providers-index-page';
import { ProviderDetailPage } from '../pages/providers/provider-detail-page';
import {
  NoCapabilityPage,
  NotFoundPage,
  PlaceholderPage,
} from '../pages/placeholder-page';

/**
 * Route protection (task §18): AccessGate admits ONLY an `active` session
 * (valid Himma session + MFA assurance + a real `/admin/me` resolution —
 * the W3-1 baseline; no recent-factor demand) into the shell; GuardedArea
 * then applies the capability gate per surface. All of this is UX — every
 * backend endpoint stays independently authorized by its admin policy and
 * role checks.
 */
function AdminRoot() {
  return (
    <AccessGate>
      <ActiveShell />
    </AccessGate>
  );
}

function ActiveShell() {
  const session = useSession();
  if (session.status !== 'active') {
    return null; // AccessGate owns every other state
  }
  return <AdminShell access={session.access} />;
}

function GuardedArea({ children }: { children: React.ReactElement }) {
  const session = useSession();
  const location = useLocation();
  if (session.status !== 'active') {
    return null;
  }
  if (!canAccessPath(session.access, location.pathname)) {
    return <NoCapabilityPage />;
  }
  return children;
}

const area = (element: React.ReactElement) => <GuardedArea>{element}</GuardedArea>;

export const adminRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AdminRoot />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: area(<DashboardPage />) },
      { path: 'providers', element: area(<ProvidersIndexPage />) },
      { path: 'providers/:organizationId', element: area(<ProviderDetailPage />) },
      {
        // W3-5: verification work happens from the review queue and each
        // provider's detail workspace — the nav entry lands on the queue.
        path: 'verification',
        element: <Navigate to="/providers?view=queue" replace />,
      },
      {
        path: 'moderation',
        element: area(
          <PlaceholderPage
            title="Catalogue moderation"
            slice="W3-6"
            description="The listing review queue consumes the existing backend moderation contracts in W3-6. Approval rests at approved — publication stays with the provider."
          />,
        ),
      },
      {
        path: 'revisions',
        element: area(
          <PlaceholderPage
            title="Revision moderation"
            slice="W3-6"
            description="Protected-change review over the existing ProgramRevision contracts (including the reviewer change-set) connects in W3-6."
          />,
        ),
      },
      {
        path: 'taxonomy',
        element: area(
          <PlaceholderPage
            title="Taxonomy"
            slice="W3-7"
            description="Categories, activity types, areas, and collections management over the existing admin taxonomy contracts connects in W3-7."
          />,
        ),
      },
      {
        path: 'access',
        element: area(
          <PlaceholderPage
            title="Access administration"
            slice="W3-9"
            description="Role assignment review and administration over the existing dual-control backend connects in W3-9, together with the admin step-up policy."
          />,
        ),
      },
      {
        path: 'audit',
        element: area(
          <PlaceholderPage
            title="Audit"
            slice="W3-9"
            description="The audit explorer read arrives in W3-9. Every sensitive administrative action is already audited server-side."
          />,
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
