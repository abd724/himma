import { ChevronDown } from 'lucide-react';
import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import styles from './select-field.module.css';

type SelectFieldProps = {
  label: string;
  /** Inline validation error; associated via aria-describedby. */
  error?: string | null;
  hint?: string;
  children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>;

/** Labeled native select with accessible inline validation. */
export function SelectField({
  label,
  error = null,
  hint,
  id,
  children,
  className: _cn,
  ...rest
}: SelectFieldProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const errorId = `${selectId}-error`;
  const hintId = `${selectId}-hint`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={selectId}>
        {label}
      </label>
      <div className={styles.selectWrap}>
        <select
          {...rest}
          id={selectId}
          className={[styles.select, error ? styles.selectInvalid : ''].filter(Boolean).join(' ')}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        >
          {children}
        </select>
        <ChevronDown className={styles.chevron} aria-hidden="true" strokeWidth={2} />
      </div>
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
