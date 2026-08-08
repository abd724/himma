import { z } from 'zod';
import type { BranchScope, ProviderRole } from '../../provider-access/contract';
import { ORG_WIDE_ONLY_ROLES } from '../../provider-access/contract';
import { INVITATION_FIELD_LIMITS } from '../../team/contract';

/**
 * Invite-form schema mirroring the REAL `POST .../staff/invitations` body
 * (email format ≤320 · one of the seven canonical roles · branch scope
 * `all` or 1–50 explicit branches, with org-wide-only roles locked to
 * `all`). Client validation is UX only — the backend stays authoritative
 * and the fixture re-applies the same limits server-side.
 */

export const inviteRoleValues = [
  'owner',
  'org_manager',
  'branch_manager',
  'listings_editor',
  'coach',
  'front_desk',
  'finance',
] as const;

export const inviteFormSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(1, 'Enter their email address.')
      .max(INVITATION_FIELD_LIMITS.email, 'That email address is too long.')
      .email('Enter a valid email address.'),
    role: z.enum(inviteRoleValues, { message: 'Choose a role.' }),
    scopeMode: z.enum(['all', 'selected']),
    branchIds: z.array(z.string()),
  })
  .superRefine((values, ctx) => {
    if (ORG_WIDE_ONLY_ROLES.includes(values.role) && values.scopeMode !== 'all') {
      ctx.addIssue({
        code: 'custom',
        path: ['scopeMode'],
        message: 'This role always covers the whole organization.',
      });
    }
    if (values.scopeMode === 'selected' && values.branchIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['branchIds'],
        message: 'Choose at least one branch, or switch to all branches.',
      });
    }
    if (
      values.scopeMode === 'selected' &&
      values.branchIds.length > INVITATION_FIELD_LIMITS.branchScopeMax
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['branchIds'],
        message: 'Too many branches selected.',
      });
    }
  });

export type InviteFormValues = z.infer<typeof inviteFormSchema>;

export function emptyInviteFormValues(): InviteFormValues {
  return { email: '', role: 'coach', scopeMode: 'all', branchIds: [] };
}

export function roleIsOrgWideOnly(role: ProviderRole): boolean {
  return ORG_WIDE_ONLY_ROLES.includes(role);
}

/** The exact wire scope: `'all'` is EXPLICIT and distinct from selecting
 *  every branch manually (an explicit id list stays an id list). */
export function toBranchScope(values: InviteFormValues): BranchScope {
  if (values.scopeMode === 'all' || roleIsOrgWideOnly(values.role)) {
    return 'all';
  }
  return [...values.branchIds];
}
