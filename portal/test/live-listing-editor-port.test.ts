import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiJsonResponse } from '../src/api/client';
import type { LiveTransport } from '../src/auth/live/live-auth-runtime';
import { createLiveListingEditorPort } from '../src/services/live/live-listing-editor-port';

/**
 * Live listing editor mutations (W2-12C2) — deterministic mapping coverage
 * over a stubbed transport: wire bodies/paths, CAS pass-through, the
 * backend's automatic protected-edit ProgramRevision routing, outcome
 * translation, fail-closed DTO echoes, read-only-transport structure, and
 * fixture isolation. The REAL backend behavior behind the same port is
 * proven by the contract suite
 * (test-contract/catalogue-mutation-contract.test.ts on real PostgreSQL).
 */

interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
}

function makeTransport(
  respond: (
    call: RecordedCall,
  ) => { status: number; body?: unknown; code?: string } | 'network' | 'noSession',
) {
  const calls: RecordedCall[] = [];
  const transport: LiveTransport = {
    async authorizedRequest(path, options = {}) {
      const call: RecordedCall = { path, method: options.method ?? 'GET', body: options.body };
      calls.push(call);
      const result = respond(call);
      if (result === 'noSession') return null;
      if (result === 'network') {
        return { status: 0, code: null, body: null, networkFailure: true };
      }
      const response: ApiJsonResponse = {
        status: result.status,
        code: result.code ?? null,
        body:
          result.body ??
          (result.code !== undefined ? { code: result.code, message: 'refused' } : null),
        networkFailure: false,
      };
      return response;
    },
    async publicRequest() {
      throw new Error('editor mutations never use the public channel');
    },
    notifyAccessChanged() {
      throw new Error('catalogue mutations must never claim an access change');
    },
  };
  return { transport, calls };
}

const ORG = '018f0000-0000-7000-8000-00000000d001';
const PROGRAM = '018f0000-0000-7000-8000-00000000d101';
const OPTION = '018f0000-0000-7000-8000-00000000d201';
const BRANCH = '018f0000-0000-7000-8000-00000000d301';
const MEDIA = '018f0000-0000-7000-8000-00000000d401';
const OFFER = '018f0000-0000-7000-8000-00000000d501';
const REVISION = '018f0000-0000-7000-8000-00000000d601';

const OPTION_VIEW = {
  id: OPTION,
  kind: 'monthly',
  amountFils: 25_000,
  currency: 'AED',
  sessionsCount: 12,
  labelEn: 'Monthly',
  labelAr: null,
  sortHint: 1,
  state: 'active',
  version: 1,
};

const MEDIA_VIEW = {
  id: MEDIA,
  mediaRef: '018f0000-0000-7000-8000-00000000d701',
  sortHint: 1,
  altTextEn: 'Front',
  altTextAr: null,
  active: true,
  version: 2,
};

const OFFER_VIEW = {
  id: OFFER,
  kind: 'freeTrial',
  labelEn: 'Free trial session',
  labelAr: null,
  trialAmountFils: null,
  effectiveStart: '2026-09-01T08:00:00.000Z',
  effectiveEnd: null,
  state: 'active',
  version: 1,
};

const CREATE_INPUT = {
  titleEn: 'Adult Beginner Swimming',
  activityTypeId: '018f0000-0000-7000-8000-00000000d801',
  setting: 'indoor',
  genderEligibility: 'mixed',
} as const;

describe('program creation', () => {
  test('POSTs the exact create body and returns the CANONICAL backend id/version (never invented)', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: {
        status: 'programCreated',
        program: { id: PROGRAM, listingState: 'draft', version: 1 },
      },
    }));
    const port = createLiveListingEditorPort(transport);
    const outcome = await port.createProgram(ORG, CREATE_INPUT);
    expect(calls[0]).toEqual({
      path: `/provider/organizations/${ORG}/listings`,
      method: 'POST',
      body: CREATE_INPUT,
    });
    expect(outcome).toEqual({
      kind: 'programCreated',
      program: { id: PROGRAM, listingState: 'draft', version: 1 },
    });
  });

  test('a malformed creation echo fails closed instead of inventing a program', async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { status: 'programCreated', program: { id: PROGRAM } },
    }));
    const port = createLiveListingEditorPort(transport);
    await expect(port.createProgram(ORG, CREATE_INPUT)).resolves.toEqual({ kind: 'unavailable' });
  });

  test.each([
    ['invalidTaxonomy', { status: 422, code: 'invalidTaxonomy' }, 'invalidTaxonomy'],
    ['invalidEligibility', { status: 422, code: 'invalidEligibility' }, 'invalidEligibility'],
    ['forbidden role', { status: 403, code: 'forbidden' }, 'forbidden'],
    ['foreign org', { status: 404, code: 'notFound' }, 'notFound'],
    ['suspended org', { status: 403, code: 'organizationSuspended' }, 'organizationSuspended'],
    ['backend failure', { status: 500, code: 'internalError' }, 'unavailable'],
    ['network failure', 'network' as const, 'unavailable'],
    ['no session', 'noSession' as const, 'unavailable'],
  ])('create outcome: %s → %s', async (_label, wire, kind) => {
    const { transport } = makeTransport(() => wire);
    const port = createLiveListingEditorPort(transport);
    await expect(port.createProgram(ORG, CREATE_INPUT)).resolves.toEqual({ kind });
  });
});

describe('program edit (CAS + automatic protected-edit revision routing)', () => {
  test('PATCHes expectedVersion + dirty fields and maps a direct update', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { status: 'programUpdated', version: 5 },
    }));
    const port = createLiveListingEditorPort(transport);
    const outcome = await port.updateProgram(ORG, PROGRAM, 4, { titleEn: 'New Title' });
    expect(calls[0]).toEqual({
      path: `/provider/organizations/${ORG}/listings/${PROGRAM}`,
      method: 'PATCH',
      body: { expectedVersion: 4, titleEn: 'New Title' },
    });
    expect(outcome).toEqual({ kind: 'programUpdated', version: 5 });
  });

  test('a protected change on a review-gated listing maps the backend revisionSubmitted routing verbatim', async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: {
        status: 'revisionSubmitted',
        revisionId: REVISION,
        appliedFields: ['titleEn'],
        deferredFields: ['descriptionEn'],
      },
    }));
    const port = createLiveListingEditorPort(transport);
    await expect(
      port.updateProgram(ORG, PROGRAM, 4, { titleEn: 'T', descriptionEn: 'D' }),
    ).resolves.toEqual({
      kind: 'revisionSubmitted',
      revisionId: REVISION,
      appliedFields: ['titleEn'],
      deferredFields: ['descriptionEn'],
    });
  });

  test.each([
    ['an open revision blocks a competing protected edit', { status: 409, code: 'revisionPending' }, 'revisionPending'],
    ['a locked lifecycle state refuses edits', { status: 409, code: 'lifecycleConflict' }, 'lifecycleConflict'],
    ['a stale expectedVersion never overwrites', { status: 409, code: 'staleVersion' }, 'staleVersion'],
    ['an inactive activity type cannot be newly selected', { status: 422, code: 'invalidTaxonomy' }, 'invalidTaxonomy'],
    ['inconsistent eligibility is refused', { status: 422, code: 'invalidEligibility' }, 'invalidEligibility'],
    ['a foreign program is not-found-shaped', { status: 404, code: 'notFound' }, 'notFound'],
  ])('edit outcome: %s → %s', async (_label, wire, kind) => {
    const { transport } = makeTransport(() => wire);
    const port = createLiveListingEditorPort(transport);
    await expect(port.updateProgram(ORG, PROGRAM, 4, { titleEn: 'X' })).resolves.toEqual({
      kind,
    });
  });

  test('a stale response is terminal — the port never silently retries with a newer version', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 409, code: 'staleVersion' }));
    const port = createLiveListingEditorPort(transport);
    await port.updateProgram(ORG, PROGRAM, 4, { titleEn: 'X' });
    expect(calls).toHaveLength(1);
  });
});

describe('price options (integer fils, stable ids, revision-aware)', () => {
  test('add POSTs the exact body and validates the echoed option', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { status: 'optionAdded', option: OPTION_VIEW },
    }));
    const port = createLiveListingEditorPort(transport);
    const outcome = await port.addPriceOption(ORG, PROGRAM, {
      kind: 'monthly',
      amountFils: 25_000,
      labelEn: 'Monthly',
    });
    expect(calls[0]).toEqual({
      path: `/provider/organizations/${ORG}/listings/${PROGRAM}/price-options`,
      method: 'POST',
      body: { kind: 'monthly', amountFils: 25_000, labelEn: 'Monthly' },
    });
    expect(outcome).toEqual({ kind: 'optionAdded', option: OPTION_VIEW });
  });

  test('a price change on a review-gated listing rides the revision model (revisionSubmitted / revisionPending)', async () => {
    const submitted = makeTransport(() => ({
      status: 200,
      body: { status: 'revisionSubmitted', revisionId: REVISION },
    }));
    await expect(
      createLiveListingEditorPort(submitted.transport).updatePriceOption(
        ORG,
        PROGRAM,
        OPTION,
        1,
        { amountFils: 30_000 },
      ),
    ).resolves.toEqual({ kind: 'revisionSubmitted', revisionId: REVISION });

    const pending = makeTransport(() => ({ status: 409, code: 'revisionPending' }));
    await expect(
      createLiveListingEditorPort(pending.transport).archivePriceOption(ORG, PROGRAM, OPTION, 1),
    ).resolves.toEqual({ kind: 'revisionPending' });
  });

  test('update/archive carry expectedVersion and map stale/lifecycle refusals 1:1', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 409, code: 'staleVersion' }));
    const port = createLiveListingEditorPort(transport);
    await expect(
      port.updatePriceOption(ORG, PROGRAM, OPTION, 3, { amountFils: 9_900 }),
    ).resolves.toEqual({ kind: 'staleVersion' });
    expect(calls[0]!.body).toEqual({ expectedVersion: 3, amountFils: 9_900 });

    const archived = makeTransport(() => ({ status: 409, code: 'lifecycleConflict' }));
    await expect(
      createLiveListingEditorPort(archived.transport).updatePriceOption(ORG, PROGRAM, OPTION, 3, {
        amountFils: 100,
      }),
    ).resolves.toEqual({ kind: 'lifecycleConflict' });
  });

  test('a malformed option echo fails closed', async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { status: 'optionAdded', option: { id: OPTION } },
    }));
    await expect(
      createLiveListingEditorPort(transport).addPriceOption(ORG, PROGRAM, { kind: 'free' }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('branch associations', () => {
  test('associate/remove hit the real routes; an out-of-scope branch id maps invalidBranch', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { status: 'branchAssociated' },
    }));
    const port = createLiveListingEditorPort(transport);
    await expect(port.addBranchAssociation(ORG, PROGRAM, BRANCH)).resolves.toEqual({
      kind: 'branchAssociated',
    });
    expect(calls[0]).toEqual({
      path: `/provider/organizations/${ORG}/listings/${PROGRAM}/branches`,
      method: 'POST',
      body: { branchId: BRANCH },
    });

    const refused = makeTransport(() => ({ status: 422, code: 'invalidBranchScope' }));
    await expect(
      createLiveListingEditorPort(refused.transport).addBranchAssociation(ORG, PROGRAM, BRANCH),
    ).resolves.toEqual({ kind: 'invalidBranch' });

    const removal = makeTransport(() => ({
      status: 200,
      body: { status: 'branchAssociationRemoved' },
    }));
    await expect(
      createLiveListingEditorPort(removal.transport).removeBranchAssociation(ORG, PROGRAM, BRANCH),
    ).resolves.toEqual({ kind: 'branchAssociationRemoved' });
    expect(removal.calls[0]!.path).toBe(
      `/provider/organizations/${ORG}/listings/${PROGRAM}/branches/${BRANCH}/remove`,
    );
  });
});

describe('media metadata (no binary/upload behavior exists)', () => {
  test('update/archive carry expectedVersion against the real metadata routes; echoes validate', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { status: 'mediaUpdated', media: MEDIA_VIEW },
    }));
    const port = createLiveListingEditorPort(transport);
    await expect(
      port.updateMedia(ORG, PROGRAM, MEDIA, 1, { altTextEn: 'Front' }),
    ).resolves.toEqual({ kind: 'mediaUpdated', media: MEDIA_VIEW });
    expect(calls[0]).toEqual({
      path: `/provider/organizations/${ORG}/listings/${PROGRAM}/media/${MEDIA}`,
      method: 'PATCH',
      body: { expectedVersion: 1, altTextEn: 'Front' },
    });

    const archive = makeTransport(() => ({ status: 200, body: { status: 'mediaArchived' } }));
    await expect(
      createLiveListingEditorPort(archive.transport).archiveMedia(ORG, PROGRAM, MEDIA, 2),
    ).resolves.toEqual({ kind: 'mediaArchived' });
    expect(archive.calls[0]!.body).toEqual({ expectedVersion: 2 });
  });
});

describe('offers (windows pass through as the exact wire ISO strings)', () => {
  test('add sends the untouched ISO date-time strings — no timezone policy is invented', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { status: 'offerAdded', offer: OFFER_VIEW },
    }));
    const port = createLiveListingEditorPort(transport);
    const input = {
      kind: 'freeTrial',
      labelEn: 'Free trial session',
      effectiveStart: '2026-09-01T08:00:00.000Z',
      effectiveEnd: null,
    };
    await expect(port.addOffer(ORG, PROGRAM, input)).resolves.toEqual({
      kind: 'offerAdded',
      offer: OFFER_VIEW,
    });
    expect(calls[0]!.body).toEqual(input);
  });

  test.each([
    ['invalid window/value', { status: 422, code: 'invalidOffer' }, 'invalidOffer'],
    ['stale version on update', { status: 409, code: 'staleVersion' }, 'staleVersion'],
  ])('offer update outcome: %s → %s', async (_label, wire, kind) => {
    const { transport } = makeTransport(() => wire);
    await expect(
      createLiveListingEditorPort(transport).updateOffer(ORG, PROGRAM, OFFER, 1, {
        labelEn: 'X',
      }),
    ).resolves.toEqual({ kind });
  });

  test('end hits the real named route with expectedVersion', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { status: 'offerEnded' },
    }));
    await expect(
      createLiveListingEditorPort(transport).endOffer(ORG, PROGRAM, OFFER, 3),
    ).resolves.toEqual({ kind: 'offerEnded' });
    expect(calls[0]).toEqual({
      path: `/provider/organizations/${ORG}/listings/${PROGRAM}/offers/${OFFER}/end`,
      method: 'POST',
      body: { expectedVersion: 3 },
    });
  });
});

describe('structural guarantees', () => {
  test('every operation is an authenticated POST/PATCH — never GET, never the public channel, never an access-change claim', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 500, code: 'internalError' }));
    const port = createLiveListingEditorPort(transport);
    await port.createProgram(ORG, CREATE_INPUT);
    await port.updateProgram(ORG, PROGRAM, 1, {});
    await port.addPriceOption(ORG, PROGRAM, { kind: 'free' });
    await port.updatePriceOption(ORG, PROGRAM, OPTION, 1, {});
    await port.archivePriceOption(ORG, PROGRAM, OPTION, 1);
    await port.addBranchAssociation(ORG, PROGRAM, BRANCH);
    await port.removeBranchAssociation(ORG, PROGRAM, BRANCH);
    await port.addMedia(ORG, PROGRAM, { mediaRef: MEDIA });
    await port.updateMedia(ORG, PROGRAM, MEDIA, 1, {});
    await port.archiveMedia(ORG, PROGRAM, MEDIA, 1);
    await port.addOffer(ORG, PROGRAM, { kind: 'promo', labelEn: 'P' });
    await port.updateOffer(ORG, PROGRAM, OFFER, 1, {});
    await port.endOffer(ORG, PROGRAM, OFFER, 1);
    expect(calls).toHaveLength(13);
    for (const call of calls) {
      expect(['POST', 'PATCH']).toContain(call.method);
    }
  });

  test('the live editor module is structurally isolated from fixture code', () => {
    const source = readFileSync(
      join(__dirname, '../src/services/live/live-listing-editor-port.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/services\/mock|fixture/i);
  });
});
