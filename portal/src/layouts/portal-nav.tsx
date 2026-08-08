import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { usePortalPorts } from '../app/ports-context';
import { VisuallyHidden } from '../components/ui/visually-hidden';
import { organizationPath, portalNavItems, type PortalNavItem } from '../navigation/nav-items';
import { useActiveOrganization } from '../organization/organization-context';
import styles from './portal-nav.module.css';

const groups: ReadonlyArray<{ id: PortalNavItem['group']; label: string | null }> = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'organization', label: 'Organization' },
  { id: 'account', label: null },
];

/**
 * Primary navigation — one component for every presentation: full sidebar,
 * tablet rail (CSS-compacted), and mobile drawer. Active state comes from the
 * router (`aria-current="page"`); visibility metadata comes from
 * navigation/nav-items.ts and is never an authorization decision.
 *
 * Capability-gated items (today: Team, `staff.read`, owner-only) render
 * only once the active organization's membership capabilities are KNOWN to
 * include the capability — the same backend-returned capability list every
 * page reads (shared `organizationView` cache; no extra request in steady
 * state). This is usability-only visibility: the backend refuses the read
 * either way, and direct navigation renders the truthful no-access surface.
 */
export function PortalNav({ onNavigate }: { onNavigate?: () => void }) {
  const organization = useActiveOrganization();
  const { profilePort } = usePortalPorts();

  const viewQuery = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });
  const capabilities =
    viewQuery.data?.kind === 'loaded' ? viewQuery.data.view.membership.capabilities : null;

  const itemVisible = (item: PortalNavItem): boolean =>
    item.requiredCapability === null ||
    (capabilities !== null && capabilities.includes(item.requiredCapability));

  return (
    <nav className={styles.nav} aria-label="Primary">
      {groups.map((group) => {
        const items = portalNavItems.filter(
          (item) => item.group === group.id && itemVisible(item),
        );
        return (
          <div key={group.id} className={styles.group}>
            {group.label ? (
              <p className={styles.groupLabel} aria-hidden="true">
                {group.label}
              </p>
            ) : null}
            <ul className={styles.list}>
              {items.map((item) => (
                <li key={item.id}>
                  <NavLink
                    to={organizationPath(organization.id, item.segment)}
                    end={item.segment === ''}
                    className={({ isActive }) =>
                      isActive ? `${styles.link} ${styles.linkActive}` : styles.link
                    }
                    onClick={onNavigate}
                  >
                    <item.icon className={styles.icon} aria-hidden="true" strokeWidth={1.75} />
                    <span className={styles.label}>{item.label}</span>
                    {item.comingSoon ? (
                      <>
                        <span className={styles.soonTag} aria-hidden="true">
                          Soon
                        </span>
                        <VisuallyHidden>Coming soon</VisuallyHidden>
                      </>
                    ) : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
