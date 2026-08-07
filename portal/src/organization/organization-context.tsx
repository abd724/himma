import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';

/**
 * Shell-level organization context (docs/29 §5–§6).
 *
 * The organization id lives in the URL (`/o/:organizationId/...`, mirroring
 * backend addressing) and this context resolves it against the accessible
 * organizations. In W2-1 the accessible set comes from an isolated
 * development fixture; W2-2 replaces the source with real `/provider/me`
 * membership resolution behind the same provider — consumers never change.
 */
export interface ShellOrganization {
  readonly id: string;
  readonly displayName: string;
}

const AccessibleOrganizationsContext = createContext<readonly ShellOrganization[] | null>(null);

export function AccessibleOrganizationsProvider({
  organizations,
  children,
}: {
  organizations: readonly ShellOrganization[];
  children: ReactNode;
}) {
  return (
    <AccessibleOrganizationsContext.Provider value={organizations}>
      {children}
    </AccessibleOrganizationsContext.Provider>
  );
}

export function useAccessibleOrganizations(): readonly ShellOrganization[] {
  const organizations = useContext(AccessibleOrganizationsContext);
  if (organizations === null) {
    throw new Error('useAccessibleOrganizations requires AccessibleOrganizationsProvider');
  }
  return organizations;
}

export interface OrganizationScope {
  readonly organizations: readonly ShellOrganization[];
  readonly activeOrganization: ShellOrganization;
}

const ActiveOrganizationContext = createContext<ShellOrganization | null>(null);

export function ActiveOrganizationProvider({
  organization,
  children,
}: {
  organization: ShellOrganization;
  children: ReactNode;
}) {
  return (
    <ActiveOrganizationContext.Provider value={organization}>
      {children}
    </ActiveOrganizationContext.Provider>
  );
}

export function useActiveOrganization(): ShellOrganization {
  const organization = useContext(ActiveOrganizationContext);
  if (organization === null) {
    throw new Error('useActiveOrganization requires an organization-scoped route');
  }
  return organization;
}

/** Resolves the route's :organizationId against the accessible set (null = no access/unknown). */
export function useRouteOrganization(): ShellOrganization | null {
  const { organizationId } = useParams();
  const organizations = useAccessibleOrganizations();
  return useMemo(
    () => organizations.find((organization) => organization.id === organizationId) ?? null,
    [organizations, organizationId],
  );
}
