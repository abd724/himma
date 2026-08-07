import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession, useSessionActions } from '../../auth/session-context';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { PasswordField, TextField } from '../../components/ui/text-field';
import { usePageTitle } from '../../hooks/use-page-title';
import { AccessShell } from './access-shell';
import { SESSION_ENDED_COPY, SIGN_IN_ERROR_COPY } from './access-copy';
import { BootstrapLoading } from './session-surfaces';
import { PortalUnavailableSurface } from './session-surfaces';
import { accessDestination, useReturnTo, withReturnTo } from './use-access-navigation';
import styles from './sign-in-page.module.css';

export function SignInPage() {
  usePageTitle('Sign in');
  const session = useSession();
  const actions = useSessionActions();
  const returnTo = useReturnTo();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email: string | null; password: string | null }>(
    { email: null, password: null },
  );
  const alertRef = useRef<HTMLDivElement>(null);

  const submitting = session.status === 'authenticating';
  const signInError = session.status === 'signedOut' ? session.signInError : null;
  const sessionEnded = session.status === 'signedOut' && session.reason === 'sessionExpired';

  // A failed attempt announces via role=alert and receives focus so keyboard
  // and screen-reader users land on the explanation.
  useEffect(() => {
    if (signInError) {
      alertRef.current?.focus();
    }
  }, [signInError]);

  if (session.status === 'bootstrapping') {
    return <BootstrapLoading />;
  }
  if (session.status === 'unavailable') {
    return <PortalUnavailableSurface />;
  }
  if (session.status === 'mfaChallenge') {
    return <Navigate to={withReturnTo('/mfa', returnTo)} replace />;
  }
  if (
    session.status === 'resolvingAccess' ||
    session.status === 'active' ||
    session.status === 'noMembership' ||
    session.status === 'accessUnavailable'
  ) {
    return <Navigate to={accessDestination(returnTo)} replace />;
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const nextErrors = {
      email: email.trim() ? null : 'Enter your email address.',
      password: password ? null : 'Enter your password.',
    };
    setFieldErrors(nextErrors);
    if (nextErrors.email || nextErrors.password) {
      return;
    }
    void actions.signIn({ email, password });
  };

  return (
    <AccessShell>
      <header className={styles.header}>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.subtitle}>Your provider workspace on Himma.</p>
      </header>

      {sessionEnded && !signInError ? <InlineAlert tone="info">{SESSION_ENDED_COPY}</InlineAlert> : null}
      {signInError ? (
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          <InlineAlert tone="error">{SIGN_IN_ERROR_COPY[signInError]}</InlineAlert>
        </div>
      ) : null}

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <TextField
          label="Email address"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          error={fieldErrors.email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          value={password}
          error={fieldErrors.password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" busy={submitting} busyLabel="Signing in…">
          Sign in
        </Button>
      </form>

      <p className={styles.invitationNote}>
        Provider access is by invitation from Himma. Reach out to your Himma contact if you&rsquo;re
        expecting access.
      </p>
      {/* Password reset arrives with live authentication (W2-12): the reset
          contract is enumeration-safe server-side; no dead link until then. */}
    </AccessShell>
  );
}
