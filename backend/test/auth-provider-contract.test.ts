/**
 * B2-2 — AuthProviderAdapter contract suite (docs/26 §2, §11.4).
 *
 * One behavioral contract, run against every adapter implementation: the
 * deterministic fake used by all automated tests, and the Cognito adapter
 * exercised against locally generated JWKS fixtures — no AWS access, no
 * cloud resource, no network.
 */
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import type { JWK, JWTPayload } from 'jose';

import type {
  AuthProviderAdapter,
  TokenValidationResult,
} from '../src/modules/identity/providers/adapter';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import {
  CognitoAuthProviderAdapter,
} from '../src/modules/identity/providers/cognito/cognito-adapter';
import {
  parseCognitoConfig,
  jwksUriFor,
  type CognitoAdapterConfig,
} from '../src/modules/identity/providers/cognito/config';

// Non-production fixture values only — nothing here references a real pool.
const POOL_ISSUER = 'https://cognito-idp.test-region-1.amazonaws.com/test_pool_fixture';
const CLIENT_ID = 'client-app-1';

interface AdapterHarness {
  adapter: AuthProviderAdapter;
  expected: ProviderEvidence;
  /** Returns a token the adapter must validate to `expected`. */
  validToken: () => Promise<string>;
  /** Returns a token the adapter must reject as invalidProviderEvidence. */
  invalidToken: () => Promise<string>;
  makeUnavailable: () => void;
  restore: () => void;
}

function contractSuite(makeHarness: () => Promise<AdapterHarness>): void {
  let harness: AdapterHarness;

  beforeAll(async () => {
    harness = await makeHarness();
  });

  afterEach(() => {
    harness.restore();
  });

  it('validates a well-formed token to normalized evidence', async () => {
    const result = await harness.adapter.validateToken(await harness.validToken());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toMatchObject({
        provider: harness.expected.provider,
        issuer: harness.expected.issuer,
        subject: harness.expected.subject,
        email: harness.expected.email,
        emailVerified: harness.expected.emailVerified,
      });
    }
  });

  it('rejects an invalid token as invalidProviderEvidence (typed, never a thrown SDK error)', async () => {
    const result = await harness.adapter.validateToken(await harness.invalidToken());
    expect(result).toEqual<TokenValidationResult>({
      ok: false,
      reason: 'invalidProviderEvidence',
    });
  });

  it('rejects garbage input as invalidProviderEvidence', async () => {
    const result = await harness.adapter.validateToken('not-a-token');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalidProviderEvidence');
  });

  it('normalizes provider outage into the typed providerUnavailable outcome', async () => {
    harness.makeUnavailable();
    const result = await harness.adapter.validateToken(await harness.validToken());
    expect(result).toEqual<TokenValidationResult>({
      ok: false,
      reason: 'providerUnavailable',
    });
  });
}

// ---------------------------------------------------------------------------
// Deterministic fake
// ---------------------------------------------------------------------------

const FAKE_EVIDENCE: ProviderEvidence = {
  provider: 'google',
  issuer: 'https://accounts.google.com',
  subject: 'contract-sub-1',
  email: 'contract@example.test',
  emailVerified: true,
  isPrivateRelay: false,
  assurance: 'single_factor',
};

describe('AuthProviderAdapter contract — deterministic fake', () => {
  contractSuite(async () => {
    const fake = new FakeAuthProviderAdapter();
    const valid = fake.issueToken(FAKE_EVIDENCE);
    return {
      adapter: fake,
      expected: FAKE_EVIDENCE,
      validToken: async () => valid,
      invalidToken: async () => 'fake-token-that-was-never-issued',
      makeUnavailable: () => fake.setUnavailable(true),
      restore: () => fake.setUnavailable(false),
    };
  });

  it('rejects issued tokens whose evidence is malformed (validation runs inside the adapter)', async () => {
    const fake = new FakeAuthProviderAdapter();
    const token = fake.issueRawToken({ issuer: '', subject: 'x' });
    const result = await fake.validateToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalidProviderEvidence');
  });

  it('is deterministic: the same token always yields the same evidence', async () => {
    const fake = new FakeAuthProviderAdapter();
    const token = fake.issueToken(FAKE_EVIDENCE);
    const first = await fake.validateToken(token);
    const second = await fake.validateToken(token);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Cognito adapter over local JWKS fixtures
// ---------------------------------------------------------------------------

interface KeyFixture {
  jwk: JWK;
  sign: (
    payload: JWTPayload,
    options?: { kid?: string; issuer?: string; expiresIn?: string; audience?: string },
  ) => Promise<string>;
}

async function makeKey(kid: string): Promise<KeyFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return {
    jwk,
    sign: async (payload, options = {}) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? kid })
        .setIssuer(options.issuer ?? POOL_ISSUER)
        .setAudience(options.audience ?? CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? '5m')
        .sign(privateKey),
  };
}

const CONFIG: CognitoAdapterConfig = {
  issuer: POOL_ISSUER,
  clientIds: [CLIENT_ID],
};

function idClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    sub: 'cognito-sub-1',
    token_use: 'id',
    email: 'federated@example.test',
    email_verified: true,
    identities: [{ providerName: 'Google' }],
    ...overrides,
  };
}

describe('AuthProviderAdapter contract — Cognito over local JWKS', () => {
  contractSuite(async () => {
    const key = await makeKey('k1');
    let down = false;
    const localResolver = createLocalJWKSet({ keys: [key.jwk] });
    const adapter = new CognitoAuthProviderAdapter(CONFIG, {
      getKey: (protectedHeader, token) => {
        if (down) throw new Error('simulated network failure fetching JWKS');
        return localResolver(protectedHeader, token);
      },
    });
    return {
      adapter,
      expected: {
        provider: 'google',
        issuer: POOL_ISSUER,
        subject: 'cognito-sub-1',
        email: 'federated@example.test',
        emailVerified: true,
        isPrivateRelay: false,
        assurance: 'single_factor',
      },
      validToken: () => key.sign(idClaims()),
      invalidToken: () => key.sign(idClaims(), { expiresIn: '-5m' }),
      makeUnavailable: () => {
        down = true;
      },
      restore: () => {
        down = false;
      },
    };
  });
});

describe('Cognito adapter specifics', () => {
  let key: KeyFixture;
  let adapter: CognitoAuthProviderAdapter;

  beforeAll(async () => {
    key = await makeKey('k1');
    adapter = new CognitoAuthProviderAdapter(CONFIG, {
      getKey: createLocalJWKSet({ keys: [key.jwk] }),
    });
  });

  async function validate(payload: JWTPayload, options?: { kid?: string; issuer?: string }) {
    return adapter.validateToken(await key.sign(payload, options));
  }

  it('rejects a token from a different issuer signed with the same key', async () => {
    const result = await validate(idClaims(), { issuer: 'https://cognito-idp.test-region-1.amazonaws.com/other_pool' });
    expect(result).toEqual({ ok: false, reason: 'invalidProviderEvidence' });
  });

  it('rejects a wrong-audience token signed with the trusted key', async () => {
    const token = await key.sign(idClaims(), { audience: 'some-other-client' });
    const result = await adapter.validateToken(token);
    expect(result).toEqual({ ok: false, reason: 'invalidProviderEvidence' });
  });

  it('rejects a token forged with an untrusted key', async () => {
    const forged = await new SignJWT(idClaims())
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(POOL_ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign((await generateKeyPair('RS256')).privateKey);
    const result = await adapter.validateToken(forged);
    expect(result).toEqual({ ok: false, reason: 'invalidProviderEvidence' });
  });

  it('rejects access tokens: token_use must be id in B2-2 (session flows are B2-3)', async () => {
    const result = await validate(idClaims({ token_use: 'access' }));
    expect(result).toEqual({ ok: false, reason: 'invalidProviderEvidence' });
  });

  it('rejects a token missing its subject', async () => {
    const claims = idClaims();
    delete claims.sub;
    const result = await validate(claims);
    expect(result).toEqual({ ok: false, reason: 'invalidProviderEvidence' });
  });

  it('survives JWKS rotation: a new kid validates once the refreshed key set carries it', async () => {
    const k2 = await makeKey('k2');
    let keys = { keys: [key.jwk] };
    const rotating = new CognitoAuthProviderAdapter(CONFIG, {
      getKey: (header, token) => createLocalJWKSet(keys)(header, token),
    });
    const token = await k2.sign(idClaims());
    expect((await rotating.validateToken(token)).ok).toBe(false); // pre-rotation
    keys = { keys: [key.jwk, k2.jwk] }; // provider rotated; refreshed JWKS
    expect((await rotating.validateToken(token)).ok).toBe(true);
  });

  it('ignores cognito:groups and custom role claims as authorization authority', async () => {
    const withGroups = await validate(
      idClaims({ 'cognito:groups': ['admins', 'finance'], 'custom:role': 'super_admin' }),
    );
    const withoutGroups = await validate(idClaims());
    expect(withGroups.ok).toBe(true);
    expect(withoutGroups.ok).toBe(true);
    if (withGroups.ok && withoutGroups.ok) {
      expect(withGroups.evidence).toEqual(withoutGroups.evidence);
      expect(JSON.stringify(withGroups.evidence)).not.toContain('admins');
      expect(JSON.stringify(withGroups.evidence)).not.toContain('super_admin');
    }
  });

  it('maps Apple federation and private-relay addresses', async () => {
    const result = await validate(
      idClaims({
        identities: [{ providerName: 'SignInWithApple' }],
        email: 'abc123@privaterelay.appleid.com',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.provider).toBe('apple');
      expect(result.evidence.isPrivateRelay).toBe(true);
      expect(result.evidence.emailVerified).toBe(true);
    }
  });

  it('maps native email identities and string-typed email_verified claims', async () => {
    const result = await validate(
      idClaims({ identities: undefined, email_verified: 'true' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.provider).toBe('email');
      expect(result.evidence.emailVerified).toBe(true);
    }
  });

  it('reports mfa assurance from the amr claim', async () => {
    const result = await validate(idClaims({ amr: ['pwd', 'software_token_mfa'] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence.assurance).toBe('mfa');
  });
});

describe('Cognito adapter configuration (types only — nothing provisioned)', () => {
  it('parses config from environment values and derives the JWKS URI', () => {
    const config = parseCognitoConfig({
      COGNITO_ISSUER: POOL_ISSUER,
      COGNITO_CLIENT_IDS: 'client-app-1, client-app-2',
    });
    expect(config).toEqual({
      issuer: POOL_ISSUER,
      clientIds: ['client-app-1', 'client-app-2'],
    });
    expect(jwksUriFor(config as CognitoAdapterConfig)).toBe(
      `${POOL_ISSUER}/.well-known/jwks.json`,
    );
  });

  it('returns undefined when no pool is configured (the B2-2 state everywhere)', () => {
    expect(parseCognitoConfig({})).toBeUndefined();
  });

  it('rejects non-https issuers and empty client id lists', () => {
    expect(() =>
      parseCognitoConfig({ COGNITO_ISSUER: 'http://insecure', COGNITO_CLIENT_IDS: 'a' }),
    ).toThrow();
    expect(() =>
      parseCognitoConfig({ COGNITO_ISSUER: POOL_ISSUER, COGNITO_CLIENT_IDS: ' , ' }),
    ).toThrow();
  });
});
