import { ActionLink } from '../components/ui/action-link';
import { StatusSurface } from '../components/ui/status-surface';
import { usePageTitle } from '../hooks/use-page-title';

/**
 * Rendered when the route's organization id doesn't resolve to an accessible
 * organization. W2-2 gives this real meaning (membership resolution); the
 * shell keeps deep links from ever landing on a blank screen.
 */
export function OrganizationMissingPage() {
  usePageTitle('Organization not found');

  return (
    <StatusSurface
      title="We can't find that organization"
      actions={<ActionLink to="/">Go to the portal</ActionLink>}
    >
      <p>The link may be out of date, or the organization may not be available to you.</p>
    </StatusSurface>
  );
}
