import { ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityTypeRecord, CategoryRecord } from '../../../taxonomy/contract';
import { VisuallyHidden } from '../../../components/ui/visually-hidden';
import styles from './activity-type-combobox.module.css';

/**
 * Searchable Activity Type selector — the Himma-MANAGED controlled
 * vocabulary (docs/24 §12.1, D-S4-3): providers SELECT from the active
 * canonical taxonomy; typing only filters and can never create, submit, or
 * imply a new taxonomy record. When nothing matches, the truthful fallback
 * points at Himma (no provider-facing "request a new activity type"
 * workflow exists — a recorded contract gap), never a fake create action.
 *
 * Accessible combobox semantics: `role="combobox"` input with
 * `aria-expanded`/`aria-controls`/`aria-activedescendant`, a `listbox`
 * popup of `option`s, full arrow/Enter/Escape keyboard support, and a
 * polite result-count announcement.
 */
export function ActivityTypeCombobox({
  activityTypes,
  categories,
  value,
  onSelect,
  error,
  currentActivityType,
  disabled = false,
  supportPath,
  requiredMark = false,
}: {
  /** ACTIVE canonical taxonomy rows (the real public read). */
  activityTypes: readonly ActivityTypeRecord[];
  /** Category context (the real public categories read); null degrades
   *  gracefully to labels without category context. */
  categories: readonly CategoryRecord[] | null;
  /** The selected activityTypeId ('' = none yet). */
  value: string;
  onSelect: (activityTypeId: string) => void;
  error: string | null;
  /** Edit mode: the loaded listing's embedded activity type — kept as the
   *  CURRENT value even when no longer active (never newly selectable). */
  currentActivityType?: { id: string; labelEn: string; active: boolean };
  disabled?: boolean;
  /** The existing Support route — the truthful missing-taxonomy fallback. */
  supportPath: string;
  requiredMark?: boolean;
}) {
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;

  const categoryLabelOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories ?? []) {
      map.set(category.id, category.labelEn);
    }
    return (categoryId: string): string | null => map.get(categoryId) ?? null;
  }, [categories]);

  const historicalType =
    currentActivityType !== undefined && !currentActivityType.active ? currentActivityType : null;

  const selectedLabel = useMemo(() => {
    if (value === '') {
      return '';
    }
    const active = activityTypes.find((type) => type.id === value);
    if (active !== undefined) {
      return active.labelEn;
    }
    if (historicalType !== null && historicalType.id === value) {
      return `${historicalType.labelEn} (no longer in the catalogue)`;
    }
    return '';
  }, [value, activityTypes, historicalType]);

  const [open, setOpen] = useState(false);
  /** Null until the user types — an opened selector shows the FULL list. */
  const [filterText, setFilterText] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const query = (filterText ?? '').trim().toLowerCase();
    if (query === '') {
      return activityTypes;
    }
    return activityTypes.filter((type) => type.labelEn.toLowerCase().includes(query));
  }, [activityTypes, filterText]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(results.length - 1, 0)));
  }, [results.length]);

  const close = () => {
    setOpen(false);
    setFilterText(null);
    setActiveIndex(0);
  };

  const openList = () => {
    if (disabled) {
      return;
    }
    setOpen(true);
  };

  const selectOption = (type: ActivityTypeRecord) => {
    onSelect(type.id);
    close();
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) {
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) {
          openList();
          return;
        }
        setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (open) {
          setActiveIndex((index) => Math.max(index - 1, 0));
        }
        return;
      case 'Home':
        if (open && results.length > 0) {
          event.preventDefault();
          setActiveIndex(0);
        }
        return;
      case 'End':
        if (open && results.length > 0) {
          event.preventDefault();
          setActiveIndex(results.length - 1);
        }
        return;
      case 'Enter':
        if (open) {
          // Enter only ever picks a LISTED canonical option — free text is
          // never submitted as taxonomy.
          event.preventDefault();
          const active = results[activeIndex];
          if (active !== undefined) {
            selectOption(active);
          }
        }
        return;
      case 'Escape':
        if (open) {
          event.preventDefault();
          close();
        }
        return;
      case 'Tab':
        close();
        return;
      default:
        return;
    }
  };

  const displayValue = open ? (filterText ?? '') : selectedLabel;
  const activeOptionId =
    open && results.length > 0 ? `${baseId}-option-${activeIndex}` : undefined;
  const describedBy =
    [error !== null ? errorId : null, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        Activity type
        {requiredMark ? (
          <span className={styles.requiredMark} aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      <div className={styles.comboWrap}>
        <Search className={styles.searchIcon} aria-hidden="true" strokeWidth={1.75} />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          className={[
            styles.input,
            error !== null ? styles.inputInvalid : '',
            value !== '' && !disabled ? styles.inputWithClear : '',
          ]
            .filter(Boolean)
            .join(' ')}
          placeholder="Search activities…"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-required={requiredMark ? 'true' : undefined}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-invalid={error !== null ? true : undefined}
          aria-describedby={describedBy}
          {...(activeOptionId !== undefined ? { 'aria-activedescendant': activeOptionId } : {})}
          value={displayValue}
          onChange={(event) => {
            setFilterText(event.target.value);
            setActiveIndex(0);
            if (!open) {
              openList();
            }
          }}
          onClick={openList}
          onFocus={openList}
          onBlur={close}
          onKeyDown={onKeyDown}
        />
        {value !== '' && !disabled ? (
          <button
            type="button"
            className={styles.clearButton}
            aria-label="Clear the selected activity type"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onSelect('');
              setFilterText(null);
              inputRef.current?.focus();
              setOpen(true);
            }}
          >
            <X aria-hidden="true" strokeWidth={1.75} />
          </button>
        ) : (
          <ChevronDown className={styles.chevron} aria-hidden="true" strokeWidth={2} />
        )}
        {open ? (
          // Presentation wrapper: mousedown-preventDefault keeps focus in
          // the combobox input while clicking inside the popup (options and
          // the support link keep working); it is not itself interactive.
          <div
            className={styles.popup}
            role="presentation"
            onMouseDown={(event) => {
              if (!(event.target instanceof HTMLAnchorElement)) {
                event.preventDefault();
              }
            }}
          >
            <ul id={listboxId} role="listbox" aria-label="Activity types" className={styles.list}>
              {results.map((type, index) => {
                const categoryLabel = categoryLabelOf(type.categoryId);
                return (
                  // ARIA combobox pattern: keyboard interaction lives on the
                  // input (aria-activedescendant); options are pointer
                  // targets only, so no per-option keyboard listener exists.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <li
                    key={type.id}
                    id={`${baseId}-option-${index}`}
                    role="option"
                    aria-selected={type.id === value}
                    className={[
                      styles.option,
                      index === activeIndex ? styles.optionActive : '',
                      type.id === value ? styles.optionSelected : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectOption(type)}
                  >
                    <span className={styles.optionLabel}>{type.labelEn}</span>
                    {categoryLabel !== null ? (
                      <span className={styles.optionCategory}>{categoryLabel}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {results.length === 0 ? (
              <div className={styles.noResults}>
                <p className={styles.noResultsTitle}>No matching activity</p>
                <p className={styles.noResultsBody}>
                  Can&rsquo;t find the activity you need? Activity types are managed by Himma so
                  customers can search and filter consistently. Ask the Himma team to add it
                  through <Link to={supportPath}>Support</Link>.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <VisuallyHidden>
        <span role="status">
          {open
            ? results.length === 0
              ? 'No matching activity types'
              : `${results.length} activity ${results.length === 1 ? 'type' : 'types'} available`
            : ''}
        </span>
      </VisuallyHidden>
      <p id={hintId} className={styles.hint}>
        {historicalType !== null && value === historicalType.id
          ? `“${historicalType.labelEn}” is no longer in the Himma catalogue. It stays until you choose a current activity type.`
          : 'Activity types are managed by Himma. Customers browse and filter by them.'}
      </p>
      {error !== null ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
