import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import {
  LISTING_STATES,
  ORGANIZATION_STATES,
  REVIEW_STATES,
  type AdminProvidersReadPort,
  type ListingState,
  type OrganizationDetail,
  type OrganizationDetailOutcome,
  type OrganizationsListOutcome,
  type OrganizationState,
  type OrganizationSummary,
  type ReviewState,
} from '../../providers/contract';

/**
 * LIVE internal provider reads over the REAL `GET /admin/organizations`
 * routes (W3-2). GET-only by construction; every response is validated
 * field-for-field and a contract violation fails the WHOLE read closed
 * (`unavailable`) rather than constructing partial operational truth.
 * Search/filter/pagination parameters pass through to the backend — the
 * server filters the complete authorized set before pagination; nothing is
 * ever filtered client-side.
 */

function isState(value: unknown): value is OrganizationState {
  return (ORGANIZATION_STATES as readonly string[]).includes(value as string);
}

function isReviewState(value: unknown): value is ReviewState {
  return (REVIEW_STATES as readonly string[]).includes(value as string);
}

function stringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function summaryFrom(row: unknown): OrganizationSummary | null {
  if (typeof row !== 'object' || row === null) return null;
  const raw = row as Record<string, unknown>;
  const storefront = raw.storefront as Record<string, unknown> | undefined;
  if (
    typeof raw.organizationId !== 'string' ||
    typeof raw.displayName !== 'string' ||
    typeof raw.tradeName !== 'string' ||
    !isState(raw.verificationState) ||
    !isReviewState(raw.reviewState) ||
    typeof storefront !== 'object' ||
    storefront === null ||
    typeof storefront.published !== 'boolean' ||
    typeof storefront.publiclyVisible !== 'boolean' ||
    typeof raw.activeBranchCount !== 'number' ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    organizationId: raw.organizationId,
    displayName: raw.displayName,
    tradeName: raw.tradeName,
    verificationState: raw.verificationState,
    reviewState: raw.reviewState,
    storefront: {
      published: storefront.published,
      publiclyVisible: storefront.publiclyVisible,
    },
    activeBranchCount: raw.activeBranchCount,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function detailFrom(body: unknown): OrganizationDetail | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const organization = raw.organization as Record<string, unknown> | undefined;
  const profile = raw.profile as Record<string, unknown> | undefined;
  const catalogue = raw.catalogue as Record<string, unknown> | undefined;
  if (
    typeof organization !== 'object' ||
    organization === null ||
    typeof organization.id !== 'string' ||
    typeof organization.legalName !== 'string' ||
    typeof organization.tradeName !== 'string' ||
    typeof organization.orgKind !== 'string' ||
    !isState(organization.verificationState) ||
    !isReviewState(organization.reviewState) ||
    !stringOrNull(organization.suspendedAt) ||
    !stringOrNull(organization.offboardedAt) ||
    typeof organization.createdAt !== 'string' ||
    typeof organization.updatedAt !== 'string' ||
    typeof organization.version !== 'number' ||
    typeof profile !== 'object' ||
    profile === null ||
    typeof profile.displayName !== 'string' ||
    !stringOrNull(profile.descriptionEn) ||
    !stringOrNull(profile.descriptionAr) ||
    !stringOrNull(profile.publicPhone) ||
    !stringOrNull(profile.publicEmail) ||
    !stringOrNull(profile.publicWebsite) ||
    !stringOrNull(profile.publicInstagram) ||
    typeof profile.published !== 'boolean' ||
    typeof profile.publiclyVisible !== 'boolean' ||
    !Array.isArray(raw.branches) ||
    !Array.isArray(raw.team) ||
    typeof catalogue !== 'object' ||
    catalogue === null ||
    typeof catalogue.total !== 'number' ||
    typeof catalogue.byState !== 'object' ||
    catalogue.byState === null
  ) {
    return null;
  }
  const branches: OrganizationDetail['branches'][number][] = [];
  for (const entry of raw.branches) {
    const branch = entry as Record<string, unknown>;
    if (
      typeof branch.id !== 'string' ||
      typeof branch.label !== 'string' ||
      !stringOrNull(branch.addressLine) ||
      !stringOrNull(branch.city) ||
      typeof branch.areaLabel !== 'string' ||
      typeof branch.active !== 'boolean' ||
      typeof branch.createdAt !== 'string'
    ) {
      return null;
    }
    branches.push({
      id: branch.id,
      label: branch.label,
      addressLine: branch.addressLine,
      city: branch.city,
      areaLabel: branch.areaLabel,
      active: branch.active,
      createdAt: branch.createdAt,
    });
  }
  const team: OrganizationDetail['team'][number][] = [];
  for (const entry of raw.team) {
    const member = entry as Record<string, unknown>;
    if (
      typeof member.membershipId !== 'string' ||
      !stringOrNull(member.displayName) ||
      typeof member.role !== 'string' ||
      typeof member.branchScopeKind !== 'string' ||
      typeof member.createdAt !== 'string'
    ) {
      return null;
    }
    team.push({
      membershipId: member.membershipId,
      displayName: member.displayName,
      role: member.role,
      branchScopeKind: member.branchScopeKind,
      createdAt: member.createdAt,
    });
  }
  const byState = {} as Record<ListingState, number>;
  for (const state of LISTING_STATES) {
    const count = (catalogue.byState as Record<string, unknown>)[state];
    if (typeof count !== 'number') return null;
    byState[state] = count;
  }
  return {
    organization: {
      id: organization.id,
      legalName: organization.legalName,
      tradeName: organization.tradeName,
      orgKind: organization.orgKind,
      verificationState: organization.verificationState,
      reviewState: organization.reviewState,
      suspendedAt: organization.suspendedAt,
      offboardedAt: organization.offboardedAt,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
      version: organization.version,
    },
    profile: {
      displayName: profile.displayName,
      descriptionEn: profile.descriptionEn,
      descriptionAr: profile.descriptionAr,
      publicPhone: profile.publicPhone,
      publicEmail: profile.publicEmail,
      publicWebsite: profile.publicWebsite,
      publicInstagram: profile.publicInstagram,
      published: profile.published,
      publiclyVisible: profile.publiclyVisible,
    },
    branches,
    team,
    catalogue: { total: catalogue.total, byState },
  };
}

export function createLiveProvidersReadPort(transport: LiveTransport): AdminProvidersReadPort {
  return {
    async listOrganizations(params): Promise<OrganizationsListOutcome> {
      const query = new URLSearchParams();
      query.set('limit', String(params.limit));
      if (params.cursor !== undefined) query.set('cursor', params.cursor);
      if (params.q !== undefined && params.q.trim() !== '') query.set('q', params.q);
      if (params.state !== undefined) query.set('state', params.state);
      if (params.needsReview === true) query.set('needsReview', 'true');
      const encoded = query.toString();
      const response = await transport.authorizedRequest(
        `/admin/organizations${encoded === '' ? '' : `?${encoded}`}`,
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const body = response.body as { organizations?: unknown; nextCursor?: unknown } | null;
        if (
          body === null ||
          !Array.isArray(body.organizations) ||
          !(typeof body.nextCursor === 'string' || body.nextCursor === null)
        ) {
          return { kind: 'unavailable' };
        }
        const organizations: OrganizationSummary[] = [];
        for (const row of body.organizations) {
          const summary = summaryFrom(row);
          if (summary === null) return { kind: 'unavailable' };
          organizations.push(summary);
        }
        return { kind: 'loaded', page: { organizations, nextCursor: body.nextCursor } };
      }
      return response.code === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
    },

    async getOrganization(organizationId): Promise<OrganizationDetailOutcome> {
      const response = await transport.authorizedRequest(
        `/admin/organizations/${encodeURIComponent(organizationId)}`,
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const detail = detailFrom(response.body);
        return detail === null ? { kind: 'unavailable' } : { kind: 'loaded', detail };
      }
      if (response.code === 'forbidden') return { kind: 'forbidden' };
      if (response.status === 404 || response.status === 422) return { kind: 'notFound' };
      return { kind: 'unavailable' };
    },
  };
}
