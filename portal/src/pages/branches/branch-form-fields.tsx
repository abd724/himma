import { useState } from 'react';
import { useController, useWatch, type UseFormReturn } from 'react-hook-form';
import { Button } from '../../components/ui/button';
import { SelectField } from '../../components/ui/select-field';
import { TextField } from '../../components/ui/text-field';
import { BRANCH_FIELD_LIMITS } from '../../branches/contract';
import { WEEK_DAYS, WEEK_DAY_LABELS } from '../../branches/opening-hours';
import type { AreaRecord } from '../../taxonomy/contract';
import type { BranchFormValues } from './branch-form';
import styles from './branches.module.css';

/**
 * The shared branch editor fields (create + edit). Field-level truth:
 * every field below is a canonically provider-mutable branch column; the
 * area picker sources ACTIVE admin-owned areas from the taxonomy read and
 * never accepts free text. A historical `areaLabel` that no longer matches
 * an active area stays visible as the current (non-reselectable) value and
 * is only replaced when the provider deliberately picks a new area.
 */
export function BranchFormFields({
  form,
  areas,
  currentAreaLabel,
}: {
  form: UseFormReturn<BranchFormValues>;
  areas: readonly AreaRecord[];
  /** The loaded branch's stored area label (edit only). */
  currentAreaLabel?: string;
}) {
  const errors = form.formState.errors;
  const historicalArea =
    currentAreaLabel !== undefined &&
    currentAreaLabel !== '' &&
    !areas.some((area) => area.labelEn === currentAreaLabel)
      ? currentAreaLabel
      : null;

  return (
    <>
      <fieldset className={styles.formSection}>
        <legend className={styles.formLegend}>Location basics</legend>
        <TextField
          label="Branch name"
          hint="How this location appears to your team and to customers, e.g. “Dubai Marina pool”."
          aria-required="true"
          error={errors.label?.message ?? null}
          {...form.register('label')}
        />
        <SelectField
          label="Area"
          hint={
            historicalArea !== null
              ? `“${historicalArea}” is no longer offered for new selection. It stays until you choose a current area.`
              : 'Areas are managed by Himma. Customers browse and filter by area.'
          }
          aria-required="true"
          error={errors.areaLabel?.message ?? null}
          {...form.register('areaLabel')}
        >
          <option value="" disabled>
            Choose an area
          </option>
          {historicalArea !== null ? (
            <option value={historicalArea} disabled>
              {historicalArea} (no longer offered)
            </option>
          ) : null}
          {areas.map((area) => (
            <option key={area.id} value={area.labelEn}>
              {area.labelEn}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Address line"
          hint="Street or building details customers use to find you."
          error={errors.addressLine?.message ?? null}
          {...form.register('addressLine')}
        />
        <TextField
          label="City"
          hint="Kept for your records — not shown on your public storefront."
          error={errors.city?.message ?? null}
          {...form.register('city')}
        />
      </fieldset>

      <fieldset className={styles.formSection}>
        <legend className={styles.formLegend}>Map pin — optional</legend>
        <p className={styles.formNote}>
          Coordinates place this branch on the map in the Himma app. Leave both empty if you
          are unsure.
        </p>
        <div className={styles.geoRow}>
          <TextField
            label="Latitude"
            inputMode="decimal"
            error={errors.latitude?.message ?? null}
            {...form.register('latitude')}
          />
          <TextField
            label="Longitude"
            inputMode="decimal"
            error={errors.longitude?.message ?? null}
            {...form.register('longitude')}
          />
        </div>
      </fieldset>

      <OpeningHoursFields form={form} />
      <FacilitiesFields form={form} />
    </>
  );
}

function OpeningHoursFields({ form }: { form: UseFormReturn<BranchFormValues> }) {
  const hours = useWatch({ control: form.control, name: 'hours' });
  const errors = form.formState.errors;

  return (
    <fieldset className={styles.formSection}>
      <legend className={styles.formLegend}>Opening hours — optional</legend>
      <p className={styles.formNote}>
        Tick the days this branch is open and set its hours. Days left unticked show as closed.
      </p>
      <div className={styles.hoursGrid}>
        {WEEK_DAYS.map((day) => {
          const enabled = hours?.[day]?.enabled ?? false;
          const dayErrors = errors.hours?.[day];
          return (
            <div key={day} className={styles.hoursRow}>
              <label className={styles.hoursDay}>
                <input
                  type="checkbox"
                  className={styles.hoursCheckbox}
                  {...form.register(`hours.${day}.enabled`)}
                />
                <span>{WEEK_DAY_LABELS[day]}</span>
              </label>
              {enabled ? (
                <div className={styles.hoursTimes}>
                  <TextField
                    label={`${WEEK_DAY_LABELS[day]} opens at`}
                    type="time"
                    error={dayErrors?.open?.message ?? null}
                    {...form.register(`hours.${day}.open`)}
                  />
                  <TextField
                    label={`${WEEK_DAY_LABELS[day]} closes at`}
                    type="time"
                    error={dayErrors?.close?.message ?? null}
                    {...form.register(`hours.${day}.close`)}
                  />
                </div>
              ) : (
                <p className={styles.hoursClosed}>Closed</p>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function FacilitiesFields({ form }: { form: UseFormReturn<BranchFormValues> }) {
  const {
    field,
    fieldState: { error },
  } = useController({ control: form.control, name: 'facilities' });
  const facilities: string[] = field.value ?? [];
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);

  const addFacility = () => {
    const value = draft.trim();
    if (value === '') {
      return;
    }
    if (value.length > BRANCH_FIELD_LIMITS.facilityLength) {
      setDraftError(
        `Facilities can be at most ${BRANCH_FIELD_LIMITS.facilityLength} characters.`,
      );
      return;
    }
    if (facilities.length >= BRANCH_FIELD_LIMITS.facilitiesCount) {
      setDraftError(
        `You can list at most ${BRANCH_FIELD_LIMITS.facilitiesCount} facilities.`,
      );
      return;
    }
    if (facilities.some((facility) => facility.toLowerCase() === value.toLowerCase())) {
      setDraftError('That facility is already listed.');
      return;
    }
    field.onChange([...facilities, value]);
    setDraft('');
    setDraftError(null);
  };

  return (
    <fieldset className={styles.formSection}>
      <legend className={styles.formLegend}>Facilities — optional</legend>
      <p className={styles.formNote}>
        Amenities customers can expect at this location, e.g. “Parking” or “Changing rooms”.
      </p>
      <div className={styles.facilityAddRow}>
        <TextField
          label="Add a facility"
          value={draft}
          error={draftError ?? error?.message ?? null}
          maxLength={BRANCH_FIELD_LIMITS.facilityLength}
          onChange={(event) => {
            setDraft(event.target.value);
            setDraftError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addFacility();
            }
          }}
        />
        <Button type="button" variant="secondary" onClick={addFacility}>
          Add
        </Button>
      </div>
      {facilities.length > 0 ? (
        <ul className={styles.facilityChips} aria-label="Listed facilities">
          {facilities.map((facility) => (
            <li key={facility} className={styles.facilityChip}>
              <span>{facility}</span>
              <button
                type="button"
                className={styles.facilityRemove}
                aria-label={`Remove ${facility}`}
                onClick={() =>
                  field.onChange(facilities.filter((candidate) => candidate !== facility))
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.formNote}>No facilities listed yet.</p>
      )}
    </fieldset>
  );
}
