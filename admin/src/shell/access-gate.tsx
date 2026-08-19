import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useSession, useSessionActions } from '../auth/session-context';
import type { AdminSessionState, MfaError, SignInError } from '../auth/session-machine';
import styles from './access-gate.module.css';

/**
 * The admin access zone (task §14): every non-active session state renders
 * here — sign-in, MFA challenge, the step-up seam, signed-out,
 * no-admin-access, session-expired, unavailable — with account-enumeration-
 * safe wording (one credential-failure class; no raw Cognito errors).
 * Only an `active` session ever reaches the protected shell children.
 */

const SIGN_IN_ERROR_COPY: Record<SignInError, string> = {
  invalidCredentials: 'That email and password combination didn’t work. Check both and try again.',
  accountSuspended: 'This account is currently unavailable. Contact your Himma administrator.',
  rateLimited: 'Too many attempts. Wait a moment, then try again.',
  providerUnavailable: 'Sign-in isn’t reachable right now. Try again in a moment.',
  challengeExpired: 'The verification step took too long. Sign in again to restart.',
  failure: 'Sign-in didn’t complete. Try again in a moment.',
};

const MFA_ERROR_COPY: Record<MfaError, string> = {
  invalidCode: 'That code wasn’t accepted. Enter the current code from your authenticator app.',
  rateLimited: 'Too many attempts. Wait a moment, then try again.',
  failure: 'Verification didn’t complete. Try again in a moment.',
};

export function AccessGate({ children }: { children: ReactNode }) {
  const session = useSession();
  switch (session.status) {
    case 'active':
      return <>{children}</>;
    case 'bootstrapping':
    case 'authenticating':
      return (
        <AccessFrame>
          <p className={styles.status} role="status">
            Preparing the Himma admin console…
          </p>
        </AccessFrame>
      );
    case 'resolvingAccess':
      return (
        <AccessFrame>
          <p className={styles.status} role="status">
            Checking your administrative access…
          </p>
        </AccessFrame>
      );
    case 'unavailable':
      return (
        <AccessFrame>
          <h1 className={styles.title}>Sign-in isn’t available</h1>
          <p className={styles.body}>
            This deployment has no authentication configured. The console stays locked until it
            does — no access can be granted here.
          </p>
        </AccessFrame>
      );
    case 'signedOut':
      return <SignInScreen state={session} />;
    case 'mfaChallenge':
      return <MfaScreen state={session} />;
    case 'stepUpRequired':
      return <StepUpScreen state={session} />;
    case 'noAdminAccess':
      return <NoAccessScreen displayName={session.identity.displayName} />;
    case 'accessUnavailable':
      return <AccessUnavailableScreen />;
  }
}

function AccessFrame({ children }: { children: ReactNode }) {
  return (
    <main className={styles.frame}>
      <div className={styles.card}>
        <p className={styles.brand}>
          Himma <span className={styles.brandTag}>Admin</span>
        </p>
        {children}
      </div>
    </main>
  );
}

function SignInScreen({
  state,
}: {
  state: Extract<AdminSessionState, { status: 'signedOut' }>;
}) {
  const actions = useSessionActions();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const emailId = useId();
  const passwordId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void actions.signIn({ email: email.trim(), password });
  };

  return (
    <AccessFrame>
      <h1 className={styles.title}>Staff sign in</h1>
      {state.reason === 'sessionExpired' ? (
        <p className={styles.notice} role="status">
          Your session ended. Sign in again to continue.
        </p>
      ) : null}
      {state.reason === 'signedOut' ? (
        <p className={styles.notice} role="status">
          You’re signed out.
        </p>
      ) : null}
      {state.signInError !== null ? (
        <p className={styles.error} role="alert">
          {SIGN_IN_ERROR_COPY[state.signInError]}
        </p>
      ) : null}
      <form onSubmit={submit} className={styles.form}>
        <label className={styles.label} htmlFor={emailId}>
          Work email
        </label>
        <input
          id={emailId}
          className={styles.input}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label className={styles.label} htmlFor={passwordId}>
          Password
        </label>
        <input
          id={passwordId}
          className={styles.input}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button className={styles.primary} type="submit">
          Sign in
        </button>
      </form>
    </AccessFrame>
  );
}

function MfaScreen({
  state,
}: {
  state: Extract<AdminSessionState, { status: 'mfaChallenge' }>;
}) {
  const actions = useSessionActions();
  const [code, setCode] = useState('');
  const codeId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void actions.completeMfa(code.trim());
  };

  return (
    <AccessFrame>
      <h1 className={styles.title}>Verify it’s you</h1>
      <p className={styles.body}>
        Enter the 6-digit code from your authenticator app. Multi-factor verification is required
        for every Himma administrator.
      </p>
      {state.error !== null ? (
        <p className={styles.error} role="alert">
          {MFA_ERROR_COPY[state.error]}
        </p>
      ) : null}
      <form onSubmit={submit} className={styles.form}>
        <label className={styles.label} htmlFor={codeId}>
          Verification code
        </label>
        <input
          id={codeId}
          className={styles.input}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button className={styles.primary} type="submit" disabled={state.submitting}>
          {state.submitting ? 'Verifying…' : 'Verify'}
        </button>
        <button
          className={styles.secondary}
          type="button"
          onClick={() => void actions.cancelMfa()}
        >
          Cancel and start over
        </button>
      </form>
    </AccessFrame>
  );
}

function StepUpScreen({
  state,
}: {
  state: Extract<AdminSessionState, { status: 'stepUpRequired' }>;
}) {
  const actions = useSessionActions();
  const [code, setCode] = useState('');
  const codeId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void actions.completeStepUpTotp(code.trim());
  };

  return (
    <AccessFrame>
      <h1 className={styles.title}>Confirm your identity</h1>
      <p className={styles.body}>
        This step needs a fresh verification. Enter the current code from your authenticator app
        to continue as {state.identity.displayName || 'this administrator'}.
      </p>
      {state.error !== null ? (
        <p className={styles.error} role="alert">
          {MFA_ERROR_COPY[state.error]}
        </p>
      ) : null}
      <form onSubmit={submit} className={styles.form}>
        <label className={styles.label} htmlFor={codeId}>
          Verification code
        </label>
        <input
          id={codeId}
          className={styles.input}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button className={styles.primary} type="submit" disabled={state.submitting}>
          {state.submitting ? 'Confirming…' : 'Confirm'}
        </button>
        <SignOutLink />
      </form>
    </AccessFrame>
  );
}

function NoAccessScreen({ displayName }: { displayName: string }) {
  return (
    <AccessFrame>
      <h1 className={styles.title}>This console is for Himma staff</h1>
      <p className={styles.body}>
        {displayName ? `${displayName}, your` : 'Your'} account is signed in, but it holds no
        active Himma administrative role. Provider and customer accounts can’t use the admin
        console. If you believe you should have access, contact an Access Administrator.
      </p>
      <SignOutLink />
    </AccessFrame>
  );
}

function AccessUnavailableScreen() {
  const actions = useSessionActions();
  return (
    <AccessFrame>
      <h1 className={styles.title}>We couldn’t check your access</h1>
      <p className={styles.body}>Something interrupted the access check. Nothing was changed.</p>
      <button className={styles.primary} type="button" onClick={() => actions.retryAccess()}>
        Try again
      </button>
      <SignOutLink />
    </AccessFrame>
  );
}

function SignOutLink() {
  const actions = useSessionActions();
  return (
    <button className={styles.secondary} type="button" onClick={() => void actions.signOut()}>
      Sign out
    </button>
  );
}
