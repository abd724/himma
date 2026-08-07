import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { PageHeader } from '../../components/ui/page-header';
import { ActionLink } from '../../components/ui/action-link';
import { usePageTitle } from '../../hooks/use-page-title';
import { organizationPath } from '../../navigation/nav-items';
import { useActiveOrganization } from '../../organization/organization-context';
import { usePortalPorts } from '../../app/ports-context';
import type { OrganizationView } from '../../profile/contract';
import { ORGANIZATION_STATE_LABEL, isStillOnboarding } from './organization-state';
import { PublicationPanel } from './publication-panel';
import { StorefrontPanel } from './storefront-panel';
import styles from './business-profile-page.module.css';

/**
 * Business Profile (docs/29 §6 route `/o/:organizationId/profile`, tabs
 * business · storefront · publication): ONE provider experience over the
 * canonical STRUCTURAL split — the private organization record (legal/trade
 * identity, lifecycle; admin-recorded, read-only here) versus the public
 * storefront projection (`organization_public_profile`; editable with
 * `profile.edit`). The UI never blurs which side a field lives on.
 */

export function BusinessProfilePage() {
  usePageTitle('Business Profile');
  const organization = useActiveOrganization();
  const { profilePort } = usePortalPorts();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });

  const refreshView = () =>
    queryClient.invalidateQueries({ queryKey: ['organizationView', organization.id] });
  const refreshOnboarding = () =>
    queryClient.invalidateQueries({ queryKey: ['onboarding', organization.id] });

  return (
    <>
      <PageHeader
        title="Business Profile"
        description="Your organization's details and your public storefront — what customers see on Himma."
      />
      {query.isPending ? (
        <p className={styles.loading} role="status">
          Loading your business profile…
        </p>
      ) : !query.isError && query.data && query.data.kind === 'loaded' ? (
        <ProfileTabs
          view={query.data.view}
          onRefreshView={refreshView}
          onSaved={() => Promise.all([refreshView(), refreshOnboarding()])}
        />
      ) : (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load your business profile. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

const TABS = [
  { id: 'business', label: 'Business information' },
  { id: 'storefront', label: 'Public storefront' },
  { id: 'publication', label: 'Publication' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function ProfileTabs({
  view,
  onRefreshView,
  onSaved,
}: {
  view: OrganizationView;
  /** Resolves once the refreshed organization view is back in the cache. */
  onRefreshView: () => Promise<unknown>;
  /** Resolves once view + onboarding caches reflect the saved profile. */
  onSaved: () => Promise<unknown>;
}) {
  const [activeTab, setActiveTab] = useState<TabId>('business');
  const canEdit = view.membership.capabilities.includes('profile.edit');
  const suspended = view.organization.verificationState === 'suspended';

  const onTabListKeyDown = (event: ReactKeyboardEvent) => {
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = TABS.length - 1;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const next = TABS[nextIndex];
    if (next) {
      setActiveTab(next.id);
      document.getElementById(`profile-tab-${next.id}`)?.focus();
    }
  };

  return (
    <div className={styles.tabsWrap}>
      <div role="tablist" aria-label="Business Profile sections" className={styles.tabList}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`profile-tab-${tab.id}`}
            aria-selected={tab.id === activeTab}
            aria-controls={`profile-panel-${tab.id}`}
            tabIndex={tab.id === activeTab ? 0 : -1}
            className={`${styles.tab} ${tab.id === activeTab ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={onTabListKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Panels stay mounted so form edits survive switching tabs. */}
      <div
        role="tabpanel"
        id="profile-panel-business"
        aria-labelledby="profile-tab-business"
        hidden={activeTab !== 'business'}
        className={styles.tabPanel}
      >
        <BusinessInformationPanel view={view} />
      </div>
      <div
        role="tabpanel"
        id="profile-panel-storefront"
        aria-labelledby="profile-tab-storefront"
        hidden={activeTab !== 'storefront'}
        className={styles.tabPanel}
      >
        <StorefrontPanel
          view={view}
          canEdit={canEdit}
          suspended={suspended}
          onRefreshView={onRefreshView}
          onSaved={onSaved}
        />
      </div>
      <div
        role="tabpanel"
        id="profile-panel-publication"
        aria-labelledby="profile-tab-publication"
        hidden={activeTab !== 'publication'}
        className={styles.tabPanel}
      >
        <PublicationPanel
          view={view}
          canEdit={canEdit}
          suspended={suspended}
          onRefreshView={onRefreshView}
          onSaved={onSaved}
        />
      </div>
    </div>
  );
}

/**
 * The PRIVATE organization record: admin-recorded identity + lifecycle.
 * Nothing here is customer-visible, and nothing here is provider-editable —
 * there is no provider (or admin) endpoint that changes these fields today.
 * `legalName` arrives only when the membership holds `org.legal.view`.
 */
function BusinessInformationPanel({ view }: { view: OrganizationView }) {
  const state = view.organization.verificationState;
  const stateLabel = ORGANIZATION_STATE_LABEL[state] ?? 'Status unavailable';

  return (
    <section aria-label="Business information" className={styles.panelSection}>
      <p className={styles.panelIntro}>
        Your private business record with Himma. These details are <strong>not shown to
        customers</strong> — your public storefront is what customers see. To correct them,
        contact your Himma representative.
      </p>
      <dl className={styles.recordList}>
        {view.organization.legalName !== undefined ? (
          <div className={styles.recordRow}>
            <dt className={styles.recordTerm}>
              Legal name
              <span className={styles.privateBadge}>Private</span>
            </dt>
            <dd className={styles.recordValue}>{view.organization.legalName}</dd>
          </div>
        ) : null}
        <div className={styles.recordRow}>
          <dt className={styles.recordTerm}>
            Trade name
            <span className={styles.privateBadge}>Private</span>
          </dt>
          <dd className={styles.recordValue}>{view.organization.tradeName}</dd>
        </div>
        <div className={styles.recordRow}>
          <dt className={styles.recordTerm}>Himma status</dt>
          <dd className={styles.recordValue}>
            <span className={styles.stateChip}>{stateLabel}</span>
            {isStillOnboarding(state) ? (
              <span className={styles.recordAction}>
                <ActionLink to={organizationPath(view.organization.id, 'onboarding')}>
                  View setup status
                </ActionLink>
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
    </section>
  );
}
