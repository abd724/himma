import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { SkipLink } from '../components/ui/skip-link';
import { Wordmark } from '../components/ui/wordmark';
import { MobileDrawer } from './mobile-drawer';
import { PortalNav } from './portal-nav';
import { TopBar } from './top-bar';
import styles from './portal-shell.module.css';

const MAIN_CONTENT_ID = 'main-content';

/**
 * Responsive portal shell (docs/29 §5, §12): persistent sidebar on desktop,
 * compact rail on tablet (CSS), modal drawer on narrow viewports. Hosts the
 * branding area, primary navigation, organization context, account
 * placeholder, and the main-content landmark.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const navTriggerRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();

  // Safety net: any route change closes the drawer (nav links also close it
  // directly so the intent is explicit).
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Focus returns to the trigger only after the shell is no longer inert.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !navOpen) {
      navTriggerRef.current?.focus();
    }
    wasOpenRef.current = navOpen;
  }, [navOpen]);

  const closeNav = () => {
    setNavOpen(false);
  };

  return (
    <div className={styles.shell}>
      <SkipLink targetId={MAIN_CONTENT_ID} />
      {/* While the modal drawer is open the rest of the shell is inert and
          hidden from assistive technology. */}
      <div className={styles.shellInner} aria-hidden={navOpen || undefined} inert={navOpen}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}>
            <Wordmark />
          </div>
          <PortalNav />
        </aside>
        <div className={styles.contentColumn}>
          <TopBar
            navOpen={navOpen}
            onOpenNav={() => setNavOpen(true)}
            navTriggerRef={navTriggerRef}
          />
          <main id={MAIN_CONTENT_ID} className={styles.main} tabIndex={-1}>
            <div className={styles.content}>{children}</div>
          </main>
        </div>
      </div>
      {navOpen ? <MobileDrawer onClose={closeNav} /> : null}
    </div>
  );
}
