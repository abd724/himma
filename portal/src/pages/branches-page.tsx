import { MapPin } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PlaceholderPanel } from '../components/ui/placeholder-panel';
import { usePageTitle } from '../hooks/use-page-title';

export function BranchesPage() {
  usePageTitle('Branches');

  return (
    <>
      <PageHeader
        title="Branches"
        description="Manage your locations — addresses, opening hours, and facilities."
      />
      <PlaceholderPanel icon={MapPin} title="Branch management is being built" milestone="portal">
        <p>
          You will add and edit your branches here. Customers see active branches on your storefront
          and on each listing that runs there.
        </p>
      </PlaceholderPanel>
    </>
  );
}
