import type { ReactNode } from 'react';
import styles from './page-header.module.css';

/**
 * Current-route page-heading pattern: every page opens with exactly one h1
 * and a short purpose line (docs/29 §11 heading discipline).
 */
export function PageHeader({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className={styles.pageHeader}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{description}</p>
    </div>
  );
}
