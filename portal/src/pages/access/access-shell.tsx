import type { ReactNode } from 'react';
import { Wordmark } from '../../components/ui/wordmark';
import styles from './access-shell.module.css';

/**
 * Shared layout for the access zone (sign-in, MFA, step-up, signed-out):
 * a calm brand panel beside a focused card on desktop, a single column on
 * narrow viewports.
 */
export function AccessShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.wrap}>
      <aside className={styles.brandPanel}>
        <Wordmark />
        <p className={styles.brandLine}>
          The workspace where UAE activity providers run their presence on Himma.
        </p>
      </aside>
      <main className={styles.main}>
        <div className={styles.card}>
          <div className={styles.cardBrand}>
            <Wordmark />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
