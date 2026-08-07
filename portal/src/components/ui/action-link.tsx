import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import styles from './action-link.module.css';

/** Primary link styled as the portal's standard action button. */
export function ActionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className={styles.actionLink} to={to}>
      {children}
    </Link>
  );
}
