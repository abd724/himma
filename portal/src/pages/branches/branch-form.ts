import { z } from 'zod';
import type { BranchInput, BranchPatch, GeoPoint } from '../../branches/contract';
import { BRANCH_FIELD_LIMITS } from '../../branches/contract';
import type { BranchRecord } from '../../profile/contract';
import {
  WEEK_DAYS,
  isValidTime,
  parseOpeningHours,
  serializeOpeningHours,
  type WeekDay,
  type WeeklyOpeningHours,
} from '../../branches/opening-hours';

/**
 * Client-side mirror of the branch route constraints (docs/08 §14: client
 * validation is UX only — the backend stays authoritative). Limits are the
 * exact TypeBox values from the real POST/PATCH bodies: label 1–120 and
 * areaLabel 1–80 required, addressLine ≤240, city ≤80, geo ranges
 * (−180…180 / −90…90), facilities ≤20 × 1–40 chars.
 */

const dayHoursSchema = z.object({
  enabled: z.boolean(),
  open: z.string(),
  close: z.string(),
});

export const branchFormSchema = z.object({
  label: z
    .string()
    .max(
      BRANCH_FIELD_LIMITS.label,
      `Branch names can be at most ${BRANCH_FIELD_LIMITS.label} characters.`,
    )
    .refine((value) => value.trim().length > 0, 'Enter a name for this branch.'),
  areaLabel: z
    .string()
    .max(BRANCH_FIELD_LIMITS.areaLabel)
    .refine((value) => value.trim().length > 0, 'Choose the area this branch is in.'),
  addressLine: z
    .string()
    .max(
      BRANCH_FIELD_LIMITS.addressLine,
      `Addresses can be at most ${BRANCH_FIELD_LIMITS.addressLine} characters.`,
    ),
  city: z
    .string()
    .max(BRANCH_FIELD_LIMITS.city, `City can be at most ${BRANCH_FIELD_LIMITS.city} characters.`),
  latitude: z
    .string()
    .refine(
      (value) => value.trim() === '' || isFiniteInRange(value, -90, 90),
      'Latitude must be a number between −90 and 90.',
    ),
  longitude: z
    .string()
    .refine(
      (value) => value.trim() === '' || isFiniteInRange(value, -180, 180),
      'Longitude must be a number between −180 and 180.',
    ),
  hours: z.object({
    mon: dayHoursSchema,
    tue: dayHoursSchema,
    wed: dayHoursSchema,
    thu: dayHoursSchema,
    fri: dayHoursSchema,
    sat: dayHoursSchema,
    sun: dayHoursSchema,
  }),
  facilities: z
    .array(z.string())
    .max(
      BRANCH_FIELD_LIMITS.facilitiesCount,
      `You can list at most ${BRANCH_FIELD_LIMITS.facilitiesCount} facilities.`,
    ),
})
  .superRefine((values, context) => {
    if (
      (values.latitude.trim() === '') !== (values.longitude.trim() === '')
    ) {
      const empty = values.latitude.trim() === '' ? 'latitude' : 'longitude';
      context.addIssue({
        code: 'custom',
        path: [empty],
        message: 'Enter both latitude and longitude, or leave both empty.',
      });
    }
    for (const day of WEEK_DAYS) {
      const dayValue = values.hours[day];
      if (!dayValue.enabled) {
        continue;
      }
      if (!isValidTime(dayValue.open) || !isValidTime(dayValue.close)) {
        context.addIssue({
          code: 'custom',
          path: ['hours', day, isValidTime(dayValue.open) ? 'close' : 'open'],
          message: 'Enter opening and closing times for this day.',
        });
      }
    }
  });

function isFiniteInRange(value: string, min: number, max: number): boolean {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

export interface DayHoursFormValue {
  enabled: boolean;
  open: string;
  close: string;
}

export interface BranchFormValues {
  label: string;
  areaLabel: string;
  addressLine: string;
  city: string;
  latitude: string;
  longitude: string;
  hours: Record<WeekDay, DayHoursFormValue>;
  facilities: string[];
}

const CLOSED_DAY: DayHoursFormValue = { enabled: false, open: '', close: '' };

export function emptyBranchFormValues(): BranchFormValues {
  return {
    label: '',
    areaLabel: '',
    addressLine: '',
    city: '',
    latitude: '',
    longitude: '',
    hours: hoursToForm(null),
    facilities: [],
  };
}

function hoursToForm(hours: WeeklyOpeningHours | null): Record<WeekDay, DayHoursFormValue> {
  const out = {} as Record<WeekDay, DayHoursFormValue>;
  for (const day of WEEK_DAYS) {
    const dayHours = hours?.[day];
    out[day] = dayHours
      ? { enabled: true, open: dayHours.open, close: dayHours.close }
      : { ...CLOSED_DAY };
  }
  return out;
}

export function toBranchFormValues(branch: BranchRecord): BranchFormValues {
  return {
    label: branch.label,
    areaLabel: branch.areaLabel,
    addressLine: branch.addressLine ?? '',
    city: branch.city ?? '',
    latitude: branch.geoPoint === null ? '' : String(branch.geoPoint.latitude),
    longitude: branch.geoPoint === null ? '' : String(branch.geoPoint.longitude),
    hours: hoursToForm(parseOpeningHours(branch.openingHours)),
    facilities: [...branch.facilities],
  };
}

function normalizedGeo(values: BranchFormValues): GeoPoint | null {
  if (values.latitude.trim() === '' || values.longitude.trim() === '') {
    return null;
  }
  return {
    longitude: Number(values.longitude.trim()),
    latitude: Number(values.latitude.trim()),
  };
}

function normalizedHours(values: BranchFormValues): WeeklyOpeningHours | null {
  const weekly: Partial<Record<WeekDay, { open: string; close: string }>> = {};
  for (const day of WEEK_DAYS) {
    const dayValue = values.hours[day];
    if (dayValue.enabled && isValidTime(dayValue.open) && isValidTime(dayValue.close)) {
      weekly[day] = { open: dayValue.open, close: dayValue.close };
    }
  }
  return serializeOpeningHours(weekly);
}

function normalizedFacilities(values: BranchFormValues): string[] {
  return values.facilities.map((facility) => facility.trim()).filter((facility) => facility !== '');
}

const nullable = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** The full POST body (label + areaLabel required by the real contract). */
export function buildBranchInput(values: BranchFormValues): BranchInput {
  const geo = normalizedGeo(values);
  const hours = normalizedHours(values);
  const facilities = normalizedFacilities(values);
  return {
    label: values.label.trim(),
    areaLabel: values.areaLabel.trim(),
    addressLine: nullable(values.addressLine),
    city: nullable(values.city),
    ...(geo !== null ? { geoPoint: geo } : {}),
    ...(hours !== null ? { openingHours: hours } : {}),
    ...(facilities.length > 0 ? { facilities } : {}),
  };
}

function geoEqual(before: GeoPoint | null, after: GeoPoint | null): boolean {
  if (before === null || after === null) {
    return before === after;
  }
  return before.longitude === after.longitude && before.latitude === after.latitude;
}

/**
 * Builds the PATCH body from CHANGED fields only, comparing normalized form
 * values against the loaded branch record — untouched fields are never
 * sent, so a save can never overwrite another writer's changes to fields
 * this editor did not touch. A branch whose stored `openingHours` value is
 * in an unrecognised shape only loses it if the provider actually edits
 * hours (the parse-null base then differs from a deliberate edit only).
 */
export function buildBranchPatch(values: BranchFormValues, base: BranchRecord): BranchPatch {
  const patch: {
    label?: string;
    areaLabel?: string;
    addressLine?: string | null;
    city?: string | null;
    geoPoint?: GeoPoint | null;
    openingHours?: unknown;
    facilities?: string[];
  } = {};

  const label = values.label.trim();
  if (label !== base.label) {
    patch.label = label;
  }
  const areaLabel = values.areaLabel.trim();
  if (areaLabel !== base.areaLabel) {
    patch.areaLabel = areaLabel;
  }
  const addressLine = nullable(values.addressLine);
  if (addressLine !== (base.addressLine ?? null)) {
    patch.addressLine = addressLine;
  }
  const city = nullable(values.city);
  if (city !== (base.city ?? null)) {
    patch.city = city;
  }
  const geo = normalizedGeo(values);
  if (!geoEqual(base.geoPoint, geo)) {
    patch.geoPoint = geo;
  }
  const baseHours = serializeOpeningHours(parseOpeningHours(base.openingHours) ?? {});
  const hours = normalizedHours(values);
  if (JSON.stringify(baseHours) !== JSON.stringify(hours)) {
    patch.openingHours = hours;
  }
  const facilities = normalizedFacilities(values);
  if (
    facilities.length !== base.facilities.length ||
    facilities.some((facility, index) => facility !== base.facilities[index])
  ) {
    patch.facilities = facilities;
  }
  return patch;
}
