import { Users } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PlaceholderPanel } from '../components/ui/placeholder-panel';
import { usePageTitle } from '../hooks/use-page-title';

export function TeamPage() {
  usePageTitle('Team');

  return (
    <>
      <PageHeader
        title="Team"
        description="Invite staff, assign roles, and choose which branches each person works with."
      />
      <PlaceholderPanel icon={Users} title="Team management is being built" milestone="portal">
        <p>
          You will invite your staff here and manage what each person can do — from managing the
          whole organization to running sessions at a single branch.
        </p>
      </PlaceholderPanel>
    </>
  );
}
