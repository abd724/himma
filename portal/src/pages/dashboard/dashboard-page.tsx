import { useQuery } from '@tanstack/react-query';
import { Image as ImageIcon } from 'lucide-react';
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
  attentionItems,
  awaitingHimmaItems,
  catalogueCounts,
  DASHBOARD_STATE_ORDER,
  loadCatalogueSummary,
  recentListings,
  type AttentionItem,
  type AwaitingItem,
} from './dashboard-domain';
import { catalogueAuthority, formatListingDate, listingStateLabel, listingStateTone } from '../listings/listing-domain';
import { StateChip } from '../listings/state-chip';
import { isStillOnboarding, ORGANIZATION_STATE_LABEL } from '../profile/organization-state';
import { invitationIsOverdue } from '../team/team-authority';
import styles from './dashboard.module.css';

/**
 * The provider Dashboard (docs/29 §10; W2-11 owner correction) — the
 * operational home, built ONLY from truth the current contracts own:
 *
 * - a KPI row (published listings · needs-attention count under the EXACT
 *   dashboard-domain rule · active branches · active team members for
 *   `staff.read` holders) — every number scope-aware;
 * - "Needs your attention" (provider-actionable now) split from "Awaiting
 *   Himma" (submitted/in-review listings, organization verification);
 * - a concise organization/storefront status;
 * - a compact catalogue overview by REAL lifecycle state;
 * - recently updated listings (thumbnails from the W2-12C1 list-card
 *   projection each summary row carries — no extra read for this).
 *
 * DELIBERATELY ABSENT (no authoritative backend exists — recorded future
 * dashboard requirements, never faked): bookings, participants (bookings ≠
 * attending people — an adult account books for children), revenue, average
 * booking value, cancellations/refunds, attendance/utilization, growth
 * percentages, performance charts, and provider-configurable goals. The KPI
 * row and section grid are structured so those cards/sections slot in when
 * their backends arrive, without redesigning this page.
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
  const rows: readonly ProgramSummaryRecord[] =
    catalogueQuery.data?.kind === 'loaded' ? catalogueQuery.data.programs : [];

  const staffQuery = useQuery({
    queryKey: ['staff', organization.id],
    queryFn: () => teamPort.loadStaff(organization.id),
    enabled: canReadStaff,
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Here’s what needs your attention and how your Himma presence is doing."
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
        <DashboardBody
          view={view}
          scoped={authority?.assignedActiveBranchIds !== null}
          canReadCatalogue={canReadCatalogue}
          canReadStaff={canReadStaff}
          rows={rows}
          catalogueState={
            !canReadCatalogue
              ? 'hidden'
              : catalogueQuery.isPending
                ? 'loading'
                : catalogueQuery.data?.kind === 'loaded'
                  ? 'loaded'
                  : 'failed'
          }
          onRetryCatalogue={() => void catalogueQuery.refetch()}
          staffQuery={staffQuery}
        />
      )}
    </>
  );
}

function DashboardBody({
  view,
  scoped,
  canReadCatalogue,
  canReadStaff,
  rows,
  catalogueState,
  onRetryCatalogue,
  staffQuery,
}: {
  view: OrganizationView;
  scoped: boolean;
  canReadCatalogue: boolean;
  canReadStaff: boolean;
  rows: readonly ProgramSummaryRecord[];
  catalogueState: 'hidden' | 'loading' | 'loaded' | 'failed';
  onRetryCatalogue: () => void;
  staffQuery: { isPending: boolean; data?: StaffLoadOutcome | undefined; refetch: () => Promise<unknown> };
}) {
  const organizationId = view.organization.id;
  const canPublish = view.membership.capabilities.includes('listings.publish');
  const counts = catalogueCounts(rows);
  const attention = attentionItems({
    rows,
    canPublish,
    organizationVerificationState: view.organization.verificationState,
  });
  const awaiting = awaitingHimmaItems({
    rows,
    organizationVerificationState: view.organization.verificationState,
  });
  const activeBranches = view.branches.filter((branch) => branch.active).length;
  const staff = staffQuery.data?.kind === 'loaded' ? staffQuery.data.staff : null;
  const activeMembers = staff?.memberships.filter((row) => row.state === 'active').length ?? null;
  const pendingInvitations =
    staff?.invitations.filter(
      (row: StaffInvitationRecord) => row.state === 'sent' && !invitationIsOverdue(row),
    ).length ?? null;

  return (
    <div className={styles.dashboardWrap}>
      {scoped && canReadCatalogue ? (
        <p className={styles.supportingText}>
          Listing numbers cover the listings you can access from your assigned branches.
        </p>
      ) : null}

      {/* Section A — KPI row. Future operational KPIs (bookings ·
          participants · revenue · average booking value · goals) slot in
          here when their backends exist — never faked meanwhile. */}
      <ul className={styles.kpiRow} aria-label="Key numbers">
        {canReadCatalogue ? (
          <>
            <KpiCard
              value={catalogueState === 'loaded' ? counts.published : null}
              label={scoped ? 'Published (your scope)' : 'Published listings'}
              to={organizationPath(organizationId, 'listings')}
            />
            <KpiCard
              value={catalogueState === 'loaded' ? attention.length : null}
              label="Needs attention"
              href="#dashboard-attention"
              emphasized={catalogueState === 'loaded' && attention.length > 0}
            />
          </>
        ) : null}
        <KpiCard
          value={activeBranches}
          label="Active branches"
          to={organizationPath(organizationId, 'branches')}
        />
        {canReadStaff ? (
          <KpiCard
            value={activeMembers}
            label="Team members"
            to={organizationPath(organizationId, 'team')}
          />
        ) : null}
      </ul>

      <div className={styles.columns}>
        <div className={styles.mainColumn}>
          <AttentionSection
            organizationId={organizationId}
            canReadCatalogue={canReadCatalogue}
            catalogueState={catalogueState}
            onRetryCatalogue={onRetryCatalogue}
            attention={attention}
            awaiting={awaiting}
          />
          {canReadCatalogue && catalogueState === 'loaded' && rows.length > 0 ? (
            <RecentSection organizationId={organizationId} rows={rows} />
          ) : null}
        </div>

        <div className={styles.sideColumn}>
          <OrganizationSection view={view} />
          {canReadCatalogue ? (
            <CatalogueOverviewSection
              organizationId={organizationId}
              catalogueState={catalogueState}
              counts={counts}
              hasListings={rows.length > 0}
              canManage={view.membership.capabilities.includes('listings.manage')}
              suspended={view.organization.verificationState === 'suspended'}
            />
          ) : (
            <p className={styles.supportingText}>
              Your role&rsquo;s dashboard covers organization status. The catalogue is managed by
              your organization&rsquo;s catalogue roles.
            </p>
          )}
          {canReadStaff && pendingInvitations !== null && pendingInvitations > 0 ? (
            <p className={styles.supportingText}>
              {pendingInvitations} invitation{pendingInvitations === 1 ? '' : 's'} awaiting a
              response —{' '}
              <Link className={styles.inlineLink} to={organizationPath(organizationId, 'team')}>
                go to your team
              </Link>
              .
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// -- KPI card -----------------------------------------------------------------

function KpiCard({
  value,
  label,
  to,
  href,
  emphasized = false,
}: {
  value: number | null;
  label: string;
  to?: string;
  href?: string;
  emphasized?: boolean;
}) {
  const body = (
    <>
      <span className={styles.kpiValue}>{value === null ? '—' : value}</span>
      <span className={styles.kpiLabel}>{label}</span>
    </>
  );
  const cardClass = emphasized ? `${styles.kpiCard} ${styles.kpiCardEmphasis}` : styles.kpiCard;
  return (
    <li className={styles.kpiItem}>
      {to !== undefined ? (
        <Link className={cardClass} to={to}>
          {body}
        </Link>
      ) : href !== undefined ? (
        <a className={cardClass} href={href}>
          {body}
        </a>
      ) : (
        <span className={cardClass}>{body}</span>
      )}
    </li>
  );
}

// -- Section B — Needs your attention / Awaiting Himma -----------------------

function attentionCopy(item: AttentionItem): { headline: string; support: string } {
  switch (item.kind) {
    case 'changesRequested':
      return {
        headline: item.titleEn,
        support: 'Himma asked for changes — make the corrections, then resubmit for review.',
      };
    case 'approvedReadyToPublish':
      return { headline: item.titleEn, support: 'Approved by Himma — publish when you’re ready.' };
    case 'draftIncomplete':
      return { headline: item.titleEn, support: `Draft — ${item.reason.toLowerCase()} before it can be submitted.` };
    case 'organizationSetup':
      return {
        headline: 'Finish setting up your organization',
        support:
          item.verificationState === 'rejected'
            ? 'Himma asked for changes to your verification — review and resubmit.'
            : 'Complete your setup and submit it for Himma verification.',
      };
  }
}

function AttentionSection({
  organizationId,
  canReadCatalogue,
  catalogueState,
  onRetryCatalogue,
  attention,
  awaiting,
}: {
  organizationId: string;
  canReadCatalogue: boolean;
  catalogueState: 'hidden' | 'loading' | 'loaded' | 'failed';
  onRetryCatalogue: () => void;
  attention: readonly AttentionItem[];
  awaiting: readonly AwaitingItem[];
}) {
  return (
    <section aria-labelledby="dashboard-attention-heading" className={styles.section} id="dashboard-attention">
      <h2 id="dashboard-attention-heading" className={styles.sectionTitle}>
        Needs your attention
      </h2>
      <div className={styles.sectionCard}>
        {canReadCatalogue && catalogueState === 'loading' ? (
          <p className={styles.loading} role="status">
            Checking your catalogue…
          </p>
        ) : canReadCatalogue && catalogueState === 'failed' ? (
          <div className={styles.cardFailure}>
            <InlineAlert tone="error">
              We couldn&rsquo;t check your catalogue. Everything else is unaffected.
            </InlineAlert>
            <Button variant="secondary" onClick={onRetryCatalogue}>
              Try again
            </Button>
          </div>
        ) : attention.length === 0 ? (
          <p className={styles.bodyText}>
            You&rsquo;re up to date — nothing needs your attention right now.
          </p>
        ) : (
          <ul className={styles.actionList}>
            {attention.map((item) => {
              const copy = attentionCopy(item);
              const target =
                item.kind === 'organizationSetup'
                  ? organizationPath(organizationId, 'onboarding')
                  : `${organizationPath(organizationId, 'listings')}/${item.id}`;
              return (
                <li key={item.kind === 'organizationSetup' ? 'org-setup' : item.id}>
                  <Link className={styles.actionRow} to={target}>
                    <span className={styles.actionMain}>
                      <span className={styles.actionHeadline}>{copy.headline}</span>
                      <span className={styles.actionSupport}>{copy.support}</span>
                    </span>
                    <span className={styles.actionChevron} aria-hidden="true">
                      →
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {awaiting.length > 0 ? (
          <div className={styles.awaitingBlock}>
            <h3 className={styles.awaitingTitle}>Awaiting Himma</h3>
            <ul className={styles.awaitingList}>
              {awaiting.map((item) =>
                item.kind === 'organizationVerification' ? (
                  <li key="org-verification" className={styles.awaitingRow}>
                    <span>Organization verification</span>
                    <StateChip
                      label={ORGANIZATION_STATE_LABEL[item.verificationState] ?? item.verificationState}
                      tone="info"
                    />
                  </li>
                ) : (
                  <li key={item.id} className={styles.awaitingRow}>
                    <Link
                      className={styles.inlineLink}
                      to={`${organizationPath(organizationId, 'listings')}/${item.id}`}
                    >
                      {item.titleEn}
                    </Link>
                    <StateChip
                      label={listingStateLabel(item.listingState)}
                      tone={listingStateTone(item.listingState)}
                    />
                  </li>
                ),
              )}
            </ul>
            <p className={styles.supportingText}>
              Himma is reviewing these — there&rsquo;s nothing you need to do.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// -- Section C — organization status (concise) --------------------------------

function OrganizationSection({ view }: { view: OrganizationView }) {
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
            Currently suspended — everything stays readable, and changes are unavailable until
            Himma reinstates it.
          </p>
        ) : (
          <p className={styles.supportingText}>
            {view.profile.published
              ? 'Storefront published — visible to customers once the organization is live.'
              : 'Storefront not published yet.'}
          </p>
        )}
        {onboarding ? (
          <Link className={styles.inlineLink} to={organizationPath(view.organization.id, 'onboarding')}>
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

// -- Section D — compact catalogue overview -----------------------------------

function CatalogueOverviewSection({
  organizationId,
  catalogueState,
  counts,
  hasListings,
  canManage,
  suspended,
}: {
  organizationId: string;
  catalogueState: 'hidden' | 'loading' | 'loaded' | 'failed';
  counts: Record<string, number>;
  hasListings: boolean;
  canManage: boolean;
  suspended: boolean;
}) {
  return (
    <section aria-labelledby="dashboard-catalogue-heading" className={styles.section}>
      <h2 id="dashboard-catalogue-heading" className={styles.sectionTitle}>
        Catalogue
      </h2>
      <div className={styles.sectionCard}>
        {catalogueState === 'loading' ? (
          <p className={styles.loading} role="status">
            Loading your catalogue summary…
          </p>
        ) : catalogueState !== 'loaded' ? (
          <p className={styles.supportingText}>The catalogue summary isn&rsquo;t available right now.</p>
        ) : !hasListings ? (
          <>
            <p className={styles.bodyText}>No listings yet.</p>
            {canManage && !suspended ? (
              <Link className={styles.inlineLink} to={`${organizationPath(organizationId, 'listings')}/new`}>
                Create your first listing
              </Link>
            ) : (
              <p className={styles.supportingText}>
                Listings appear here once your catalogue team creates them.
              </p>
            )}
          </>
        ) : (
          <>
            <ul className={styles.statusGrid} aria-label="Listings by status">
              {DASHBOARD_STATE_ORDER.filter((state) => (counts[state] ?? 0) > 0).map((state) => (
                <li key={state} className={styles.statusCell}>
                  <StateChip label={listingStateLabel(state)} tone={listingStateTone(state)} />
                  <span className={styles.statusCount}>{counts[state]}</span>
                </li>
              ))}
            </ul>
            <Link className={styles.inlineLink} to={organizationPath(organizationId, 'listings')}>
              Go to your listings
            </Link>
          </>
        )}
      </div>
    </section>
  );
}

// -- optional — recently updated ---------------------------------------------

function RecentSection({
  organizationId,
  rows,
}: {
  organizationId: string;
  rows: readonly ProgramSummaryRecord[];
}) {
  const recent = recentListings(rows);
  return (
    <section aria-labelledby="dashboard-recent-heading" className={styles.section}>
      <h2 id="dashboard-recent-heading" className={styles.sectionTitle}>
        Recently updated
      </h2>
      <div className={styles.sectionCard}>
        <ul className={styles.recentList}>
          {recent.map((row) => {
            const thumbnailUrl = row.thumbnailUrl;
            return (
              <li key={row.id}>
                <Link
                  className={styles.recentRow}
                  to={`${organizationPath(organizationId, 'listings')}/${row.id}`}
                >
                  {thumbnailUrl !== null ? (
                    <img className={styles.recentThumb} src={thumbnailUrl} alt="" loading="lazy" />
                  ) : (
                    <span className={`${styles.recentThumb} ${styles.recentThumbFallback}`} aria-hidden="true">
                      <ImageIcon strokeWidth={1.5} className={styles.recentThumbIcon} />
                    </span>
                  )}
                  <span className={styles.recentMain}>
                    <span className={styles.recentTitle}>{row.titleEn}</span>
                    <span className={styles.recentMeta}>Updated {formatListingDate(row.updatedAt)}</span>
                  </span>
                  <StateChip label={listingStateLabel(row.listingState)} tone={listingStateTone(row.listingState)} />
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
