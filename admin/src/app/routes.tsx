import { Navigate, useLocation } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import { useSession } from '../auth/session-context';
import { canAccessPath } from './nav-model';
import { AccessGate } from '../shell/access-gate';
import { AdminShell } from '../shell/admin-shell';
import { DashboardPage } from '../pages/dashboard-page';
import {
  NoCapabilityPage,
  NotFoundPage,
  PlaceholderPage,
} from '../pages/placeholder-page';

/**
 * Route protection (task §18): AccessGate admits ONLY an `active` session
 * (valid Himma session + MFA + recent factor + a real `/admin/me`
 * resolution) into the shell; GuardedArea then applies the capability gate
 * per surface. All of this is UX — every future backend endpoint stays
 * independently authorized by the `admin` policy and its role checks.
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
      {
        path: 'providers',
        element: area(
          <PlaceholderPage
            title="Providers"
            slice="W3-2"
            description="The provider directory, review queue, and organization detail connect to new real admin reads in W3-2. Nothing is shown here until that truth exists."
          />,
        ),
      },
      {
        path: 'verification',
        element: area(
          <PlaceholderPage
            title="Verification"
            slice="W3-3–W3-5"
            description="Verification cases, evidence review, and decisions arrive with the verification domain (W3-3), its private document storage (W3-4), and the review workflow (W3-5)."
          />,
        ),
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
