import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession, useSessionActions } from '../auth/session-context';
import { visibleNavItems } from '../app/nav-model';
import type { AdminAccess } from '../access/contract';
import styles from './admin-shell.module.css';

/**
 * The internal operations console shell (task §15): compact, denser than
 * the provider SaaS portal, Himma visual system. Desktop keeps a fixed
 * sidebar; below the desktop breakpoint navigation lives in an accessible
 * drawer (focus is moved in on open and RETURNED to the trigger on close;
 * Escape closes). Navigation items derive from the backend capability
 * projection only (nav-model.ts).
 */
export function AdminShell({ access }: { access: AdminAccess }) {
  const session = useSession();
  const actions = useSessionActions();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const items = visibleNavItems(access);

  // Route changes close the drawer; focus returns to the trigger.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (drawerOpen) {
      drawerRef.current?.querySelector<HTMLElement>('a, button')?.focus();
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setDrawerOpen(false);
          triggerRef.current?.focus();
        }
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }
    return undefined;
  }, [drawerOpen]);

  const identity = session.status === 'active' ? session.identity : null;

  const navigation = (
    <ul className={styles.navList}>
      {items.map((item) => (
        <li key={item.path}>
          <NavLink
            to={item.path}
            className={({ isActive }) =>
              isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink
            }
          >
            {item.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#admin-main">
        Skip to content
      </a>
      <header className={styles.topBar}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.menuButton}
          aria-expanded={drawerOpen}
          aria-controls="admin-drawer"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          Menu
        </button>
        <p className={styles.brand}>
          Himma <span className={styles.brandTag}>Admin</span>
        </p>
        <div className={styles.identity}>
          <span className={styles.identityName}>
            {access.user.displayName}
            {identity?.email ? ` · ${identity.email}` : ''}
          </span>
          <span className={styles.identityRoles}>{access.roles.join(' · ')}</span>
        </div>
        <button
          type="button"
          className={styles.signOut}
          onClick={() => void actions.signOut()}
        >
          Sign out
        </button>
      </header>

      <div className={styles.bodyRow}>
        <nav className={styles.sidebar} aria-label="Admin navigation">
          {navigation}
        </nav>

        {drawerOpen ? (
          <div className={styles.drawerBackdrop}>
            <nav
              id="admin-drawer"
              ref={drawerRef}
              className={styles.drawer}
              aria-label="Admin navigation"
            >
              <button
                type="button"
                className={styles.drawerClose}
                onClick={() => {
                  setDrawerOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                Close menu
              </button>
              {navigation}
            </nav>
          </div>
        ) : null}

        <main id="admin-main" className={styles.main}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
