import {
  Banknote,
  CalendarDays,
  ClipboardList,
  LayoutDashboard,
  LifeBuoy,
  MapPin,
  Settings,
  Store,
  Ticket,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * Primary navigation metadata — the docs/29 §5 sidebar order, exactly.
 *
 * `requiredCapability` is a metadata seat for the backend capability id that
 * will gate VISIBILITY of each section once real provider access context
 * exists (W2-2+). It is null for every item today, it is presentation
 * metadata only, and it is never an authorization decision — the backend
 * remains the security boundary (docs/29 §2).
 */
export type PortalSectionId =
  | 'dashboard'
  | 'listings'
  | 'schedule'
  | 'bookings'
  | 'branches'
  | 'team'
  | 'profile'
  | 'finance'
  | 'settings';

export interface PortalNavItem {
  readonly id: PortalSectionId;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Path segment under `/o/:organizationId` ('' = the dashboard index). */
  readonly segment: string;
  /** Grouping label rendered as quiet section headers in the full sidebar. */
  readonly group: 'workspace' | 'organization' | 'account';
  /**
   * Sections whose domain has no backend yet (Slice 6/7/W5) carry an honest
   * "coming soon" marker in navigation — never fabricated data (docs/29 §5).
   */
  readonly comingSoon: boolean;
  /** Future backend capability id (W2-2+); presentation metadata only. */
  readonly requiredCapability: string | null;
}

export const portalNavItems: readonly PortalNavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    segment: '',
    group: 'workspace',
    comingSoon: false,
    requiredCapability: null,
  },
  {
    id: 'listings',
    label: 'Listings',
    icon: ClipboardList,
    segment: 'listings',
    group: 'workspace',
    comingSoon: false,
    requiredCapability: null,
  },
  {
    id: 'schedule',
    label: 'Schedule',
    icon: CalendarDays,
    segment: 'schedule',
    group: 'workspace',
    comingSoon: true,
    requiredCapability: null,
  },
  {
    id: 'bookings',
    label: 'Bookings',
    icon: Ticket,
    segment: 'bookings',
    group: 'workspace',
    comingSoon: true,
    requiredCapability: null,
  },
  {
    id: 'branches',
    label: 'Branches',
    icon: MapPin,
    segment: 'branches',
    group: 'organization',
    comingSoon: false,
    requiredCapability: null,
  },
  {
    id: 'team',
    label: 'Team',
    icon: Users,
    segment: 'team',
    group: 'organization',
    comingSoon: false,
    requiredCapability: null,
  },
  {
    id: 'profile',
    label: 'Business Profile',
    icon: Store,
    segment: 'profile',
    group: 'organization',
    comingSoon: false,
    requiredCapability: null,
  },
  {
    id: 'finance',
    label: 'Finance',
    icon: Banknote,
    segment: 'finance',
    group: 'organization',
    comingSoon: true,
    requiredCapability: null,
  },
  {
    id: 'settings',
    label: 'Settings & Support',
    icon: Settings,
    segment: 'settings',
    group: 'account',
    comingSoon: false,
    requiredCapability: null,
  },
];

export function organizationPath(organizationId: string, segment = ''): string {
  return segment ? `/o/${organizationId}/${segment}` : `/o/${organizationId}`;
}

export const supportIcon: LucideIcon = LifeBuoy;
