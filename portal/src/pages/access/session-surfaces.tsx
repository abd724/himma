import { useSessionActions } from '../../auth/session-context';
import { ActionLink } from '../../components/ui/action-link';
import { Button } from '../../components/ui/button';
import { StatusSurface } from '../../components/ui/status-surface';
import { Wordmark } from '../../components/ui/wordmark';
import { usePageTitle } from '../../hooks/use-page-title';
import styles from './session-surfaces.module.css';

/**
 * Semantic access surfaces (task §14) — deliberately distinct from the 404:
 * loading, portal-unavailable (fail-closed), no membership, access
 * resolution failure, and inaccessible-workspace states.
 */

/** Intentional, visually stable bootstrap state — no protected content flash. */
export function BootstrapLoading() {
  return (
    <main className={styles.loadingWrap}>
      <div className={styles.loadingCard}>
        <Wordmark />
        <span className={styles.spinner} aria-hidden="true" />
        <p role="status">Preparing your workspace…</p>
      </div>
    </main>
  );
}

/** FAIL-CLOSED surface for environments with no configured authentication. */
export function PortalUnavailableSurface() {
  usePageTitle('Portal unavailable');
  return (
    <StatusSurface title="Sign-in isn't available yet">
      <p>
        The provider portal isn&rsquo;t connected to sign-in in this environment. Please check back
        soon, or contact Himma if you expected access here.
      </p>
    </StatusSurface>
  );
}

// These surfaces render under the access guard, which routes the resulting
// signed-out state to its confirmation page.
function useSignOutAction() {
  const actions = useSessionActions();
  return async () => {
    await actions.signOut();
  };
}

/** Authenticated, but no active provider membership exists. */
export function NoMembershipPage() {
  usePageTitle('No workspace access');
  const signOut = useSignOutAction();
  return (
    <StatusSurface
      title="No provider workspace available"
      actions={
        <Button variant="secondary" onClick={() => void signOut()}>
          Sign out
        </Button>
      }
    >
      <p>
        You&rsquo;re signed in, but this account doesn&rsquo;t currently have access to a provider
        workspace on Himma. Provider access is set up by invitation — if you were expecting access,
        contact your organization&rsquo;s owner or your Himma contact.
      </p>
    </StatusSurface>
  );
}

/** Access resolution failed (transient) — retry without re-authenticating. */
export function AccessUnavailablePage() {
  usePageTitle('Workspace unavailable');
  const { retryAccess } = useSessionActions();
  const signOut = useSignOutAction();
  return (
    <StatusSurface
      title="We couldn't load your workspace"
      actions={
        <>
          <Button onClick={retryAccess}>Try again</Button>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </>
      }
    >
      <p>Something went wrong while loading your workspace access. Try again in a moment.</p>
    </StatusSurface>
  );
}

/**
 * The addressed organization isn't in the caller's resolved access. Reveals
 * nothing about the requested id; offers the safe ways forward.
 */
export function WorkspaceUnavailablePage() {
  usePageTitle('Workspace unavailable');
  const signOut = useSignOutAction();
  return (
    <StatusSurface
      title="This workspace isn't available"
      actions={
        <>
          <ActionLink to="/">Go to your workspace</ActionLink>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </>
      }
    >
      <p>The link may be out of date, or your access may have changed.</p>
    </StatusSurface>
  );
}
