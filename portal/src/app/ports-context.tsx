import { createContext, useContext, type ReactNode } from 'react';
import type { BranchPort } from '../branches/contract';
import type { ListingsReadPort } from '../catalogue/contract';
import type { ListingEditorPort } from '../catalogue/editor-contract';
import type { BulkImportPort } from '../catalogue/import-contract';
import type { ListingCardPort } from '../catalogue/card-contract';
import type { ListingLifecyclePort } from '../catalogue/lifecycle-contract';
import type { InvitationPort } from '../invitations/contract';
import type { OnboardingPort } from '../onboarding/contract';
import type { OrganizationProfilePort } from '../profile/contract';
import type {
  ActivityTypeReadPort,
  AreaReadPort,
  CategoryReadPort,
} from '../taxonomy/contract';
import type { TeamPort } from '../team/contract';

/** Domain-port access for pages — composed by AppProviders from the runtime. */
export interface PortalPorts {
  readonly invitationPort: InvitationPort;
  readonly onboardingPort: OnboardingPort;
  readonly profilePort: OrganizationProfilePort;
  readonly branchPort: BranchPort;
  readonly areaPort: AreaReadPort;
  readonly teamPort: TeamPort;
  readonly listingsPort: ListingsReadPort;
  readonly listingEditorPort: ListingEditorPort;
  readonly listingLifecyclePort: ListingLifecyclePort;
  readonly bulkImportPort: BulkImportPort;
  readonly listingCardPort: ListingCardPort;
  readonly activityTypePort: ActivityTypeReadPort;
  readonly categoryPort: CategoryReadPort;
}

const PortsContext = createContext<PortalPorts | null>(null);

export function PortsProvider({ ports, children }: { ports: PortalPorts; children: ReactNode }) {
  return <PortsContext.Provider value={ports}>{children}</PortsContext.Provider>;
}

export function usePortalPorts(): PortalPorts {
  const ports = useContext(PortsContext);
  if (ports === null) {
    throw new Error('usePortalPorts requires PortsProvider');
  }
  return ports;
}
