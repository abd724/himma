/**
 * Deterministic provider-surface fixtures (S3-3). Build organizations,
 * staff memberships, and MFA-assured bearers against a buildApp instance's
 * FakeAccessTokenVerifier — everything resolves through the real pipeline
 * and real PostgreSQL; nothing here bypasses a policy.
 */
import { sql, type Kysely } from 'kysely';

import { newId } from '../../src/db/ids';
import type { DB } from '../../src/db/kysely';
import type { AccessTokenEvidence } from '../../src/modules/identity/providers/access-token';
import type { FakeAccessTokenVerifier } from '../../src/modules/identity/providers/fake/fake-access-token-verifier';
import { establishSession } from '../../src/modules/identity/services/sessions';
import type { ProviderRole } from '../../src/modules/provider/provider-roles';
import { createUser } from './identity-fixtures';

export interface ProviderTestContext {
  db: Kysely<DB>;
  verifier: FakeAccessTokenVerifier;
  issuer: string;
}

let counter = 0;

export async function createProviderOrg(
  db: Kysely<DB>,
  options: { state?: string; displayName?: string; legalName?: string; branches?: number } = {},
): Promise<{ orgId: string; branchIds: string[] }> {
  counter += 1;
  const orgId = newId();
  const state = options.state ?? 'live';
  await sql`
    INSERT INTO organization (id, legal_name, trade_name, verification_state, suspended_at, offboarded_at)
    VALUES (${orgId}, ${options.legalName ?? `Legal ${counter} LLC`}, ${`Trade ${counter}`}, ${state},
            ${state === 'suspended' ? new Date() : null},
            ${state === 'offboarded' ? new Date() : null})`.execute(db);
  await sql`
    INSERT INTO organization_public_profile (organization_id, display_name)
    VALUES (${orgId}, ${options.displayName ?? `Provider ${counter}`})`.execute(db);
  const branchIds: string[] = [];
  for (let i = 0; i < (options.branches ?? 2); i += 1) {
    const branchId = newId();
    await sql`
      INSERT INTO branch (id, organization_id, label, area_label)
      VALUES (${branchId}, ${orgId}, ${`Branch ${i + 1}`}, 'Area')`.execute(db);
    branchIds.push(branchId);
  }
  return { orgId, branchIds };
}

export async function addMembership(
  db: Kysely<DB>,
  userId: string,
  orgId: string,
  role: ProviderRole,
  scopeBranchIds?: string[],
): Promise<string> {
  const membershipId = newId();
  await db.transaction().execute(async (trx) => {
    await sql`
      INSERT INTO staff_membership (id, user_id, organization_id, role, branch_scope_kind)
      VALUES (${membershipId}, ${userId}, ${orgId}, ${role},
              ${scopeBranchIds === undefined ? 'all' : 'branches'})`.execute(trx);
    for (const branchId of scopeBranchIds ?? []) {
      await sql`
        INSERT INTO staff_membership_branch (membership_id, branch_id, organization_id)
        VALUES (${membershipId}, ${branchId}, ${orgId})`.execute(trx);
    }
  });
  return membershipId;
}

export interface BearerOptions {
  assurance?: 'single_factor' | 'mfa';
  /** Mirror an active TOTP enrollment for the user (default true). */
  enrolled?: boolean;
  /** Provider auth time — controls step-up freshness (default now). */
  authTime?: Date;
  email?: string;
  emailVerified?: boolean;
  /** Extra provider token scopes — proven inert for provider authority. */
  scopes?: string[];
}

export async function bearerForUser(
  ctx: ProviderTestContext,
  userId: string,
  options: BearerOptions = {},
): Promise<{ bearer: string; sessionId: string }> {
  counter += 1;
  const subject = `provider-sub-${counter}`;
  await ctx.db
    .insertInto('auth_identity')
    .values({
      id: newId(),
      user_id: userId,
      provider: 'google',
      issuer: ctx.issuer,
      subject,
      email: options.email ?? null,
      email_verified: options.emailVerified ?? false,
      is_private_relay: false,
    })
    .execute();
  if (options.enrolled !== false) {
    const active = await ctx.db
      .selectFrom('mfa_method')
      .select('id')
      .where('user_id', '=', userId)
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (active === undefined) {
      await ctx.db
        .insertInto('mfa_method')
        .values({ id: newId(), user_id: userId, kind: 'totp', state: 'active', confirmed_at: new Date() })
        .execute();
    }
  }
  const evidence: AccessTokenEvidence = {
    issuer: ctx.issuer,
    subject,
    originJti: `provider-origin-${counter}`,
    scopes: options.scopes ?? ['openid'],
    assurance: options.assurance ?? 'mfa',
    expiresAt: new Date(Date.now() + 3_600_000),
    authTime: options.authTime ?? new Date(),
  };
  const established = await establishSession({ db: ctx.db }, { evidence, client: {} });
  if (established.kind !== 'sessionEstablished') throw new Error(established.kind);
  return { bearer: ctx.verifier.issueToken(evidence), sessionId: established.sessionId };
}

/** Staff user of one org with a fully MFA-assured bearer. */
export async function staffBearer(
  ctx: ProviderTestContext,
  orgId: string,
  role: ProviderRole,
  options: BearerOptions & { scopeBranchIds?: string[] } = {},
): Promise<{ userId: string; membershipId: string; bearer: string; sessionId: string }> {
  const userId = await createUser(ctx.db);
  const { scopeBranchIds, ...bearerOptions } = options;
  const membershipId = await addMembership(ctx.db, userId, orgId, role, scopeBranchIds);
  const { bearer, sessionId } = await bearerForUser(ctx, userId, bearerOptions);
  return { userId, membershipId, bearer, sessionId };
}

/** Session-bound recovery-code step-up grant (B2-6A shape, test-inserted). */
export async function grantStepUp(
  db: Kysely<DB>,
  userId: string,
  sessionId: string,
  options: { method?: string; expiresInSeconds?: number } = {},
): Promise<void> {
  await db
    .insertInto('step_up_grant')
    .values({
      id: newId(),
      user_id: userId,
      login_session_id: sessionId,
      method: options.method ?? 'recovery_code',
      granted_at: new Date(),
      expires_at: new Date(Date.now() + (options.expiresInSeconds ?? 900) * 1000),
    })
    .execute();
}
