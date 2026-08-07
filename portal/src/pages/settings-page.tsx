import { LifeBuoy, Settings } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui/page-header';
import { PlaceholderPanel } from '../components/ui/placeholder-panel';
import { usePageTitle } from '../hooks/use-page-title';
import { organizationPath } from '../navigation/nav-items';
import { useActiveOrganization } from '../organization/organization-context';
import styles from './settings-page.module.css';

export function SettingsPage() {
  usePageTitle('Settings & Support');
  const organization = useActiveOrganization();

  return (
    <>
      <PageHeader
        title="Settings & Support"
        description="Your account security, preferences, and help from Himma."
      />
      <div className={styles.stack}>
        <PlaceholderPanel icon={Settings} title="Account & security settings are being built" milestone="portal">
          <p>
            You will manage how you sign in — including two-step verification — and your
            preferences here.
          </p>
        </PlaceholderPanel>
        <p className={styles.supportLine}>
          Looking for help?{' '}
          <Link className={styles.supportLink} to={organizationPath(organization.id, 'support')}>
            <LifeBuoy className={styles.supportIcon} aria-hidden="true" strokeWidth={1.75} />
            Go to Support
          </Link>
        </p>
      </div>
    </>
  );
}
