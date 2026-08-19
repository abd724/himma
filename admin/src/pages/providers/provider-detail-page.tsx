import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useProvidersPort } from '../../app/app';
import {
  LISTING_STATES,
  type ListingState,
  type OrganizationDetail,
} from '../../providers/contract';
import pageStyles from '../pages.module.css';
import styles from './providers.module.css';
import { REVIEW_LABELS, STATE_LABELS } from './providers-index-page';
import { VerificationPanel } from './verification-panel';

/**
 * W3-2 internal Provider detail — the operations view over one
 * organization's REAL current truth: identity/lifecycle, storefront,
 * branches, team, and catalogue state counts. READ-ONLY: no lifecycle
 * buttons exist (verify/reject/go-live/suspend belong to later slices
 * behind the VerificationCase authority), and the verification section
 * shows the current STATE only — evidence review does not exist yet and
 * nothing here pretends it does.
 */

const LISTING_LABELS: Record<ListingState, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  in_review: 'In review',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  published: 'Published',
  paused: 'Paused',
  archived: 'Archived',
};

const PROVIDER_ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  org_manager: 'Organization manager',
  branch_manager: 'Branch manager',
  listings_editor: 'Listings editor',
  coach: 'Coach',
  front_desk: 'Front desk',
  finance: 'Finance',
};

const dateTimeFormat = new Intl.DateTimeFormat('en-AE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function formatDate(value: string): string {
  return dateTimeFormat.format(new Date(value));
}

function OverviewSection({ detail }: { detail: OrganizationDetail }) {
  const { organization, profile } = detail;
  return (
    <section className={styles.sectionPanel} aria-labelledby="overview-title">
      <h2 id="overview-title" className={styles.sectionTitle}>
        Overview
      </h2>
      <dl className={styles.factList}>
        <dt>Status</dt>
        <dd>
          <span className={styles.badge + ' ' + styles.badgeNeutral}>
            {STATE_LABELS[organization.verificationState]}
          </span>
        </dd>
        <dt>Review</dt>
        <dd>{REVIEW_LABELS[organization.reviewState]}</dd>
        <dt>Trade name</dt>
        <dd>{organization.tradeName}</dd>
        <dt>Legal name</dt>
        <dd>{organization.legalName}</dd>
        <dt>Storefront</dt>
        <dd>
          {profile.publiclyVisible
            ? 'Publicly visible (live and published)'
            : profile.published
              ? 'Published by the provider, not publicly visible until live'
              : 'Not published'}
        </dd>
        <dt>Created</dt>
        <dd>{formatDate(organization.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{formatDate(organization.updatedAt)}</dd>
        {organization.suspendedAt !== null ? (
          <>
            <dt>Suspended</dt>
            <dd>{formatDate(organization.suspendedAt)}</dd>
          </>
        ) : null}
        {organization.offboardedAt !== null ? (
          <>
            <dt>Offboarded</dt>
            <dd>{formatDate(organization.offboardedAt)}</dd>
          </>
        ) : null}
        {profile.publicPhone !== null ? (
          <>
            <dt>Public phone</dt>
            <dd>{profile.publicPhone}</dd>
          </>
        ) : null}
        {profile.publicEmail !== null ? (
          <>
            <dt>Public email</dt>
            <dd>{profile.publicEmail}</dd>
          </>
        ) : null}
        {profile.publicWebsite !== null ? (
          <>
            <dt>Website</dt>
            <dd>{profile.publicWebsite}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

// The W3-5 review workspace replaced the W3-2 placeholder section — see
// verification-panel.tsx (AD-03 case UX over the real backend path).

function BranchesSection({ detail }: { detail: OrganizationDetail }) {
  return (
    <section className={styles.sectionPanel} aria-labelledby="branches-title">
      <h2 id="branches-title" className={styles.sectionTitle}>
        Branches ({detail.branches.length})
      </h2>
      {detail.branches.length === 0 ? (
        <p className={pageStyles.panelBody}>No branches recorded.</p>
      ) : (
        <ul className={styles.subList}>
          {detail.branches.map((branch) => (
            <li key={branch.id} className={styles.subItem}>
              <span className={styles.subPrimary}>{branch.label}</span>
              <span className={styles.subSecondary}>
                {branch.areaLabel}
                {branch.city !== null ? ` · ${branch.city}` : ''}
                {branch.addressLine !== null ? ` · ${branch.addressLine}` : ''}
              </span>
              {branch.active ? null : (
                <span className={`${styles.badge} ${styles.badgeBlocked}`}>Inactive</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamSection({ detail }: { detail: OrganizationDetail }) {
  return (
    <section className={styles.sectionPanel} aria-labelledby="team-title">
      <h2 id="team-title" className={styles.sectionTitle}>
        Team ({detail.team.length})
      </h2>
      {detail.team.length === 0 ? (
        <p className={pageStyles.panelBody}>No active staff memberships.</p>
      ) : (
        <ul className={styles.subList}>
          {detail.team.map((member) => (
            <li key={member.membershipId} className={styles.subItem}>
              <span className={styles.subPrimary}>
                {member.displayName ?? 'No display name recorded'}
              </span>
              <span className={styles.subSecondary}>
                {PROVIDER_ROLE_LABELS[member.role] ?? member.role}
                {member.branchScopeKind === 'all' ? ' · all branches' : ' · branch-scoped'}
                {` · since ${formatDate(member.createdAt)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CatalogueSection({ detail }: { detail: OrganizationDetail }) {
  return (
    <section className={styles.sectionPanel} aria-labelledby="catalogue-title">
      <h2 id="catalogue-title" className={styles.sectionTitle}>
        Catalogue ({detail.catalogue.total} listing{detail.catalogue.total === 1 ? '' : 's'})
      </h2>
      {detail.catalogue.total === 0 ? (
        <p className={pageStyles.panelBody}>This provider has no listings yet.</p>
      ) : (
        <div className={styles.countGrid}>
          {LISTING_STATES.filter((state) => detail.catalogue.byState[state] > 0).map((state) => (
            <div key={state} className={styles.countCell}>
              <span className={styles.countValue}>{detail.catalogue.byState[state]}</span>
              <span className={styles.countLabel}>{LISTING_LABELS[state]}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function ProviderDetailPage() {
  const port = useProvidersPort();
  const { organizationId } = useParams<{ organizationId: string }>();

  const query = useQuery({
    queryKey: ['admin-organization', organizationId],
    enabled: organizationId !== undefined,
    async queryFn() {
      const outcome = await port.getOrganization(organizationId ?? '');
      if (outcome.kind !== 'loaded') {
        throw new Error(outcome.kind);
      }
      return outcome.detail;
    },
    // Semantic refusals are authoritative — retry only transient failures.
    retry: (failureCount, error) =>
      error.message !== 'forbidden' && error.message !== 'notFound' && failureCount < 1,
  });

  return (
    <>
      <Link className={styles.backLink} to="/providers">
        ← Providers
      </Link>
      {query.isPending ? (
        <div className={styles.statusPanel} role="status">
          Loading provider…
        </div>
      ) : query.isError ? (
        query.error.message === 'notFound' ? (
          <>
            <h1 className={pageStyles.pageTitle}>Provider not found</h1>
            <div className={styles.statusPanel}>
              There’s no provider organization at this address.
            </div>
          </>
        ) : query.error.message === 'forbidden' ? (
          <div className={styles.statusPanel}>
            Your roles don’t include provider operations, so this record isn’t available to you.
          </div>
        ) : (
          <div className={styles.statusPanel} role="alert">
            <p style={{ marginTop: 0 }}>We couldn’t load this provider.</p>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void query.refetch()}
            >
              Try again
            </button>
          </div>
        )
      ) : (
        <>
          <h1 className={pageStyles.pageTitle}>{query.data.profile.displayName}</h1>
          <div className={styles.detailGrid}>
            <OverviewSection detail={query.data} />
            <VerificationPanel organizationId={query.data.organization.id} />
            <BranchesSection detail={query.data} />
            <TeamSection detail={query.data} />
            <CatalogueSection detail={query.data} />
          </div>
        </>
      )}
    </>
  );
}
