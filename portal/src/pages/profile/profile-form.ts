import { z } from 'zod';
import type { ProfilePatch, PublicProfileRecord } from '../../profile/contract';

/**
 * Client-side mirror of the PATCH .../profile constraints (docs/08 §14:
 * client validation is UX only — the backend stays authoritative). Limits
 * are the exact TypeBox values from the real route schema. English display
 * name is the only REQUIRED public field (the DB's sole NOT NULL text
 * column and the submission-completeness rule); Arabic stays optional for
 * the English-only launch and never blocks saving.
 */
export const PROFILE_FIELD_LIMITS = {
  displayName: 120,
  description: 2000,
  publicPhone: 32,
  publicEmail: 320,
  publicWebsite: 300,
  publicInstagram: 64,
} as const;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const profileFormSchema = z.object({
  displayName: z
    .string()
    .max(
      PROFILE_FIELD_LIMITS.displayName,
      `Display names can be at most ${PROFILE_FIELD_LIMITS.displayName} characters.`,
    )
    .refine((value) => value.trim().length > 0, 'Enter the name customers will see.'),
  descriptionEn: z
    .string()
    .max(
      PROFILE_FIELD_LIMITS.description,
      `Descriptions can be at most ${PROFILE_FIELD_LIMITS.description} characters.`,
    ),
  descriptionAr: z
    .string()
    .max(
      PROFILE_FIELD_LIMITS.description,
      `Descriptions can be at most ${PROFILE_FIELD_LIMITS.description} characters.`,
    ),
  publicPhone: z
    .string()
    .max(
      PROFILE_FIELD_LIMITS.publicPhone,
      `Phone numbers can be at most ${PROFILE_FIELD_LIMITS.publicPhone} characters.`,
    ),
  publicEmail: z
    .string()
    .max(
      PROFILE_FIELD_LIMITS.publicEmail,
      `Email addresses can be at most ${PROFILE_FIELD_LIMITS.publicEmail} characters.`,
    )
    .refine(
      (value) => value.trim() === '' || EMAIL_SHAPE.test(value.trim()),
      'Enter a valid email address, or leave this empty.',
    ),
  publicWebsite: z
    .string()
    .max(
      PROFILE_FIELD_LIMITS.publicWebsite,
      `Website addresses can be at most ${PROFILE_FIELD_LIMITS.publicWebsite} characters.`,
    ),
  publicInstagram: z
    .string()
    .max(
      PROFILE_FIELD_LIMITS.publicInstagram,
      `Instagram handles can be at most ${PROFILE_FIELD_LIMITS.publicInstagram} characters.`,
    ),
});

export type ProfileFormValues = z.infer<typeof profileFormSchema>;

/** Nullable storefront columns → editable text fields ('' = not provided). */
export function toFormValues(profile: PublicProfileRecord): ProfileFormValues {
  return {
    displayName: profile.displayName,
    descriptionEn: profile.descriptionEn ?? '',
    descriptionAr: profile.descriptionAr ?? '',
    publicPhone: profile.publicPhone ?? '',
    publicEmail: profile.publicEmail ?? '',
    publicWebsite: profile.publicWebsite ?? '',
    publicInstagram: profile.publicInstagram ?? '',
  };
}

/**
 * Builds the PATCH body from DIRTY fields only — untouched fields are never
 * sent, so a save can never overwrite another writer's changes to fields
 * this editor did not touch. '' clears a nullable field (→ null).
 */
export function buildProfilePatch(
  values: ProfileFormValues,
  dirtyFields: Partial<Record<keyof ProfileFormValues, unknown>>,
): ProfilePatch {
  const patch: {
    displayName?: string;
    descriptionEn?: string | null;
    descriptionAr?: string | null;
    publicPhone?: string | null;
    publicEmail?: string | null;
    publicWebsite?: string | null;
    publicInstagram?: string | null;
  } = {};
  const nullable = (value: string): string | null => {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  if (dirtyFields.displayName) {
    patch.displayName = values.displayName.trim();
  }
  if (dirtyFields.descriptionEn) {
    patch.descriptionEn = nullable(values.descriptionEn);
  }
  if (dirtyFields.descriptionAr) {
    patch.descriptionAr = nullable(values.descriptionAr);
  }
  if (dirtyFields.publicPhone) {
    patch.publicPhone = nullable(values.publicPhone);
  }
  if (dirtyFields.publicEmail) {
    patch.publicEmail = nullable(values.publicEmail);
  }
  if (dirtyFields.publicWebsite) {
    patch.publicWebsite = nullable(values.publicWebsite);
  }
  if (dirtyFields.publicInstagram) {
    patch.publicInstagram = nullable(values.publicInstagram);
  }
  return patch;
}
