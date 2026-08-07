import { Ticket } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PlaceholderPanel } from '../components/ui/placeholder-panel';
import { usePageTitle } from '../hooks/use-page-title';

export function BookingsPage() {
  usePageTitle('Bookings');

  return (
    <>
      <PageHeader
        title="Bookings"
        description="Follow bookings as they arrive, run your sessions, and record attendance."
      />
      <PlaceholderPanel icon={Ticket} title="Bookings arrive with the booking platform" milestone="platform">
        <p>
          When customers can book your activities through Himma, this page will show who is coming
          to each session and help your team run the day.
        </p>
      </PlaceholderPanel>
    </>
  );
}
