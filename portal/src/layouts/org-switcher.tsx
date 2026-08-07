import { Check, ChevronsUpDown } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  useAccessibleOrganizations,
  useActiveOrganization,
  type ShellOrganization,
} from '../organization/organization-context';
import styles from './org-switcher.module.css';

function initials(displayName: string): string {
  return displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

function OrgAvatar({ organization }: { organization: ShellOrganization }) {
  return (
    <span className={styles.avatar} aria-hidden="true">
      {initials(organization.displayName)}
    </span>
  );
}

/**
 * Organization context switcher (docs/29 §5). Shell-level structure only:
 * the accessible set is fixture-fed until W2-2 supplies real membership
 * resolution. Switching preserves the current section under the new
 * organization's scope. With a single accessible organization the switcher
 * disappears into a plain context label.
 */
export function OrgSwitcher() {
  const organizations = useAccessibleOrganizations();
  const active = useActiveOrganization();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
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
      const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]');
      firstItem?.focus();
    }
  }, [open]);

  if (organizations.length <= 1) {
    return (
      <div className={styles.staticContext}>
        <OrgAvatar organization={active} />
        <span className={styles.name}>{active.displayName}</span>
      </div>
    );
  }

  const switchTo = (organization: ShellOrganization) => {
    setOpen(false);
    if (organization.id !== active.id) {
      const nextPath = location.pathname.replace(`/o/${active.id}`, `/o/${organization.id}`);
      navigate(nextPath);
    }
    buttonRef.current?.focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [],
    );
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(currentIndex + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(currentIndex - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className={styles.switcher}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <OrgAvatar organization={active} />
        <span className={styles.name}>{active.displayName}</span>
        <ChevronsUpDown className={styles.chevron} aria-hidden="true" strokeWidth={2} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Switch organization"
          className={styles.menu}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
        >
          {organizations.map((organization) => {
            const isActive = organization.id === active.id;
            return (
              <button
                key={organization.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                className={styles.menuItem}
                tabIndex={-1}
                onClick={() => switchTo(organization)}
              >
                <OrgAvatar organization={organization} />
                <span className={styles.name}>{organization.displayName}</span>
                {isActive ? (
                  <Check className={styles.check} aria-hidden="true" strokeWidth={2.5} />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
