import { Navigate } from 'react-router-dom';
import { useSession } from '../../auth/session-context';
import { ActionLink } from '../../components/ui/action-link';
import { StatusSurface } from '../../components/ui/status-surface';
import { usePageTitle } from '../../hooks/use-page-title';

export function SignedOutPage() {
  usePageTitle('Signed out');
  const session = useSession();

  if (
    session.status === 'active' ||
    session.status === 'resolvingAccess' ||
    session.status === 'noMembership' ||
    session.status === 'accessUnavailable'
  ) {
    return <Navigate to="/" replace />;
  }

  return (
    <StatusSurface
      title="You're signed out"
      actions={<ActionLink to="/sign-in">Sign in</ActionLink>}
    >
      <p>Your workspace session has ended. Sign in again whenever you&rsquo;re ready.</p>
    </StatusSurface>
  );
}
