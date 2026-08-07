import { UserRound } from 'lucide-react';
import { useId } from 'react';
import { VisuallyHidden } from '../components/ui/visually-hidden';
import styles from './account-placeholder.module.css';

/**
 * Account/access affordance placeholder (docs/29 §16 W2-1). W2-2 replaces
 * this with the real account & security menu driven by session state. Until
 * then it is an inert, honestly-described control — no fake identity.
 */
export function AccountPlaceholder() {
  const descriptionId = useId();

  return (
    <>
      <button
        type="button"
        className={styles.account}
        aria-disabled="true"
        aria-label="Account"
        aria-describedby={descriptionId}
      >
        <UserRound className={styles.icon} aria-hidden="true" strokeWidth={1.75} />
        <span className={styles.label}>Account</span>
      </button>
      <VisuallyHidden>
        <span id={descriptionId}>Sign-in and account controls arrive in an upcoming portal update.</span>
      </VisuallyHidden>
    </>
  );
}
