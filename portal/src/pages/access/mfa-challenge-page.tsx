import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useSession, useSessionActions } from '../../auth/session-context';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { TextField } from '../../components/ui/text-field';
import { usePageTitle } from '../../hooks/use-page-title';
import { AccessShell } from './access-shell';
import { MFA_ERROR_COPY } from './access-copy';
import { accessDestination, useReturnTo, withReturnTo } from './use-access-navigation';
import styles from './sign-in-page.module.css';

/**
 * Login TOTP challenge (SOFTWARE_TOKEN_MFA semantics). Recovery codes are
 * deliberately absent here: canon defines them as step-up credentials, not a
 * login-challenge alternative.
 */
export function MfaChallengePage() {
  usePageTitle('Two-step verification');
  const session = useSession();
  const actions = useSessionActions();
  const navigate = useNavigate();
  const returnTo = useReturnTo();
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const challenge = session.status === 'mfaChallenge' ? session : null;

  useEffect(() => {
    if (challenge?.error) {
      alertRef.current?.focus();
    }
  }, [challenge?.error]);

  if (challenge === null) {
    if (
      session.status === 'signedOut' ||
      session.status === 'unavailable' ||
      session.status === 'bootstrapping' ||
      session.status === 'authenticating'
    ) {
      return <Navigate to={withReturnTo('/sign-in', returnTo)} replace />;
    }
    // Verified — continue to the intended destination.
    return <Navigate to={accessDestination(returnTo)} replace />;
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (challenge?.submitting) {
      return;
    }
    if (!code.trim()) {
      setFieldError('Enter the 6-digit code.');
      return;
    }
    setFieldError(null);
    void actions.completeMfa(code);
  };

  const onCancel = async () => {
    await actions.cancelMfa();
    navigate('/sign-in', { replace: true });
  };

  return (
    <AccessShell>
      <header className={styles.header}>
        <h1 className={styles.title}>Two-step verification</h1>
        <p className={styles.subtitle}>
          Enter the 6-digit code from your authenticator app to finish signing in.
        </p>
      </header>

      {challenge.error ? (
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          <InlineAlert tone="error">{MFA_ERROR_COPY[challenge.error]}</InlineAlert>
        </div>
      ) : null}

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <TextField
          label="Verification code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          error={fieldError}
          onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
        <Button type="submit" busy={challenge.submitting} busyLabel="Verifying…">
          Verify
        </Button>
        <Button variant="ghost" onClick={() => void onCancel()}>
          Back to sign in
        </Button>
      </form>
    </AccessShell>
  );
}
