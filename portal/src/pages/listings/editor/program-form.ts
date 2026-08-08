import { z } from 'zod';
import type { ProgramDetailRecord } from '../../../catalogue/contract';
import {
  GENDER_ELIGIBILITY_VALUES,
  PROGRAM_FIELD_LIMITS,
  PROGRAM_SETTINGS,
  SKILL_LEVELS,
  type ProgramCreateInput,
  type ProgramPatch,
} from '../../../catalogue/editor-contract';

/**
 * Client-side mirror of the real Program create/PATCH constraints (docs/08
 * §14: client validation is UX only — the backend stays authoritative).
 * Limits are the exact TypeBox values; ages are independent from gender;
 * Arabic is optional and never blocks anything.
 */

const optionalAge = z
  .string()
  .refine(
    (value) => value.trim() === '' || (/^\d+$/.test(value.trim()) && Number(value.trim()) <= PROGRAM_FIELD_LIMITS.ageMax),
    `Ages are whole numbers up to ${PROGRAM_FIELD_LIMITS.ageMax}.`,
  );

export const programFormSchema = z
  .object({
    titleEn: z
      .string()
      .max(
        PROGRAM_FIELD_LIMITS.titleEn,
        `Titles can be at most ${PROGRAM_FIELD_LIMITS.titleEn} characters.`,
      )
      .refine((value) => value.trim().length > 0, 'Enter an English title for this listing.'),
    titleAr: z.string().max(PROGRAM_FIELD_LIMITS.titleAr),
    descriptionEn: z.string().max(PROGRAM_FIELD_LIMITS.descriptionEn),
    descriptionAr: z.string().max(PROGRAM_FIELD_LIMITS.descriptionAr),
    activityTypeId: z.string().refine((value) => value !== '', 'Choose an activity type.'),
    setting: z.enum(PROGRAM_SETTINGS),
    genderEligibility: z.enum(GENDER_ELIGIBILITY_VALUES),
    allAges: z.boolean(),
    minAge: optionalAge,
    maxAge: optionalAge,
    skillLevel: z.enum([...SKILL_LEVELS, '']),
    eligibilityNotes: z.string().max(PROGRAM_FIELD_LIMITS.eligibilityNotes),
  })
  .superRefine((values, ctx) => {
    const minAge = values.minAge.trim() === '' ? null : Number(values.minAge.trim());
    const maxAge = values.maxAge.trim() === '' ? null : Number(values.maxAge.trim());
    if (minAge !== null && maxAge !== null && minAge > maxAge) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxAge'],
        message: 'The upper age can’t be below the lower age.',
      });
    }
    if (values.allAges && (minAge !== null || maxAge !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['allAges'],
        message: 'An all-ages listing can’t also carry age bounds — clear the ages or the box.',
      });
    }
  });

export type ProgramFormValues = z.infer<typeof programFormSchema>;

export function emptyProgramFormValues(): ProgramFormValues {
  return {
    titleEn: '',
    titleAr: '',
    descriptionEn: '',
    descriptionAr: '',
    activityTypeId: '',
    setting: 'indoor',
    genderEligibility: 'mixed',
    allAges: false,
    minAge: '',
    maxAge: '',
    skillLevel: '',
    eligibilityNotes: '',
  };
}

export function programFormValuesOf(program: ProgramDetailRecord): ProgramFormValues {
  return {
    titleEn: program.titleEn,
    titleAr: program.titleAr ?? '',
    descriptionEn: program.descriptionEn ?? '',
    descriptionAr: program.descriptionAr ?? '',
    activityTypeId: program.activityType.id,
    setting: program.setting === 'outdoor' ? 'outdoor' : 'indoor',
    genderEligibility: (GENDER_ELIGIBILITY_VALUES as readonly string[]).includes(
      program.genderEligibility,
    )
      ? (program.genderEligibility as ProgramFormValues['genderEligibility'])
      : 'mixed',
    allAges: program.allAges,
    minAge: program.minAge === null ? '' : String(program.minAge),
    maxAge: program.maxAge === null ? '' : String(program.maxAge),
    skillLevel: (SKILL_LEVELS as readonly string[]).includes(program.skillLevel ?? '')
      ? (program.skillLevel as ProgramFormValues['skillLevel'])
      : '',
    eligibilityNotes: program.eligibilityNotes ?? '',
  };
}

const nullableText = (value: string): string | null => (value.trim() === '' ? null : value);
const nullableAge = (value: string): number | null =>
  value.trim() === '' ? null : Number(value.trim());

/** POST body from the create form — exactly the real create fields. */
export function buildCreateInput(values: ProgramFormValues): ProgramCreateInput {
  return {
    titleEn: values.titleEn.trim(),
    titleAr: nullableText(values.titleAr),
    descriptionEn: nullableText(values.descriptionEn),
    descriptionAr: nullableText(values.descriptionAr),
    activityTypeId: values.activityTypeId,
    setting: values.setting,
    genderEligibility: values.genderEligibility,
    minAge: nullableAge(values.minAge),
    maxAge: nullableAge(values.maxAge),
    allAges: values.allAges,
    skillLevel: values.skillLevel === '' ? null : values.skillLevel,
    eligibilityNotes: nullableText(values.eligibilityNotes),
  };
}

/**
 * Dirty-field-only PATCH: only fields whose canonical value differs from the
 * loaded baseline are sent — an untouched field never appears in the body.
 */
export function buildProgramPatch(
  baseline: ProgramFormValues,
  values: ProgramFormValues,
): ProgramPatch {
  const patch: Record<string, unknown> = {};
  const canonical = {
    titleEn: values.titleEn.trim(),
    titleAr: nullableText(values.titleAr),
    descriptionEn: nullableText(values.descriptionEn),
    descriptionAr: nullableText(values.descriptionAr),
    activityTypeId: values.activityTypeId,
    setting: values.setting,
    genderEligibility: values.genderEligibility,
    minAge: nullableAge(values.minAge),
    maxAge: nullableAge(values.maxAge),
    allAges: values.allAges,
    skillLevel: values.skillLevel === '' ? null : values.skillLevel,
    eligibilityNotes: nullableText(values.eligibilityNotes),
  };
  const base = {
    titleEn: baseline.titleEn.trim(),
    titleAr: nullableText(baseline.titleAr),
    descriptionEn: nullableText(baseline.descriptionEn),
    descriptionAr: nullableText(baseline.descriptionAr),
    activityTypeId: baseline.activityTypeId,
    setting: baseline.setting,
    genderEligibility: baseline.genderEligibility,
    minAge: nullableAge(baseline.minAge),
    maxAge: nullableAge(baseline.maxAge),
    allAges: baseline.allAges,
    skillLevel: baseline.skillLevel === '' ? null : baseline.skillLevel,
    eligibilityNotes: nullableText(baseline.eligibilityNotes),
  };
  for (const key of Object.keys(canonical) as (keyof typeof canonical)[]) {
    if (canonical[key] !== base[key]) {
      patch[key] = canonical[key];
    }
  }
  return patch as ProgramPatch;
}
