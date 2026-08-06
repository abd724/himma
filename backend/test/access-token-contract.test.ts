/**
 * B2-3 — access-token verification boundary (docs/26 §4.1, Amendment A1.1).
 *
 * A deliberately SEPARATE port from B2-2's identity-evidence adapter: API
 * authentication consumes Cognito ACCESS tokens; a Cognito ID token is never
 * an API bearer token. One behavioral contract runs against the
 * deterministic fake and the Cognito verifier over locally generated JWKS —
 * no AWS access, no cloud resource.
 */
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import type { JWK, JWTPayload } from 'jose';

import type {
  AccessTokenEvidence,
  AccessTokenVerificationResult,
  AccessTokenVerifier,
} from '../src/modules/identity/providers/access-token';
import { validateAccessTokenEvidence } from '../src/modules/identity/providers/access-token';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { CognitoAccessTokenVerifier } from '../src/modules/identity/providers/cognito/cognito-access-token-verifier';
import { parseCognitoConfig } from '../src/modules/identity/providers/cognito/config';

const POOL_ISSUER = 'https://cognito-idp.test-region-1.amazonaws.com/test_pool_fixture';
const CLIENT_ID = 'client-app-1';

function makeEvidence(overrides: Partial<AccessTokenEvidence> = {}): AccessTokenEvidence {
  return {
    issuer: POOL_ISSUER,
    subject: 'access-sub-1',
    originJti: 'origin-jti-1',
    jti: 'jti-1',
    clientId: CLIENT_ID,
    scopes: ['openid'],
    assurance: 'single_factor',
    expiresAt: new Date(Date.now() + 300_000),
    ...overrides,
  };
}

describe('validateAccessTokenEvidence', () => {
  it('accepts complete normalized evidence', () => {
    expect(validateAccessTokenEvidence(makeEvidence()).ok).toBe(true);
  });

  it.each([
    ['empty issuer', { issuer: ' ' }],
    ['empty subject', { subject: '' }],
    ['missing origin_jti', { originJti: '' }],
    ['whitespace origin_jti', { originJti: 'a b' }],
    ['past-only expiry type', { expiresAt: 'soon' as unknown as Date }],
  ])('rejects %s', (_label, overrides) => {
    expect(
      validateAccessTokenEvidence({ ...makeEvidence(), ...overrides } as never).ok,
    ).toBe(false);
  });

  it('rejects structurally foreign input without throwing', () => {
    for (const junk of [null, undefined, 5, 'token', {}]) {
      expect(validateAccessTokenEvidence(junk as never).ok).toBe(false);
    }
  });
});

interface VerifierHarness {
  verifier: AccessTokenVerifier;
  expected: AccessTokenEvidence;
  validToken: () => Promise<string>;
  invalidToken: () => Promise<string>;
  makeUnavailable: () => void;
  restore: () => void;
}

function contractSuite(makeHarness: () => Promise<VerifierHarness>): void {
  let harness: VerifierHarness;

  beforeAll(async () => {
    harness = await makeHarness();
  });

  afterEach(() => harness.restore());

  it('verifies a well-formed access token to normalized evidence', async () => {
    const result = await harness.verifier.verifyAccessToken(await harness.validToken());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toMatchObject({
        issuer: harness.expected.issuer,
        subject: harness.expected.subject,
        originJti: harness.expected.originJti,
      });
    }
  });

  it('rejects an invalid token as the typed invalidAccessToken outcome', async () => {
    const result = await harness.verifier.verifyAccessToken(await harness.invalidToken());
    expect(result).toEqual<AccessTokenVerificationResult>({
      ok: false,
      reason: 'invalidAccessToken',
    });
  });

  it('rejects garbage input as invalidAccessToken', async () => {
    const result = await harness.verifier.verifyAccessToken('not-a-token');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalidAccessToken');
  });

  it('normalizes provider outage into providerUnavailable', async () => {
    harness.makeUnavailable();
    const result = await harness.verifier.verifyAccessToken(await harness.validToken());
    expect(result).toEqual<AccessTokenVerificationResult>({
      ok: false,
      reason: 'providerUnavailable',
    });
  });
}

describe('AccessTokenVerifier contract — deterministic fake', () => {
  contractSuite(async () => {
    const fake = new FakeAccessTokenVerifier();
    const evidence = makeEvidence();
    const valid = fake.issueToken(evidence);
    return {
      verifier: fake,
      expected: evidence,
      validToken: async () => valid,
      invalidToken: async () => 'never-issued',
      makeUnavailable: () => fake.setUnavailable(true),
      restore: () => fake.setUnavailable(false),
    };
  });
});

// ---------------------------------------------------------------------------
// Cognito access-token verifier over local JWKS
// ---------------------------------------------------------------------------

interface KeyFixture {
  jwk: JWK;
  sign: (
    payload: JWTPayload,
    options?: { kid?: string; issuer?: string; expiresIn?: string; notBefore?: string },
  ) => Promise<string>;
}

async function makeKey(kid: string): Promise<KeyFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return {
    jwk,
    sign: async (payload, options = {}) => {
      let builder = new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? kid })
        .setIssuer(options.issuer ?? POOL_ISSUER)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? '5m');
      if (options.notBefore !== undefined) builder = builder.setNotBefore(options.notBefore);
      return builder.sign(privateKey);
    },
  };
}

function accessClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    sub: 'access-sub-1',
    token_use: 'access',
    client_id: CLIENT_ID,
    origin_jti: 'origin-jti-1',
    jti: 'jti-1',
    scope: 'openid profile',
    ...overrides,
  };
}

describe('AccessTokenVerifier contract — Cognito over local JWKS', () => {
  contractSuite(async () => {
    const key = await makeKey('k1');
    let down = false;
    const localResolver = createLocalJWKSet({ keys: [key.jwk] });
    const verifier = new CognitoAccessTokenVerifier(
      { issuer: POOL_ISSUER, clientIds: [CLIENT_ID] },
      {
        getKey: (header, token) => {
          if (down) throw new Error('simulated network failure fetching JWKS');
          return localResolver(header, token);
        },
      },
    );
    return {
      verifier,
      expected: makeEvidence(),
      validToken: () => key.sign(accessClaims()),
      invalidToken: () => key.sign(accessClaims(), { expiresIn: '-5m' }),
      makeUnavailable: () => {
        down = true;
      },
      restore: () => {
        down = false;
      },
    };
  });
});

describe('Cognito access-token verifier specifics', () => {
  let key: KeyFixture;
  let verifier: CognitoAccessTokenVerifier;

  beforeAll(async () => {
    key = await makeKey('k1');
    verifier = new CognitoAccessTokenVerifier(
      { issuer: POOL_ISSUER, clientIds: [CLIENT_ID] },
      { getKey: createLocalJWKSet({ keys: [key.jwk] }) },
    );
  });

  it('REJECTS a Cognito ID token presented as an API bearer token', async () => {
    const idToken = await key.sign({
      sub: 'access-sub-1',
      token_use: 'id',
      aud: CLIENT_ID,
      email: 'person@example.test',
      email_verified: true,
      origin_jti: 'origin-jti-1',
    });
    const result = await verifier.verifyAccessToken(idToken);
    expect(result).toEqual({ ok: false, reason: 'invalidAccessToken' });
  });

  it('rejects a missing token_use claim', async () => {
    const claims = accessClaims();
    delete claims.token_use;
    expect(await verifier.verifyAccessToken(await key.sign(claims))).toEqual({
      ok: false,
      reason: 'invalidAccessToken',
    });
  });

  it('rejects a wrong issuer signed with the trusted key', async () => {
    const token = await key.sign(accessClaims(), {
      issuer: 'https://cognito-idp.test-region-1.amazonaws.com/other_pool',
    });
    expect(await verifier.verifyAccessToken(token)).toEqual({
      ok: false,
      reason: 'invalidAccessToken',
    });
  });

  it('rejects a wrong client_id', async () => {
    const token = await key.sign(accessClaims({ client_id: 'unknown-client' }));
    expect(await verifier.verifyAccessToken(token)).toEqual({
      ok: false,
      reason: 'invalidAccessToken',
    });
  });

  it('rejects an expired token and a not-yet-valid token', async () => {
    expect(
      await verifier.verifyAccessToken(await key.sign(accessClaims(), { expiresIn: '-1m' })),
    ).toEqual({ ok: false, reason: 'invalidAccessToken' });
    expect(
      await verifier.verifyAccessToken(
        await key.sign(accessClaims(), { notBefore: '10m', expiresIn: '20m' }),
      ),
    ).toEqual({ ok: false, reason: 'invalidAccessToken' });
  });

  it('tolerates small clock skew within the bounded configured tolerance', async () => {
    const tolerant = new CognitoAccessTokenVerifier(
      { issuer: POOL_ISSUER, clientIds: [CLIENT_ID], clockToleranceSeconds: 60 },
      { getKey: createLocalJWKSet({ keys: [key.jwk] }) },
    );
    const justExpired = await key.sign(accessClaims(), { expiresIn: '-10s' });
    expect((await tolerant.verifyAccessToken(justExpired)).ok).toBe(true);
    const farExpired = await key.sign(accessClaims(), { expiresIn: '-10m' });
    expect((await tolerant.verifyAccessToken(farExpired)).ok).toBe(false);
  });

  it('rejects an invalid signature and an unknown kid', async () => {
    const forged = await (await makeKey('k1')).sign(accessClaims()); // same kid, untrusted key
    expect(await verifier.verifyAccessToken(forged)).toEqual({
      ok: false,
      reason: 'invalidAccessToken',
    });
    const unknownKid = await key.sign(accessClaims(), { kid: 'k9' });
    expect(await verifier.verifyAccessToken(unknownKid)).toEqual({
      ok: false,
      reason: 'invalidAccessToken',
    });
  });

  it('rejects a token without origin_jti (sessions are keyed by it — approved policy)', async () => {
    const claims = accessClaims();
    delete claims.origin_jti;
    expect(await verifier.verifyAccessToken(await key.sign(claims))).toEqual({
      ok: false,
      reason: 'invalidAccessToken',
    });
  });

  it('ignores cognito:groups and custom role claims entirely', async () => {
    const withGroups = await verifier.verifyAccessToken(
      await key.sign(accessClaims({ 'cognito:groups': ['admins'], 'custom:role': 'super_admin' })),
    );
    const withoutGroups = await verifier.verifyAccessToken(await key.sign(accessClaims()));
    expect(withGroups.ok).toBe(true);
    expect(withoutGroups.ok).toBe(true);
    if (withGroups.ok && withoutGroups.ok) {
      expect(withGroups.evidence).toEqual(withoutGroups.evidence);
      expect(JSON.stringify(withGroups.evidence)).not.toContain('admins');
      expect(JSON.stringify(withGroups.evidence)).not.toContain('super_admin');
    }
  });

  it('carries scopes and mfa assurance in the normalized evidence', async () => {
    const result = await verifier.verifyAccessToken(
      await key.sign(accessClaims({ scope: 'openid profile', amr: ['software_token_mfa'] })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.scopes).toEqual(['openid', 'profile']);
      expect(result.evidence.assurance).toBe('mfa');
      expect(result.evidence.clientId).toBe(CLIENT_ID);
      expect(result.evidence.jti).toBe('jti-1');
    }
  });
});

describe('configuration fails closed', () => {
  it('clock tolerance is bounded and validated by the config parser', () => {
    const config = parseCognitoConfig({
      COGNITO_ISSUER: POOL_ISSUER,
      COGNITO_CLIENT_IDS: CLIENT_ID,
      COGNITO_CLOCK_TOLERANCE_SECONDS: '60',
    });
    expect(config?.clockToleranceSeconds).toBe(60);
    expect(() =>
      parseCognitoConfig({
        COGNITO_ISSUER: POOL_ISSUER,
        COGNITO_CLIENT_IDS: CLIENT_ID,
        COGNITO_CLOCK_TOLERANCE_SECONDS: '9999',
      }),
    ).toThrow();
    expect(() =>
      parseCognitoConfig({
        COGNITO_ISSUER: POOL_ISSUER,
        COGNITO_CLIENT_IDS: CLIENT_ID,
        COGNITO_CLOCK_TOLERANCE_SECONDS: 'lots',
      }),
    ).toThrow();
  });

  it('a verifier cannot be built without a trusted issuer and client ids', () => {
    expect(
      () => new CognitoAccessTokenVerifier({ issuer: '', clientIds: [CLIENT_ID] }),
    ).toThrow();
    expect(() => new CognitoAccessTokenVerifier({ issuer: POOL_ISSUER, clientIds: [] })).toThrow();
  });
});
