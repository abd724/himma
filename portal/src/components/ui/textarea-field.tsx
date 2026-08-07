import { useId, type TextareaHTMLAttributes } from 'react';
import styles from './textarea-field.module.css';

type TextAreaFieldProps = {
  label: string;
  /** Inline validation error; associated via aria-describedby. */
  error?: string | null;
  hint?: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Labeled multi-line input with accessible inline validation. */
export function TextAreaField({
  label,
  error = null,
  hint,
  id,
  className: _cn,
  ...rest
}: TextAreaFieldProps) {
  const autoId = useId();
  const textareaId = id ?? autoId;
  const errorId = `${textareaId}-error`;
  const hintId = `${textareaId}-hint`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={textareaId}>
        {label}
      </label>
      <textarea
        rows={4}
        {...rest}
        id={textareaId}
        className={[styles.textarea, error ? styles.textareaInvalid : ''].filter(Boolean).join(' ')}
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
