import { X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Wordmark } from '../components/ui/wordmark';
import { PortalNav } from './portal-nav';
import styles from './mobile-drawer.module.css';

export const MOBILE_DRAWER_ID = 'portal-navigation-drawer';

/**
 * Narrow-viewport navigation drawer (docs/29 §5): modal, keyboard-operable,
 * dismissible by close button, backdrop, or Escape. The opener restores focus
 * to the trigger; navigation closes the drawer.
 */
export function MobileDrawer({ onClose }: { onClose: () => void }) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    // Minimal focus trap: cycle Tab within the drawer while it is open.
    const focusable = Array.from(
      drawerRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [],
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.overlay}>
      {/* Pointer-convenience dismissal only — the close button and Escape are
          the accessible ways out, so the backdrop stays presentational. */}
      <div className={styles.backdrop} aria-hidden="true" onClick={onClose} />
      {/* Keyboard dismissal/trapping lives on the dialog container. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={drawerRef}
        id={MOBILE_DRAWER_ID}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={styles.drawer}
        onKeyDown={onKeyDown}
      >
        <div className={styles.header}>
          <Wordmark />
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.closeButton}
            aria-label="Close navigation"
            onClick={onClose}
          >
            <X aria-hidden="true" strokeWidth={2} />
          </button>
        </div>
        <PortalNav onNavigate={onClose} />
      </div>
    </div>
  );
}
