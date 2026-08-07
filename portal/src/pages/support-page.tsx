import { LifeBuoy } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PlaceholderPanel } from '../components/ui/placeholder-panel';
import { usePageTitle } from '../hooks/use-page-title';

export function SupportPage() {
  usePageTitle('Support');

  return (
    <>
      <PageHeader
        title="Support"
        description="Get in touch with Himma when you need a hand."
      />
      <PlaceholderPanel icon={LifeBuoy} title="Support contact is being built" milestone="portal">
        <p>
          A direct way to reach the Himma team — and to follow up on your requests — will live
          here.
        </p>
      </PlaceholderPanel>
    </>
  );
}
