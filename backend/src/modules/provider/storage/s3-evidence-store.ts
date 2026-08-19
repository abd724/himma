/**
 * S3-compatible PRIVATE evidence store driver (W3-4; D-W3-1 Option B).
 *
 * Works against any SigV4 S3-compatible object store (AWS S3, MinIO,
 * Cloudflare R2, …) over HTTPS with AWS Signature Version 4 — implemented
 * directly on node:crypto + global fetch (no new dependency), the same
 * real-client-over-wire-protocol posture as the Cognito API client.
 *
 * Production security posture (documented W3-4 decisions):
 * - the bucket/prefix is PRIVATE by bucket policy — this driver never sets
 *   an ACL and never constructs, returns, or logs a public/presigned URL;
 * - server-side encryption rides the store's production convention: the
 *   `x-amz-server-side-encryption` header (AES256 by default, or a KMS key
 *   when configured);
 * - every request is signed per call and carries the payload SHA-256 —
 *   the object written is exactly the bytes the backend hashed;
 * - like the Cognito client, the wire format is unit-tested against a
 *   deterministic in-process endpoint; the REAL-bucket smoke is a recorded
 *   operational dependency (no cloud infrastructure exists in this repo).
 *
 * Credentials live in configuration only — never in PostgreSQL, never in
 * responses, never in thrown errors.
 */
import { createHash, createHmac } from 'node:crypto';

import {
  EvidenceStoreError,
  type StoredObjectFacts,
  type VerificationEvidenceObjectStore,
} from './evidence-store';

export interface S3EvidenceStoreConfig {
  /** e.g. https://s3.me-south-1.amazonaws.com or a MinIO/R2 endpoint. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional extra key prefix inside the bucket (tenancy/env separation). */
  keyPrefix?: string;
  /** Path-style addressing (default true — safest for S3-compatibles). */
  forcePathStyle?: boolean;
  /** Server-side encryption: 'AES256' (default) or a KMS key id. */
  serverSideEncryption?: { kind: 'AES256' } | { kind: 'aws:kms'; kmsKeyId: string };
  /** Injectable transport/clock for deterministic tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding of one key segment (S3 canonical URI rules). */
function encodeKeySegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function createS3EvidenceStore(
  config: S3EvidenceStoreConfig,
): VerificationEvidenceObjectStore {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') {
    throw new EvidenceStoreError('S3 evidence store endpoint must be https');
  }
  const pathStyle = config.forcePathStyle ?? true;
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => new Date());

  const objectUrl = (key: string): { url: URL; host: string; canonicalUri: string } => {
    const fullKey = `${config.keyPrefix !== undefined ? `${config.keyPrefix}/` : ''}${key}`;
    const encodedKey = fullKey.split('/').map(encodeKeySegment).join('/');
    if (pathStyle) {
      const canonicalUri = `/${encodeKeySegment(config.bucket)}/${encodedKey}`;
      const url = new URL(canonicalUri, endpoint);
      return { url, host: endpoint.host, canonicalUri };
    }
    const host = `${config.bucket}.${endpoint.host}`;
    const canonicalUri = `/${encodedKey}`;
    const url = new URL(canonicalUri, `${endpoint.protocol}//${host}`);
    return { url, host, canonicalUri };
  };

  /** AWS Signature Version 4 for one request. */
  const signedHeaders = (input: {
    method: 'PUT' | 'GET' | 'HEAD';
    canonicalUri: string;
    host: string;
    payloadSha256: string;
    extraHeaders: Record<string, string>;
  }): Record<string, string> => {
    const at = now();
    const amzDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host: input.host,
      'x-amz-content-sha256': input.payloadSha256,
      'x-amz-date': amzDate,
      ...input.extraHeaders,
    };
    const sortedNames = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = sortedNames
      .map((name) => `${name}:${headers[name]!.trim()}\n`)
      .join('');
    const signedHeaderNames = sortedNames.join(';');
    const canonicalRequest = [
      input.method,
      input.canonicalUri,
      '', // no query strings are ever used (no presigned URLs exist)
      canonicalHeaders,
      signedHeaderNames,
      input.payloadSha256,
    ].join('\n');
    const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    return {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
    };
  };

  const request = async (input: {
    method: 'PUT' | 'GET' | 'HEAD';
    key: string;
    body?: Buffer;
    contentType?: string;
    sse?: boolean;
  }): Promise<Response> => {
    const { url, host, canonicalUri } = objectUrl(input.key);
    const payloadSha256 = sha256Hex(input.body ?? Buffer.alloc(0));
    const extraHeaders: Record<string, string> = {};
    if (input.contentType !== undefined) extraHeaders['content-type'] = input.contentType;
    if (input.sse === true) {
      const sse = config.serverSideEncryption ?? { kind: 'AES256' as const };
      extraHeaders['x-amz-server-side-encryption'] = sse.kind;
      if (sse.kind === 'aws:kms') {
        extraHeaders['x-amz-server-side-encryption-aws-kms-key-id'] = sse.kmsKeyId;
      }
    }
    const headers = signedHeaders({
      method: input.method,
      canonicalUri,
      host,
      payloadSha256,
      extraHeaders,
    });
    try {
      return await fetchImpl(url.toString(), {
        method: input.method,
        headers,
        ...(input.body !== undefined ? { body: new Uint8Array(input.body) } : {}),
      });
    } catch (error) {
      // Never surface endpoint/credential material through the error chain.
      throw new EvidenceStoreError('evidence store request failed', { cause: error });
    }
  };

  return {
    async putObject(input) {
      const response = await request({
        method: 'PUT',
        key: input.key,
        body: input.body,
        contentType: input.contentType,
        sse: true,
      });
      if (!response.ok) {
        throw new EvidenceStoreError(`evidence store PUT refused (${response.status})`);
      }
    },

    async headObject(key): Promise<StoredObjectFacts | null> {
      const response = await request({ method: 'HEAD', key });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new EvidenceStoreError(`evidence store HEAD refused (${response.status})`);
      }
      const length = Number(response.headers.get('content-length') ?? Number.NaN);
      if (!Number.isFinite(length) || length < 0) {
        throw new EvidenceStoreError('evidence store HEAD returned no usable length');
      }
      return { byteSize: length };
    },

    async getObject(key) {
      const response = await request({ method: 'GET', key });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new EvidenceStoreError(`evidence store GET refused (${response.status})`);
      }
      const body = Buffer.from(await response.arrayBuffer());
      return {
        body,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      };
    },
  };
}
