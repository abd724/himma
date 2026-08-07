import type { ReactNode } from 'react';
import styles from './visually-hidden.module.css';

/** Screen-reader-only text (kept in the accessibility tree, visually removed). */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className={styles.visuallyHidden}>{children}</span>;
}
