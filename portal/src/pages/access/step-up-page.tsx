import { useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useSession, useSessionActions } from '../../auth/session-context';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { TextField } from '../../components/ui/text-field';
import { usePageTitle } from '../../hooks/use-page-title';
import { AccessShell } from './access-shell';
import { BootstrapLoading } from './session-surfaces';
import { accessDestination, useReturnTo } from './use-access-navigation';
import styles from './sign-in-page.module.css';

const STEP_UP_ERROR_COPY = {
  invalidCode: "That code didn't work. Try again.",
  challengeExpired: 'That took too long. Enter a fresh code to continue.',
  rateLimited: 'Too many attempts. Please try again later.',
  failure: 'Something went wrong. Please try again.',
} as const;

type StepUpError = keyof typeof STEP_UP_ERROR_COPY;

/**
 * Reusable additional-verification interstitial (task §8): a future
 * sensitive action that receives `stepUpRequired` sends the user here with
 * a returnTo, and retries after the grant. Mirrors `/auth/step-up/totp/*`
 * and `/auth/step-up/recovery-code` semantics — TOTP first, single-use
 * recovery code as the fallback. Nothing routes here globally.
 */
export function StepUpPage() {
  usePageTitle('Confirm it’s you');
  const session = useSession();
  const actions = useSessionActions();
  const navigate = useNavigate();
  const returnTo = useReturnTo();
  const [method, setMethod] = useState<'totp' | 'recoveryCode'>('totp');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<StepUpError | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  if (session.status === 'bootstrapping' || session.status === 'resolvingAccess') {
    return <BootstrapLoading />;
  }
  if (session.status !== 'active') {
    return <Navigate to="/sign-in" replace />;
  }

  const destination = accessDestination(returnTo);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    if (!code.trim()) {
      setFieldError(method === 'totp' ? 'Enter the 6-digit code.' : 'Enter a recovery code.');
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    const outcome =
      method === 'totp'
        ? await actions.completeStepUpTotp(code)
        : await actions.completeStepUpRecoveryCode(code);
    setSubmitting(false);
    if (outcome.kind === 'completed') {
      navigate(destination, { replace: true });
      return;
    }
    setError(outcome.kind === 'invalidCode' || outcome.kind === 'challengeExpired' || outcome.kind === 'rateLimited' ? outcome.kind : 'failure');
    alertRef.current?.focus();
  };

  const switchMethod = (nextMethod: 'totp' | 'recoveryCode') => {
    setMethod(nextMethod);
    setCode('');
    setError(null);
    setFieldError(null);
  };

  return (
    <AccessShell>
      <header className={styles.header}>
        <h1 className={styles.title}>Confirm it&rsquo;s you</h1>
        <p className={styles.subtitle}>
          {method === 'totp'
            ? 'This needs a recent verification. Enter a code from your authenticator app.'
            : 'Enter one of the single-use recovery codes you saved when setting up two-step verification.'}
        </p>
      </header>

      {error ? (
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          <InlineAlert tone="error">{STEP_UP_ERROR_COPY[error]}</InlineAlert>
        </div>
      ) : null}

      <form className={styles.form} onSubmit={(event) => void onSubmit(event)} noValidate>
        {method === 'totp' ? (
          <TextField
            label="Verification code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            error={fieldError}
            onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
          />
        ) : (
          <TextField
            label="Recovery code"
            name="recovery-code"
            autoComplete="off"
            value={code}
            error={fieldError}
            onChange={(event) => setCode(event.target.value)}
          />
        )}
        <Button type="submit" busy={submitting} busyLabel="Verifying…">
          Verify
        </Button>
        <Button
          variant="ghost"
          onClick={() => switchMethod(method === 'totp' ? 'recoveryCode' : 'totp')}
        >
          {method === 'totp' ? 'Use a recovery code instead' : 'Use your authenticator app instead'}
        </Button>
        <Button variant="ghost" onClick={() => navigate(destination)}>
          Go back
        </Button>
      </form>
    </AccessShell>
  );
}
