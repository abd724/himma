import type { ApiJsonResponse } from '../../api/client';
import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import type {
  BranchInput,
  BranchPatch,
  BranchPort,
  CreateBranchOutcome,
  DeactivateBranchOutcome,
  UpdateBranchOutcome,
} from '../../branches/contract';
import type { InvitationPort } from '../../invitations/contract';
import type {
  OnboardingPort,
  OnboardingSnapshotOutcome,
  SubmitForVerificationOutcome,
} from '../../onboarding/contract';
import type {
  BranchRecord,
  OrganizationProfilePort,
  OrganizationView,
  OrganizationViewOutcome,
  ProfilePatch,
  UpdateProfileOutcome,
} from '../../profile/contract';
import {
  PROVIDER_ROLES,
  type BranchScope,
  type ProviderRole,
} from '../../provider-access/contract';
import type { AreaRecord, AreaReadPort } from '../../taxonomy/contract';
import type {
  StaffInvitationRecord,
  StaffInvitationState,
  StaffMembershipRecord,
  StaffMembershipState,
  TeamPort,
} from '../../team/contract';

/**
 * LIVE provider domain ports (W2-12B) — the production implementations of
 * the W2-3…W2-6 seams over the authenticated W2-12A transport, route for
 * route against the REAL Slice-3 backend:
 *
 * - `GET  /provider/organizations/:orgId`                        → org view
 * - `PATCH .../profile`                                          → profile CAS edit
 * - `POST .../submit`                                            → verification submission
 * - `POST .../branches` · `PATCH .../branches/:id` · `POST .../branches/:id/deactivate`
 * - `GET  .../staff` · `POST .../staff/invitations` ·
 *   `POST .../staff/invitations/:id/revoke` · `POST .../staff/memberships/:id/revoke`
 * - `POST /provider/invitations/accept`
 * - `GET  /catalogue/areas` (public read — the branch editor's one direct
 *   taxonomy dependency; NOT the listing taxonomy, which stays W2-12C)
 *
 * Principles:
 * - `/provider/me` (the session layer) remains the ONLY access authority —
 *   these ports return display/edit truth and never grant navigation.
 * - Outcomes map 1:1 from the backend's typed error envelope; a response
 *   outside the approved DTO shape FAILS CLOSED to `unavailable` (no
 *   partial truth, no fixture fallback — fixtures are not reachable from
 *   this module at all).
 * - Access-affecting successes push the W2-2 `accessChanged` interrupt so
 *   the shell re-resolves `/provider/me`: organization submission (state
 *   change), a display-name edit (shell identity), invitation acceptance
 *   (new access), and membership revocation (the revoked seat may be the
 *   caller's own — one authoritative re-read is the safe, documented cost).
 * - `mfaRequired` cannot occur behind the portal's guard chain (single
 *   factor never reaches provider-private surfaces); if it ever arrives it
 *   maps to the safe `forbidden` presentation rather than inventing UX.
 */

const codeOf = (response: ApiJsonResponse): string => response.code ?? '';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isProviderRole(value: unknown): value is ProviderRole {
  return typeof value === 'string' && (PROVIDER_ROLES as readonly string[]).includes(value);
}

function branchRecordFrom(raw: unknown): BranchRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.label !== 'string' ||
    typeof row.areaLabel !== 'string' ||
    typeof row.active !== 'boolean' ||
    typeof row.version !== 'number' ||
    !isStringArray(row.facilities)
  ) {
    return null;
  }
  const geo = row.geoPoint;
  const geoPoint =
    typeof geo === 'object' &&
    geo !== null &&
    typeof (geo as { longitude?: unknown }).longitude === 'number' &&
    typeof (geo as { latitude?: unknown }).latitude === 'number'
      ? {
          longitude: (geo as { longitude: number }).longitude,
          latitude: (geo as { latitude: number }).latitude,
        }
      : null;
  return {
    id: row.id,
    label: row.label,
    addressLine: typeof row.addressLine === 'string' ? row.addressLine : null,
    city: typeof row.city === 'string' ? row.city : null,
    areaLabel: row.areaLabel,
    geoPoint,
    openingHours: row.openingHours ?? null,
    facilities: row.facilities,
    active: row.active,
    version: row.version,
  };
}

function branchScopeFrom(raw: unknown): BranchScope | null {
  if (raw === 'all') return 'all';
  if (isStringArray(raw)) return raw;
  return null;
}

/** Field-for-field validation of the real OrganizationViewSchema — any
 *  contract violation fails the WHOLE read closed. */
function organizationViewFrom(body: unknown): OrganizationView | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const organization = raw.organization as Record<string, unknown> | undefined;
  const profile = raw.profile as Record<string, unknown> | undefined;
  const membership = raw.membership as Record<string, unknown> | undefined;
  if (
    typeof organization !== 'object' ||
    organization === null ||
    typeof profile !== 'object' ||
    profile === null ||
    typeof membership !== 'object' ||
    membership === null ||
    !Array.isArray(raw.branches)
  ) {
    return null;
  }
  if (
    typeof organization.id !== 'string' ||
    typeof organization.tradeName !== 'string' ||
    typeof organization.orgKind !== 'string' ||
    typeof organization.verificationState !== 'string' ||
    typeof organization.version !== 'number'
  ) {
    return null;
  }
  if (
    typeof profile.displayName !== 'string' ||
    typeof profile.published !== 'boolean' ||
    typeof profile.version !== 'number' ||
    !isStringArray(profile.galleryMediaRefs)
  ) {
    return null;
  }
  const role = membership.role;
  const branchScope = branchScopeFrom(membership.branchScope);
  if (
    typeof membership.id !== 'string' ||
    !isProviderRole(role) ||
    branchScope === null ||
    !isStringArray(membership.capabilities)
  ) {
    return null;
  }
  const branches: BranchRecord[] = [];
  for (const entry of raw.branches) {
    const branch = branchRecordFrom(entry);
    if (branch === null) return null;
    branches.push(branch);
  }
  const nullableString = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;
  return {
    organization: {
      id: organization.id,
      tradeName: organization.tradeName,
      ...(typeof organization.legalName === 'string'
        ? { legalName: organization.legalName }
        : {}),
      orgKind: organization.orgKind,
      verificationState: organization.verificationState,
      ...('commercialTermsRef' in organization
        ? { commercialTermsRef: nullableString(organization.commercialTermsRef) }
        : {}),
      version: organization.version,
    },
    profile: {
      displayName: profile.displayName,
      descriptionEn: nullableString(profile.descriptionEn),
      descriptionAr: nullableString(profile.descriptionAr),
      logoMediaRef: nullableString(profile.logoMediaRef),
      coverMediaRef: nullableString(profile.coverMediaRef),
      galleryMediaRefs: profile.galleryMediaRefs,
      publicPhone: nullableString(profile.publicPhone),
      publicEmail: nullableString(profile.publicEmail),
      publicWebsite: nullableString(profile.publicWebsite),
      publicInstagram: nullableString(profile.publicInstagram),
      published: profile.published,
      version: profile.version,
    },
    branches,
    membership: {
      id: membership.id,
      role,
      branchScope,
      capabilities: membership.capabilities,
    },
  };
}

export interface LiveDomainPorts {
  readonly profilePort: OrganizationProfilePort;
  readonly onboardingPort: OnboardingPort;
  readonly branchPort: BranchPort;
  readonly areaPort: AreaReadPort;
  readonly teamPort: TeamPort;
  readonly invitationPort: InvitationPort;
}

export function createLiveDomainPorts(transport: LiveTransport): LiveDomainPorts {
  const orgPath = (organizationId: string, suffix = '') =>
    `/provider/organizations/${encodeURIComponent(organizationId)}${suffix}`;

  const loadOrganizationView = async (
    organizationId: string,
  ): Promise<OrganizationViewOutcome> => {
    const response = await transport.authorizedRequest(orgPath(organizationId));
    if (response === null || response.networkFailure) return { kind: 'unavailable' };
    if (response.status === 200) {
      const view = organizationViewFrom(response.body);
      return view === null ? { kind: 'unavailable' } : { kind: 'loaded', view };
    }
    switch (codeOf(response)) {
      case 'notFound':
      case 'forbidden': // org.read is universal; an anomaly stays not-found-shaped
      case 'mfaRequired':
        return { kind: 'notFound' };
      default:
        return { kind: 'unavailable' };
    }
  };

  const profilePort: OrganizationProfilePort = {
    loadOrganizationView,
    async updateProfile(
      organizationId,
      expectedVersion,
      patch: ProfilePatch,
    ): Promise<UpdateProfileOutcome> {
      const response = await transport.authorizedRequest(orgPath(organizationId, '/profile'), {
        method: 'PATCH',
        body: { expectedVersion, ...patch },
      });
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const version = (response.body as { version?: unknown } | null)?.version;
        if (typeof version !== 'number') return { kind: 'unavailable' };
        if (patch.displayName !== undefined) {
          // The shell's membership display identity derives from this
          // field — re-resolve /provider/me like the fixture does.
          transport.notifyAccessChanged();
        }
        return { kind: 'profileUpdated', version };
      }
      switch (codeOf(response)) {
        case 'staleVersion':
          return { kind: 'staleVersion' };
        case 'validationError':
          return { kind: 'validationError' };
        case 'organizationSuspended':
          return { kind: 'organizationSuspended' };
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },
  };

  const onboardingPort: OnboardingPort = {
    /**
     * The documented COMPOSITION over the org view. `listingCount` stays
     * null in W2-12B: the provider listings read is deliberately NOT
     * integrated yet (task §24) — the count wires up with the W2-12C
     * catalogue integration, and a null count renders as "unknown", never
     * as a fabricated zero.
     */
    async loadSnapshot(organizationId): Promise<OnboardingSnapshotOutcome> {
      const outcome = await loadOrganizationView(organizationId);
      if (outcome.kind !== 'loaded') return { kind: outcome.kind };
      const view = outcome.view;
      return {
        kind: 'loaded',
        snapshot: {
          organization: {
            id: view.organization.id,
            tradeName: view.organization.tradeName,
            verificationState: view.organization.verificationState,
            version: view.organization.version,
          },
          profile: {
            displayName: view.profile.displayName,
            published: view.profile.published,
          },
          branches: view.branches.map((branch) => ({
            id: branch.id,
            label: branch.label,
            active: branch.active,
          })),
          membership: {
            role: view.membership.role,
            capabilities: view.membership.capabilities,
          },
          listingCount: null,
        },
      };
    },

    async submitForVerification(
      organizationId,
      expectedVersion,
    ): Promise<SubmitForVerificationOutcome> {
      const response = await transport.authorizedRequest(orgPath(organizationId, '/submit'), {
        method: 'POST',
        body: { expectedVersion },
      });
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const version = (response.body as { version?: unknown } | null)?.version;
        if (typeof version !== 'number') return { kind: 'unavailable' };
        // organizationState changed — /provider/me carries it; re-resolve.
        transport.notifyAccessChanged();
        return { kind: 'organizationSubmitted', version };
      }
      switch (codeOf(response)) {
        case 'organizationIncomplete':
          return { kind: 'organizationIncomplete' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'staleVersion':
          return { kind: 'staleVersion' };
        case 'organizationSuspended':
          return { kind: 'organizationSuspended' };
        case 'forbidden':
        case 'mfaRequired':
        case 'notFound': // no membership cannot reach here; keep it authority-shaped
          return { kind: 'forbidden' };
        default:
          return { kind: 'unavailable' };
      }
    },
  };

  const branchPort: BranchPort = {
    async createBranch(organizationId, input: BranchInput): Promise<CreateBranchOutcome> {
      const response = await transport.authorizedRequest(orgPath(organizationId, '/branches'), {
        method: 'POST',
        body: input,
      });
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const branch = branchRecordFrom((response.body as { branch?: unknown } | null)?.branch);
        return branch === null ? { kind: 'unavailable' } : { kind: 'branchCreated', branch };
      }
      switch (codeOf(response)) {
        case 'validationError':
          return { kind: 'validationError' };
        case 'organizationSuspended':
          return { kind: 'organizationSuspended' };
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },

    async updateBranch(
      organizationId,
      branchId,
      expectedVersion,
      patch: BranchPatch,
    ): Promise<UpdateBranchOutcome> {
      const response = await transport.authorizedRequest(
        orgPath(organizationId, `/branches/${encodeURIComponent(branchId)}`),
        { method: 'PATCH', body: { expectedVersion, ...patch } },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const branch = branchRecordFrom((response.body as { branch?: unknown } | null)?.branch);
        return branch === null ? { kind: 'unavailable' } : { kind: 'branchUpdated', branch };
      }
      switch (codeOf(response)) {
        case 'staleVersion':
          return { kind: 'staleVersion' };
        case 'validationError':
          return { kind: 'validationError' };
        case 'organizationSuspended':
          return { kind: 'organizationSuspended' };
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },

    async deactivateBranch(
      organizationId,
      branchId,
      expectedVersion,
    ): Promise<DeactivateBranchOutcome> {
      const response = await transport.authorizedRequest(
        orgPath(organizationId, `/branches/${encodeURIComponent(branchId)}/deactivate`),
        { method: 'POST', body: { expectedVersion } },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) return { kind: 'branchDeactivated' };
      switch (codeOf(response)) {
        case 'staleVersion':
          return { kind: 'staleVersion' };
        case 'organizationSuspended':
          return { kind: 'organizationSuspended' };
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },
  };

  const areaPort: AreaReadPort = {
    /** The REAL public area taxonomy read — the branch editor's direct
     *  dependency (task §13; deliberately NOT the listing taxonomy). */
    async listAreas() {
      const response = await transport.publicRequest('/catalogue/areas');
      if (response.status !== 200) return { kind: 'unavailable' };
      const rows = (response.body as { areas?: unknown } | null)?.areas;
      if (!Array.isArray(rows)) return { kind: 'unavailable' };
      const areas: AreaRecord[] = [];
      for (const entry of rows) {
        if (typeof entry !== 'object' || entry === null) return { kind: 'unavailable' };
        const raw = entry as Record<string, unknown>;
        if (
          typeof raw.id !== 'string' ||
          typeof raw.slug !== 'string' ||
          typeof raw.labelEn !== 'string'
        ) {
          return { kind: 'unavailable' };
        }
        areas.push({
          id: raw.id,
          slug: raw.slug,
          labelEn: raw.labelEn,
          labelAr: typeof raw.labelAr === 'string' ? raw.labelAr : null,
          city: typeof raw.city === 'string' ? raw.city : null,
        });
      }
      return { kind: 'loaded', areas };
    },
  };

  const membershipFrom = (raw: unknown): StaffMembershipRecord | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      typeof row.userId !== 'string' ||
      !isProviderRole(row.role) ||
      (row.branchScopeKind !== 'all' && row.branchScopeKind !== 'branches') ||
      !isStringArray(row.branchIds) ||
      (row.state !== 'active' && row.state !== 'revoked') ||
      typeof row.createdAt !== 'string' ||
      typeof row.version !== 'number'
    ) {
      return null;
    }
    return {
      id: row.id,
      userId: row.userId,
      role: row.role,
      branchScopeKind: row.branchScopeKind,
      branchIds: row.branchIds,
      state: row.state as StaffMembershipState,
      createdAt: row.createdAt,
      version: row.version,
    };
  };

  const invitationFrom = (raw: unknown): StaffInvitationRecord | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      typeof row.email !== 'string' ||
      !isProviderRole(row.role) ||
      (row.branchScopeKind !== 'all' && row.branchScopeKind !== 'branches') ||
      !isStringArray(row.branchIds) ||
      typeof row.state !== 'string' ||
      !['sent', 'accepted', 'revoked', 'expired'].includes(row.state) ||
      typeof row.expiresAt !== 'string' ||
      typeof row.version !== 'number'
    ) {
      return null;
    }
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      branchScopeKind: row.branchScopeKind,
      branchIds: row.branchIds,
      state: row.state as StaffInvitationState,
      expiresAt: row.expiresAt,
      version: row.version,
    };
  };

  const teamPort: TeamPort = {
    async loadStaff(organizationId) {
      const response = await transport.authorizedRequest(orgPath(organizationId, '/staff'));
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const body = response.body as {
          memberships?: unknown;
          invitations?: unknown;
        } | null;
        if (body === null || !Array.isArray(body.memberships) || !Array.isArray(body.invitations)) {
          return { kind: 'unavailable' };
        }
        const memberships: StaffMembershipRecord[] = [];
        for (const entry of body.memberships) {
          const row = membershipFrom(entry);
          if (row === null) return { kind: 'unavailable' };
          memberships.push(row);
        }
        const invitations: StaffInvitationRecord[] = [];
        for (const entry of body.invitations) {
          const row = invitationFrom(entry);
          if (row === null) return { kind: 'unavailable' };
          invitations.push(row);
        }
        return { kind: 'loaded', staff: { memberships, invitations } };
      }
      switch (codeOf(response)) {
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },

    async issueInvitation(organizationId, input) {
      const response = await transport.authorizedRequest(
        orgPath(organizationId, '/staff/invitations'),
        {
          method: 'POST',
          body: {
            email: input.email,
            role: input.role,
            branchScope:
              input.branchScope === 'all'
                ? { kind: 'all' }
                : { kind: 'branches', branchIds: input.branchScope },
          },
        },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const body = response.body as {
          invitationId?: unknown;
          expiresAt?: unknown;
          mailDelivery?: unknown;
        } | null;
        if (
          body === null ||
          typeof body.invitationId !== 'string' ||
          typeof body.expiresAt !== 'string' ||
          (body.mailDelivery !== 'delivered' && body.mailDelivery !== 'failed')
        ) {
          return { kind: 'unavailable' };
        }
        return {
          kind: 'invitationIssued',
          invitationId: body.invitationId,
          expiresAt: body.expiresAt,
          mailDelivery: body.mailDelivery,
        };
      }
      switch (codeOf(response)) {
        case 'stepUpRequired':
          return { kind: 'stepUpRequired' };
        case 'invalidBranchScope':
          return { kind: 'invalidBranchScope' };
        case 'validationError':
          return { kind: 'validationError' };
        case 'organizationSuspended':
          return { kind: 'organizationSuspended' };
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },

    async revokeInvitation(organizationId, invitationId) {
      const response = await transport.authorizedRequest(
        orgPath(organizationId, `/staff/invitations/${encodeURIComponent(invitationId)}/revoke`),
        { method: 'POST', body: {} },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) return { kind: 'invitationRevoked' };
      switch (codeOf(response)) {
        case 'stepUpRequired':
          return { kind: 'stepUpRequired' };
        case 'lifecycleConflict':
          return { kind: 'lifecycleConflict' };
        case 'organizationSuspended':
          return { kind: 'organizationSuspended' };
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },

    async revokeMembership(organizationId, membershipId, expectedVersion) {
      const response = await transport.authorizedRequest(
        orgPath(organizationId, `/staff/memberships/${encodeURIComponent(membershipId)}/revoke`),
        { method: 'POST', body: { expectedVersion } },
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        // The revoked seat may be the CALLER'S own — one authoritative
        // /provider/me re-read after a staff revocation is the safe cost
        // (task §18; the fixture emits the same interrupt for self-changes).
        transport.notifyAccessChanged();
        return { kind: 'membershipRevoked' };
      }
      switch (codeOf(response)) {
        case 'stepUpRequired':
          return { kind: 'stepUpRequired' };
        case 'lastOwnerProtected':
          return { kind: 'lastOwnerProtected' };
        case 'staleVersion':
          return { kind: 'staleVersion' };
        case 'organizationSuspended':
          return { kind: 'organizationSuspended' };
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },
  };

  const invitationPort: InvitationPort = {
    async accept(token) {
      const response = await transport.authorizedRequest('/provider/invitations/accept', {
        method: 'POST',
        body: { token },
      });
      if (response === null || response.networkFailure) {
        return { kind: 'providerUnavailable' };
      }
      if (response.status === 200) {
        const body = response.body as {
          organizationId?: unknown;
          membershipId?: unknown;
        } | null;
        if (
          body === null ||
          typeof body.organizationId !== 'string' ||
          typeof body.membershipId !== 'string'
        ) {
          return { kind: 'failure' };
        }
        // New access exists — re-resolve /provider/me (the acceptance page
        // routes on the refreshed membership).
        transport.notifyAccessChanged();
        return {
          kind: 'invitationAccepted',
          organizationId: body.organizationId,
          membershipId: body.membershipId,
        };
      }
      switch (codeOf(response)) {
        case 'invitationInvalid':
          return { kind: 'invitationInvalid' };
        case 'rateLimited':
          return { kind: 'rateLimited' };
        case 'providerUnavailable':
          return { kind: 'providerUnavailable' };
        default:
          return { kind: 'failure' };
      }
    },
  };

  return { profilePort, onboardingPort, branchPort, areaPort, teamPort, invitationPort };
}
