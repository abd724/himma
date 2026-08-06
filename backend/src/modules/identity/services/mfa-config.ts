/**
 * MFA security configuration (docs/26 §14.C) — B2-6B.
 *
 * Every value here is configuration with a safe default, never a literal in
 * service code: recovery-code count, challenge TTL and attempt cap, step-up
 * max-age, enrollment window, and the recovery-code pepper.
 *
 * Pepper boundary: the pepper VALUE arrives only through this configuration
 * (docs/23 §10.3 secret store in production; a deterministic, clearly
 * non-production constant in development/test). It is held in memory for
 * HMAC computation and is NEVER persisted, logged, audited, or defaulted in
 * production — production fails closed without an explicit, real pepper.
 * B2-6A's `pepper_version` column records WHICH pepper digested a batch;
 * this module supplies the version → value mapping.
 */
import type { NodeEnv } from '../../../config/env';

export class MfaConfigError extends Error {}

/** Deterministic non-production pepper — production refuses this value. */
export const DEV_TEST_PEPPER = 'himma-dev-test-recovery-pepper-never-production';

const MIN_PRODUCTION_PEPPER_LENGTH = 32;

export interface MfaConfig {
  recoveryCodeCount: number;
  activePepperVersion: number;
  /** Pepper version → pepper value; consumption resolves a batch's version here. */
  peppers: ReadonlyMap<number, string>;
  enrollmentTtlSeconds: number;
  challengeTtlSeconds: number;
  challengeAttemptCap: number;
  stepUpTtlSeconds: number;
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
    throw new MfaConfigError(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function parseMfaConfig(
  nodeEnv: NodeEnv,
  env: Record<string, string | undefined> = process.env,
): MfaConfig {
  const rawPepper = env.HIMMA_MFA_RECOVERY_PEPPER?.trim();
  let pepper: string;
  if (nodeEnv === 'production') {
    // Fail closed: no default, no dev value, no short value.
    if (rawPepper === undefined || rawPepper === '') {
      throw new MfaConfigError(
        'Production requires HIMMA_MFA_RECOVERY_PEPPER from the secret store; refusing to run recovery-code hashing without it.',
      );
    }
    if (rawPepper.length < MIN_PRODUCTION_PEPPER_LENGTH) {
      throw new MfaConfigError(
        `HIMMA_MFA_RECOVERY_PEPPER must be at least ${MIN_PRODUCTION_PEPPER_LENGTH} characters in production.`,
      );
    }
    if (rawPepper === DEV_TEST_PEPPER) {
      throw new MfaConfigError(
        'HIMMA_MFA_RECOVERY_PEPPER must not be the development/test pepper in production.',
      );
    }
    pepper = rawPepper;
  } else {
    pepper = rawPepper !== undefined && rawPepper !== '' ? rawPepper : DEV_TEST_PEPPER;
  }

  const activePepperVersion = parseBoundedInt(
    env,
    'HIMMA_MFA_RECOVERY_PEPPER_VERSION',
    1,
    1,
    1_000,
  );
  return {
    recoveryCodeCount: parseBoundedInt(env, 'HIMMA_MFA_RECOVERY_CODE_COUNT', 10, 1, 100),
    activePepperVersion,
    peppers: new Map([[activePepperVersion, pepper]]),
    enrollmentTtlSeconds: parseBoundedInt(env, 'HIMMA_MFA_ENROLLMENT_TTL_SECONDS', 900, 60, 86_400),
    challengeTtlSeconds: parseBoundedInt(env, 'HIMMA_MFA_CHALLENGE_TTL_SECONDS', 300, 30, 3_600),
    challengeAttemptCap: parseBoundedInt(env, 'HIMMA_MFA_CHALLENGE_ATTEMPT_CAP', 5, 1, 20),
    stepUpTtlSeconds: parseBoundedInt(env, 'HIMMA_MFA_STEP_UP_TTL_SECONDS', 900, 60, 86_400),
  };
}
