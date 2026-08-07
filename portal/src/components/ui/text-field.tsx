import { Eye, EyeOff } from 'lucide-react';
import { useId, useState, type InputHTMLAttributes } from 'react';
import styles from './text-field.module.css';

type FieldProps = {
  label: string;
  /** Inline validation error; associated via aria-describedby. */
  error?: string | null;
  hint?: string;
} & InputHTMLAttributes<HTMLInputElement>;

/** Labeled input with accessible inline validation. */
export function TextField({ label, error = null, hint, id, className: _cn, ...rest }: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <input
        {...rest}
        id={inputId}
        className={[styles.input, error ? styles.inputInvalid : ''].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
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

/** Password input with an accessible visibility control. */
export function PasswordField({ label, error = null, hint, id, ...rest }: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const [visible, setVisible] = useState(false);
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <div className={styles.passwordWrap}>
        <input
          {...rest}
          id={inputId}
          type={visible ? 'text' : 'password'}
          className={[styles.input, styles.passwordInput, error ? styles.inputInvalid : '']
            .filter(Boolean)
            .join(' ')}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        <button
          type="button"
          className={styles.visibilityToggle}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          onClick={() => setVisible((wasVisible) => !wasVisible)}
        >
          {visible ? (
            <EyeOff aria-hidden="true" strokeWidth={1.75} />
          ) : (
            <Eye aria-hidden="true" strokeWidth={1.75} />
          )}
        </button>
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
