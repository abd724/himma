import { LayoutDashboard } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PlaceholderPanel } from '../components/ui/placeholder-panel';
import { usePageTitle } from '../hooks/use-page-title';
import { useActiveOrganization } from '../organization/organization-context';

export function DashboardPage() {
  usePageTitle('Dashboard');
  const organization = useActiveOrganization();

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`A clear view of ${organization.displayName} on Himma — status, required actions, and what to do next.`}
      />
      <PlaceholderPanel icon={LayoutDashboard} title="Your dashboard is on its way" milestone="portal">
        <p>As the portal takes shape, this page will bring together:</p>
        <ul>
          <li>your organization&rsquo;s verification and storefront status,</li>
          <li>the actions your listings and profile still need,</li>
          <li>a summary of your catalogue by lifecycle state,</li>
          <li>your team and pending invitations.</li>
        </ul>
      </PlaceholderPanel>
    </>
  );
}
