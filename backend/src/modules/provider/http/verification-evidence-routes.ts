/**
 * Verification-evidence storage routes (W3-4; D-W3-1) — the server-proxied
 * private upload/download surface. NO presigned or public URL exists
 * anywhere: every byte flows through these authorized routes, and every
 * response identifies documents by evidence id only (the opaque
 * storage_ref never leaves the backend).
 *
 * Provider surface (policy `provider`, capability
 * `verification.evidence.manage` — owner-only): scoped by the pipeline to
 * the ONE addressed organization; the services additionally pin every
 * case/evidence row to that organization (cross-org = not-found shape).
 * Admin surface (policy `admin` baseline, `operations` role fresh per
 * transaction — the W3-2 read pattern): document retrieval for review.
 * NO route calls finalizeEvidenceStorage with client data — the trusted
 * facts are computed server-side in evidence-storage.ts.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import {
  downloadEvidenceBinary,
  providerRegisterEvidence,
  uploadEvidenceBinary,
  type EvidenceStorageDeps,
} from '../services/evidence-storage';
import { requireOrgScope, requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';

const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const EVIDENCE_ERRORS = {
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  413: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  500: ErrorBody,
  503: ErrorBody,
};

/** Content-Disposition filename sanitation: header-safe ASCII, no quotes,
 *  no control characters — display metadata only (keys are never
 *  filename-derived). */
function sanitizedFilename(original: string): string {
  const cleaned = original
    .replace(/[\r\n"\\]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .trim();
  return cleaned.length === 0 ? 'document' : cleaned.slice(0, 150);
}

/** Streams one authorized private document (the 200 leg is deliberately
 *  outside the JSON response schemas — raw bytes, typed against the base
 *  reply). Headers only ever carry the sanitized display filename and the
 *  declared content type — never storage refs, digests, or URLs. */
function sendDocument(
  reply: FastifyReply,
  document: { body: Buffer; contentType: string; originalFilename: string; byteSize: number },
): FastifyReply {
  void reply.header('content-type', document.contentType);
  void reply.header('content-length', String(document.byteSize));
  void reply.header(
    'content-disposition',
    `attachment; filename="${sanitizedFilename(document.originalFilename)}"`,
  );
  return reply.status(200).send(document.body);
}

/** Registers buffer parsers for exactly the allowed upload types. */
export function installEvidenceContentParsers(
  app: FastifyInstance,
  allowedContentTypes: readonly string[],
): void {
  for (const contentType of allowedContentTypes) {
    app.addContentTypeParser(
      contentType,
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
  }
}

function uploadOutcomeName(
  kind: 'forbidden' | 'evidenceNotFound' | 'evidenceStateConflict' | 'invalidEvidenceUpload' | 'storageUnavailable',
): HttpOutcomeName {
  switch (kind) {
    case 'forbidden':
      return 'forbidden';
    case 'evidenceNotFound':
      return 'notFound';
    case 'evidenceStateConflict':
      return 'evidenceStateConflict';
    case 'invalidEvidenceUpload':
      return 'invalidEvidenceMetadata';
    case 'storageUnavailable':
      return 'storageUnavailable';
  }
}

export function registerProviderEvidenceRoutes(
  instance: FastifyInstance,
  deps: EvidenceStorageDeps,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  // Upload initiation: register the metadata INTENT (pending_upload).
  app.post(
    '/provider/organizations/:organizationId/verification/evidence',
    {
      config: { authPolicy: 'provider', providerCapability: 'verification.evidence.manage' },
      bodyLimit: 16_384,
      schema: {
        params: Type.Object({ organizationId: Uuid }),
        body: Type.Object({
          caseId: Uuid,
          requirementId: Uuid,
          originalFilename: Type.String({ minLength: 1, maxLength: 300 }),
          declaredContentType: Type.String({ minLength: 3, maxLength: 200 }),
        }),
        response: {
          200: Type.Object({
            status: Type.Literal('evidenceRegistered'),
            evidenceId: Uuid,
            version: Type.Integer(),
            supersededEvidenceId: Type.Optional(Uuid),
          }),
          ...EVIDENCE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await providerRegisterEvidence(
        deps,
        { organizationId: scope.organizationId, userId: principal.userId },
        request.body,
      );
      switch (result.kind) {
        case 'evidenceRegistered':
          return reply.status(200).send({
            status: 'evidenceRegistered',
            evidenceId: result.evidenceId,
            version: result.version,
            ...(result.supersededEvidenceId !== undefined
              ? { supersededEvidenceId: result.supersededEvidenceId }
              : {}),
          });
        case 'caseNotFound':
        case 'requirementNotFound':
          return sendOutcome(reply, 'notFound');
        case 'caseStateConflict':
          return sendOutcome(reply, 'lifecycleConflict');
        case 'invalidMetadata':
          return sendOutcome(reply, 'invalidEvidenceMetadata');
        case 'forbidden':
          return sendOutcome(reply, 'forbidden');
      }
    },
  );

  // Private binary write → trusted server-side finalization. The raw body
  // must carry the DECLARED content type; trusted size/digest are computed
  // from the received bytes — nothing client-supplied is authoritative.
  app.put(
    '/provider/organizations/:organizationId/verification/evidence/:evidenceId/content',
    {
      config: { authPolicy: 'provider', providerCapability: 'verification.evidence.manage' },
      bodyLimit: deps.upload.maxBytes,
      schema: {
        params: Type.Object({ organizationId: Uuid, evidenceId: Uuid }),
        response: {
          200: Type.Object({
            status: Type.Literal('evidenceStored'),
            version: Type.Integer(),
          }),
          ...EVIDENCE_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        return sendOutcome(reply, 'invalidEvidenceMetadata');
      }
      const result = await uploadEvidenceBinary(
        deps,
        { kind: 'provider', organizationId: scope.organizationId, userId: principal.userId },
        {
          evidenceId: request.params.evidenceId,
          body,
          requestContentType: request.headers['content-type'],
        },
      );
      if (result.kind === 'evidenceStored') {
        return reply.status(200).send({ status: 'evidenceStored', version: result.version });
      }
      return sendOutcome(reply, uploadOutcomeName(result.kind));
    },
  );

  // Authorized retrieval of the organization's OWN current stored document.
  app.get(
    '/provider/organizations/:organizationId/verification/evidence/:evidenceId/content',
    {
      config: { authPolicy: 'provider', providerCapability: 'verification.evidence.manage' },
      schema: {
        params: Type.Object({ organizationId: Uuid, evidenceId: Uuid }),
        // 200 is the raw private document stream — deliberately unschema'd.
        response: { ...EVIDENCE_ERRORS },
      },
    },
    async (request, reply) => {
      const scope = requireOrgScope(request.principal);
      const principal = requirePrincipal(request.principal);
      const result = await downloadEvidenceBinary(
        deps,
        { kind: 'provider', organizationId: scope.organizationId, userId: principal.userId },
        { evidenceId: request.params.evidenceId },
      );
      if (result.kind !== 'evidenceContent') {
        return sendOutcome(
          reply,
          result.kind === 'storageUnavailable'
            ? 'storageUnavailable'
            : result.kind === 'forbidden'
              ? 'forbidden'
              : 'notFound',
        );
      }
      return sendDocument(reply, result);
    },
  );
}

export function registerAdminEvidenceRoutes(
  instance: FastifyInstance,
  deps: EvidenceStorageDeps,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  // Internal operations retrieval (review), incl. superseded history.
  // Ordinary internal READ — the W3-1 baseline; D-W3-5 step-up stays open.
  app.get(
    '/admin/verification/evidence/:evidenceId/content',
    {
      config: { authPolicy: 'admin' },
      schema: {
        params: Type.Object({ evidenceId: Uuid }),
        response: { ...EVIDENCE_ERRORS },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await downloadEvidenceBinary(
        deps,
        { kind: 'operations', userId: principal.userId },
        { evidenceId: request.params.evidenceId },
      );
      if (result.kind !== 'evidenceContent') {
        return sendOutcome(
          reply,
          result.kind === 'storageUnavailable'
            ? 'storageUnavailable'
            : result.kind === 'forbidden'
              ? 'forbidden'
              : 'notFound',
        );
      }
      return sendDocument(reply, result);
    },
  );
}
