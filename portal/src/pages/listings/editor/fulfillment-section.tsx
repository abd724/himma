import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { usePortalPorts } from '../../../app/ports-context';
import type { PriceOptionRecord } from '../../../catalogue/contract';
import type {
  FulfillmentRevision,
  FulfillmentScheduleTerm,
  FulfillmentTermsInput,
  LoadFulfillmentOutcome,
} from '../../../catalogue/fulfillment-contract';
import { Button } from '../../../components/ui/button';
import { InlineAlert } from '../../../components/ui/inline-alert';
import { SelectField } from '../../../components/ui/select-field';
import { TextField } from '../../../components/ui/text-field';
import type { OrganizationView } from '../../../profile/contract';
import { priceOptionName } from '../listing-domain';
import styles from './editor.module.css';

/**
 * Fulfillment terms editor (W2-13 §4–7) for the ENTITLEMENT price-option
 * kinds (package/membership) — what the customer's purchase entitles them
 * to and how it is used up. Membership stays commercial vocabulary only
 * (D-S6-3): whether it is a finite pass or unlimited access is decided
 * HERE, never by the kind. Saving never edits terms in place — the backend
 * supersedes the active revision and inserts the next IMMUTABLE one, and
 * customers who already purchased keep their historical terms (the "future
 * purchases only" note is the truthful rendering of that rule). Server
 * validation is authoritative; the client mirrors it only to give earlier,
 * clearer messages.
 */

const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

interface FulfillmentFormState {
  usageKind: 'finite' | 'unlimited';
  usesTotal: string;
  validityKind: 'daysFromConfirmation' | 'fixedEndDate' | 'none';
  validityDays: string;
  validityEndDate: string;
  reservationRequired: boolean;
  walkInAllowed: boolean;
  branchId: string; // '' = any branch
  scheduleTerms: Array<{ weekday: string; startTime: string; endTime: string }>;
}

const emptyForm = (_optionKind: string): FulfillmentFormState => ({
  usageKind: 'finite',
  usesTotal: '',
  validityKind: 'daysFromConfirmation',
  validityDays: '',
  validityEndDate: '',
  reservationRequired: false,
  walkInAllowed: true,
  branchId: '',
  scheduleTerms: [],
});

const formFromRevision = (revision: FulfillmentRevision): FulfillmentFormState => ({
  usageKind: revision.usageKind,
  usesTotal: revision.usesTotal === undefined ? '' : String(revision.usesTotal),
  validityKind: revision.validityKind,
  validityDays: revision.validityDays === undefined ? '' : String(revision.validityDays),
  validityEndDate: revision.validityEndDate ?? '',
  reservationRequired: revision.reservationRequired,
  walkInAllowed: revision.walkInAllowed,
  branchId: revision.branchId ?? '',
  scheduleTerms: revision.scheduleTerms.map((term) => ({
    weekday: String(term.weekday),
    startTime: term.startTime,
    endTime: term.endTime,
  })),
});

function describeRevision(revision: FulfillmentRevision, optionKind: string): string {
  const usage =
    revision.usageKind === 'unlimited'
      ? 'Unlimited visits'
      : optionKind === 'package'
        ? 'One visit per package session'
        : `${revision.usesTotal ?? '—'} visits`;
  const validity =
    revision.validityKind === 'daysFromConfirmation'
      ? `valid ${revision.validityDays} days from purchase`
      : revision.validityKind === 'fixedEndDate'
        ? `valid until ${revision.validityEndDate}`
        : 'no time limit';
  const methods = [
    revision.walkInAllowed ? 'walk-in' : null,
    revision.reservationRequired ? 'reservation required' : null,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(' · ');
  return `${usage}, ${validity}${methods === '' ? '' : ` · ${methods}`}`;
}

export function FulfillmentSection({
  view,
  programId,
  option,
  canManage,
}: {
  view: OrganizationView;
  programId: string;
  option: PriceOptionRecord;
  canManage: boolean;
}) {
  const { fulfillmentPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [formOpen, setFormOpen] = useState(false);
  const [formState, setFormState] = useState<FulfillmentFormState>(emptyForm(option.kind));
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);

  const query = useQuery({
    queryKey: ['fulfillment', view.organization.id, programId, option.id],
    queryFn: () => fulfillmentPort.loadFulfillment(view.organization.id, programId, option.id),
  });

  const focusAlert = () => requestAnimationFrame(() => alertRef.current?.focus());

  const data: LoadFulfillmentOutcome | undefined = query.data;
  const loaded = data !== undefined && data.kind === 'fulfillment' ? data : null;
  const active = loaded === null ? null : loaded.active;

  const openForm = () => {
    setFormState(active !== null ? formFromRevision(active) : emptyForm(option.kind));
    setFormError(null);
    setFormOpen(true);
  };

  /** Client mirror of the server rules — earlier messages only; the PUT
   *  outcome stays authoritative. */
  const buildTerms = (): { ok: true; terms: FulfillmentTermsInput } | { ok: false; message: string } => {
    const isPackage = option.kind === 'package';
    const usageKind = isPackage ? 'finite' : formState.usageKind;
    let usesTotal: number | undefined;
    if (!isPackage && usageKind === 'finite') {
      if (!/^\d+$/.test(formState.usesTotal.trim()) || Number(formState.usesTotal) < 1) {
        return { ok: false, message: 'A limited membership needs a whole number of visits.' };
      }
      usesTotal = Number(formState.usesTotal);
    }
    let validityDays: number | undefined;
    let validityEndDate: string | undefined;
    if (formState.validityKind === 'daysFromConfirmation') {
      if (!/^\d+$/.test(formState.validityDays.trim()) || Number(formState.validityDays) < 1) {
        return { ok: false, message: 'Enter how many days the purchase stays valid.' };
      }
      validityDays = Number(formState.validityDays);
    } else if (formState.validityKind === 'fixedEndDate') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(formState.validityEndDate.trim())) {
        return { ok: false, message: 'Choose the end date the purchase stays valid until.' };
      }
      validityEndDate = formState.validityEndDate.trim();
    } else if (usageKind === 'unlimited') {
      return {
        ok: false,
        message: 'Unlimited access needs a validity period — otherwise it would never end.',
      };
    }
    if (!formState.reservationRequired && !formState.walkInAllowed) {
      return {
        ok: false,
        message: 'Choose at least one way to attend — walk-in, reservation, or both.',
      };
    }
    let scheduleTerms: FulfillmentScheduleTerm[] | undefined;
    if (formState.scheduleTerms.length > 0) {
      scheduleTerms = [];
      for (const row of formState.scheduleTerms) {
        if (row.startTime === '' || row.endTime === '' || row.startTime >= row.endTime) {
          return {
            ok: false,
            message: 'Each schedule row needs a start time before its end time.',
          };
        }
        scheduleTerms.push({
          weekday: Number(row.weekday),
          startTime: row.startTime,
          endTime: row.endTime,
        });
      }
    }
    return {
      ok: true,
      terms: {
        usageKind,
        ...(usesTotal !== undefined ? { usesTotal } : {}),
        validityKind: formState.validityKind,
        ...(validityDays !== undefined ? { validityDays } : {}),
        ...(validityEndDate !== undefined ? { validityEndDate } : {}),
        reservationRequired: formState.reservationRequired,
        walkInAllowed: formState.walkInAllowed,
        ...(formState.branchId !== '' ? { branchId: formState.branchId } : {}),
        ...(scheduleTerms !== undefined ? { scheduleTerms } : {}),
      },
    };
  };

  const save = async () => {
    if (savingRef.current) return;
    const built = buildTerms();
    if (!built.ok) {
      setFormError(built.message);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFormError(null);
    const outcome = await fulfillmentPort.setFulfillment(
      view.organization.id,
      programId,
      option.id,
      built.terms,
    );
    savingRef.current = false;
    setSaving(false);
    switch (outcome.kind) {
      case 'revisionCreated':
        setFormOpen(false);
        setNotice({
          tone: 'success',
          text: 'Fulfillment terms saved. They apply to future purchases only — customers who already bought keep the terms they bought under.',
        });
        await queryClient.invalidateQueries({
          queryKey: ['fulfillment', view.organization.id, programId, option.id],
        });
        focusAlert();
        return;
      case 'invalidFulfillmentConfig':
        setFormError('That combination of terms isn’t valid for this option. Review the visits, validity, and attendance settings.');
        return;
      case 'invalidBranch':
        setFormError('That branch isn’t available any more. Choose another branch or any branch.');
        return;
      case 'lifecycleConflict':
        setFormError('This option can’t take fulfillment changes right now. Reload the listing and try again.');
        return;
      case 'forbidden':
        setFormError('Your role can’t change fulfillment terms.');
        return;
      case 'notFound':
        setFormError('We can’t reach this option any more. Reload the listing and try again.');
        return;
      default:
        setFormError('We couldn’t save these terms right now. Try again in a moment.');
    }
  };

  const activeBranches = view.branches.filter((branch) => branch.active);
  const isPackage = option.kind === 'package';

  return (
    <section aria-labelledby={headingId} className={styles.fulfillmentBlock}>
      <h3 id={headingId} className={styles.fulfillmentTitle}>
        Fulfillment — {priceOptionName(option)}
      </h3>
      <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
        {notice !== null ? <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert> : null}
      </div>
      {query.isPending ? (
        <p className={styles.sectionIntro} role="status">
          Loading fulfillment terms…
        </p>
      ) : loaded === null ? (
        <InlineAlert tone="error">
          We couldn’t load the fulfillment terms right now. Try again in a moment.
        </InlineAlert>
      ) : (
        <>
          {active !== null ? (
            <p className={styles.sectionIntro}>{describeRevision(active, option.kind)}</p>
          ) : (
            <p className={styles.sectionIntro}>
              No fulfillment terms yet. Customers can’t use this option at the door until its
              terms are set.
            </p>
          )}
          {canManage && !formOpen ? (
            <div>
              <Button variant="secondary" onClick={openForm}>
                {active !== null ? 'Change terms' : 'Set terms'}
              </Button>
            </div>
          ) : null}
          {canManage && formOpen ? (
            <form
              className={styles.inlineFormCard}
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
              noValidate
              aria-label={`Fulfillment terms for ${priceOptionName(option)}`}
            >
              {formError !== null ? <InlineAlert tone="error">{formError}</InlineAlert> : null}
              <InlineAlert tone="info">
                Changes apply to future purchases only. Customers who already bought this option
                keep the terms they bought under.
              </InlineAlert>

              {isPackage ? (
                <p className={styles.sectionIntro}>
                  A package is a fixed number of visits — one per package session
                  {option.sessionsCount !== null ? ` (${option.sessionsCount} sessions)` : ''}.
                </p>
              ) : (
                <>
                  <SelectField
                    label="Access"
                    hint="Whether this membership is a limited pass or unlimited access."
                    value={formState.usageKind}
                    onChange={(event) =>
                      setFormState({
                        ...formState,
                        usageKind: event.target.value as 'finite' | 'unlimited',
                      })
                    }
                  >
                    <option value="finite">Limited number of visits</option>
                    <option value="unlimited">Unlimited visits</option>
                  </SelectField>
                  {formState.usageKind === 'finite' ? (
                    <TextField
                      label="Visits included"
                      inputMode="numeric"
                      value={formState.usesTotal}
                      onChange={(event) =>
                        setFormState({ ...formState, usesTotal: event.target.value })
                      }
                    />
                  ) : null}
                </>
              )}

              <SelectField
                label="Validity"
                hint="How long a purchase stays usable."
                value={formState.validityKind}
                onChange={(event) =>
                  setFormState({
                    ...formState,
                    validityKind: event.target.value as FulfillmentFormState['validityKind'],
                  })
                }
              >
                <option value="daysFromConfirmation">A number of days from purchase</option>
                <option value="fixedEndDate">Until a fixed end date</option>
                {isPackage || formState.usageKind === 'finite' ? (
                  <option value="none">No time limit</option>
                ) : null}
              </SelectField>
              {formState.validityKind === 'daysFromConfirmation' ? (
                <TextField
                  label="Valid for (days)"
                  inputMode="numeric"
                  value={formState.validityDays}
                  onChange={(event) =>
                    setFormState({ ...formState, validityDays: event.target.value })
                  }
                />
              ) : null}
              {formState.validityKind === 'fixedEndDate' ? (
                <TextField
                  label="Valid until"
                  type="date"
                  value={formState.validityEndDate}
                  onChange={(event) =>
                    setFormState({ ...formState, validityEndDate: event.target.value })
                  }
                />
              ) : null}

              <fieldset className={styles.fulfillmentFieldset}>
                <legend className={styles.radioGroupLabel}>How customers attend</legend>
                <label className={styles.radioOption}>
                  <input
                    type="checkbox"
                    checked={formState.walkInAllowed}
                    onChange={(event) =>
                      setFormState({ ...formState, walkInAllowed: event.target.checked })
                    }
                  />
                  Walk-in — show a check-in code at the desk
                </label>
                <label className={styles.radioOption}>
                  <input
                    type="checkbox"
                    checked={formState.reservationRequired}
                    onChange={(event) =>
                      setFormState({ ...formState, reservationRequired: event.target.checked })
                    }
                  />
                  Reservation required before attending
                </label>
              </fieldset>

              <SelectField
                label="Branch"
                hint="Where this option can be used."
                value={formState.branchId}
                onChange={(event) =>
                  setFormState({ ...formState, branchId: event.target.value })
                }
              >
                <option value="">Any branch</option>
                {activeBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.label}
                  </option>
                ))}
              </SelectField>

              {!isPackage ? (
                <fieldset className={styles.fulfillmentFieldset}>
                  <legend className={styles.radioGroupLabel}>
                    Attendance hours (optional)
                  </legend>
                  {formState.scheduleTerms.map((row, index) => (
                    <div key={index} className={styles.optionFieldRow}>
                      <SelectField
                        label="Day"
                        value={row.weekday}
                        onChange={(event) => {
                          const next = [...formState.scheduleTerms];
                          next[index] = { ...row, weekday: event.target.value };
                          setFormState({ ...formState, scheduleTerms: next });
                        }}
                      >
                        {WEEKDAY_LABELS.map((label, weekday) => (
                          <option key={label} value={String(weekday)}>
                            {label}
                          </option>
                        ))}
                      </SelectField>
                      <TextField
                        label="From"
                        type="time"
                        value={row.startTime}
                        onChange={(event) => {
                          const next = [...formState.scheduleTerms];
                          next[index] = { ...row, startTime: event.target.value };
                          setFormState({ ...formState, scheduleTerms: next });
                        }}
                      />
                      <TextField
                        label="To"
                        type="time"
                        value={row.endTime}
                        onChange={(event) => {
                          const next = [...formState.scheduleTerms];
                          next[index] = { ...row, endTime: event.target.value };
                          setFormState({ ...formState, scheduleTerms: next });
                        }}
                      />
                      <Button
                        variant="secondary"
                        type="button"
                        onClick={() =>
                          setFormState({
                            ...formState,
                            scheduleTerms: formState.scheduleTerms.filter(
                              (_, other) => other !== index,
                            ),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() =>
                        setFormState({
                          ...formState,
                          scheduleTerms: [
                            ...formState.scheduleTerms,
                            { weekday: '0', startTime: '', endTime: '' },
                          ],
                        })
                      }
                    >
                      Add hours
                    </Button>
                  </div>
                </fieldset>
              ) : null}

              <div className={styles.saveArea}>
                <Button type="submit" busy={saving} busyLabel="Saving…">
                  Save terms
                </Button>
                <Button variant="secondary" type="button" onClick={() => setFormOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}
