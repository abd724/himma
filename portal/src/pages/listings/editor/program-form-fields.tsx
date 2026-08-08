import type { UseFormReturn } from 'react-hook-form';
import { useId } from 'react';
import type { ActivityTypeRecord } from '../../../taxonomy/contract';
import { SelectField } from '../../../components/ui/select-field';
import { TextAreaField } from '../../../components/ui/textarea-field';
import { TextField } from '../../../components/ui/text-field';
import {
  GENDER_ELIGIBILITY_VALUES,
  PROGRAM_SETTINGS,
} from '../../../catalogue/editor-contract';
import { GENDER_LABELS, SETTING_LABELS, SKILL_LABELS } from '../listing-domain';
import type { ProgramFormValues } from './program-form';
import styles from './editor.module.css';

/**
 * The canonical provider-editable Program fields (create + edit), exactly
 * the real create/PATCH contract: English content first, Arabic optional,
 * DB-managed taxonomy select (ACTIVE rows only — an inactive historical
 * type stays visible but can't be newly chosen), the five-value gender
 * vocabulary, and age/skill eligibility independent of gender. Nothing
 * else — no price, no capacity, no schedule, no lifecycle control.
 */
export function ProgramFormFields({
  form,
  activityTypes,
  currentActivityType,
  showSensitiveChip = false,
  sensitiveDisabled = false,
}: {
  form: UseFormReturn<ProgramFormValues>;
  activityTypes: readonly ActivityTypeRecord[];
  /** The loaded listing's embedded activity type (edit only) — kept
   *  selectable as the CURRENT value even when no longer active. */
  currentActivityType?: { id: string; labelEn: string; active: boolean };
  /** Review-gated listings: mark the docs/28 §7 protected fields. */
  showSensitiveChip?: boolean;
  /** An open revision blocks further protected changes (backend truth). */
  sensitiveDisabled?: boolean;
}) {
  const errors = form.formState.errors;
  const allAges = form.watch('allAges');
  const settingGroupId = useId();
  const genderGroupId = useId();

  const historicalType =
    currentActivityType !== undefined && !currentActivityType.active ? currentActivityType : null;

  const sensitiveChip = showSensitiveChip ? (
    <span className={styles.reviewChip}>Needs Himma review</span>
  ) : null;

  return (
    <>
      <fieldset className={styles.formSection}>
        <legend className={styles.formLegend}>Basics</legend>
        <TextField
          label="Title (English)"
          hint="How this listing appears across Himma, e.g. “Adult Beginner Swimming”."
          aria-required="true"
          error={errors.titleEn?.message ?? null}
          {...form.register('titleEn')}
        />
        <TextField
          label="Title (Arabic, optional)"
          dir="auto"
          error={errors.titleAr?.message ?? null}
          {...form.register('titleAr')}
        />
        <SelectField
          label="Activity type"
          hint={
            historicalType !== null
              ? `“${historicalType.labelEn}” is no longer in the Himma catalogue. It stays until you choose a current activity type.`
              : 'Activity types are managed by Himma. Customers browse and filter by them.'
          }
          aria-required="true"
          error={errors.activityTypeId?.message ?? null}
          {...form.register('activityTypeId')}
        >
          <option value="" disabled>
            Choose an activity type
          </option>
          {historicalType !== null ? (
            <option value={historicalType.id}>
              {historicalType.labelEn} (no longer in the catalogue)
            </option>
          ) : null}
          {activityTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.labelEn}
            </option>
          ))}
        </SelectField>
        <div
          className={styles.radioGroup}
          role="radiogroup"
          aria-labelledby={`${settingGroupId}-label`}
        >
          <span id={`${settingGroupId}-label`} className={styles.radioGroupLabel}>
            Setting
          </span>
          <div className={styles.radioOptions}>
            {PROGRAM_SETTINGS.map((setting) => (
              <label key={setting} className={styles.radioOption}>
                <input type="radio" value={setting} {...form.register('setting')} />
                {SETTING_LABELS[setting]}
              </label>
            ))}
          </div>
        </div>
        <div className={styles.fieldWithChip}>
          <TextAreaField
            label="Description (English)"
            hint="What customers read on the listing. You can add this later."
            rows={5}
            error={errors.descriptionEn?.message ?? null}
            disabled={sensitiveDisabled}
            {...form.register('descriptionEn')}
          />
          {sensitiveChip}
        </div>
        <TextAreaField
          label="Description (Arabic, optional)"
          dir="auto"
          rows={3}
          error={errors.descriptionAr?.message ?? null}
          disabled={sensitiveDisabled}
          {...form.register('descriptionAr')}
        />
      </fieldset>

      <fieldset className={styles.formSection}>
        <legend className={styles.formLegend}>
          Eligibility {sensitiveChip}
        </legend>
        <div
          className={styles.radioGroup}
          role="radiogroup"
          aria-labelledby={`${genderGroupId}-label`}
        >
          <span id={`${genderGroupId}-label`} className={styles.radioGroupLabel}>
            Who it&rsquo;s for
          </span>
          <div className={styles.radioOptions}>
            {GENDER_ELIGIBILITY_VALUES.map((value) => (
              <label key={value} className={styles.radioOption}>
                <input
                  type="radio"
                  value={value}
                  disabled={sensitiveDisabled}
                  {...form.register('genderEligibility')}
                />
                {GENDER_LABELS[value]}
              </label>
            ))}
          </div>
        </div>
        <label className={styles.checkboxRow}>
          <input type="checkbox" disabled={sensitiveDisabled} {...form.register('allAges')} />
          All ages welcome
        </label>
        {errors.allAges?.message ? (
          <p role="alert" className={styles.fieldError}>
            {errors.allAges.message}
          </p>
        ) : null}
        {!allAges ? (
          <div className={styles.ageRow}>
            <TextField
              label="Youngest age (optional)"
              inputMode="numeric"
              error={errors.minAge?.message ?? null}
              disabled={sensitiveDisabled}
              {...form.register('minAge')}
            />
            <TextField
              label="Oldest age (optional)"
              inputMode="numeric"
              error={errors.maxAge?.message ?? null}
              disabled={sensitiveDisabled}
              {...form.register('maxAge')}
            />
          </div>
        ) : null}
        <SelectField
          label="Skill level (optional)"
          error={errors.skillLevel?.message ?? null}
          disabled={sensitiveDisabled}
          {...form.register('skillLevel')}
        >
          <option value="">Not specified</option>
          {(['beginner', 'intermediate', 'advanced', 'all-levels'] as const).map((level) => (
            <option key={level} value={level}>
              {SKILL_LABELS[level]}
            </option>
          ))}
        </SelectField>
        <TextAreaField
          label="Eligibility notes (optional)"
          hint="Anything participants should know before joining — safety requirements, prerequisites."
          rows={3}
          error={errors.eligibilityNotes?.message ?? null}
          disabled={sensitiveDisabled}
          {...form.register('eligibilityNotes')}
        />
      </fieldset>
    </>
  );
}
