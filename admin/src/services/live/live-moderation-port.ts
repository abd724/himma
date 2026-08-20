import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import type {
  AdminModerationPort,
  ModerationActionOutcome,
  ModerationListingView,
  ModerationQueueRow,
  RevisionChangeSet,
  RevisionQueueRow,
} from '../../moderation/contract';

/**
 * LIVE catalogue/revision moderation port (W3-6) over the CERTIFIED S4-2
 * admin moderation routes. GET/POST pass-through with fail-closed
 * validation of exactly the fields the workspace consumes; every typed
 * backend refusal maps to its own outcome. No moderation semantics live
 * here — the backend services stay the single authority.
 */

function stringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}
function numberOrNull(value: unknown): value is number | null {
  return typeof value === 'number' || value === null;
}

function queueRowFrom(raw: unknown): ModerationQueueRow | null {
  const row = raw as Record<string, unknown>;
  if (
    typeof row?.id !== 'string' ||
    typeof row.organizationId !== 'string' ||
    typeof row.organizationDisplayName !== 'string' ||
    typeof row.titleEn !== 'string' ||
    typeof row.listingState !== 'string' ||
    typeof row.version !== 'number' ||
    typeof row.createdAt !== 'string' ||
    typeof row.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationDisplayName: row.organizationDisplayName,
    titleEn: row.titleEn,
    listingState: row.listingState,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function revisionRowFrom(raw: unknown): RevisionQueueRow | null {
  const row = raw as Record<string, unknown>;
  if (
    typeof row?.id !== 'string' ||
    typeof row.programId !== 'string' ||
    typeof row.organizationId !== 'string' ||
    typeof row.programTitleEn !== 'string' ||
    typeof row.state !== 'string' ||
    typeof row.version !== 'number' ||
    typeof row.createdAt !== 'string'
  ) {
    return null;
  }
  return {
    id: row.id,
    programId: row.programId,
    organizationId: row.organizationId,
    programTitleEn: row.programTitleEn,
    state: row.state,
    version: row.version,
    createdAt: row.createdAt,
  };
}

function changeSetFrom(raw: unknown): RevisionChangeSet | null {
  const row = raw as Record<string, unknown>;
  if (
    typeof row?.id !== 'string' ||
    typeof row.programId !== 'string' ||
    typeof row.state !== 'string' ||
    typeof row.createdAt !== 'string' ||
    typeof row.version !== 'number' ||
    !numberOrNull(row.minAge) ||
    !numberOrNull(row.maxAge) ||
    !(typeof row.allAges === 'boolean' || row.allAges === null) ||
    !stringOrNull(row.genderEligibility) ||
    !stringOrNull(row.skillLevel) ||
    !stringOrNull(row.eligibilityNotes) ||
    !stringOrNull(row.descriptionEn) ||
    !stringOrNull(row.descriptionAr)
  ) {
    return null;
  }
  let option: RevisionChangeSet['option'] = null;
  if (row.option !== null && row.option !== undefined) {
    const raw = row.option as Record<string, unknown>;
    if (
      !stringOrNull(raw.optionId ?? null) ||
      !stringOrNull(raw.kind ?? null) ||
      !numberOrNull(raw.amountFils ?? null) ||
      !numberOrNull(raw.sessionsCount ?? null) ||
      !stringOrNull(raw.labelEn ?? null) ||
      !stringOrNull(raw.labelAr ?? null) ||
      !numberOrNull(raw.sortHint ?? null) ||
      !stringOrNull(raw.state ?? null)
    ) {
      return null;
    }
    option = {
      optionId: (raw.optionId ?? null) as string | null,
      kind: (raw.kind ?? null) as string | null,
      amountFils: (raw.amountFils ?? null) as number | null,
      sessionsCount: (raw.sessionsCount ?? null) as number | null,
      labelEn: (raw.labelEn ?? null) as string | null,
      labelAr: (raw.labelAr ?? null) as string | null,
      sortHint: (raw.sortHint ?? null) as number | null,
      state: (raw.state ?? null) as string | null,
    };
  }
  return {
    id: row.id,
    programId: row.programId,
    state: row.state,
    createdAt: row.createdAt,
    version: row.version,
    minAge: row.minAge,
    maxAge: row.maxAge,
    allAges: row.allAges,
    genderEligibility: row.genderEligibility,
    skillLevel: row.skillLevel,
    eligibilityNotes: row.eligibilityNotes,
    descriptionEn: row.descriptionEn,
    descriptionAr: row.descriptionAr,
    option,
  };
}

function viewFrom(body: unknown): ModerationListingView | null {
  const raw = body as Record<string, unknown>;
  const program = raw?.program as Record<string, unknown> | undefined;
  const organization = raw?.organization as Record<string, unknown> | undefined;
  if (
    typeof program !== 'object' ||
    program === null ||
    typeof program.id !== 'string' ||
    typeof program.titleEn !== 'string' ||
    typeof program.listingState !== 'string' ||
    typeof program.version !== 'number' ||
    !stringOrNull(program.descriptionEn) ||
    typeof program.setting !== 'string' ||
    typeof program.genderEligibility !== 'string' ||
    !numberOrNull(program.minAge) ||
    !numberOrNull(program.maxAge) ||
    typeof program.allAges !== 'boolean' ||
    !stringOrNull(program.skillLevel) ||
    !stringOrNull(program.eligibilityNotes) ||
    !stringOrNull(program.publishedAt) ||
    typeof program.updatedAt !== 'string' ||
    !Array.isArray(program.priceOptions) ||
    !Array.isArray(program.branches) ||
    typeof organization !== 'object' ||
    organization === null ||
    typeof organization.id !== 'string' ||
    typeof organization.displayName !== 'string' ||
    typeof organization.verificationState !== 'string'
  ) {
    return null;
  }
  const priceOptions: ModerationListingView['program']['priceOptions'][number][] = [];
  for (const entry of program.priceOptions) {
    const option = entry as Record<string, unknown>;
    if (
      typeof option.kind !== 'string' ||
      !numberOrNull(option.amountFils ?? null) ||
      !stringOrNull(option.labelEn ?? null) ||
      typeof option.state !== 'string'
    ) {
      return null;
    }
    priceOptions.push({
      kind: option.kind,
      amountFils: (option.amountFils ?? null) as number | null,
      labelEn: (option.labelEn ?? null) as string | null,
      state: option.state,
    });
  }
  const branches: ModerationListingView['program']['branches'][number][] = [];
  for (const entry of program.branches) {
    const branch = entry as Record<string, unknown>;
    if (typeof branch.label !== 'string' || typeof branch.associationActive !== 'boolean') {
      return null;
    }
    branches.push({ label: branch.label, associationActive: branch.associationActive });
  }
  let revision: RevisionChangeSet | null = null;
  if (raw.revision !== null && raw.revision !== undefined) {
    revision = changeSetFrom(raw.revision);
    if (revision === null) return null;
  }
  return {
    program: {
      id: program.id,
      titleEn: program.titleEn,
      listingState: program.listingState,
      version: program.version,
      descriptionEn: program.descriptionEn,
      setting: program.setting,
      genderEligibility: program.genderEligibility,
      minAge: program.minAge,
      maxAge: program.maxAge,
      allAges: program.allAges,
      skillLevel: program.skillLevel,
      eligibilityNotes: program.eligibilityNotes,
      publishedAt: program.publishedAt,
      updatedAt: program.updatedAt,
      priceOptions,
      branches,
    },
    organization: {
      id: organization.id,
      displayName: organization.displayName,
      verificationState: organization.verificationState,
    },
    revision,
  };
}

function actionOutcomeFrom(response: { status: number; code: string | null }): ModerationActionOutcome {
  if (response.status === 200) return { kind: 'completed' };
  switch (response.code) {
    case 'stepUpRequired':
      return { kind: 'stepUpRequired' };
    case 'lifecycleConflict':
      return { kind: 'lifecycleConflict' };
    case 'staleVersion':
      return { kind: 'staleVersion' };
    case 'invalidEligibility':
    case 'invalidPriceOption':
      return { kind: 'revisionInvalid' };
    case 'forbidden':
      return { kind: 'forbidden' };
    case 'notFound':
      return { kind: 'notFound' };
    default:
      return { kind: 'unavailable' };
  }
}

export function createLiveModerationPort(transport: LiveTransport): AdminModerationPort {
  const act = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<ModerationActionOutcome> => {
    const response = await transport.authorizedRequest(path, { method: 'POST', body });
    if (response === null || response.networkFailure) return { kind: 'unavailable' };
    return actionOutcomeFrom(response);
  };
  const queueQuery = (params: { state?: string; cursor?: string }): string => {
    const query = new URLSearchParams();
    if (params.state !== undefined) query.set('state', params.state);
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    const encoded = query.toString();
    return encoded === '' ? '' : `?${encoded}`;
  };

  return {
    async listListings(params) {
      const response = await transport.authorizedRequest(`/admin/listings${queueQuery(params)}`);
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const body = response.body as { listings?: unknown; nextCursor?: unknown } | null;
        if (
          body === null ||
          !Array.isArray(body.listings) ||
          !(typeof body.nextCursor === 'string' || body.nextCursor === null)
        ) {
          return { kind: 'unavailable' };
        }
        const rows: ModerationQueueRow[] = [];
        for (const entry of body.listings) {
          const row = queueRowFrom(entry);
          if (row === null) return { kind: 'unavailable' };
          rows.push(row);
        }
        return { kind: 'loaded', rows, nextCursor: body.nextCursor };
      }
      return response.code === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
    },

    async listRevisions(params) {
      const response = await transport.authorizedRequest(`/admin/revisions${queueQuery(params)}`);
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const body = response.body as { revisions?: unknown; nextCursor?: unknown } | null;
        if (
          body === null ||
          !Array.isArray(body.revisions) ||
          !(typeof body.nextCursor === 'string' || body.nextCursor === null)
        ) {
          return { kind: 'unavailable' };
        }
        const rows: RevisionQueueRow[] = [];
        for (const entry of body.revisions) {
          const row = revisionRowFrom(entry);
          if (row === null) return { kind: 'unavailable' };
          rows.push(row);
        }
        return { kind: 'loaded', rows, nextCursor: body.nextCursor };
      }
      return response.code === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
    },

    async getListing(programId) {
      const response = await transport.authorizedRequest(
        `/admin/listings/${encodeURIComponent(programId)}`,
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const view = viewFrom(response.body);
        return view === null ? { kind: 'unavailable' } : { kind: 'loaded', view };
      }
      if (response.code === 'forbidden') return { kind: 'forbidden' };
      if (response.status === 404 || response.status === 422) return { kind: 'notFound' };
      return { kind: 'unavailable' };
    },

    reviewListing(programId, action, input) {
      const segment =
        action === 'start_review' ? 'start' : action === 'approve' ? 'approve' : 'request-changes';
      return act(`/admin/listings/${encodeURIComponent(programId)}/review/${segment}`, {
        expectedVersion: input.expectedVersion,
        ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
      });
    },

    startRevisionReview(programId, revisionId, input) {
      return act(
        `/admin/listings/${encodeURIComponent(programId)}/revisions/${encodeURIComponent(revisionId)}/review/start`,
        { expectedVersion: input.expectedVersion },
      );
    },

    decideRevision(programId, revisionId, decision, input) {
      return act(
        `/admin/listings/${encodeURIComponent(programId)}/revisions/${encodeURIComponent(revisionId)}/${decision === 'approve' ? 'approve' : 'reject'}`,
        {
          expectedVersion: input.expectedVersion,
          ...(decision === 'reject' && input.reasonCode !== undefined
            ? { reasonCode: input.reasonCode }
            : {}),
        },
      );
    },
  };
}
