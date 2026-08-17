import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { usePortalPorts } from '../../../app/ports-context';
import type { PriceOptionRecord, ProgramDetailRecord } from '../../../catalogue/contract';
import { PRICE_OPTION_KINDS } from '../../../catalogue/contract';
import type { PriceOptionPatch } from '../../../catalogue/editor-contract';
import { filsToAedInput, parseAedToFils, parseSessionsCount } from '../../../catalogue/money';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { InlineAlert } from '../../../components/ui/inline-alert';
import { TextField } from '../../../components/ui/text-field';
import { VisuallyHidden } from '../../../components/ui/visually-hidden';
import type { OrganizationView } from '../../../profile/contract';
import {
  priceOptionAmountDisplay,
  priceOptionKindLabel,
  priceOptionName,
} from '../listing-domain';
import { StateChip } from '../state-chip';
import { commonMutationErrorCopy, REVISION_PENDING_COPY } from './editor-domain';
import styles from './editor.module.css';

/**
 * ProgramPriceOption editor (D-S4-1): several commercial ways to purchase
 * the SAME listing — never one listing per option, never a Program.price.
 * Stable ids; integer fils (AED input converts deterministically at this
 * boundary); free/package kind ties enforced; deterministic (sortHint, id)
 * order with keyboard reorder; archive-only retirement. On review-gated
 * listings EVERY option change routes through Himma review — the real
 * revision outcome, clearly announced before and after.
 */

interface OptionFormState {
  kind: string;
  amount: string;
  sessions: string;
  labelEn: string;
}

type Busy =
  | { kind: 'none' }
  | { kind: 'saving' }
  | { kind: 'reordering'; optionId: string };

export function PricingSection({
  view,
  program,
  reviewGated,
  revisionPending,
  readOnly,
}: {
  view: OrganizationView;
  program: ProgramDetailRecord;
  reviewGated: boolean;
  revisionPending: boolean;
  readOnly: boolean;
}) {
  const { listingEditorPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const [openForm, setOpenForm] = useState<'add' | { edit: string } | null>(null);
  const [formState, setFormState] = useState<OptionFormState>({
    kind: 'monthly',
    amount: '',
    sessions: '',
    labelEn: '',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'error'; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState<Busy>({ kind: 'none' });
  const [confirmArchive, setConfirmArchive] = useState<PriceOptionRecord | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const ordered = [...program.priceOptions].sort(
    (a, b) => a.sortHint - b.sortHint || (a.id < b.id ? -1 : 1),
  );
  const activeOrdered = ordered.filter((option) => option.state === 'active');
  // Protected changes are blocked while a revision is pending — truthfully,
  // because the backend would refuse them (revisionPending).
  const mutationsBlocked = readOnly || (reviewGated && revisionPending);

  const focusAlert = () => requestAnimationFrame(() => alertRef.current?.focus());

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['listing', view.organization.id, program.id],
    });
    // The index list-card carries the derived price summary (W2-12C1) —
    // refresh it so the row reflects the option change.
    await queryClient.invalidateQueries({ queryKey: ['listings', view.organization.id] });
  };

  const announce = (tone: 'success' | 'info' | 'error', text: string) => {
    setNotice({ tone, text });
    focusAlert();
  };

  const openAdd = () => {
    setFormState({ kind: 'monthly', amount: '', sessions: '', labelEn: '' });
    setFormError(null);
    setOpenForm('add');
  };

  const openEdit = (option: PriceOptionRecord) => {
    setFormState({
      kind: option.kind,
      amount: option.amountFils === null ? '' : filsToAedInput(option.amountFils),
      sessions: option.sessionsCount === null ? '' : String(option.sessionsCount),
      labelEn: option.labelEn ?? '',
    });
    setFormError(null);
    setOpenForm({ edit: option.id });
  };

  /** Deterministic AED→fils at the adapter boundary — never a float. */
  const buildOption = ():
    | {
        ok: true;
        input: {
          kind: string;
          amountFils: number | null;
          sessionsCount: number | null;
          labelEn: string | null;
        };
      }
    | { ok: false; message: string } => {
    const kind = formState.kind;
    let amountFils: number | null = null;
    if (kind !== 'free') {
      const parsed = parseAedToFils(formState.amount);
      if (parsed.kind === 'invalid') {
        return {
          ok: false,
          message:
            parsed.reason === 'tooManyDecimals'
              ? 'Amounts use at most two decimal places (fils).'
              : parsed.reason === 'tooLarge'
                ? 'That amount is larger than Himma supports.'
                : 'Enter the price in AED, e.g. 450 or 450.50.',
        };
      }
      amountFils = parsed.fils;
    }
    let sessionsCount: number | null = null;
    if (kind === 'package') {
      const parsed = parseSessionsCount(formState.sessions);
      if (parsed.kind === 'invalid') {
        return { ok: false, message: 'A package needs a whole number of sessions.' };
      }
      sessionsCount = parsed.sessions;
    }
    return {
      ok: true,
      input: {
        kind,
        amountFils,
        sessionsCount,
        labelEn: formState.labelEn.trim() === '' ? null : formState.labelEn.trim(),
      },
    };
  };

  const submitForm = async () => {
    if (busy.kind !== 'none') {
      return;
    }
    const built = buildOption();
    if (!built.ok) {
      setFormError(built.message);
      return;
    }
    setBusy({ kind: 'saving' });
    setFormError(null);
    if (openForm === 'add') {
      const outcome = await listingEditorPort.addPriceOption(
        view.organization.id,
        program.id,
        built.input,
      );
      setBusy({ kind: 'none' });
      switch (outcome.kind) {
        case 'optionAdded':
          setOpenForm(null);
          await invalidate();
          announce('success', 'Price option added.');
          return;
        case 'revisionSubmitted':
          setOpenForm(null);
          await invalidate();
          announce(
            'info',
            'Sent to Himma for review. The live pricing keeps its current options until Himma approves the change.',
          );
          return;
        case 'invalidPriceOption':
          setFormError('That combination isn’t valid for this option kind.');
          return;
        default:
          setFormError(commonMutationErrorCopy(outcome.kind));
          return;
      }
    }
    if (openForm !== null && typeof openForm === 'object') {
      const option = program.priceOptions.find((candidate) => candidate.id === openForm.edit);
      if (option === undefined) {
        setBusy({ kind: 'none' });
        setOpenForm(null);
        return;
      }
      const patch: PriceOptionPatch = {
        kind: built.input.kind,
        amountFils: built.input.amountFils,
        sessionsCount: built.input.sessionsCount,
        labelEn: built.input.labelEn,
      };
      const outcome = await listingEditorPort.updatePriceOption(
        view.organization.id,
        program.id,
        option.id,
        option.version,
        patch,
      );
      setBusy({ kind: 'none' });
      switch (outcome.kind) {
        case 'optionUpdated':
          setOpenForm(null);
          await invalidate();
          announce('success', 'Price option saved.');
          return;
        case 'revisionSubmitted':
          setOpenForm(null);
          await invalidate();
          announce(
            'info',
            'Sent to Himma for review. The live pricing keeps its current values until Himma approves the change.',
          );
          return;
        case 'invalidPriceOption':
          setFormError('That combination isn’t valid for this option kind.');
          return;
        case 'staleVersion':
          setOpenForm(null);
          await invalidate();
          announce(
            'error',
            'Someone else changed this option first. It has been reloaded — apply your change again.',
          );
          return;
        default:
          setFormError(commonMutationErrorCopy(outcome.kind));
          return;
      }
    }
  };

  const archive = async (option: PriceOptionRecord) => {
    setConfirmArchive(null);
    const outcome = await listingEditorPort.archivePriceOption(
      view.organization.id,
      program.id,
      option.id,
      option.version,
    );
    switch (outcome.kind) {
      case 'optionArchived':
        await invalidate();
        announce('success', `“${priceOptionName(option)}” was archived. Archiving is permanent.`);
        return;
      case 'revisionSubmitted':
        await invalidate();
        announce(
          'info',
          'The archive request was sent to Himma for review. The option stays live until Himma approves it.',
        );
        return;
      case 'staleVersion':
        await invalidate();
        announce('error', 'Someone else changed this option first. Reloaded — try again.');
        return;
      default:
        announce('error', commonMutationErrorCopy(outcome.kind));
    }
  };

  /**
   * Keyboard-accessible reorder: renumbers the ACTIVE options to canonical
   * 10/20/30… hints and PATCHes exactly the options whose hint changed —
   * honest per-option `sortHint` commands, no invented bulk endpoint.
   * (Hidden on review-gated listings: an option change there is a
   * review-routed change, and one revision can carry one change.)
   */
  const move = async (option: PriceOptionRecord, direction: -1 | 1) => {
    if (busy.kind !== 'none') {
      return;
    }
    const currentIndex = activeOrdered.findIndex((candidate) => candidate.id === option.id);
    const targetIndex = currentIndex + direction;
    if (currentIndex === -1 || targetIndex < 0 || targetIndex >= activeOrdered.length) {
      return;
    }
    const next = [...activeOrdered];
    next.splice(currentIndex, 1);
    next.splice(targetIndex, 0, option);
    setBusy({ kind: 'reordering', optionId: option.id });
    for (let position = 0; position < next.length; position += 1) {
      const target = next[position]!;
      const sortHint = (position + 1) * 10;
      if (target.sortHint === sortHint) {
        continue;
      }
      const outcome = await listingEditorPort.updatePriceOption(
        view.organization.id,
        program.id,
        target.id,
        target.version,
        { sortHint },
      );
      if (outcome.kind !== 'optionUpdated') {
        setBusy({ kind: 'none' });
        await invalidate();
        announce('error', commonMutationErrorCopy(outcome.kind));
        return;
      }
    }
    setBusy({ kind: 'none' });
    await invalidate();
    announce('success', `“${priceOptionName(option)}” moved.`);
  };

  const formOpenFor = (optionId: string) =>
    openForm !== null && openForm !== 'add' && openForm.edit === optionId;

  return (
    <section aria-labelledby="editor-pricing-heading" className={styles.section}>
      <h2 id="editor-pricing-heading" className={styles.sectionTitle}>
        Pricing options
      </h2>
      <div className={styles.sectionCard}>
        <p className={styles.sectionIntro}>
          Different ways to buy the SAME listing — for example monthly, a term, or a session
          package. Customers choose one at booking; Himma never shows a listing per price.
        </p>
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          {notice !== null ? <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert> : null}
        </div>
        {reviewGated && !readOnly ? (
          <InlineAlert tone="info">
            {revisionPending
              ? REVISION_PENDING_COPY
              : 'Pricing is protected on this listing — any pricing change goes to Himma for review before it appears to customers.'}
          </InlineAlert>
        ) : null}

        {ordered.length === 0 ? (
          <p className={styles.sectionIntro}>
            No pricing options yet. A listing needs at least one active price option before it can
            be submitted for review.
          </p>
        ) : (
          <ul className={styles.rowList} aria-label="Pricing options">
            {ordered.map((option) => (
              <li
                key={option.id}
                className={
                  option.state === 'archived'
                    ? `${styles.childRow} ${styles.archivedRow}`
                    : styles.childRow
                }
              >
                <div className={styles.childRowMain}>
                  <span className={styles.childRowName}>
                    {priceOptionName(option)}
                    {option.state === 'archived' ? (
                      <StateChip label="Archived" tone="neutral" />
                    ) : null}
                  </span>
                  <span className={styles.childRowMeta}>
                    {priceOptionKindLabel(option.kind)}
                    {option.sessionsCount !== null ? ` · ${option.sessionsCount} sessions` : ''}
                  </span>
                </div>
                <span className={styles.childRowAmount}>{priceOptionAmountDisplay(option)}</span>
                {!mutationsBlocked && option.state === 'active' ? (
                  <div className={styles.childRowActions}>
                    {!reviewGated && activeOrdered.length > 1 ? (
                      <>
                        <Button
                          variant="secondary"
                          disabled={activeOrdered[0]?.id === option.id || busy.kind !== 'none'}
                          onClick={() => void move(option, -1)}
                        >
                          Move up
                          <VisuallyHidden> {priceOptionName(option)}</VisuallyHidden>
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={
                            activeOrdered[activeOrdered.length - 1]?.id === option.id ||
                            busy.kind !== 'none'
                          }
                          onClick={() => void move(option, 1)}
                        >
                          Move down
                          <VisuallyHidden> {priceOptionName(option)}</VisuallyHidden>
                        </Button>
                      </>
                    ) : null}
                    <Button variant="secondary" onClick={() => openEdit(option)}>
                      Edit
                      <VisuallyHidden> {priceOptionName(option)}</VisuallyHidden>
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirmArchive(option)}>
                      Archive
                      <VisuallyHidden> {priceOptionName(option)}</VisuallyHidden>
                    </Button>
                  </div>
                ) : null}
                {formOpenFor(option.id) ? (
                  <OptionForm
                    title={`Edit ${priceOptionName(option)}`}
                    formState={formState}
                    setFormState={setFormState}
                    error={formError}
                    saving={busy.kind === 'saving'}
                    reviewGated={reviewGated}
                    onSubmit={() => void submitForm()}
                    onCancel={() => setOpenForm(null)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {!mutationsBlocked && openForm === null ? (
          <div>
            <Button variant="secondary" onClick={openAdd}>
              Add price option
            </Button>
          </div>
        ) : null}
        {openForm === 'add' ? (
          <OptionForm
            title="Add price option"
            formState={formState}
            setFormState={setFormState}
            error={formError}
            saving={busy.kind === 'saving'}
            reviewGated={reviewGated}
            onSubmit={() => void submitForm()}
            onCancel={() => setOpenForm(null)}
          />
        ) : null}
      </div>

      {confirmArchive !== null ? (
        <ConfirmDialog
          title={`Archive “${priceOptionName(confirmArchive)}”?`}
          confirmLabel="Archive"
          cancelLabel="Keep option"
          destructive
          onConfirm={() => void archive(confirmArchive)}
          onCancel={() => setConfirmArchive(null)}
        >
          <p>
            Archiving is permanent — an archived option can never be reactivated. It stays visible
            here as history.
            {reviewGated
              ? ' On this listing the archive request goes to Himma for review first.'
              : ''}
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function OptionForm({
  title,
  formState,
  setFormState,
  error,
  saving,
  reviewGated,
  onSubmit,
  onCancel,
}: {
  title: string;
  formState: OptionFormState;
  setFormState: (next: OptionFormState) => void;
  error: string | null;
  saving: boolean;
  reviewGated: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const kindGroupId = useId();
  return (
    <form
      className={styles.inlineFormCard}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      noValidate
      aria-label={title}
    >
      <p className={styles.inlineFormTitle}>{title}</p>
      {error !== null ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <div
        className={styles.radioGroup}
        role="radiogroup"
        aria-labelledby={`${kindGroupId}-label`}
      >
        <span id={`${kindGroupId}-label`} className={styles.radioGroupLabel}>
          Price option type
        </span>
        <div className={styles.radioOptions}>
          {PRICE_OPTION_KINDS.map((kind) => (
            <label key={kind} className={styles.radioOption}>
              <input
                type="radio"
                name={`${kindGroupId}-kind`}
                value={kind}
                checked={formState.kind === kind}
                onChange={() => setFormState({ ...formState, kind })}
              />
              {priceOptionKindLabel(kind)}
            </label>
          ))}
        </div>
      </div>
      <div className={styles.optionFieldRow}>
        {formState.kind !== 'free' ? (
          <TextField
            label="Price (AED)"
            hint="For example 450 or 450.50."
            inputMode="decimal"
            value={formState.amount}
            onChange={(event) => setFormState({ ...formState, amount: event.target.value })}
          />
        ) : null}
        {formState.kind === 'package' ? (
          <TextField
            label="Sessions in the package"
            inputMode="numeric"
            value={formState.sessions}
            onChange={(event) => setFormState({ ...formState, sessions: event.target.value })}
          />
        ) : null}
        <TextField
          label="Label (optional)"
          hint="A short commercial name, e.g. “3 months”."
          value={formState.labelEn}
          onChange={(event) => setFormState({ ...formState, labelEn: event.target.value })}
        />
      </div>
      <div className={styles.saveArea}>
        <Button type="submit" busy={saving} busyLabel="Saving…">
          {reviewGated ? 'Send for review' : 'Save option'}
        </Button>
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
