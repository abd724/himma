import { ShieldCheck } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useSession, useSessionActions } from '../../auth/session-context';
import { Button } from '../../components/ui/button';
import { usePageTitle } from '../../hooks/use-page-title';
import { AccessShell } from './access-shell';
import { BootstrapLoading } from './session-surfaces';
import styles from './mfa-enroll-page.module.css';

/**
 * Two-step-verification enrollment gate. MFA is MANDATORY for provider
 * management (D-S3-5) — a session without it never enters the workspace, and
 * this page never implies it is optional.
 *
 * The real enrollment ceremony (authenticator secret + confirm + one-time
 * recovery codes, `/auth/mfa/totp/*`) requires live Cognito and arrives with
 * the integration milestone; secrets are never displayed from fixtures.
 */
export function MfaEnrollPage() {
  usePageTitle('Set up two-step verification');
  const session = useSession();
  const actions = useSessionActions();
  const navigate = useNavigate();

  if (session.status === 'bootstrapping' || session.status === 'resolvingAccess') {
    return <BootstrapLoading />;
  }
  if (session.status === 'signedOut' || session.status === 'unavailable') {
    return <Navigate to="/sign-in" replace />;
  }
  if (session.status !== 'noMembership' && session.status !== 'active' && session.status !== 'accessUnavailable') {
    return <Navigate to="/sign-in" replace />;
  }
  if (session.assurance === 'mfa') {
    return <Navigate to="/" replace />;
  }

  const signOut = async () => {
    await actions.signOut();
    navigate('/signed-out');
  };

  return (
    <AccessShell>
      <header className={styles.header}>
        <span className={styles.iconWrap} aria-hidden="true">
          <ShieldCheck strokeWidth={1.75} />
        </span>
        <h1 className={styles.title}>Set up two-step verification</h1>
        <p className={styles.subtitle}>
          Two-step verification is required to manage your organization on Himma. It protects your
          listings, team, and customers.
        </p>
      </header>

      <ol className={styles.steps}>
        <li>Install an authenticator app on your phone.</li>
        <li>Scan the setup code Himma shows you.</li>
        <li>Confirm with a 6-digit code and save your recovery codes.</li>
      </ol>

      <p className={styles.note}>
        Setting up two-step verification from the portal arrives in an upcoming update. Until then,
        your Himma contact will help you get set up.
      </p>

      <Button variant="secondary" onClick={() => void signOut()}>
        Sign out
      </Button>
    </AccessShell>
  );
}
