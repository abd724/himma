import { MailOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useSession, useSessionActions } from '../../auth/session-context';
import { usePortalPorts } from '../../app/ports-context';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { usePageTitle } from '../../hooks/use-page-title';
import { AccessShell } from './access-shell';
import { BootstrapLoading, PortalUnavailableSurface } from './session-surfaces';
import { withReturnTo } from './use-access-navigation';
import styles from './invitation-page.module.css';

/**
 * Invitation acceptance (docs/29 §6 `/invitation/:token`, docs/27 §9).
 *
 * Canon constraints honored exactly:
 * - No preview/resolution read exists, so the pre-acceptance screen is
 *   generic — it can never show the organization, role, or target email.
 * - Every refusal is the ONE collapsed `invitationInvalid`; the copy lists
 *   possibilities without claiming which occurred (no oracle).
 * - Acceptance requires an authenticated session (verified-email matching is
 *   server truth); sign-in/MFA is COMPOSED via returnTo, never duplicated.
 * - The opaque token stays in the URL only: never stored, never logged,
 *   never echoed into copy; after acceptance the journey replaces the URL.
 */
type AcceptState =
  | { phase: 'idle' }
  | { phase: 'accepting' }
  | { phase: 'accepted'; organizationId: string }
  | { phase: 'invalid' }
  | { phase: 'rateLimited' }
  | { phase: 'unavailable' }
  | { phase: 'failure' };

const INVALID_COPY =
  'This invitation can’t be used with this account. It may have expired, already been used, or been sent to a different email address.';

export function InvitationPage() {
  usePageTitle('Provider invitation');
  const { token = '' } = useParams();
  const session = useSession();
  const actions = useSessionActions();
  const { invitationPort } = usePortalPorts();
  const navigate = useNavigate();
  const [accept, setAccept] = useState<AcceptState>({ phase: 'idle' });
  const alertRef = useRef<HTMLDivElement>(null);

  const returnTo = `/invitation/${token}`;

  // After acceptance the session re-resolves access; once the new membership
  // is visible, continue into the workspace (onboarding for a not-yet-live
  // organization, the dashboard otherwise). replace: the token leaves the URL.
  useEffect(() => {
    if (accept.phase !== 'accepted' || session.status !== 'active') {
      return;
    }
    const membership = session.memberships.find(
      (candidate) => candidate.organizationId === accept.organizationId,
    );
    if (!membership) {
      return;
    }
    const base = `/o/${membership.organizationId}`;
    navigate(membership.organizationState === 'live' ? base : `${base}/onboarding`, {
      replace: true,
    });
  }, [accept, session, navigate]);

  useEffect(() => {
    if (
      accept.phase === 'invalid' ||
      accept.phase === 'rateLimited' ||
      accept.phase === 'unavailable' ||
      accept.phase === 'failure'
    ) {
      alertRef.current?.focus();
    }
  }, [accept.phase]);

  if (session.status === 'bootstrapping' || session.status === 'authenticating') {
    return <BootstrapLoading />;
  }
  if (session.status === 'unavailable') {
    return <PortalUnavailableSurface />;
  }
  if (session.status === 'mfaChallenge') {
    return <Navigate to={withReturnTo('/mfa', returnTo)} replace />;
  }

  const signedIn =
    session.status === 'active' ||
    session.status === 'noMembership' ||
    session.status === 'accessUnavailable' ||
    session.status === 'resolvingAccess';
  const identity = signedIn && session.status !== 'resolvingAccess' ? session.identity : null;

  const onAccept = async () => {
    if (accept.phase === 'accepting') {
      return;
    }
    setAccept({ phase: 'accepting' });
    const outcome = await invitationPort.accept(token);
    switch (outcome.kind) {
      case 'invitationAccepted':
        setAccept({ phase: 'accepted', organizationId: outcome.organizationId });
        return;
      case 'invitationInvalid':
        setAccept({ phase: 'invalid' });
        return;
      case 'rateLimited':
        setAccept({ phase: 'rateLimited' });
        return;
      case 'providerUnavailable':
        setAccept({ phase: 'unavailable' });
        return;
      default:
        setAccept({ phase: 'failure' });
    }
  };

  const switchAccount = async () => {
    setAccept({ phase: 'idle' });
    await actions.signOut();
  };

  return (
    <AccessShell>
      <header className={styles.header}>
        <span className={styles.iconWrap} aria-hidden="true">
          <MailOpen strokeWidth={1.75} />
        </span>
        <h1 className={styles.title}>Provider invitation</h1>
        <p className={styles.subtitle}>
          {signedIn
            ? 'Accept your invitation to join a provider workspace on Himma.'
            : 'You’ve been invited to join a provider workspace on Himma.'}
        </p>
      </header>

      {accept.phase === 'invalid' ? (
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          <InlineAlert tone="error">
            {INVALID_COPY} Ask your organization&rsquo;s owner or your Himma contact for a new
            invitation.
          </InlineAlert>
        </div>
      ) : null}
      {accept.phase === 'rateLimited' ? (
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          <InlineAlert tone="error">Too many attempts. Please try again later.</InlineAlert>
        </div>
      ) : null}
      {accept.phase === 'unavailable' ? (
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          <InlineAlert tone="error">
            Invitations are temporarily unavailable. Please try again in a moment.
          </InlineAlert>
        </div>
      ) : null}
      {accept.phase === 'failure' ? (
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          <InlineAlert tone="error">Something went wrong. Please try again.</InlineAlert>
        </div>
      ) : null}

      {accept.phase === 'accepted' ? (
        <p className={styles.accepted} role="status">
          Invitation accepted — taking you to your workspace…
        </p>
      ) : signedIn ? (
        <div className={styles.actions}>
          {identity ? (
            <p className={styles.identityLine}>
              Signed in as <strong>{identity.email}</strong>. Invitations work with the email
              address they were sent to.
            </p>
          ) : null}
          <Button
            onClick={() => void onAccept()}
            busy={accept.phase === 'accepting'}
            busyLabel="Accepting…"
          >
            Accept invitation
          </Button>
          <Button variant="ghost" onClick={() => void switchAccount()}>
            Use a different account
          </Button>
        </div>
      ) : (
        <div className={styles.actions}>
          <p className={styles.identityLine}>
            Sign in with the email address your invitation was sent to, then accept it here.
          </p>
          <Button onClick={() => navigate(withReturnTo('/sign-in', returnTo))}>
            Sign in to continue
          </Button>
        </div>
      )}

      <p className={styles.note}>
        Provider access on Himma is by invitation. If you weren&rsquo;t expecting one, you can
        safely ignore this link.
      </p>
    </AccessShell>
  );
}
