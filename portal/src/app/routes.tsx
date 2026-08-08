import { Outlet, type RouteObject } from 'react-router-dom';
import { ErrorSurface } from '../components/error-surface';
import { PortalShell } from '../layouts/portal-shell';
import {
  ActiveOrganizationProvider,
  useRouteOrganization,
} from '../organization/organization-context';
import { InvitationPage } from '../pages/access/invitation-page';
import { MfaChallengePage } from '../pages/access/mfa-challenge-page';
import { MfaEnrollPage } from '../pages/access/mfa-enroll-page';
import { WorkspaceUnavailablePage } from '../pages/access/session-surfaces';
import { SignInPage } from '../pages/access/sign-in-page';
import { SignedOutPage } from '../pages/access/signed-out-page';
import { StepUpPage } from '../pages/access/step-up-page';
import { BookingsPage } from '../pages/bookings-page';
import { BranchCreatePage } from '../pages/branches/branch-create-page';
import { BranchDetailPage } from '../pages/branches/branch-detail-page';
import { BranchesPage } from '../pages/branches/branch-list-page';
import { BusinessProfilePage } from '../pages/profile/business-profile-page';
import { DashboardPage } from '../pages/dashboard-page';
import { FinancePage } from '../pages/finance-page';
import { ListingsPage } from '../pages/listings-page';
import { NotFoundPage, OrganizationSectionNotFoundPage } from '../pages/not-found-page';
import { OnboardingPage } from '../pages/onboarding/onboarding-page';
import { SchedulePage } from '../pages/schedule-page';
import { SettingsPage } from '../pages/settings-page';
import { SupportPage } from '../pages/support-page';
import { TeamPage } from '../pages/team/team-list-page';
import { TeamInvitePage } from '../pages/team/team-invite-page';
import { TeamMemberPage } from '../pages/team/team-member-page';
import { RequireProviderAccess, WorkspaceRedirect } from './require-provider-access';

/**
 * Resolves `/o/:organizationId` against the caller's RESOLVED access and
 * mounts the org-scoped shell. An id outside the resolved access renders the
 * safe workspace-unavailable surface — never another organization's shell,
 * never details about the requested id.
 */
function OrganizationScope() {
  const organization = useRouteOrganization();
  if (!organization) {
    return <WorkspaceUnavailablePage />;
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
 * Route architecture (docs/29 §6): the pre-authenticated access zone plus
 * the guarded organization-scoped sections. Frontend guards shape UX only.
 */
export const portalRoutes: RouteObject[] = [
  {
    path: '/',
    errorElement: <ErrorSurface />,
    children: [
      { path: 'sign-in', element: <SignInPage /> },
      { path: 'mfa', element: <MfaChallengePage /> },
      { path: 'mfa/enroll', element: <MfaEnrollPage /> },
      { path: 'step-up', element: <StepUpPage /> },
      { path: 'signed-out', element: <SignedOutPage /> },
      { path: 'invitation/:token', element: <InvitationPage /> },
      {
        element: <RequireProviderAccess />,
        children: [
          { index: true, element: <WorkspaceRedirect /> },
          { path: 'o', element: <WorkspaceRedirect /> },
          {
            path: 'o/:organizationId',
            element: <OrganizationScope />,
            children: [
              { index: true, element: <DashboardPage /> },
              { path: 'onboarding', element: <OnboardingPage /> },
              { path: 'listings', element: <ListingsPage /> },
              { path: 'schedule', element: <SchedulePage /> },
              { path: 'bookings', element: <BookingsPage /> },
              { path: 'branches', element: <BranchesPage /> },
              { path: 'branches/new', element: <BranchCreatePage /> },
              { path: 'branches/:branchId', element: <BranchDetailPage /> },
              { path: 'team', element: <TeamPage /> },
              { path: 'team/invite', element: <TeamInvitePage /> },
              { path: 'team/:membershipId', element: <TeamMemberPage /> },
              { path: 'profile', element: <BusinessProfilePage /> },
              { path: 'finance', element: <FinancePage /> },
              { path: 'settings', element: <SettingsPage /> },
              { path: 'support', element: <SupportPage /> },
              { path: '*', element: <OrganizationSectionNotFoundPage /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
