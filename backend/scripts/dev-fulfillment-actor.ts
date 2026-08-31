/**
 * RI-5 — the DEVELOPMENT-ONLY provider fulfillment-configuration ACTOR
 * (the dev-checkin-actor pattern): one route letting the Playwright
 * calendar journey exercise a REAL future product revision without a
 * portal login (dev-identity subjects are per-process, so a seeded staff
 * LOGIN cannot exist — the actor stands in for the provider owner).
 *
 * Structural boundaries (identical to dev-checkin-actor):
 * - Lives in scripts/, registered ONLY by dev-server (which refuses to
 *   start in production); never part of buildApp, never composable there.
 * - It performs NO shortcut writes: the revision goes through the REAL
 *   W2-13 `setFulfillmentConfig` service under a real owner staff
 *   membership (find-or-created per organization), so the certified
 *   immutable-revision model — supersede-and-insert, value snapshots,
 *   audit/outbox — runs unmodified. Existing customer entitlements stay
 *   bound to their historical revision; that immutability is exactly what
 *   the RI-5 schedule-change journey proves end-to-end.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { sql } from 'kysely';

import type { Db } from '../src/db/kysely';
import { newId } from '../src/db/ids';
import { setFulfillmentConfig } from '../src/modules/entitlement/services/fulfillment-admin';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';

const BODY_LIMIT = 8_192;

export interface DevFulfillmentActorDeps {
  db: Db;
}

/** Find-or-create the dev owner staff membership for an org. */
async function ownerScope(db: Db, organizationId: string): Promise<OrgScope & { userId: string }> {
  const existing = await sql<{ id: string; user_id: string }>`
    SELECT id, user_id FROM staff_membership
    WHERE organization_id = ${organizationId} AND role = 'owner' AND state = 'active'
    LIMIT 1`.execute(db);
  let membershipId = existing.rows[0]?.id;
  let userId = existing.rows[0]?.user_id;
  if (membershipId === undefined || userId === undefined) {
    userId = newId();
    membershipId = newId();
    await sql`INSERT INTO app_user (id) VALUES (${userId})`.execute(db);
    await sql`INSERT INTO staff_membership (id, user_id, organization_id, role, branch_scope_kind)
              VALUES (${membershipId}, ${userId}, ${organizationId}, 'owner', 'all')`.execute(db);
  }
  return {
    organizationId,
    membershipId,
    role: 'owner',
    capabilities: capabilitiesForRole('owner'),
    branchScope: 'all',
    organizationState: 'live',
    userId,
  };
}

export function registerDevFulfillmentActor(
  rawApp: FastifyInstance,
  deps: DevFulfillmentActorDeps,
): void {
  const app = rawApp.withTypeProvider<TypeBoxTypeProvider>();

  app.post(
    '/dev/fulfillment/revise',
    {
      config: { authPolicy: 'public' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          {
            /** The price option to supersede, addressed by program title +
             *  option label (dev seed identities — never customer input). */
            programTitle: Type.String({ minLength: 1, maxLength: 200 }),
            optionLabel: Type.String({ minLength: 1, maxLength: 200 }),
            terms: Type.Object(
              {
                usageKind: Type.Union([Type.Literal('finite'), Type.Literal('unlimited')]),
                usesTotal: Type.Optional(Type.Integer({ minimum: 1 })),
                validityKind: Type.Union([
                  Type.Literal('daysFromConfirmation'),
                  Type.Literal('fixedEndDate'),
                  Type.Literal('none'),
                ]),
                validityDays: Type.Optional(Type.Integer({ minimum: 1 })),
                validityEndDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
                reservationRequired: Type.Boolean(),
                walkInAllowed: Type.Boolean(),
                scheduleTerms: Type.Optional(
                  Type.Array(
                    Type.Object({
                      weekday: Type.Integer({ minimum: 0, maximum: 6 }),
                      startTime: Type.String({ pattern: '^\\d{2}:\\d{2}$' }),
                      endTime: Type.String({ pattern: '^\\d{2}:\\d{2}$' }),
                    }),
                    { maxItems: 14 },
                  ),
                ),
              },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const option = await sql<{
        option_id: string;
        program_id: string;
        organization_id: string;
      }>`
        SELECT o.id AS option_id, o.program_id, o.organization_id
        FROM program_price_option o
        JOIN program p ON p.id = o.program_id
        WHERE p.title_en = ${request.body.programTitle}
          AND o.label_en = ${request.body.optionLabel}
        LIMIT 1`.execute(deps.db);
      const row = option.rows[0];
      if (row === undefined) return reply.status(404).send({ kind: 'optionNotFound' });
      const scope = await ownerScope(deps.db, row.organization_id);
      const result = await setFulfillmentConfig(
        { db: deps.db },
        scope,
        { userId: scope.userId },
        {
          programId: row.program_id,
          optionId: row.option_id,
          terms: request.body.terms,
        },
      );
      if (result.kind !== 'revisionCreated') {
        return reply.status(409).send({ kind: result.kind });
      }
      return reply.status(201).send({ kind: 'revisionCreated', revision: result.revision });
    },
  );
}
