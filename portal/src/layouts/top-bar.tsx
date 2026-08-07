import { Menu } from 'lucide-react';
import type { RefObject } from 'react';
import { MOBILE_DRAWER_ID } from './mobile-drawer';
import { AccountPlaceholder } from './account-placeholder';
import { OrgSwitcher } from './org-switcher';
import styles from './top-bar.module.css';

/**
 * Top bar (docs/29 §5): responsive navigation trigger (narrow viewports),
 * organization context, and the account affordance placeholder.
 */
export function TopBar({
  navOpen,
  onOpenNav,
  navTriggerRef,
}: {
  navOpen: boolean;
  onOpenNav: () => void;
  navTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header className={styles.topBar}>
      <button
        ref={navTriggerRef}
        type="button"
        className={styles.menuButton}
        aria-label="Open navigation"
        aria-expanded={navOpen}
        aria-controls={navOpen ? MOBILE_DRAWER_ID : undefined}
        onClick={onOpenNav}
      >
        <Menu aria-hidden="true" strokeWidth={2} />
      </button>
      <OrgSwitcher />
      <div className={styles.spacer} />
      <AccountPlaceholder />
    </header>
  );
}
