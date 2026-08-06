/**
 * Staff-invitation security configuration (docs/27 §9, §17 configurables).
 *
 * Same boundary pattern as the B2-6B recovery-code pepper (mfa-config): the
 * pepper VALUE arrives only through configuration (docs/23 §10.3 secret
 * store in production; a deterministic, clearly non-production constant in
 * development/test). It is held in memory for HMAC computation and is NEVER
 * persisted, logged, audited, or defaulted in production — production fails
 * closed without an explicit, real pepper. `staff_invitation.pepper_version`
 * records WHICH pepper digested a token; this module supplies the
 * version → value mapping.
 */
import type { NodeEnv } from '../../config/env';

export class StaffInvitationConfigError extends Error {}

/** Deterministic non-production pepper — production refuses this value. */
export const DEV_TEST_INVITATION_PEPPER =
  'himma-dev-test-staff-invitation-pepper-never-production';

const MIN_PRODUCTION_PEPPER_LENGTH = 32;

export interface StaffInvitationConfig {
  /** Invitation validity window (docs/27 §17 default: 7 days). */
  invitationTtlSeconds: number;
  activePepperVersion: number;
  /** Pepper version → pepper value; acceptance resolves a row's version here. */
  peppers: ReadonlyMap<number, string>;
}

function parseBoundedInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new StaffInvitationConfigError(
      `${key} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

export function parseStaffInvitationConfig(
  nodeEnv: NodeEnv,
  env: Record<string, string | undefined> = process.env,
): StaffInvitationConfig {
  const rawPepper = env.HIMMA_STAFF_INVITATION_PEPPER?.trim();
  let pepper: string;
  if (nodeEnv === 'production') {
    // Fail closed: no default, no dev value, no short value.
    if (rawPepper === undefined || rawPepper === '') {
      throw new StaffInvitationConfigError(
        'Production requires HIMMA_STAFF_INVITATION_PEPPER from the secret store; refusing to run invitation-token hashing without it.',
      );
    }
    if (rawPepper.length < MIN_PRODUCTION_PEPPER_LENGTH) {
      throw new StaffInvitationConfigError(
        `HIMMA_STAFF_INVITATION_PEPPER must be at least ${MIN_PRODUCTION_PEPPER_LENGTH} characters in production.`,
      );
    }
    if (rawPepper === DEV_TEST_INVITATION_PEPPER) {
      throw new StaffInvitationConfigError(
        'HIMMA_STAFF_INVITATION_PEPPER must not be the development/test pepper in production.',
      );
    }
    pepper = rawPepper;
  } else {
    pepper =
      rawPepper !== undefined && rawPepper !== ''
        ? rawPepper
        : DEV_TEST_INVITATION_PEPPER;
  }

  const activePepperVersion = parseBoundedInt(
    env,
    'HIMMA_STAFF_INVITATION_PEPPER_VERSION',
    1,
    1,
    1_000,
  );
  return {
    invitationTtlSeconds: parseBoundedInt(
      env,
      'HIMMA_STAFF_INVITATION_TTL_SECONDS',
      7 * 86_400,
      3_600,
      90 * 86_400,
    ),
    activePepperVersion,
    peppers: new Map([[activePepperVersion, pepper]]),
  };
}
