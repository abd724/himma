import { ActionLink } from '../components/ui/action-link';
import { PageHeader } from '../components/ui/page-header';
import { StatusSurface } from '../components/ui/status-surface';
import { usePageTitle } from '../hooks/use-page-title';
import { organizationPath } from '../navigation/nav-items';
import { useActiveOrganization } from '../organization/organization-context';
import styles from './not-found-page.module.css';

/** Route-level not-found outside any organization scope. */
export function NotFoundPage() {
  usePageTitle('Page not found');

  return (
    <StatusSurface
      title="Page not found"
      actions={<ActionLink to="/">Go to the portal</ActionLink>}
    >
      <p>That page doesn&rsquo;t exist. The link may be out of date.</p>
    </StatusSurface>
  );
}

/** Not-found for an unknown section inside a valid organization scope. */
export function OrganizationSectionNotFoundPage() {
  usePageTitle('Page not found');
  const organization = useActiveOrganization();

  return (
    <>
      <PageHeader
        title="Page not found"
        description="That page doesn't exist in this workspace. The link may be out of date — use the navigation to find what you were looking for, or head back to your dashboard."
      />
      <p className={styles.action}>
        <ActionLink to={organizationPath(organization.id)}>Go to Dashboard</ActionLink>
      </p>
    </>
  );
}
