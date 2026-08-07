import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './button.module.css';

/**
 * Standard portal button. `busy` renders the working state, announces it, and
 * inertly blocks further activation without removing keyboard focus
 * (duplicate-submit protection that screen readers can follow).
 */
export function Button({
  children,
  variant = 'primary',
  busy = false,
  busyLabel,
  type = 'button',
  onClick,
  className,
  ...rest
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  busy?: boolean;
  busyLabel?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      type={type}
      className={[styles.button, styles[variant], busy ? styles.busy : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={busy ? (event) => event.preventDefault() : onClick}
    >
      {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
      <span>{busy && busyLabel ? busyLabel : children}</span>
    </button>
  );
}
