import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './inline-alert.module.css';

/**
 * Inline status message. `tone="error"` renders an assertive alert; `info`
 * and `success` render polite status regions. Rendered persistently (not
 * toast) so no information disappears on its own.
 */
export function InlineAlert({
  tone,
  children,
}: {
  tone: 'error' | 'info' | 'success';
  children: ReactNode;
}) {
  const Icon = tone === 'error' ? AlertCircle : tone === 'success' ? CheckCircle2 : Info;
  return (
    <div className={`${styles.alert} ${styles[tone]}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon className={styles.icon} aria-hidden="true" strokeWidth={2} />
      <div className={styles.body}>{children}</div>
    </div>
  );
}
