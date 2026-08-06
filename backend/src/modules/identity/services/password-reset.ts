/**
 * Enumeration-safe password-reset request (docs/26 §5.5–5.6, D2) — B2-4.
 *
 * Always resolves to the same outward result. When an active email identity
 * exists: challenge bookkeeping (no code — codes are the provider's) plus a
 * notice through the MailSender port (captured in dev/test; production
 * delivery disabled). The mail call is network I/O and runs strictly AFTER
 * the bookkeeping transactions. Nothing observable distinguishes the two
 * paths — the route adds the timing floor.
 */
import { withTransaction } from '../../../db/transaction';
import type { MailSender } from '../mail/mail-sender';
import { findActiveEmailIdentity } from '../persistence/identity-repository';
import type { IdentityServiceDeps } from './account-status';
import { recordChallengeRequested } from './challenges';

export interface PasswordResetDeps extends IdentityServiceDeps {
  mailSender: MailSender;
}

export async function requestPasswordReset(
  deps: PasswordResetDeps,
  input: { email: string },
): Promise<{ status: 'accepted' }> {
  const identity = await withTransaction(deps.db, (trx) =>
    findActiveEmailIdentity(trx, input.email),
  );
  if (identity !== undefined) {
    await recordChallengeRequested(deps, {
      kind: 'password_reset',
      identityId: identity.id,
      userId: identity.user_id,
    });
    await deps.mailSender.send({
      to: input.email,
      template: 'password_reset_notice',
      subject: 'Password reset requested',
      body: 'A password reset was requested for your Himma account. Follow the instructions in your sign-in app to continue.',
    });
  }
  return { status: 'accepted' };
}
