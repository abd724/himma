import { ChevronDown, LogOut } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useSession, useSessionActions } from '../auth/session-context';
import styles from './account-menu.module.css';

function initialsOf(displayName: string): string {
  return displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Account & access menu (replaces the W2-1 placeholder): shows the signed-in
 * identity from the session facade and owns the sign-out affordance.
 * Account-security management remains a later task.
 */
export function AccountMenu() {
  const session = useSession();
  const actions = useSessionActions();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
  }, [open]);

  if (session.status !== 'active') {
    return null;
  }
  const { identity } = session;

  // The access guard routes the signed-out state to its confirmation page.
  const signOut = async () => {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    await actions.signOut();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className={styles.account}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account — ${identity.displayName}`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {initialsOf(identity.displayName)}
        </span>
        <span className={styles.name}>{identity.displayName}</span>
        <ChevronDown className={styles.chevron} aria-hidden="true" strokeWidth={2} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Account"
          className={styles.menu}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
        >
          <div className={styles.identityRow}>
            <p className={styles.identityName}>{identity.displayName}</p>
            <p className={styles.identityEmail}>{identity.email}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            tabIndex={-1}
            onClick={() => void signOut()}
          >
            <LogOut className={styles.menuIcon} aria-hidden="true" strokeWidth={1.75} />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
