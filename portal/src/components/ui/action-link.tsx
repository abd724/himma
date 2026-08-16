import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import styles from './action-link.module.css';

/** Link styled as the portal's standard action button. `secondary` renders
 *  the outlined companion treatment for supporting actions. */
export function ActionLink({
  to,
  children,
  variant = 'primary',
}: {
  to: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Link
      className={variant === 'secondary' ? `${styles.actionLink} ${styles.secondary}` : styles.actionLink}
      to={to}
    >
      {children}
    </Link>
  );
}
