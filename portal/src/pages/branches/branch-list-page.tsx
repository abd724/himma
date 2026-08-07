import { useQuery } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePortalPorts } from '../../app/ports-context';
import { ActionLink } from '../../components/ui/action-link';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { PageHeader } from '../../components/ui/page-header';
import { usePageTitle } from '../../hooks/use-page-title';
import { organizationPath } from '../../navigation/nav-items';
import { useActiveOrganization } from '../../organization/organization-context';
import type { BranchRecord, OrganizationView } from '../../profile/contract';
import { isStillOnboarding } from '../profile/organization-state';
import { SUSPENDED_BRANCH_COPY, branchEditReach } from './branch-authority';
import styles from './branches.module.css';

/**
 * Branch index (docs/29 §6 route `/o/:organizationId/branches`). Reads come
 * from the canonical org view (`GET /provider/organizations/:orgId` →
 * `branches[]`, creation order) — the real backend has no separate branch
 * list route, and `org.read` serves EVERY branch of the organization to
 * every role; branch scope limits mutation reach, never this read. Only
 * real branch fields render: no bookings, staff, revenue, occupancy, or
 * session data exists for branches anywhere in the backend.
 */
export function BranchesPage() {
  usePageTitle('Branches');
  const organization = useActiveOrganization();
  const { profilePort } = usePortalPorts();

  const query = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });

  return (
    <>
      <PageHeader
        title="Branches"
        description="Your locations — where your activities run and what customers see on your storefront."
      />
      {query.isPending ? (
        <p className={styles.loading} role="status">
          Loading your branches…
        </p>
      ) : !query.isError && query.data && query.data.kind === 'loaded' ? (
        <BranchList view={query.data.view} />
      ) : (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load your branches. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

function BranchList({ view }: { view: OrganizationView }) {
  const capabilities = view.membership.capabilities;
  const suspended = view.organization.verificationState === 'suspended';
  const canCreate = capabilities.includes('branch.create') && !suspended;
  const reach = branchEditReach(view.membership, suspended);

  const activeCount = view.branches.filter((branch) => branch.active).length;
  const inactiveCount = view.branches.length - activeCount;

  if (view.branches.length === 0) {
    return (
      <div className={styles.emptyCard}>
        {suspended ? <InlineAlert tone="info">{SUSPENDED_BRANCH_COPY}</InlineAlert> : null}
        <MapPin className={styles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
        <h2 className={styles.emptyTitle}>No branches yet</h2>
        {canCreate ? (
          <>
            <p className={styles.emptyBody}>
              Add your first location so customers know where your activities run.
              {isStillOnboarding(view.organization.verificationState)
                ? ' Your organization needs at least one active branch before it can be submitted for verification.'
                : ''}
            </p>
            <ActionLink to={organizationPath(view.organization.id, 'branches/new')}>
              Add your first branch
            </ActionLink>
          </>
        ) : (
          <p className={styles.emptyBody}>
            An owner or organization manager adds branches for this organization.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.listWrap}>
      {suspended ? <InlineAlert tone="info">{SUSPENDED_BRANCH_COPY}</InlineAlert> : null}
      {reach.kind === 'scoped' ? (
        <InlineAlert tone="info">
          You manage your assigned branches. Every branch is listed here, and the ones you can
          edit are marked.
        </InlineAlert>
      ) : reach.kind === 'none' && !suspended ? (
        <p className={styles.readOnlyNote}>
          Your role can view branches. An owner or organization manager makes changes here.
        </p>
      ) : null}

      <div className={styles.listHeader}>
        <p className={styles.summary} role="status">
          {activeCount} active {activeCount === 1 ? 'branch' : 'branches'}
          {inactiveCount > 0
            ? ` · ${inactiveCount} deactivated ${inactiveCount === 1 ? 'branch' : 'branches'}`
            : ''}
        </p>
        {canCreate ? (
          <ActionLink to={organizationPath(view.organization.id, 'branches/new')}>
            Add branch
          </ActionLink>
        ) : null}
      </div>

      <ul className={styles.branchList} aria-label="Branches">
        {view.branches.map((branch) => (
          <BranchRow
            key={branch.id}
            branch={branch}
            organizationId={view.organization.id}
            assigned={reach.kind === 'scoped' && reach.branchIds.includes(branch.id)}
            showAssignment={reach.kind === 'scoped'}
          />
        ))}
      </ul>
    </div>
  );
}

function BranchRow({
  branch,
  organizationId,
  assigned,
  showAssignment,
}: {
  branch: BranchRecord;
  organizationId: string;
  assigned: boolean;
  showAssignment: boolean;
}) {
  return (
    <li className={styles.branchRow}>
      <Link
        className={styles.branchLink}
        to={organizationPath(organizationId, `branches/${branch.id}`)}
      >
        <span className={styles.branchMain}>
          <span className={styles.branchName}>{branch.label}</span>
          <span className={styles.branchMeta}>
            {branch.areaLabel}
            {branch.addressLine ? ` · ${branch.addressLine}` : ''}
          </span>
        </span>
        <span className={styles.branchChips}>
          {showAssignment && assigned && branch.active ? (
            <span className={styles.scopeChip}>Assigned to you</span>
          ) : null}
          <span
            className={`${styles.statusChip} ${branch.active ? styles.statusActive : styles.statusInactive}`}
          >
            {branch.active ? 'Active' : 'Deactivated'}
          </span>
        </span>
      </Link>
    </li>
  );
}
