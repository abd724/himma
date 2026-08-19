import {
  EvidenceStoreError,
  type StoredObjectFacts,
  type VerificationEvidenceObjectStore,
} from './evidence-store';

/**
 * Deterministic in-memory evidence store — the dev/test double behind the
 * SAME port the S3-compatible driver implements (the FakeAccessTokenVerifier
 * pattern). Failure controls simulate infrastructure incidents at each
 * lifecycle step so the "never falsely stored" guarantees are provable.
 * Never a production composition: production either configures the real
 * private driver or the evidence surface is ABSENT (fail closed).
 */
export interface FakeEvidenceStore extends VerificationEvidenceObjectStore {
  /** Test introspection — object count and raw content by key. */
  objectCount(): number;
  rawObject(key: string): { body: Buffer; contentType: string } | undefined;
  /** One-shot failure injections (infrastructure incident simulation). */
  failNextPut(): void;
  failNextHead(): void;
  failNextGet(): void;
}

export function createFakeEvidenceStore(): FakeEvidenceStore {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const failures = { put: false, head: false, get: false };

  const takeFailure = (step: keyof typeof failures): boolean => {
    if (failures[step]) {
      failures[step] = false;
      return true;
    }
    return false;
  };

  return {
    async putObject(input) {
      if (takeFailure('put')) throw new EvidenceStoreError('injected put failure');
      objects.set(input.key, { body: Buffer.from(input.body), contentType: input.contentType });
    },
    async headObject(key): Promise<StoredObjectFacts | null> {
      if (takeFailure('head')) throw new EvidenceStoreError('injected head failure');
      const object = objects.get(key);
      return object === undefined ? null : { byteSize: object.body.byteLength };
    },
    async getObject(key) {
      if (takeFailure('get')) throw new EvidenceStoreError('injected get failure');
      const object = objects.get(key);
      return object === undefined
        ? null
        : { body: Buffer.from(object.body), contentType: object.contentType };
    },
    objectCount: () => objects.size,
    rawObject: (key) => objects.get(key),
    failNextPut: () => {
      failures.put = true;
    },
    failNextHead: () => {
      failures.head = true;
    },
    failNextGet: () => {
      failures.get = true;
    },
  };
}
