/**
 * Himma-admin organization lifecycle services (docs/27 §10, §13.3) — S3-4.
 *
 * Internal admin surface, NOT the provider portal: authority is the
 * Slice-2 database-backed `operations` admin role, resolved fresh inside
 * every transaction — provider memberships and Cognito claims are worthless
 * here (and vice versa). The S3-1 organization state machine remains the
 * final authority; these services pre-check for typed outcomes and can
 * never bypass the trigger.
 *
 * D-S3-3 production safeguard (binding): `in_review → verified` and
 * `verified → live` FAIL CLOSED in production until the authoritative
 * VerificationCase/document-review capability exists and reports ready.
 * Slice 3 contains NO such capability, so a production build can never
 * truthfully report it — forcing the flag on refuses startup (build-app),
 * and the refusal path below audits every blocked attempt. Development and
 * test exercise the complete lifecycle deterministically.
 */
import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import type { NodeEnv } from '../../../config/env';
import type { MailSender } from '../../identity/mail/mail-sender';
import { listActiveRoles } from '../../identity/persistence/admin-role-repository';
import type { StaffInvitationConfig } from '../staff-invitation-config';
import {
  composeInvitationMail,
  normalizeInvitationEmail,
  persistInvitationInTrx,
  prepareInvitationToken,
  type MailDeliveryStatus,
} from './staff-invitations';

export interface OrganizationAdminDeps {
  db: Db;
  mailSender: MailSender;
  invitationConfig: StaffInvitationConfig;
  /** D-S3-3 gate inputs — see the production safeguard note above. */
  lifecycle: {
    nodeEnv: NodeEnv;
    verificationEvidenceCapabilityReady: boolean;
  };
}

export interface AdminOrgActor {
  userId: string;
}

/** Operations-role check, fresh from PostgreSQL inside the transaction —
 *  the §13.3 lifecycle surface is operations-only, not every admin role. */
async function hasOperationsRole(trx: Trx, userId: string): Promise<boolean> {
  return (await listActiveRoles(trx, userId)).includes('operations');
}

// -- creation (§10 step 2; one transaction with the founding invitation) ------

export type CreateOrganizationResult =
  | {
      kind: 'organizationCreated';
      organizationId: string;
      invitationId: string;
      expiresAt: Date;
      mailDelivery: MailDeliveryStatus;
    }
  | { kind: 'forbidden' };

export async function createOrganization(
  deps: OrganizationAdminDeps,
  actor: AdminOrgActor,
  input: {
    legalName: string;
    tradeName: string;
    displayName?: string;
    foundingOwnerEmail: string;
  },
): Promise<CreateOrganizationResult> {
  const email = normalizeInvitationEmail(input.foundingOwnerEmail);
  // In-memory CSPRNG work before the transaction; the raw token reaches
  // only the post-commit mail payload.
  const token = prepareInvitationToken(deps.invitationConfig);
  const displayName = input.displayName ?? input.tradeName;

  const created = await withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) {
      return { kind: 'forbidden' as const };
    }
    const organizationId = newId();
    await trx
      .insertInto('organization')
      .values({ id: organizationId, legal_name: input.legalName, trade_name: input.tradeName })
      .execute();
    await trx
      .insertInto('organization_public_profile')
      .values({ organization_id: organizationId, display_name: displayName })
      .execute();
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'org.created',
      entityType: 'organization',
      entityId: organizationId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: organizationId,
      eventType: 'organization.created',
      payload: { organizationId, origin: 'admin_created' },
    });
    // The FOUNDING Owner invitation — the one membership path whose
    // provenance is admin-recorded (docs/27 §10); no placeholder User is
    // ever created for a not-yet-existing invitee.
    const expiresAt = new Date(Date.now() + deps.invitationConfig.invitationTtlSeconds * 1000);
    const invitationId = await persistInvitationInTrx(trx, {
      organizationId,
      email,
      role: 'owner',
      branchScopeKind: 'all',
      branchScopeIds: [],
      invitedBy: actor.userId,
      token,
      expiresAt,
    });
    return { kind: 'created' as const, organizationId, invitationId, expiresAt };
  });
  if (created.kind !== 'created') return created;

  // Network I/O strictly AFTER commit; a mail failure never rolls the
  // committed organization/invitation back — it is reported for resend.
  let mailDelivery: MailDeliveryStatus = 'delivered';
  try {
    await deps.mailSender.send(
      composeInvitationMail({
        email,
        displayName,
        rawToken: token.rawToken,
        expiresAt: created.expiresAt,
      }),
    );
  } catch {
    mailDelivery = 'failed';
  }
  return {
    kind: 'organizationCreated',
    organizationId: created.organizationId,
    invitationId: created.invitationId,
    expiresAt: created.expiresAt,
    mailDelivery,
  };
}

// -- lifecycle transitions (§13.3; S3-1 machine remains the authority) --------

export type AdminLifecycleAction =
  | 'start_review'
  | 'verify'
  | 'reject'
  | 'go_live'
  | 'suspend'
  | 'reinstate'
  | 'offboard';

interface TransitionSpec {
  fromStates: readonly string[];
  toState: string;
  audit: string;
  event: string;
  /** D-S3-3: production fail-closed behind the evidence capability. */
  evidenceGated: boolean;
  setSuspendedAt?: 'now' | 'clear';
  setOffboardedAt?: 'now';
}

const TRANSITIONS: Record<AdminLifecycleAction, TransitionSpec> = {
  start_review: {
    fromStates: ['submitted'],
    toState: 'in_review',
    audit: 'org.review_started',
    event: 'organization.review_started',
    evidenceGated: false,
  },
  verify: {
    fromStates: ['in_review'],
    toState: 'verified',
    audit: 'org.verified',
    event: 'organization.verified',
    evidenceGated: true,
  },
  reject: {
    fromStates: ['in_review'],
    toState: 'rejected',
    audit: 'org.rejected',
    event: 'organization.rejected',
    evidenceGated: false,
  },
  go_live: {
    fromStates: ['verified'],
    toState: 'live',
    audit: 'org.went_live',
    event: 'organization.went_live',
    evidenceGated: true,
  },
  suspend: {
    fromStates: ['live'],
    toState: 'suspended',
    audit: 'org.suspended',
    event: 'organization.suspended',
    evidenceGated: false,
    setSuspendedAt: 'now',
  },
  reinstate: {
    fromStates: ['suspended'],
    toState: 'live',
    audit: 'org.reinstated',
    event: 'organization.reinstated',
    evidenceGated: false,
    setSuspendedAt: 'clear',
  },
  offboard: {
    fromStates: ['live', 'suspended'],
    toState: 'offboarded',
    audit: 'org.offboarded',
    event: 'organization.offboarded',
    evidenceGated: false,
    setSuspendedAt: 'clear',
    setOffboardedAt: 'now',
  },
};

export type TransitionOrganizationResult =
  | { kind: 'organizationTransitioned'; state: string; version: number }
  | { kind: 'forbidden' }
  | { kind: 'organizationNotFound' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'verificationEvidenceUnavailable' }
  | { kind: 'staleVersion' };

export async function transitionOrganization(
  deps: OrganizationAdminDeps,
  actor: AdminOrgActor,
  input: {
    organizationId: string;
    action: AdminLifecycleAction;
    expectedVersion: number;
    /** Safe machine-readable code only — never free-text private notes. */
    reasonCode?: string;
  },
): Promise<TransitionOrganizationResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) {
      return { kind: 'forbidden' as const };
    }
    return transitionOrganizationInTrx(trx, deps.lifecycle, actor, input);
  });
}

/**
 * @internal — the ONE organization-transition implementation (W3-5): used
 * by the standalone admin routes above and composed INSIDE the W3-5
 * verification-decision transaction so a decision and its lifecycle effect
 * can never diverge. The CALLER owns the operations-role check and the
 * transaction; everything else (locking, machine pre-checks, the D-S3-3
 * production evidence gate, CAS, audit, outbox) lives here exactly once.
 */
export async function transitionOrganizationInTrx(
  trx: Trx,
  lifecycle: OrganizationAdminDeps['lifecycle'],
  actor: AdminOrgActor,
  input: {
    organizationId: string;
    action: AdminLifecycleAction;
    expectedVersion: number;
    reasonCode?: string;
  },
): Promise<TransitionOrganizationResult> {
  const spec = TRANSITIONS[input.action];
  {
    const org = await trx
      .selectFrom('organization')
      .select(['verification_state', 'version'])
      .where('id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (org === undefined) return { kind: 'organizationNotFound' as const };
    if (!spec.fromStates.includes(org.verification_state)) {
      return { kind: 'lifecycleConflict' as const };
    }
    if (org.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    // D-S3-3 (binding): NO production path marks a provider verified/live
    // without the authoritative evidence/review capability. Slice 3 ships
    // none, the flag defaults false, and build-app refuses a production
    // start that claims otherwise — so in production this branch always
    // refuses, and the blocked attempt is itself audited (docs/27 §14.9b).
    if (
      spec.evidenceGated &&
      lifecycle.nodeEnv === 'production' &&
      !lifecycle.verificationEvidenceCapabilityReady
    ) {
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: actor.userId,
        action: 'org.verification_gate_refused',
        entityType: 'organization',
        entityId: input.organizationId,
      });
      return { kind: 'verificationEvidenceUnavailable' as const };
    }

    const updated = await trx
      .updateTable('organization')
      .set({
        verification_state: spec.toState,
        ...(spec.setSuspendedAt === 'now'
          ? { suspended_at: new Date() }
          : spec.setSuspendedAt === 'clear'
            ? { suspended_at: null }
            : {}),
        ...(spec.setOffboardedAt === 'now' ? { offboarded_at: new Date() } : {}),
      })
      .where('id', '=', input.organizationId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    if (updated === undefined) return { kind: 'staleVersion' as const };

    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: spec.audit,
      entityType: 'organization',
      entityId: input.organizationId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: input.organizationId,
      eventType: spec.event,
      payload: {
        organizationId: input.organizationId,
        previousState: org.verification_state,
        // Safe reason CODE only (bounded slug at the route schema); the
        // lifecycle event's future consumers (bookings/refunds/payouts,
        // catalogue removal) subscribe here when those entities exist.
        ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
      },
    });
    return {
      kind: 'organizationTransitioned' as const,
      state: spec.toState,
      version: updated.version,
    };
  }
}
