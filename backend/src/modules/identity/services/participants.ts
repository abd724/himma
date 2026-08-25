/**
 * RI-1 — customer participant management (docs/24 §1.2; docs/34 §4.1).
 *
 * The bounded backend companion closing the recorded gap: participant rows
 * (one structural `self` + parent-managed `child` profiles with DOB-driven
 * eligibility) existed with NO management API. This service adds exactly
 * the V1 surface: list own active participants, create a child, update the
 * V1-editable fields (name, DOB), and ARCHIVE (never destroy — booking/
 * enrolment history references participants by FK, and `status='archived'`
 * is the certified lifecycle; no migration was needed).
 *
 * Boundaries held: account-scoped everywhere (foreign ids are
 * not-found-shaped); the `self` participant can be renamed but never
 * archived (structural one-`self` account model); a child ALWAYS carries a
 * DOB (docs/24 §1.2 — eligibility fails closed without it); no medical/
 * allergy/gender/sensitive fields exist (deferred to the pending-counsel
 * ParticipantLegalProfile — docs/24 §14.B1); optimistic-version CAS on
 * mutations (`staleVersion`); every mutation is audit-evented.
 */
import { appendAuditEvent } from '../../../db/audit';
import { withTransaction } from '../../../db/transaction';
import {
  archiveParticipantCas,
  currentServerDate,
  findParticipantForAccount,
  insertChildParticipant,
  listActiveParticipants,
  updateParticipantCas,
  type ParticipantRow,
} from '../persistence/identity-repository';
import type { IdentityServiceDeps } from './account-status';

export interface ParticipantView {
  id: string;
  kind: 'self' | 'child';
  firstName: string;
  /** ISO date (YYYY-MM-DD) or null — optional for `self`, present for `child`. */
  dateOfBirth: string | null;
  status: 'active' | 'archived';
  version: number;
}

export type ListParticipantsResult = {
  kind: 'participants';
  participants: ParticipantView[];
};

export type CreateChildResult =
  | { kind: 'participantCreated'; participant: ParticipantView }
  | { kind: 'invalidParticipant'; reason: 'invalidName' | 'invalidDateOfBirth' };

export type UpdateParticipantResult =
  | { kind: 'participantUpdated'; participant: ParticipantView }
  | { kind: 'participantNotFound' }
  | { kind: 'participantArchived' }
  | { kind: 'invalidParticipant'; reason: 'invalidName' | 'invalidDateOfBirth' | 'noChanges' }
  | { kind: 'staleVersion' };

export type ArchiveParticipantResult =
  | { kind: 'participantArchived'; participant: ParticipantView }
  | { kind: 'participantNotFound' }
  | { kind: 'cannotArchiveSelf' }
  | { kind: 'staleVersion' };

const NAME_MAX = 80;
const DOB_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DOB_FLOOR = '1900-01-01';

/** `date` columns come back as LOCAL-midnight Date objects from the pg
 *  driver — format from local date parts, never via toISOString (which
 *  shifts a day for any UTC-offset process clock). */
function isoDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function toView(row: ParticipantRow): ParticipantView {
  return {
    id: row.id,
    kind: row.kind as ParticipantView['kind'],
    firstName: row.first_name,
    dateOfBirth: row.date_of_birth === null ? null : isoDate(row.date_of_birth),
    status: row.status as ParticipantView['status'],
    version: row.version,
  };
}

function normalizedName(raw: string): string | undefined {
  const name = raw.trim();
  if (name.length === 0 || name.length > NAME_MAX) return undefined;
  return name;
}

/** Structural DOB validation: real calendar date, in the past, ≥ 1900. The
 *  server never invents an age POLICY — age eligibility stays with the
 *  certified quote/confirmation engine (docs/24 §2.5). */
function normalizedDob(raw: string, today: string): string | undefined {
  if (!DOB_PATTERN.test(raw)) return undefined;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (parsed.toISOString().slice(0, 10) !== raw) return undefined; // e.g. Feb 30
  if (raw < DOB_FLOOR || raw >= today) return undefined;
  return raw;
}

export async function listParticipants(
  deps: IdentityServiceDeps,
  actor: { accountId: string },
): Promise<ListParticipantsResult> {
  return withTransaction(deps.db, async (trx) => {
    const rows = await listActiveParticipants(trx, actor.accountId);
    return { kind: 'participants' as const, participants: rows.map(toView) };
  });
}

export async function createChildParticipant(
  deps: IdentityServiceDeps,
  actor: { userId: string; accountId: string },
  input: { firstName: string; dateOfBirth: string },
): Promise<CreateChildResult> {
  const firstName = normalizedName(input.firstName);
  if (firstName === undefined) return { kind: 'invalidParticipant', reason: 'invalidName' };
  return withTransaction(deps.db, async (trx) => {
    const today = await currentServerDate(trx);
    const dateOfBirth = normalizedDob(input.dateOfBirth, today);
    if (dateOfBirth === undefined) {
      return { kind: 'invalidParticipant' as const, reason: 'invalidDateOfBirth' as const };
    }
    const id = await insertChildParticipant(trx, {
      accountId: actor.accountId,
      firstName,
      dateOfBirth,
    });
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      principalContext: 'customer',
      action: 'participant.created',
      entityType: 'participant',
      entityId: id,
    });
    const row = await findParticipantForAccount(trx, id, actor.accountId);
    if (row === undefined) throw new Error('created participant vanished');
    return { kind: 'participantCreated' as const, participant: toView(row) };
  });
}

export async function updateParticipant(
  deps: IdentityServiceDeps,
  actor: { userId: string; accountId: string },
  input: {
    participantId: string;
    version: number;
    firstName?: string;
    dateOfBirth?: string;
  },
): Promise<UpdateParticipantResult> {
  if (input.firstName === undefined && input.dateOfBirth === undefined) {
    return { kind: 'invalidParticipant', reason: 'noChanges' };
  }
  const firstName = input.firstName === undefined ? undefined : normalizedName(input.firstName);
  if (input.firstName !== undefined && firstName === undefined) {
    return { kind: 'invalidParticipant', reason: 'invalidName' };
  }
  return withTransaction(deps.db, async (trx) => {
    const existing = await findParticipantForAccount(trx, input.participantId, actor.accountId);
    if (existing === undefined) return { kind: 'participantNotFound' as const };
    if (existing.status !== 'active') return { kind: 'participantArchived' as const };

    let dateOfBirth: string | undefined;
    if (input.dateOfBirth !== undefined) {
      const today = await currentServerDate(trx);
      dateOfBirth = normalizedDob(input.dateOfBirth, today);
      if (dateOfBirth === undefined) {
        return { kind: 'invalidParticipant' as const, reason: 'invalidDateOfBirth' as const };
      }
    }

    const moved = await updateParticipantCas(trx, {
      participantId: input.participantId,
      accountId: actor.accountId,
      version: input.version,
      ...(firstName !== undefined ? { firstName } : {}),
      ...(dateOfBirth !== undefined ? { dateOfBirth } : {}),
    });
    if (!moved) return { kind: 'staleVersion' as const };
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      principalContext: 'customer',
      action: 'participant.updated',
      entityType: 'participant',
      entityId: input.participantId,
    });
    const row = await findParticipantForAccount(trx, input.participantId, actor.accountId);
    if (row === undefined) throw new Error('updated participant vanished');
    return { kind: 'participantUpdated' as const, participant: toView(row) };
  });
}

export async function archiveParticipant(
  deps: IdentityServiceDeps,
  actor: { userId: string; accountId: string },
  input: { participantId: string; version: number },
): Promise<ArchiveParticipantResult> {
  return withTransaction(deps.db, async (trx) => {
    const existing = await findParticipantForAccount(trx, input.participantId, actor.accountId);
    if (existing === undefined) return { kind: 'participantNotFound' as const };
    if (existing.kind === 'self') return { kind: 'cannotArchiveSelf' as const };
    if (existing.status === 'archived') {
      // Idempotent-friendly: archiving an archived child is a no-op replay.
      return { kind: 'participantArchived' as const, participant: toView(existing) };
    }
    const moved = await archiveParticipantCas(trx, {
      participantId: input.participantId,
      accountId: actor.accountId,
      version: input.version,
    });
    if (!moved) return { kind: 'staleVersion' as const };
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      principalContext: 'customer',
      action: 'participant.archived',
      entityType: 'participant',
      entityId: input.participantId,
    });
    const row = await findParticipantForAccount(trx, input.participantId, actor.accountId);
    if (row === undefined) throw new Error('archived participant vanished');
    return { kind: 'participantArchived' as const, participant: toView(row) };
  });
}

