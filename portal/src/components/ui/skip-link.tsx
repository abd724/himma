import styles from './skip-link.module.css';

/**
 * Skip-to-content link — first focusable element in the shell; visually
 * appears only while focused.
 */
export function SkipLink({ targetId }: { targetId: string }) {
  return (
    <a className={styles.skipLink} href={`#${targetId}`}>
      Skip to main content
    </a>
  );
}
