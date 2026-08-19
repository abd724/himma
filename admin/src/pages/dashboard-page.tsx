import { useSession } from '../auth/session-context';
import { visibleNavItems } from '../app/nav-model';
import styles from './pages.module.css';

/**
 * W3-1 Dashboard: a truthful foundation only (task §21) — the tools this
 * administrator's REAL capabilities unlock, each naming the W3 slice that
 * connects it. No fabricated queue counts, SLAs, or platform statistics
 * exist anywhere; real work queues arrive with their backend reads (W3-2+).
 */
export function DashboardPage() {
  const session = useSession();
  if (session.status !== 'active') {
    return null;
  }
  const access = session.access;
  const tools = visibleNavItems(access).filter((item) => item.path !== '/dashboard');

  return (
    <>
      <h1 className={styles.pageTitle}>Welcome, {access.user.displayName}</h1>
      <p className={styles.lead}>
        This is the Himma operations console. Your access —{' '}
        {access.roles.join(', ')} — unlocks the areas below. Live work queues appear here as each
        area is connected to its real backend.
      </p>
      {tools.length === 0 ? (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>No operational areas yet</h2>
          <p className={styles.panelBody}>
            Your role is valid, but its working areas (for example support or finance operations)
            are not part of the current admin console phase. They arrive with their own
            workstreams.
          </p>
        </section>
      ) : (
        <div className={styles.grid}>
          {tools.map((tool) => (
            <section key={tool.path} className={styles.toolCard} aria-label={tool.label}>
              <h2 className={styles.toolName}>{tool.label}</h2>
              <p className={styles.toolNote}>
                {tool.pendingSlice === null
                  ? 'Available now.'
                  : `Connects to the real backend in ${tool.pendingSlice}.`}
              </p>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
