import { MailOpen } from 'lucide-react';
import { StatusSurface } from '../../components/ui/status-surface';
import { ActionLink } from '../../components/ui/action-link';
import { usePageTitle } from '../../hooks/use-page-title';
import styles from './invitation-placeholder-page.module.css';

/**
 * Structural placeholder for the docs/29 §6 invitation-acceptance route.
 * The acceptance workflow itself is W2-3 territory — no token is read,
 * validated, or sent anywhere from this page.
 */
export function InvitationPlaceholderPage() {
  usePageTitle('Provider invitation');

  return (
    <StatusSurface
      title="Provider invitation"
      actions={<ActionLink to="/sign-in">Go to sign in</ActionLink>}
    >
      <p className={styles.lead}>
        <MailOpen className={styles.icon} aria-hidden="true" strokeWidth={1.75} />
        Invitations are how organizations and their teams join Himma.
      </p>
      <p>
        Accepting invitations in the portal arrives in an upcoming update. For now, your Himma
        contact will help you complete your invitation.
      </p>
    </StatusSurface>
  );
}
