/**
 * W3-4 — S3-compatible private evidence store driver: wire-format proofs
 * against a deterministic in-process endpoint (the Cognito-client testing
 * posture — the real-bucket smoke is a recorded operational dependency).
 * SigV4 signing, payload hashing, server-side-encryption headers, private
 * (no-ACL, no-presign) request shape, and failure mapping.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createS3EvidenceStore } from '../src/modules/provider/storage/s3-evidence-store';
import { EvidenceStoreError } from '../src/modules/provider/storage/evidence-store';

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server;
let baseUrl: string;
const captured: CapturedRequest[] = [];
const objects = new Map<string, { body: Buffer; contentType: string }>();
let refuseNext = false;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      captured.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      if (refuseNext) {
        refuseNext = false;
        response.statusCode = 500;
        return response.end('boom');
      }
      const key = request.url ?? '';
      if (request.method === 'PUT') {
        objects.set(key, {
          body,
          contentType: String(request.headers['content-type'] ?? 'application/octet-stream'),
        });
        response.statusCode = 200;
        return response.end();
      }
      const object = objects.get(key);
      if (object === undefined) {
        response.statusCode = 404;
        return response.end();
      }
      response.setHeader('content-length', object.body.byteLength);
      response.setHeader('content-type', object.contentType);
      response.statusCode = 200;
      return response.end(request.method === 'HEAD' ? undefined : object.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function storeUnderTest(options: { kms?: boolean } = {}) {
  return createS3EvidenceStore({
    endpoint: baseUrl,
    region: 'me-south-1',
    bucket: 'himma-verification-private',
    accessKeyId: 'AKIDTEST',
    secretAccessKey: 'secret-test-key',
    keyPrefix: 'env-test',
    ...(options.kms === true
      ? { serverSideEncryption: { kind: 'aws:kms' as const, kmsKeyId: 'kms-key-1' } }
      : {}),
    now: () => new Date('2026-08-19T10:00:00.000Z'),
  });
}

describe('S3-compatible driver wire format', () => {
  it('PUT writes the exact bytes with SigV4, the payload SHA-256, SSE, and the prefixed path-style private key — no ACL, no query string', async () => {
    const store = storeUnderTest();
    const body = Buffer.from('private document bytes');
    await store.putObject({
      key: 'verification/org-1/case-1/evidence-1',
      body,
      contentType: 'application/pdf',
    });
    const request = captured.at(-1)!;
    expect(request.method).toBe('PUT');
    expect(request.url).toBe(
      '/himma-verification-private/env-test/verification/org-1/case-1/evidence-1',
    );
    expect(request.url).not.toContain('?'); // never presigned/query-auth
    expect(request.body.equals(body)).toBe(true);
    expect(request.headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update(body).digest('hex'),
    );
    expect(request.headers['x-amz-server-side-encryption']).toBe('AES256');
    expect(request.headers['content-type']).toBe('application/pdf');
    expect(request.headers['x-amz-date']).toBe('20260819T100000Z');
    expect(request.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20260819\/me-south-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    expect(request.headers.authorization).toContain('content-type;host;x-amz-content-sha256');
    // Private-by-policy: the driver never sets an object ACL.
    expect(request.headers['x-amz-acl']).toBeUndefined();
  });

  it('KMS configuration rides the standard SSE headers', async () => {
    const store = storeUnderTest({ kms: true });
    await store.putObject({
      key: 'verification/org-1/case-1/evidence-kms',
      body: Buffer.from('x'),
      contentType: 'application/pdf',
    });
    const request = captured.at(-1)!;
    expect(request.headers['x-amz-server-side-encryption']).toBe('aws:kms');
    expect(request.headers['x-amz-server-side-encryption-aws-kms-key-id']).toBe('kms-key-1');
  });

  it('HEAD returns authoritative size, GET returns the bytes, and 404 maps to null', async () => {
    const store = storeUnderTest();
    const body = Buffer.from('roundtrip bytes');
    await store.putObject({
      key: 'verification/org-2/case-2/evidence-2',
      body,
      contentType: 'image/png',
    });
    await expect(store.headObject('verification/org-2/case-2/evidence-2')).resolves.toEqual({
      byteSize: body.byteLength,
    });
    const object = await store.getObject('verification/org-2/case-2/evidence-2');
    expect(object?.body.equals(body)).toBe(true);
    expect(object?.contentType).toBe('image/png');
    await expect(store.headObject('verification/absent/absent/absent')).resolves.toBeNull();
    await expect(store.getObject('verification/absent/absent/absent')).resolves.toBeNull();
  });

  it('infrastructure refusals surface as EvidenceStoreError without leaking credentials', async () => {
    const store = storeUnderTest();
    refuseNext = true;
    let caught: unknown;
    try {
      await store.putObject({
        key: 'verification/org-3/case-3/evidence-3',
        body: Buffer.from('x'),
        contentType: 'application/pdf',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvidenceStoreError);
    expect(String(caught)).not.toContain('secret-test-key');
    expect(String(caught)).not.toContain('AKIDTEST');
  });

  it('refuses a non-https endpoint outside loopback (private transport is mandatory)', () => {
    expect(() =>
      createS3EvidenceStore({
        endpoint: 'http://storage.example.com',
        region: 'me-south-1',
        bucket: 'bucket',
        accessKeyId: 'a',
        secretAccessKey: 'b',
      }),
    ).toThrow(/https/);
  });
});
