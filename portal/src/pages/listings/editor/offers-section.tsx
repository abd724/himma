import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { usePortalPorts } from '../../../app/ports-context';
import type { OfferRecord, ProgramDetailRecord } from '../../../catalogue/contract';
import { OFFER_KINDS } from '../../../catalogue/contract';
import type { OfferPatch } from '../../../catalogue/editor-contract';
import { filsToAedInput, parseAedToFils } from '../../../catalogue/money';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { InlineAlert } from '../../../components/ui/inline-alert';
import { SelectField } from '../../../components/ui/select-field';
import { TextField } from '../../../components/ui/text-field';
import { VisuallyHidden } from '../../../components/ui/visually-hidden';
import type { OrganizationView } from '../../../profile/contract';
import { formatAedFromFils, offerKindLabel } from '../listing-domain';
import { StateChip } from '../state-chip';
import { commonMutationErrorCopy } from './editor-domain';
import styles from './editor.module.css';

/**
 * Offer management — structured, INFORMATIONAL catalogue metadata (Offer ≠
 * ProgramPriceOption; docs/24 §12.1): highlights customers see on the
 * listing, never checkout math, coupons, redemption, or inventory. Exact
 * backend rules: paid trials carry a positive AED amount, other kinds
 * none; an effective window must end after it starts; ending an offer is
 * terminal (it stays as history). Offers are not review-gated — changes
 * hot-apply in every provider-editable state.
 */

interface OfferFormState {
  kind: string;
  labelEn: string;
  amount: string;
  effectiveStart: string;
  effectiveEnd: string;
}

const emptyOfferForm: OfferFormState = {
  kind: 'freeTrial',
  labelEn: '',
  amount: '',
  effectiveStart: '',
  effectiveEnd: '',
};

/** `datetime-local` value ⇄ wire ISO instant (device time zone — labeled). */
const toIso = (local: string): string | null =>
  local.trim() === '' ? null : new Date(local).toISOString();
const toLocalInput = (iso: string | null): string => {
  if (iso === null) {
    return '';
  }
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export function OffersSection({
  view,
  program,
  readOnly,
}: {
  view: OrganizationView;
  program: ProgramDetailRecord;
  readOnly: boolean;
}) {
  const { listingEditorPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const [openForm, setOpenForm] = useState<'add' | { edit: string } | null>(null);
  const [formState, setFormState] = useState<OfferFormState>(emptyOfferForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState<OfferRecord | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['listing', view.organization.id, program.id],
    });
  };

  const announce = (tone: 'success' | 'error', text: string) => {
    setNotice({ tone, text });
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  const buildOffer = ():
    | {
        ok: true;
        input: {
          kind: string;
          labelEn: string;
          trialAmountFils: number | null;
          effectiveStart: string | null;
          effectiveEnd: string | null;
        };
      }
    | { ok: false; message: string } => {
    if (formState.labelEn.trim() === '') {
      return { ok: false, message: 'Give the offer a short label customers will read.' };
    }
    let trialAmountFils: number | null = null;
    if (formState.kind === 'paidTrial') {
      const parsed = parseAedToFils(formState.amount);
      if (parsed.kind === 'invalid') {
        return { ok: false, message: 'A paid trial needs its price in AED, e.g. 25 or 25.50.' };
      }
      trialAmountFils = parsed.fils;
    }
    const effectiveStart = toIso(formState.effectiveStart);
    const effectiveEnd = toIso(formState.effectiveEnd);
    if (
      effectiveStart !== null &&
      effectiveEnd !== null &&
      Date.parse(effectiveEnd) <= Date.parse(effectiveStart)
    ) {
      return { ok: false, message: 'The offer must end after it starts.' };
    }
    return {
      ok: true,
      input: {
        kind: formState.kind,
        labelEn: formState.labelEn.trim(),
        trialAmountFils,
        effectiveStart,
        effectiveEnd,
      },
    };
  };

  const submitForm = async () => {
    if (saving) {
      return;
    }
    const built = buildOffer();
    if (!built.ok) {
      setFormError(built.message);
      return;
    }
    setSaving(true);
    setFormError(null);
    if (openForm === 'add') {
      const outcome = await listingEditorPort.addOffer(view.organization.id, program.id, built.input);
      setSaving(false);
      if (outcome.kind === 'offerAdded') {
        setOpenForm(null);
        await invalidate();
        announce('success', 'Offer added.');
        return;
      }
      setFormError(
        outcome.kind === 'invalidOffer'
          ? 'That offer isn’t valid — check the amount and the dates.'
          : commonMutationErrorCopy(outcome.kind),
      );
      return;
    }
    if (openForm !== null && typeof openForm === 'object') {
      const offer = program.offers.find((candidate) => candidate.id === openForm.edit);
      if (offer === undefined) {
        setSaving(false);
        setOpenForm(null);
        return;
      }
      const patch: OfferPatch = {
        labelEn: built.input.labelEn,
        trialAmountFils: built.input.trialAmountFils,
        effectiveStart: built.input.effectiveStart,
        effectiveEnd: built.input.effectiveEnd,
      };
      const outcome = await listingEditorPort.updateOffer(
        view.organization.id,
        program.id,
        offer.id,
        offer.version,
        patch,
      );
      setSaving(false);
      switch (outcome.kind) {
        case 'offerUpdated':
          setOpenForm(null);
          await invalidate();
          announce('success', 'Offer saved.');
          return;
        case 'invalidOffer':
          setFormError('That offer isn’t valid — check the amount and the dates.');
          return;
        case 'staleVersion':
          setOpenForm(null);
          await invalidate();
          announce('error', 'Someone else changed this offer first. Reloaded — try again.');
          return;
        default:
          setFormError(commonMutationErrorCopy(outcome.kind));
      }
    }
  };

  const endOffer = async (offer: OfferRecord) => {
    setConfirmEnd(null);
    const outcome = await listingEditorPort.endOffer(
      view.organization.id,
      program.id,
      offer.id,
      offer.version,
    );
    if (outcome.kind === 'offerEnded') {
      await invalidate();
      announce('success', `“${offer.labelEn}” has ended. It stays in your history.`);
      return;
    }
    if (outcome.kind === 'staleVersion') {
      await invalidate();
      announce('error', 'Someone else changed this offer first. Reloaded — try again.');
      return;
    }
    announce('error', commonMutationErrorCopy(outcome.kind));
  };

  const openEdit = (offer: OfferRecord) => {
    setFormState({
      kind: offer.kind,
      labelEn: offer.labelEn,
      amount: offer.trialAmountFils === null ? '' : filsToAedInput(offer.trialAmountFils),
      effectiveStart: toLocalInput(offer.effectiveStart),
      effectiveEnd: toLocalInput(offer.effectiveEnd),
    });
    setFormError(null);
    setOpenForm({ edit: offer.id });
  };

  return (
    <section aria-labelledby="editor-offers-heading" className={styles.section}>
      <h2 id="editor-offers-heading" className={styles.sectionTitle}>
        Offers
      </h2>
      <div className={styles.sectionCard}>
        <p className={styles.sectionIntro}>
          Highlights customers see on the listing — like a free trial or a seasonal promotion.
          They&rsquo;re separate from the pricing options above and never change what anyone is
          charged automatically.
        </p>
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          {notice !== null ? <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert> : null}
        </div>
        {program.offers.length === 0 ? (
          <p className={styles.sectionIntro}>No offers on this listing.</p>
        ) : (
          <ul className={styles.rowList} aria-label="Offers">
            {program.offers.map((offer) => (
              <li
                key={offer.id}
                className={
                  offer.state === 'active'
                    ? styles.childRow
                    : `${styles.childRow} ${styles.archivedRow}`
                }
              >
                <div className={styles.childRowMain}>
                  <span className={styles.childRowName}>
                    {offer.labelEn}
                    <StateChip
                      label={offer.state === 'active' ? 'Active' : 'Ended'}
                      tone={offer.state === 'active' ? 'positive' : 'neutral'}
                    />
                  </span>
                  <span className={styles.childRowMeta}>
                    {offerKindLabel(offer.kind)}
                    {offer.trialAmountFils !== null
                      ? ` · ${formatAedFromFils(offer.trialAmountFils)}`
                      : ''}
                  </span>
                </div>
                {!readOnly && offer.state === 'active' ? (
                  <div className={styles.childRowActions}>
                    <Button variant="secondary" onClick={() => openEdit(offer)}>
                      Edit
                      <VisuallyHidden> {offer.labelEn}</VisuallyHidden>
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirmEnd(offer)}>
                      End offer
                      <VisuallyHidden> {offer.labelEn}</VisuallyHidden>
                    </Button>
                  </div>
                ) : null}
                {openForm !== null && openForm !== 'add' && openForm.edit === offer.id ? (
                  <OfferForm
                    title={`Edit ${offer.labelEn}`}
                    formState={formState}
                    setFormState={setFormState}
                    error={formError}
                    saving={saving}
                    kindLocked
                    onSubmit={() => void submitForm()}
                    onCancel={() => setOpenForm(null)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {!readOnly && openForm === null ? (
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setFormState(emptyOfferForm);
                setFormError(null);
                setOpenForm('add');
              }}
            >
              Add offer
            </Button>
          </div>
        ) : null}
        {openForm === 'add' ? (
          <OfferForm
            title="Add offer"
            formState={formState}
            setFormState={setFormState}
            error={formError}
            saving={saving}
            kindLocked={false}
            onSubmit={() => void submitForm()}
            onCancel={() => setOpenForm(null)}
          />
        ) : null}
      </div>

      {confirmEnd !== null ? (
        <ConfirmDialog
          title={`End “${confirmEnd.labelEn}”?`}
          confirmLabel="End offer"
          cancelLabel="Keep offer"
          destructive
          onConfirm={() => void endOffer(confirmEnd)}
          onCancel={() => setConfirmEnd(null)}
        >
          <p>Customers stop seeing this offer. Ending is final — it stays here as history.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function OfferForm({
  title,
  formState,
  setFormState,
  error,
  saving,
  kindLocked,
  onSubmit,
  onCancel,
}: {
  title: string;
  formState: OfferFormState;
  setFormState: (next: OfferFormState) => void;
  error: string | null;
  saving: boolean;
  /** The real PATCH body carries no `kind` — an offer never changes kind. */
  kindLocked: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
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
      <div className={styles.optionFieldRow}>
        <SelectField
          label="Kind"
          value={formState.kind}
          disabled={kindLocked}
          {...(kindLocked
            ? { hint: 'An offer keeps its kind — end it and add a new one to change.' }
            : {})}
          onChange={(event) => setFormState({ ...formState, kind: event.target.value })}
        >
          {OFFER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {offerKindLabel(kind)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Label"
          hint="What customers read, e.g. “Free trial session”."
          value={formState.labelEn}
          onChange={(event) => setFormState({ ...formState, labelEn: event.target.value })}
        />
        {formState.kind === 'paidTrial' ? (
          <TextField
            label="Trial price (AED)"
            inputMode="decimal"
            value={formState.amount}
            onChange={(event) => setFormState({ ...formState, amount: event.target.value })}
          />
        ) : null}
      </div>
      <div className={styles.optionFieldRow}>
        <TextField
          label="Starts (optional)"
          type="datetime-local"
          hint="Times use your device’s time zone."
          value={formState.effectiveStart}
          onChange={(event) => setFormState({ ...formState, effectiveStart: event.target.value })}
        />
        <TextField
          label="Ends (optional)"
          type="datetime-local"
          value={formState.effectiveEnd}
          onChange={(event) => setFormState({ ...formState, effectiveEnd: event.target.value })}
        />
      </div>
      <div className={styles.saveArea}>
        <Button type="submit" busy={saving} busyLabel="Saving…">
          Save offer
        </Button>
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
