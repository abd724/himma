/**
 * Staff-invitation application services (docs/27 §9, §16 S3-2; docs/24
 * §5.2, §7.10; Amendment A1/D-S3-1).
 *
 * Token boundary (B2-6B pattern): the one-time invitation token is 256 bits
 * from Node's CSPRNG, generated in memory, delivered ONLY inside the
 * outgoing mail payload, and persisted ONLY as an HMAC-SHA-256 digest under
 * the configured pepper version. No service returns the raw token; nothing
 * logs it; audit/outbox payloads carry safe identifiers only.
 *
 * D-S3-1 acceptance (binding): the authenticated Himma user must hold a
 * VERIFIED active identity email whose normalized form matches the
 * invitation target. Unverified emails never accept; display names never
 * participate; issuer+subject (holding a session + the token) is
 * insufficient; Apple private-relay users first link + verify the invited
 * address through the existing Slice-2 identity-linking flow. Every failure
 * (unknown token, expired, revoked, consumed, wrong/unverified email)
 * collapses into ONE `invitationInvalid` outcome — no oracle distinguishes
 * them and no organization detail leaks.
 *
 * Caller context (approved S3-2 abstraction): these services receive an
 * already-authenticated actor and validate AUTHORITY directly against
 * PostgreSQL (active owner membership, or an active `operations` admin role
 * for the future §13.3 founding-invitation surface). The `provider` route
 * policy, orgScope resolution, and MFA/step-up composition are S3-3 and are
 * deliberately not fabricated here.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { appendAuditEvent } from '../../../db/audit';
import { isDbError } from '../../../db/errors';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import type { MailMessage, MailSender } from '../../identity/mail/mail-sender';
import { listActiveRoles } from '../../identity/persistence/admin-role-repository';
import { findUser } from '../../identity/persistence/identity-repository';
import {
  acceptInvitationCas,
  expireDueInvitations,
  findActiveMembership,
  findInvitationByDigestForUpdate,
  findInvitationById,
  findOrganizationState,
  insertInvitation,
  insertMembership,
  insertMembershipBranchScopes,
  listOrganizationBranches,
  revokeInvitationCas,
  revokeSentInvitationsForEmail,
  userHasActiveVerifiedEmail,
  type StaffInvitationRow,
} from '../persistence/staff-repository';
import {
  ORG_WIDE_ONLY_ROLES,
  type BranchScope,
  type ProviderRole,
} from '../provider-roles';
import {
  StaffInvitationConfigError,
  type StaffInvitationConfig,
} from '../staff-invitation-config';

export interface StaffInvitationDeps {
  db: Db;
  mailSender: MailSender;
  invitationConfig: StaffInvitationConfig;
}

/**
 * Authenticated actor asserted by the caller-context abstraction. `owner`
 * is a provider principal whose active Owner membership this module
 * re-verifies from PostgreSQL; `admin` is the future §13.3 admin surface
 * (founding Owner invitation), re-verified as an active `operations` role.
 */
export type InvitationIssuer =
  | { kind: 'owner'; userId: string }
  | { kind: 'admin'; userId: string };

/** Proof of an authenticated principal (B2-4 middleware shape). */
export interface AuthenticatedContext {
  userId: string;
}

export function normalizeInvitationEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function digestStaffInvitationToken(pepper: string, rawToken: string): string {
  return createHmac('sha256', pepper).update(rawToken).digest('hex');
}

function activePepper(config: StaffInvitationConfig): { version: number; pepper: string } {
  const version = config.activePepperVersion;
  const pepper = config.peppers.get(version);
  if (pepper === undefined) {
    throw new StaffInvitationConfigError(`No pepper configured for active version ${version}.`);
  }
  return { version, pepper };
}

/** One-time token material, prepared in memory before any transaction —
 *  the raw token never reaches a return value or the database. */
export interface PreparedInvitationToken {
  rawToken: string;
  tokenDigest: string;
  pepperVersion: number;
}

export function prepareInvitationToken(config: StaffInvitationConfig): PreparedInvitationToken {
  const { version, pepper } = activePepper(config);
  const rawToken = randomBytes(32).toString('base64url');
  return { rawToken, tokenDigest: digestStaffInvitationToken(pepper, rawToken), pepperVersion: version };
}

/**
 * Persists one invitation inside the caller's transaction: supersedes any
 * still-`sent` invitation for the same organization + address (the approved
 * resend policy), inserts the new row, and writes the audit/outbox events —
 * all atomic with whatever else the caller's transaction creates (the S3-4
 * admin org-creation flow composes this with the organization itself).
 */
export async function persistInvitationInTrx(
  trx: Trx,
  input: {
    organizationId: string;
    email: string;
    role: ProviderRole;
    branchScopeKind: 'all' | 'branches';
    branchScopeIds: string[];
    invitedBy: string;
    token: PreparedInvitationToken;
    expiresAt: Date;
  },
): Promise<string> {
  const supersededIds = await revokeSentInvitationsForEmail(trx, {
    organizationId: input.organizationId,
    email: input.email,
    revokedBy: input.invitedBy,
  });
  for (const supersededId of supersededIds) {
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: input.invitedBy,
      action: 'org.invitation_revoked',
      entityType: 'staff_invitation',
      entityId: supersededId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: input.organizationId,
      eventType: 'staff.invitation_revoked',
      payload: { invitationId: supersededId, reason: 'superseded' },
    });
  }
  const invitationId = await insertInvitation(trx, {
    organizationId: input.organizationId,
    email: input.email,
    role: input.role,
    branchScopeKind: input.branchScopeKind,
    branchScopeIds: input.branchScopeIds,
    invitedBy: input.invitedBy,
    tokenDigest: input.token.tokenDigest,
    pepperVersion: input.token.pepperVersion,
    expiresAt: input.expiresAt,
  });
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: input.invitedBy,
    action: 'org.staff_invited',
    entityType: 'staff_invitation',
    entityId: invitationId,
  });
  // Ids-only payload: the target email is PII and NEVER enters
  // audit/outbox (docs/27 §12.7).
  await appendOutboxEvent(trx, {
    aggregateType: 'organization',
    aggregateId: input.organizationId,
    eventType: 'staff.invited',
    payload: {
      invitationId,
      role: input.role,
      branchScopeKind: input.branchScopeKind,
    },
  });
  return invitationId;
}

/** The one sanctioned carrier of the raw token: the outgoing mail payload. */
export function composeInvitationMail(input: {
  email: string;
  displayName: string | undefined;
  rawToken: string;
  expiresAt: Date;
}): MailMessage {
  return {
    to: input.email,
    template: 'staff_invitation',
    subject: 'Invitation to join a provider team on Himma',
    body:
      `You have been invited to join ${input.displayName ?? 'a provider team'} on Himma.\n` +
      `Use this one-time invitation code to accept: ${input.rawToken}\n` +
      `This invitation expires on ${input.expiresAt.toISOString()}.`,
  };
}

/** Mail delivery outcome recorded on the issuance result: the invitation is
 *  already committed either way (docs/24 §7 — network I/O after commit). */
export type MailDeliveryStatus = 'delivered' | 'failed';

type IssuerGate =
  | { kind: 'ok' }
  | { kind: 'organizationNotFound' }
  | { kind: 'organizationSuspended' }
  | { kind: 'forbidden' };

/**
 * Issuer authority + organization liveness, resolved fresh from PostgreSQL.
 * Suspended organizations refuse provider-actor staff mutations (docs/27
 * §7.5) while the admin surface stays governed by its own §13.3 lifecycle
 * rules; offboarded organizations are terminal for everyone.
 */
async function gateIssuer(
  trx: Trx,
  issuer: InvitationIssuer,
  organizationId: string,
): Promise<IssuerGate> {
  const org = await findOrganizationState(trx, organizationId);
  if (org === undefined || org.verification_state === 'offboarded') {
    return { kind: 'organizationNotFound' };
  }
  if (issuer.kind === 'owner') {
    const membership = await findActiveMembership(trx, issuer.userId, organizationId);
    // No membership at all is not-found-shaped (docs/26 §11.2 posture);
    // a non-owner membership is a plain insufficient-role refusal.
    if (membership === undefined) return { kind: 'organizationNotFound' };
    if (membership.role !== 'owner') return { kind: 'forbidden' };
    if (org.verification_state === 'suspended') return { kind: 'organizationSuspended' };
    return { kind: 'ok' };
  }
  const roles = await listActiveRoles(trx, issuer.userId);
  if (!roles.includes('operations')) return { kind: 'forbidden' };
  return { kind: 'ok' };
}

export type IssueInvitationResult =
  | {
      kind: 'invitationIssued';
      invitationId: string;
      expiresAt: Date;
      mailDelivery: MailDeliveryStatus;
    }
  | { kind: 'organizationNotFound' }
  | { kind: 'organizationSuspended' }
  | { kind: 'forbidden' }
  | { kind: 'invalidBranchScope' };

export async function issueStaffInvitation(
  deps: StaffInvitationDeps,
  issuer: InvitationIssuer,
  input: {
    organizationId: string;
    email: string;
    role: ProviderRole;
    branchScope: BranchScope;
  },
): Promise<IssueInvitationResult> {
  const email = normalizeInvitationEmail(input.email);

  // Org-wide-only roles can never be branch-scoped (docs/27 §5; the schema
  // CHECK backs this — the pre-check yields a typed outcome, not a throw).
  if (ORG_WIDE_ONLY_ROLES.includes(input.role) && input.branchScope.kind !== 'all') {
    return { kind: 'invalidBranchScope' };
  }
  if (input.branchScope.kind === 'branches' && input.branchScope.branchIds.length === 0) {
    return { kind: 'invalidBranchScope' };
  }

  // Generated before the transaction: pure in-memory CSPRNG work. The raw
  // token never touches the database or the return value — only the mail.
  const token = prepareInvitationToken(deps.invitationConfig);

  const run = (): Promise<
    | { outcome: Exclude<IssueInvitationResult, { kind: 'invitationIssued' }> }
    | { outcome: { kind: 'issued'; invitationId: string; expiresAt: Date }; mail: MailMessage }
  > =>
    withTransaction(deps.db, async (trx) => {
      const gate = await gateIssuer(trx, issuer, input.organizationId);
      if (gate.kind !== 'ok') return { outcome: gate };

      let branchScopeIds: string[] = [];
      if (input.branchScope.kind === 'branches') {
        const branchIds = [...new Set(input.branchScope.branchIds)];
        const branches = await listOrganizationBranches(trx, input.organizationId, branchIds);
        // Every scoped branch must belong to this organization and be
        // active at issue time (a deactivated branch is not a valid grant
        // target; docs/27 §4 public/association rules).
        if (
          branches.length !== branchIds.length ||
          branches.some((branch) => !branch.active)
        ) {
          return { outcome: { kind: 'invalidBranchScope' as const } };
        }
        branchScopeIds = branchIds;
      }

      const expiresAt = new Date(
        Date.now() + deps.invitationConfig.invitationTtlSeconds * 1000,
      );
      // Approved resend policy (docs/27 §9) + insert + events, one path
      // shared with the S3-4 admin founding-invitation flow.
      const invitationId = await persistInvitationInTrx(trx, {
        organizationId: input.organizationId,
        email,
        role: input.role,
        branchScopeKind: input.branchScope.kind,
        branchScopeIds,
        invitedBy: issuer.userId,
        token,
        expiresAt,
      });

      const displayName = await trx
        .selectFrom('organization_public_profile')
        .select('display_name')
        .where('organization_id', '=', input.organizationId)
        .executeTakeFirst();
      const mail = composeInvitationMail({
        email,
        displayName: displayName?.display_name,
        rawToken: token.rawToken,
        expiresAt,
      });
      return { outcome: { kind: 'issued' as const, invitationId, expiresAt }, mail };
    });

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (error) {
    // Concurrent duplicate issuance for the same organization + email: the
    // loser re-runs once and supersedes the winner (resend semantics).
    if (isDbError(error, 'uniqueViolation') && error.constraint === 'uq_staff_invitation_sent') {
      result = await run();
    } else {
      throw error;
    }
  }
  if (result.outcome.kind !== 'issued') return result.outcome;

  // Network I/O strictly AFTER commit (docs/24 §7). A mail failure never
  // rolls back the committed invitation — it is reported to the caller,
  // who resends via a NEW invitation if needed.
  let mailDelivery: MailDeliveryStatus = 'delivered';
  if ('mail' in result) {
    try {
      await deps.mailSender.send(result.mail);
    } catch {
      mailDelivery = 'failed';
    }
  }
  return {
    kind: 'invitationIssued',
    invitationId: result.outcome.invitationId,
    expiresAt: result.outcome.expiresAt,
    mailDelivery,
  };
}

export type AcceptInvitationResult =
  | { kind: 'invitationAccepted'; membershipId: string; organizationId: string }
  | { kind: 'invitationInvalid' };

const INVITATION_INVALID = { kind: 'invitationInvalid' as const };

export async function acceptStaffInvitation(
  deps: StaffInvitationDeps,
  ctx: AuthenticatedContext,
  input: { token: string },
): Promise<AcceptInvitationResult> {
  // The stored pepper version is authoritative per row; candidate digests
  // cover every configured version so rotation never strands live tokens.
  const candidateDigests = [...deps.invitationConfig.peppers.values()].map((pepper) =>
    digestStaffInvitationToken(pepper, input.token.trim()),
  );

  try {
    return await withTransaction(deps.db, async (trx) => {
      const user = await findUser(trx, ctx.userId);
      if (user === undefined || user.status !== 'active') return INVITATION_INVALID;

      let invitation: StaffInvitationRow | undefined;
      for (const digest of candidateDigests) {
        invitation = await findInvitationByDigestForUpdate(trx, digest);
        if (invitation !== undefined) break;
      }
      // ONE indistinguishable failure for: unknown token, wrong state,
      // overdue, suspended/offboarded organization, unverified or
      // mismatched email, already a member (docs/27 §9).
      if (invitation === undefined || invitation.state !== 'sent') return INVITATION_INVALID;
      if (invitation.expires_at.getTime() <= Date.now()) return INVITATION_INVALID;

      const org = await findOrganizationState(trx, invitation.organization_id);
      if (
        org === undefined ||
        org.verification_state === 'suspended' ||
        org.verification_state === 'offboarded'
      ) {
        return INVITATION_INVALID;
      }

      // D-S3-1: verified normalized email match is the ONLY authorization
      // condition — authentication stays issuer+subject and acceptance
      // never merges accounts.
      if (!(await userHasActiveVerifiedEmail(trx, ctx.userId, invitation.email))) {
        return INVITATION_INVALID;
      }

      if ((await findActiveMembership(trx, ctx.userId, invitation.organization_id)) !== undefined) {
        // Already active in this organization: the invitation stays `sent`
        // (revocable/expirable), and no second membership can exist.
        return INVITATION_INVALID;
      }

      // Single-use CAS: exactly one concurrent acceptance wins (§7.10).
      if (!(await acceptInvitationCas(trx, invitation.id, ctx.userId))) {
        return INVITATION_INVALID;
      }

      const membershipId = await insertMembership(trx, {
        userId: ctx.userId,
        organizationId: invitation.organization_id,
        role: invitation.role as ProviderRole,
        branchScopeKind: invitation.branch_scope_kind as 'all' | 'branches',
        invitedBy: invitation.invited_by,
        invitationId: invitation.id,
      });
      await insertMembershipBranchScopes(trx, {
        membershipId,
        organizationId: invitation.organization_id,
        branchIds: invitation.branch_scope_ids,
      });

      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: ctx.userId,
        action: 'org.staff_joined',
        entityType: 'staff_membership',
        entityId: membershipId,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'organization',
        aggregateId: invitation.organization_id,
        eventType: 'staff.joined',
        payload: {
          membershipId,
          invitationId: invitation.id,
          role: invitation.role,
          branchScopeKind: invitation.branch_scope_kind,
        },
      });

      return {
        kind: 'invitationAccepted' as const,
        membershipId,
        organizationId: invitation.organization_id,
      };
    });
  } catch (error) {
    // Lost the active-membership race: the transaction rolled back whole
    // (invitation untouched), and the outcome is the same safe invalid.
    if (isDbError(error, 'uniqueViolation') && error.constraint === 'uq_staff_membership_active') {
      return INVITATION_INVALID;
    }
    throw error;
  }
}

export type RevokeInvitationResult =
  | { kind: 'invitationRevoked' }
  | { kind: 'invitationAlreadyFinalized' }
  | { kind: 'invitationNotFound' }
  | { kind: 'organizationNotFound' }
  | { kind: 'organizationSuspended' }
  | { kind: 'forbidden' };

/**
 * Idempotent revocation: revoking an already-revoked invitation succeeds
 * without emitting duplicate events; accepted/expired rows are finalized
 * and cannot be re-labeled.
 */
export async function revokeStaffInvitation(
  deps: StaffInvitationDeps,
  issuer: InvitationIssuer,
  input: { organizationId: string; invitationId: string },
): Promise<RevokeInvitationResult> {
  return withTransaction(deps.db, async (trx) => {
    const gate = await gateIssuer(trx, issuer, input.organizationId);
    if (gate.kind !== 'ok') return gate;

    const invitation = await findInvitationById(trx, input.organizationId, input.invitationId);
    if (invitation === undefined) return { kind: 'invitationNotFound' as const };
    if (invitation.state === 'revoked') return { kind: 'invitationRevoked' as const };
    if (invitation.state !== 'sent') return { kind: 'invitationAlreadyFinalized' as const };

    if (!(await revokeInvitationCas(trx, invitation.id, issuer.userId))) {
      // A concurrent transition finalized the row between read and CAS.
      const now = await findInvitationById(trx, input.organizationId, input.invitationId);
      return now?.state === 'revoked'
        ? { kind: 'invitationRevoked' as const }
        : { kind: 'invitationAlreadyFinalized' as const };
    }
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: issuer.userId,
      action: 'org.invitation_revoked',
      entityType: 'staff_invitation',
      entityId: invitation.id,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: input.organizationId,
      eventType: 'staff.invitation_revoked',
      payload: { invitationId: invitation.id, reason: 'revoked' },
    });
    return { kind: 'invitationRevoked' as const };
  });
}

/**
 * Expiry sweep (B2-5 pattern): acceptance already refuses overdue tokens by
 * time alone; this finalizes their state, emitting the audit and outbox
 * events in the SAME transaction as each canonical transition — exactly
 * once per invitation, idempotent under concurrent sweeps.
 */
export async function expireDueStaffInvitations(
  // W6-3: the sweep reads ONLY the database — the parameter type names that
  // exactly, so the worker composing it never has to hold the invitation
  // pepper/mail dependencies (least privilege; zero behavior change).
  deps: Pick<StaffInvitationDeps, 'db'>,
): Promise<{ expiredCount: number }> {
  return withTransaction(deps.db, async (trx) => {
    const expired = await expireDueInvitations(trx);
    for (const { id: invitationId, organization_id: organizationId } of expired) {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'org.invitation_expired',
        entityType: 'staff_invitation',
        entityId: invitationId,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'organization',
        aggregateId: organizationId,
        eventType: 'staff.invitation_expired',
        payload: { invitationId },
      });
    }
    return { expiredCount: expired.length };
  });
}
