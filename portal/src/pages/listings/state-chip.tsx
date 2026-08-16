import type { StateTone } from './listing-domain';
import styles from './listings.module.css';

const toneClass: Record<StateTone, string> = {
  positive: styles.chipPositive ?? '',
  pending: styles.chipPending ?? '',
  attention: styles.chipAttention ?? '',
  neutral: styles.chipNeutral ?? '',
  info: styles.chipInfo ?? '',
  infoOutline: styles.chipInfoOutline ?? '',
  warning: styles.chipWarning ?? '',
  muted: styles.chipMuted ?? '',
};

/** Lifecycle chip — the tone is decorative; the LABEL carries the meaning,
 *  so every state is understandable without color (task §31). */
export function StateChip({ label, tone }: { label: string; tone: StateTone }) {
  return <span className={`${styles.stateChip} ${toneClass[tone]}`}>{label}</span>;
}
