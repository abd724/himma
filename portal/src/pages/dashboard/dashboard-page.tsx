import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { usePortalPorts } from '../../app/ports-context';
import type { ProgramSummaryRecord } from '../../catalogue/contract';
import type { StaffInvitationRecord, StaffLoadOutcome } from '../../team/contract';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { PageHeader } from '../../components/ui/page-header';
import { usePageTitle } from '../../hooks/use-page-title';
import { organizationPath } from '../../navigation/nav-items';
import { useActiveOrganization } from '../../organization/organization-context';
import type { OrganizationView } from '../../profile/contract';
import {
  catalogueCounts,
  DASHBOARD_STATE_ORDER,
  listingCountLabel,
  loadCatalogueSummary,
} from './dashboard-domain';
import { catalogueAuthority, listingStateLabel } from '../listings/listing-domain';
import { isStillOnboarding, ORGANIZATION_STATE_LABEL } from '../profile/organization-state';
import { invitationIsOverdue } from '../team/team-authority';
import styles from './dashboard.module.css';

/**
 * The provider Dashboard (docs/29 §10) — a truthful status home built ONLY
 * from backend-ready truth the portal already reads:
 * - organization verification + storefront publication state (org view);
 * - the catalogue summarized by REAL lifecycle states, composed from the
 *   provider listings read (scoped memberships see exactly their reachable
 *   set — never organization-wide counts);
 * - pending team invitations (Owner only — `staff.read` is Owner-only).
 *
 * Deliberately absent: every metric whose backend does not exist (bookings,
 * revenue, attendance, ratings, capacity, occupancy, conversion) and
 * revision-pending counts (the list contract carries no revision field).
 * A smaller truthful dashboard over a fabricated one, by design.
 *
 * Content is capability-shaped for usability only — roles without
 * `catalogue.read`/`staff.read` get no catalogue/team card and NO fetch of
 * that data; the backend stays the boundary.
 */
export function DashboardPage() {
  usePageTitle('Dashboard');
  const organization = useActiveOrganization();
  const { profilePort, listingsPort, teamPort } = usePortalPorts();

  const viewQuery = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });
  const view = viewQuery.data?.kind === 'loaded' ? viewQuery.data.view : null;
  const authority = view === null ? null : catalogueAuthority(view);
  const canReadCatalogue = authority?.canRead === true;
  const canReadStaff = view?.membership.capabilities.includes('staff.read') === true;

  const catalogueQuery = useQuery({
    queryKey: ['listings', organization.id, 'dashboard-summary'],
    queryFn: () => loadCatalogueSummary(listingsPort, organization.id),
    enabled: canReadCatalogue,
  });
  const staffQuery = useQuery({
    queryKey: ['staff', organization.id],
    queryFn: () => teamPort.loadStaff(organization.id),
    enabled: canReadStaff,
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`A clear view of ${organization.displayName} on Himma — status, required actions, and what to do next.`}
      />
      {viewQuery.isPending ? (
        <p className={styles.loading} role="status">
          Loading your dashboard…
        </p>
      ) : view === null ? (
        <div className={styles.cardFailure}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load this workspace. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void viewQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className={styles.dashboardWrap}>
          <div className={styles.cardGrid}>
            <OrganizationCard view={view} />
            {canReadCatalogue ? (
              <CatalogueCard
                view={view}
                scoped={authority?.assignedActiveBranchIds !== null}
                query={catalogueQuery}
              />
            ) : null}
            {canReadStaff ? <TeamCard organizationId={organization.id} query={staffQuery} /> : null}
          </div>
          {!canReadCatalogue ? (
            <p className={styles.supportingText}>
              Your role&rsquo;s dashboard covers organization status. The catalogue is managed by
              your organization&rsquo;s catalogue roles.
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}

// -- organization status ------------------------------------------------------

function OrganizationCard({ view }: { view: OrganizationView }) {
  const state = view.organization.verificationState;
  const onboarding = isStillOnboarding(state);
  return (
    <section aria-labelledby="dashboard-organization-heading" className={styles.section}>
      <h2 id="dashboard-organization-heading" className={styles.sectionTitle}>
        Organization
      </h2>
      <div className={styles.sectionCard}>
        <p className={styles.headlineValue}>{ORGANIZATION_STATE_LABEL[state] ?? state}</p>
        {state === 'suspended' ? (
          <p className={styles.supportingText}>
            This organization is currently suspended. Everything stays readable, and changes are
            unavailable until Himma reinstates it.
          </p>
        ) : (
          <p className={styles.supportingText}>
            {view.profile.published
              ? 'Your public storefront is published — it appears to customers once the organization is live.'
              : 'Your public storefront isn’t published yet.'}
          </p>
        )}
        {onboarding ? (
          <Link
            className={styles.inlineLink}
            to={organizationPath(view.organization.id, 'onboarding')}
          >
            Continue your onboarding
          </Link>
        ) : (
          <Link className={styles.inlineLink} to={organizationPath(view.organization.id, 'profile')}>
            View your business profile
          </Link>
        )}
      </div>
    </section>
  );
}

// -- catalogue summary --------------------------------------------------------

function CatalogueCard({
  view,
  scoped,
  query,
}: {
  view: OrganizationView;
  scoped: boolean;
  query: {
    isPending: boolean;
    data?: Awaited<ReturnType<typeof loadCatalogueSummary>> | undefined;
    refetch: () => Promise<unknown>;
  };
}) {
  const organizationId = view.organization.id;
  const listingsHref = organizationPath(organizationId, 'listings');
  const canPublish = view.membership.capabilities.includes('listings.publish');
  const canManage = view.membership.capabilities.includes('listings.manage');
  const suspended = view.organization.verificationState === 'suspended';

  return (
    <section aria-labelledby="dashboard-catalogue-heading" className={styles.section}>
      <h2 id="dashboard-catalogue-heading" className={styles.sectionTitle}>
        Listings
      </h2>
      <div className={styles.sectionCard}>
        {query.isPending ? (
          <p className={styles.loading} role="status">
            Loading your catalogue summary…
          </p>
        ) : query.data?.kind === 'loaded' ? (
          <CatalogueSummary
            programs={query.data.programs}
            listingsHref={listingsHref}
            canPublish={canPublish}
            showCreate={canManage && !suspended}
            scoped={scoped}
            organizationId={organizationId}
          />
        ) : (
          <div className={styles.cardFailure}>
            <InlineAlert tone="error">
              We couldn&rsquo;t load your catalogue summary. Everything else is unaffected.
            </InlineAlert>
            <Button variant="secondary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function CatalogueSummary({
  programs,
  listingsHref,
  canPublish,
  showCreate,
  scoped,
  organizationId,
}: {
  programs: readonly ProgramSummaryRecord[];
  listingsHref: string;
  canPublish: boolean;
  showCreate: boolean;
  scoped: boolean;
  organizationId: string;
}) {
  const counts = catalogueCounts(programs);
  const attention: Array<{ key: string; headline: string; support: string | null }> = [];
  if (counts.changes_requested > 0) {
    attention.push({
      key: 'changes_requested',
      headline: `${listingCountLabel(counts.changes_requested)} need${counts.changes_requested === 1 ? 's' : ''} changes before resubmission`,
      support: 'Himma asked for changes — make the corrections, then resubmit for review.',
    });
  }
  if (counts.approved > 0) {
    attention.push({
      key: 'approved',
      headline: `${listingCountLabel(counts.approved)} approved and not yet published`,
      support: canPublish
        ? 'Himma approved — publish when you’re ready.'
        : 'Himma approved — an Owner or Organization Manager publishes them.',
    });
  }
  if (counts.draft > 0) {
    attention.push({
      key: 'draft',
      headline: `${listingCountLabel(counts.draft)} still in draft`,
      support: 'Complete and submit them for Himma review when they’re ready.',
    });
  }

  if (programs.length === 0) {
    return (
      <>
        <p className={styles.bodyText}>No listings yet.</p>
        {showCreate ? (
          <Link className={styles.inlineLink} to={`${listingsHref}/new`}>
            Create your first listing
          </Link>
        ) : (
          <p className={styles.supportingText}>
            Listings appear here once your catalogue team creates them.
          </p>
        )}
      </>
    );
  }

  return (
    <>
      {scoped ? (
        <p className={styles.supportingText}>
          These numbers cover the listings within your branch scope.
        </p>
      ) : null}
      {attention.length > 0 ? (
        <ul className={styles.attentionList}>
          {attention.map((item) => (
            <li key={item.key} className={styles.attentionRow}>
              <p className={styles.bodyText}>{item.headline}</p>
              {item.support !== null ? (
                <p className={styles.supportingText}>{item.support}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.bodyText}>Nothing needs your attention right now.</p>
      )}
      <ul className={styles.countList} aria-label="Listings by status">
        {DASHBOARD_STATE_ORDER.filter((state) => counts[state] > 0).map((state) => (
          <li key={state} className={styles.countRow}>
            <span>{listingStateLabel(state)}</span>
            <span className={styles.countValue}>{counts[state]}</span>
          </li>
        ))}
      </ul>
      <Link className={styles.inlineLink} to={listingsHref}>
        Go to your listings
      </Link>
      {showCreate ? (
        <Link className={styles.inlineLink} to={`${organizationPath(organizationId, 'listings')}/new`}>
          Create a listing
        </Link>
      ) : null}
    </>
  );
}

// -- team (Owner-only: `staff.read`) -----------------------------------------

function TeamCard({
  organizationId,
  query,
}: {
  organizationId: string;
  query: {
    isPending: boolean;
    data?: StaffLoadOutcome | undefined;
    refetch: () => Promise<unknown>;
  };
}) {
  return (
    <section aria-labelledby="dashboard-team-heading" className={styles.section}>
      <h2 id="dashboard-team-heading" className={styles.sectionTitle}>
        Team
      </h2>
      <div className={styles.sectionCard}>
        {query.isPending ? (
          <p className={styles.loading} role="status">
            Loading your team summary…
          </p>
        ) : query.data?.kind === 'loaded' ? (
          <TeamSummary
            organizationId={organizationId}
            memberships={query.data.staff.memberships}
            invitations={query.data.staff.invitations}
          />
        ) : (
          <div className={styles.cardFailure}>
            <InlineAlert tone="error">
              We couldn&rsquo;t load your team summary. Everything else is unaffected.
            </InlineAlert>
            <Button variant="secondary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function TeamSummary({
  organizationId,
  memberships,
  invitations,
}: {
  organizationId: string;
  memberships: readonly { state: string }[];
  invitations: readonly StaffInvitationRecord[];
}) {
  const activeMembers = memberships.filter((row) => row.state === 'active').length;
  const pendingInvitations = invitations.filter(
    (row) => row.state === 'sent' && !invitationIsOverdue(row),
  ).length;
  return (
    <>
      <p className={styles.bodyText}>
        {activeMembers} active member{activeMembers === 1 ? '' : 's'}
        {pendingInvitations > 0
          ? ` · ${pendingInvitations} invitation${pendingInvitations === 1 ? '' : 's'} awaiting a response`
          : ''}
      </p>
      {pendingInvitations === 0 ? (
        <p className={styles.supportingText}>No invitations are awaiting a response.</p>
      ) : null}
      <Link className={styles.inlineLink} to={organizationPath(organizationId, 'team')}>
        Go to your team
      </Link>
    </>
  );
}
