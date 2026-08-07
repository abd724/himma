import { CalendarDays } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PlaceholderPanel } from '../components/ui/placeholder-panel';
import { usePageTitle } from '../hooks/use-page-title';

export function SchedulePage() {
  usePageTitle('Schedule');

  return (
    <>
      <PageHeader
        title="Schedule"
        description="Plan recurring schedules, sessions, and camp weeks, and manage their capacity."
      />
      <PlaceholderPanel icon={CalendarDays} title="Scheduling arrives with session management" milestone="platform">
        <p>
          Once scheduling is available on Himma, you will plan your weekly patterns, publish
          sessions and camp weeks, and manage capacity from this page.
        </p>
      </PlaceholderPanel>
    </>
  );
}
