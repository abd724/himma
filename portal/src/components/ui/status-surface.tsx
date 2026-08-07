import type { ReactNode } from 'react';
import { Wordmark } from './wordmark';
import styles from './status-surface.module.css';

/**
 * Full-viewport status surface for states that render outside the
 * organization-scoped shell (unknown route, unknown organization,
 * application error). Calm, branded, with one clear way forward.
 */
export function StatusSurface({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <main className={styles.wrap}>
      <div className={styles.card}>
        <Wordmark />
        <h1 className={styles.title}>{title}</h1>
        <div className={styles.body}>{children}</div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </main>
  );
}
