/**
 * RI-4 — the DEVELOPMENT-ONLY provider check-in ACTOR (the
 * dev-hosted-checkout pattern): two routes letting the Playwright
 * journeys exercise REAL provider redemption without a portal login
 * (dev-identity subjects are per-process, so a seeded staff LOGIN cannot
 * exist — the actor stands in for the front desk instead).
 *
 * Structural boundaries (identical to dev-hosted-checkout):
 * - Lives in scripts/, registered ONLY by dev-server (which refuses to
 *   start in production); never part of buildApp, never composable there.
 * - It performs NO shortcut writes: preview/redeem go through the REAL
 *   S6-2 services (`previewRedemption`/`redeemCredential`) under a real
 *   front-desk staff membership (find-or-created per organization), so
 *   every certified authority — credential locks, occurrence agreement,
 *   entitlement serialization, brute-force windows — runs unmodified.
 * - Codes are never logged; the org is resolved by the same org-scoped
 *   alias-digest discipline the real lookup uses.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { sql } from 'kysely';

import type { Db } from '../src/db/kysely';
import { newId } from '../src/db/ids';
import {
  previewRedemption,
  redeemCredential,
} from '../src/modules/entitlement/services/attendance-redemption';
import { credentialAliasDigest } from '../src/modules/entitlement/services/redemption-credential';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';

const BODY_LIMIT = 4_096;
const DisplayCode = Type.String({ minLength: 8, maxLength: 8, pattern: '^[0-9]{8}$' });

export interface DevCheckinActorDeps {
  db: Db;
}

/** The credential's organization, by the org-scoped alias digest (the same
 *  scoping discipline the real lookup enforces). */
async function resolveOrganization(db: Db, code: string): Promise<string | undefined> {
  const orgs = await sql<{ id: string }>`SELECT id FROM organization`.execute(db);
  const digestByOrg = new Map(
    orgs.rows.map((row) => [credentialAliasDigest(row.id, code), row.id]),
  );
  const digests = [...digestByOrg.keys()];
  if (digests.length === 0) return undefined;
  const match = await sql<{ alias_digest: string }>`
    SELECT alias_digest FROM redemption_credential
    WHERE state = 'live' AND alias_digest = ANY(${digests}::text[])
    LIMIT 1`.execute(db);
  const digest = match.rows[0]?.alias_digest;
  return digest === undefined ? undefined : digestByOrg.get(digest);
}

/** Find-or-create the dev front-desk staff membership for an org. */
async function frontDeskScope(db: Db, organizationId: string): Promise<OrgScope & { userId: string }> {
  const existing = await sql<{ id: string; user_id: string }>`
    SELECT id, user_id FROM staff_membership
    WHERE organization_id = ${organizationId} AND role = 'front_desk' AND state = 'active'
    LIMIT 1`.execute(db);
  let membershipId = existing.rows[0]?.id;
  let userId = existing.rows[0]?.user_id;
  if (membershipId === undefined || userId === undefined) {
    userId = newId();
    membershipId = newId();
    await sql`INSERT INTO app_user (id) VALUES (${userId})`.execute(db);
    await sql`INSERT INTO staff_membership (id, user_id, organization_id, role, branch_scope_kind)
              VALUES (${membershipId}, ${userId}, ${organizationId}, 'front_desk', 'all')`.execute(
      db,
    );
  }
  return {
    organizationId,
    membershipId,
    role: 'front_desk',
    capabilities: capabilitiesForRole('front_desk'),
    branchScope: 'all',
    organizationState: 'live',
    userId,
  };
}

export function registerDevCheckinActor(rawApp: FastifyInstance, deps: DevCheckinActorDeps): void {
  const app = rawApp.withTypeProvider<TypeBoxTypeProvider>();

  app.post(
    '/dev/checkin/redeem',
    {
      config: { authPolicy: 'public' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object({ code: DisplayCode }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      const organizationId = await resolveOrganization(deps.db, request.body.code);
      if (organizationId === undefined) {
        return reply.status(404).send({ kind: 'credentialNotFound' });
      }
      const scope = await frontDeskScope(deps.db, organizationId);
      const preview = await previewRedemption({ db: deps.db }, scope, {
        code: request.body.code,
      });
      if (preview.kind !== 'redemptionPreview') {
        return reply.status(409).send({ kind: preview.kind });
      }
      const run = await redeemCredential({ db: deps.db }, scope, { userId: scope.userId }, {
        code: request.body.code,
        credentialId: preview.preview.credentialId,
        idempotencyKey: `dev-actor-${preview.preview.credentialId}`,
      });
      if (run.outcome.kind !== 'attendanceRecorded') {
        return reply.status(409).send({ kind: run.outcome.kind });
      }
      return reply.status(201).send({ kind: 'attendanceRecorded', attendance: run.outcome.attendance });
    },
  );
}
