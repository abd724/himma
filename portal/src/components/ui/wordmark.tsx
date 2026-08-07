import styles from './wordmark.module.css';

/**
 * Provisional text wordmark (docs/07 §11) with the portal's product
 * designation. Centralized and replaceable at rebrand.
 */
export function Wordmark() {
  return (
    <span className={styles.wordmark}>
      <span className={styles.name}>Himma</span>
      <span className={styles.product}>Provider Portal</span>
    </span>
  );
}
