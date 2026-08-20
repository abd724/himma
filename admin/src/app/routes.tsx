import { Navigate, useLocation } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import { useSession } from '../auth/session-context';
import { canAccessPath } from './nav-model';
import { AccessGate } from '../shell/access-gate';
import { AdminShell } from '../shell/admin-shell';
import { DashboardPage } from '../pages/dashboard-page';
import { ProvidersIndexPage } from '../pages/providers/providers-index-page';
import { ProviderDetailPage } from '../pages/providers/provider-detail-page';
import { ModerationQueuePage } from '../pages/moderation/moderation-queue-page';
import { ModerationDetailPage } from '../pages/moderation/moderation-detail-page';
import { RevisionQueuePage } from '../pages/moderation/revision-queue-page';
import { TaxonomyPage } from '../pages/taxonomy/taxonomy-page';
import { AccessPage } from '../pages/access/access-page';
import { AuditPage } from '../pages/audit/audit-page';
import { NoCapabilityPage, NotFoundPage } from '../pages/placeholder-page';

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
      { path: 'moderation', element: area(<ModerationQueuePage />) },
      { path: 'moderation/:programId', element: area(<ModerationDetailPage />) },
      { path: 'revisions', element: area(<RevisionQueuePage />) },
      { path: 'taxonomy', element: area(<TaxonomyPage />) },
      { path: 'access', element: area(<AccessPage />) },
      { path: 'audit', element: area(<AuditPage />) },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
