import styles from './pages.module.css';

/**
 * Truthful future-area placeholder (task §22): names the W3 slice that
 * connects the real capability. NEVER fake tables, cases, or queues — in
 * any mode.
 */
export function PlaceholderPage({
  title,
  slice,
  description,
}: {
  title: string;
  slice: string;
  description: string;
}) {
  return (
    <>
      <h1 className={styles.pageTitle}>{title}</h1>
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Connected in {slice}</h2>
        <p className={styles.panelBody}>{description}</p>
      </section>
    </>
  );
}

/** Truthful refusal for a gated area the current roles do not unlock. */
export function NoCapabilityPage() {
  return (
    <>
      <h1 className={styles.pageTitle}>This area isn’t part of your role</h1>
      <section className={styles.panel}>
        <p className={styles.panelBody}>
          Your administrative roles don’t include this working area. If your responsibilities
          changed, an Access Administrator can update your role assignment.
        </p>
      </section>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <h1 className={styles.pageTitle}>Page not found</h1>
      <section className={styles.panel}>
        <p className={styles.panelBody}>There’s nothing at this address.</p>
      </section>
    </>
  );
}
