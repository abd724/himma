import { NavLink } from 'react-router-dom';
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
 */
export function PortalNav({ onNavigate }: { onNavigate?: () => void }) {
  const organization = useActiveOrganization();

  return (
    <nav className={styles.nav} aria-label="Primary">
      {groups.map((group) => {
        const items = portalNavItems.filter((item) => item.group === group.id);
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
