import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import { createLiveVerificationPort } from '../src/services/live/live-verification-port';
import type { FetchLike } from '../src/api/client';

/**
 * The LIVE verification port over a stubbed transport: parameter
 * pass-through, view validation (fail closed), the DISTINCT typed refusal
 * mapping (safety / policy / structured not-ready / conflicts / stale /
 * step-up), and the binary download mapping. The REAL backend behavior is
 * proven by backend/test/verification-review.test.ts on real PostgreSQL
 * and the admin contract journey.
 */

const VIEW = {
  organizationId: '018f0000-0000-7000-8000-00000000d001',
  organizationState: 'in_review',
  organizationVersion: 3,
  contentSafetyReady: false,
  policyConfigured: true,
  rounds: [
    { caseId: '018f0000-0000-7000-8000-00000000c101', round: 1, state: 'in_review', decidedAt: null, outcome: null },
  ],
  latestCase: {
    caseId: '018f0000-0000-7000-8000-00000000c101',
    organizationId: '018f0000-0000-7000-8000-00000000d001',
    round: 1,
    state: 'in_review',
    policyVersion: 'policy-v1',
    readiness: { kind: 'missingRequirements', missing: [{ requirementKey: 'business_document', labelEn: 'Business document' }] },
    requirements: [
      {
        requirementId: '018f0000-0000-7000-8000-00000000e101',
        requirementKey: 'business_document',
        labelEn: 'Business document',
        descriptionEn: null,
        required: true,
        currentEvidence: null,
      },
    ],
    decision: null,
    createdAt: '2026-08-18T08:00:00.000Z',
    updatedAt: '2026-08-19T08:00:00.000Z',
    version: 2,
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function signedInPort(handler: (url: string, init: RequestInit) => Response) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/auth/csrf')) return jsonResponse(200, { csrfToken: 'CSRF' });
    if (url.endsWith('/auth/refresh')) {
      return jsonResponse(200, {
        status: 'authenticated',
        accessToken: 'AT',
        assurance: 'mfa',
        csrfToken: 'CSRF',
      });
    }
    requests.push({ url, init });
    return handler(url, init);
  };
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: 'https://api.himma.test',
    cognitoIssuer: 'https://cognito.test/pool',
    cognitoClientId: 'client-1',
    fetchImpl,
  });
  expect((await runtime.adapter.bootstrap()).kind).toBe('session');
  return { port: createLiveVerificationPort(runtime.transport), requests };
}

describe('live verification port', () => {
  test('loads and validates the full workspace view; a malformed view fails closed', async () => {
    const ok = await signedInPort(() => jsonResponse(200, VIEW));
    await expect(ok.port.getVerification(VIEW.organizationId)).resolves.toEqual({
      kind: 'loaded',
      view: VIEW,
    });
    expect(ok.requests[0]!.url).toContain(`/admin/organizations/${VIEW.organizationId}/verification`);

    const malformed = await signedInPort(() =>
      jsonResponse(200, { ...VIEW, rounds: [{ caseId: 42 }] }),
    );
    await expect(malformed.port.getVerification(VIEW.organizationId)).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  test('decide passes the three layers through and maps every DISTINCT refusal to its own outcome', async () => {
    const decided = await signedInPort(() => jsonResponse(200, { status: 'verificationDecided' }));
    const outcome = await decided.port.decide(VIEW.organizationId, {
      caseId: VIEW.latestCase.caseId,
      expectedCaseVersion: 2,
      outcome: 'rejected',
      reasonCode: 'expired_document',
      providerSafeMessage: 'Renew the licence.',
      internalNote: 'Internal only.',
    });
    expect(outcome).toEqual({ kind: 'completed' });
    const sent = JSON.parse(String(decided.requests[0]!.init.body)) as Record<string, unknown>;
    expect(sent).toEqual({
      expectedCaseVersion: 2,
      outcome: 'rejected',
      reasonCode: 'expired_document',
      providerSafeMessage: 'Renew the licence.',
      internalNote: 'Internal only.',
    });

    const cases: Array<[number, string, string]> = [
      [503, 'verificationEvidenceSafetyUnavailable', 'safetyUnavailable'],
      [503, 'verificationPolicyUnavailable', 'policyUnavailable'],
      [409, 'verificationCaseConflict', 'caseConflict'],
      [409, 'lifecycleConflict', 'lifecycleConflict'],
      [409, 'staleVersion', 'staleVersion'],
      [422, 'invalidVerificationDecision', 'invalidDecision'],
      [403, 'stepUpRequired', 'stepUpRequired'],
      [403, 'forbidden', 'forbidden'],
      [404, 'notFound', 'notFound'],
    ];
    for (const [status, code, kind] of cases) {
      const { port } = await signedInPort(() => jsonResponse(status, { code, message: 'x' }));
      await expect(
        port.decide(VIEW.organizationId, {
          caseId: VIEW.latestCase.caseId,
          expectedCaseVersion: 2,
          outcome: 'approved',
        }),
      ).resolves.toEqual({ kind });
    }
  });

  test('the structured not-ready refusal carries the missing requirements', async () => {
    const { port } = await signedInPort(() =>
      jsonResponse(409, {
        code: 'verificationCaseNotReady',
        message: 'not ready',
        missing: [{ requirementKey: 'operating_license', labelEn: 'Operating licence' }],
      }),
    );
    await expect(
      port.decide(VIEW.organizationId, {
        caseId: VIEW.latestCase.caseId,
        expectedCaseVersion: 2,
        outcome: 'approved',
      }),
    ).resolves.toEqual({
      kind: 'notReady',
      missing: [{ requirementKey: 'operating_license', labelEn: 'Operating licence' }],
    });
  });

  test('evidence download maps the binary leg, the safety refusal, and never fabricates a document', async () => {
    const document = await signedInPort(
      () =>
        // A string body: the undici Response polyfill in this test env
        // rejects jsdom Blobs; the port consumes response.blob() the same.
        new Response('bytes', {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="doc.pdf"',
          },
        }),
    );
    const downloaded = await document.port.downloadEvidence('018f0000-0000-7000-8000-00000000f001');
    expect(downloaded.kind).toBe('document');
    if (downloaded.kind === 'document') {
      expect(downloaded.filename).toBe('doc.pdf');
      expect(downloaded.contentType).toBe('application/pdf');
    }

    const gated = await signedInPort(() =>
      jsonResponse(503, { code: 'verificationEvidenceSafetyUnavailable', message: 'x' }),
    );
    await expect(
      gated.port.downloadEvidence('018f0000-0000-7000-8000-00000000f001'),
    ).resolves.toEqual({ kind: 'safetyUnavailable' });
  });
});
