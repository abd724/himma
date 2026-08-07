import { ClipboardList } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PlaceholderPanel } from '../components/ui/placeholder-panel';
import { usePageTitle } from '../hooks/use-page-title';

export function ListingsPage() {
  usePageTitle('Listings');

  return (
    <>
      <PageHeader
        title="Listings"
        description="Create and manage the programs you offer on Himma — details, eligibility, pricing options, media, and offers."
      />
      <PlaceholderPanel icon={ClipboardList} title="The listings workspace is being built" milestone="portal">
        <p>
          You will create programs here, keep their details and pricing up to date, submit them for
          review, and publish them to the Himma catalogue.
        </p>
      </PlaceholderPanel>
    </>
  );
}
