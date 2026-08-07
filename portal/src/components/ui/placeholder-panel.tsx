import { Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './placeholder-panel.module.css';

/**
 * Honest placeholder state for sections whose workflows arrive later
 * (docs/29 §5 — designed placeholders, never fabricated data).
 *
 * `milestone` selects the truthful timing line:
 * - 'portal'  → the area is planned portal work (a later W2 task);
 * - 'platform' → the domain needs a later production milestone of the
 *   platform itself (schedules, bookings, finance) before any real data can
 *   exist here.
 */
export function PlaceholderPanel({
  icon: Icon,
  title,
  children,
  milestone,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  milestone: 'portal' | 'platform';
}) {
  return (
    <section className={styles.panel}>
      <span className={styles.iconWrap} aria-hidden="true">
        <Icon className={styles.icon} strokeWidth={1.75} />
      </span>
      <h2 className={styles.title}>{title}</h2>
      <div className={styles.body}>{children}</div>
      <p className={styles.milestone}>
        <Clock className={styles.milestoneIcon} aria-hidden="true" strokeWidth={2} />
        {milestone === 'platform'
          ? 'Coming in a later production milestone.'
          : 'Arriving in an upcoming portal update.'}
      </p>
    </section>
  );
}
