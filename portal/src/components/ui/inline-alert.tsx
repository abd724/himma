import { AlertCircle, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './inline-alert.module.css';

/**
 * Inline status message. `tone="error"` renders an assertive alert; `info`
 * renders a polite status region. Rendered persistently (not toast) so no
 * information disappears on its own.
 */
export function InlineAlert({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  const Icon = tone === 'error' ? AlertCircle : Info;
  return (
    <div className={`${styles.alert} ${styles[tone]}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon className={styles.icon} aria-hidden="true" strokeWidth={2} />
      <div className={styles.body}>{children}</div>
    </div>
  );
}
