import { Store } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PlaceholderPanel } from '../components/ui/placeholder-panel';
import { usePageTitle } from '../hooks/use-page-title';

export function BusinessProfilePage() {
  usePageTitle('Business Profile');

  return (
    <>
      <PageHeader
        title="Business Profile"
        description="Your organization's details and your public storefront — what customers see on Himma."
      />
      <PlaceholderPanel icon={Store} title="Profile editing is being built" milestone="portal">
        <p>
          You will maintain your business information here and shape your public storefront — the
          display name, story, contact details, and photos customers browse on Himma.
        </p>
      </PlaceholderPanel>
    </>
  );
}
