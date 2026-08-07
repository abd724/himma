import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../auth/session-context';
import { safeReturnTo } from '../auth/return-to';
import {
  AccessibleOrganizationsProvider,
  useAccessibleOrganizations,
  type ShellOrganization,
} from '../organization/organization-context';
import {
  AccessUnavailablePage,
  BootstrapLoading,
  NoMembershipPage,
  PortalUnavailableSurface,
} from '../pages/access/session-surfaces';
import { withReturnTo } from '../pages/access/use-access-navigation';

/**
 * Layered route guard for the provider-private zone (task §10). Guards shape
 * UX only — the backend remains the security boundary. Order:
 * session state → MFA completeness → MFA enrollment → resolved membership.
 * No protected content renders before bootstrap resolution.
 */
export function RequireProviderAccess() {
  const session = useSession();
  const location = useLocation();
  const currentPath = `${location.pathname}${location.search}`;
  const returnTo = currentPath === '/' ? null : safeReturnTo(currentPath);

  switch (session.status) {
    case 'bootstrapping':
    case 'authenticating':
    case 'resolvingAccess':
      return <BootstrapLoading />;
    case 'unavailable':
      return <PortalUnavailableSurface />;
    case 'signedOut':
      // A deliberate sign-out lands on its confirmation; everything else
      // (initial load, expiry) goes to sign-in with the destination kept.
      return session.reason === 'signedOut' ? (
        <Navigate to="/signed-out" replace />
      ) : (
        <Navigate to={withReturnTo('/sign-in', returnTo)} replace />
      );
    case 'mfaChallenge':
      return <Navigate to={withReturnTo('/mfa', returnTo)} replace />;
    case 'noMembership':
      return session.assurance === 'single_factor' ? (
        <Navigate to="/mfa/enroll" replace />
      ) : (
        <NoMembershipPage />
      );
    case 'accessUnavailable':
      return <AccessUnavailablePage />;
    case 'active': {
      if (session.assurance === 'single_factor') {
        return <Navigate to="/mfa/enroll" replace />;
      }
      const organizations: ShellOrganization[] = session.memberships.map((membership) => ({
        id: membership.organizationId,
        displayName: membership.displayName,
        organizationState: membership.organizationState,
      }));
      return (
        <AccessibleOrganizationsProvider organizations={organizations}>
          <Outlet />
        </AccessibleOrganizationsProvider>
      );
    }
  }
}

/** `/` and `/o`: land on the first accessible workspace. */
export function WorkspaceRedirect() {
  const organizations = useAccessibleOrganizations();
  const first = organizations[0];
  // Unreachable in practice (active state implies ≥1 membership) — fail safe.
  if (!first) {
    return <NoMembershipPage />;
  }
  return <Navigate to={`/o/${first.id}`} replace />;
}
