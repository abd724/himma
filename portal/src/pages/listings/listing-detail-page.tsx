import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ImageOff, SearchX } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { editorAuthority, listingMutableForScope } from './editor/editor-domain';
import { usePortalPorts } from '../../app/ports-context';
import type {
  OfferRecord,
  PriceOptionRecord,
  ProgramBranchRecord,
  ProgramDetailRecord,
  ProgramMediaRecord,
} from '../../catalogue/contract';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { usePageTitle } from '../../hooks/use-page-title';
import { organizationPath } from '../../navigation/nav-items';
import { useActiveOrganization } from '../../organization/organization-context';
import type { OrganizationView } from '../../profile/contract';
import {
  ageSummary,
  CATALOGUE_NO_ACCESS_COPY,
  catalogueAuthority,
  completenessGaps,
  COMPLETENESS_GAP_COPY,
  formatAedFromFils,
  formatListingDate,
  fromPriceDisplay,
  GENDER_LABELS,
  LISTING_STATE_DESCRIPTIONS,
  isListingState,
  listingStateLabel,
  listingStateTone,
  offerKindLabel,
  priceOptionAmountDisplay,
  priceOptionKindLabel,
  priceOptionName,
  publicVisibility,
  SETTING_LABELS,
  SKILL_LABELS,
  SUSPENDED_CATALOGUE_COPY,
} from './listing-domain';
import { StateChip } from './state-chip';
import styles from './listings.module.css';

/**
 * Provider-private listing detail (docs/29 §6 route
 * `/o/:organizationId/listings/:programId`) — the READ view over the real
 * detail projection (`GET .../listings/:programId`). W2-7 renders truth
 * only: no editor, no lifecycle action, no option/branch/media/offer/
 * revision mutation exists on this surface (W2-8/W2-9 own those).
 *
 * The detail read shares the backend's ONE branch-scope reachability rule
 * with the index: a branch-scoped membership reads exactly the listings its
 * list reaches, and an in-organization out-of-scope listing collapses into
 * the SAME safe not-found surface as unknown ids and other organizations'
 * ids (no enumeration oracle).
 */
export function ListingDetailPage() {
  const organization = useActiveOrganization();
  const { programId } = useParams();
  const { profilePort, listingsPort } = usePortalPorts();

  const viewQuery = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });
  const view = viewQuery.data?.kind === 'loaded' ? viewQuery.data.view : null;
  const canRead = view !== null && catalogueAuthority(view).canRead;

  const detailQuery = useQuery({
    queryKey: ['listing', organization.id, programId],
    queryFn: () => listingsPort.loadListing(organization.id, programId ?? ''),
    // Never fetched for roles without catalogue.read — the backend would
    // refuse the read, and no listing data may reach their client state.
    enabled: canRead,
  });

  const program = detailQuery.data?.kind === 'loaded' ? detailQuery.data.program : null;
  usePageTitle(program === null ? 'Listing' : program.titleEn);

  return (
    <>
      <p className={styles.backLinkWrap}>
        <Link className={styles.backLink} to={organizationPath(organization.id, 'listings')}>
          <ArrowLeft aria-hidden="true" strokeWidth={1.75} className={styles.backIcon} />
          Back to listings
        </Link>
      </p>
      {viewQuery.isPending ? (
        <p className={styles.loading} role="status">
          Loading this listing…
        </p>
      ) : view === null ? (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load this workspace. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void viewQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : !canRead ? (
        <div className={styles.emptyCard}>
          <SearchX className={styles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
          <h2 className={styles.emptyTitle}>Listings are managed by your catalogue team</h2>
          <p className={styles.emptyBody}>{CATALOGUE_NO_ACCESS_COPY}</p>
        </div>
      ) : detailQuery.isPending ? (
        <p className={styles.loading} role="status">
          Loading this listing…
        </p>
      ) : program !== null ? (
        <ListingDetail view={view} program={program} />
      ) : detailQuery.data?.kind === 'notFound' ? (
        <ListingNotFound organizationId={organization.id} />
      ) : detailQuery.data?.kind === 'forbidden' ? (
        <div className={styles.emptyCard}>
          <SearchX className={styles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
          <h2 className={styles.emptyTitle}>Listings are managed by your catalogue team</h2>
          <p className={styles.emptyBody}>{CATALOGUE_NO_ACCESS_COPY}</p>
        </div>
      ) : (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load this listing. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void detailQuery.refetch()}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * ONE safe surface for every inaccessible id: unknown listings and other
 * organizations' listings are indistinguishable here, exactly like the
 * backend's collapsed not-found shape (no enumeration oracle).
 */
function ListingNotFound({ organizationId }: { organizationId: string }) {
  return (
    <div className={styles.emptyCard}>
      <SearchX className={styles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
      <h2 className={styles.emptyTitle}>Listing not found</h2>
      <p className={styles.emptyBody}>
        This listing doesn&rsquo;t exist or isn&rsquo;t part of this organization.
      </p>
      <Link className={styles.inlineLink} to={organizationPath(organizationId, 'listings')}>
        Go to your listings
      </Link>
    </div>
  );
}

function ListingDetail({ view, program }: { view: OrganizationView; program: ProgramDetailRecord }) {
  const authority = catalogueAuthority(view);
  // The editor entry point appears ONLY where mutation authority truly
  // exists: `listings.manage` plus the STRICTER branch-scope mutation rule
  // (readable never implies editable) and no suspension. The editor route
  // itself renders read-only truth for locked lifecycle states.
  const canOpenEditor =
    editorAuthority(view).canManage &&
    !authority.suspended &&
    listingMutableForScope(program, authority.assignedActiveBranchIds);

  return (
    <div className={styles.detailWrap}>
      <header className={styles.detailHeader}>
        <div className={styles.detailHeadline}>
          <h1 className={styles.detailTitle}>{program.titleEn}</h1>
          <StateChip
            label={listingStateLabel(program.listingState)}
            tone={listingStateTone(program.listingState)}
          />
        </div>
        <p className={styles.detailSubline}>
          {program.activityType.labelEn}
          {' · '}
          {SETTING_LABELS[program.setting] ?? program.setting}
        </p>
        {canOpenEditor ? (
          <p className={styles.detailSubline}>
            <Link
              className={styles.inlineLink}
              to={`${organizationPath(view.organization.id, 'listings')}/${program.id}/edit`}
            >
              Edit listing
            </Link>
          </p>
        ) : null}
      </header>

      {authority.suspended ? (
        <InlineAlert tone="info">{SUSPENDED_CATALOGUE_COPY}</InlineAlert>
      ) : null}

      <StatusSection view={view} program={program} />
      <OverviewSection program={program} />
      <EligibilitySection program={program} />
      <PricingSection options={program.priceOptions} />
      <BranchesSection
        branches={program.branches}
        assignedActiveBranchIds={authority.assignedActiveBranchIds}
      />
      <MediaSection media={program.media} />
      <OffersSection offers={program.offers} />
      <ReviewSection program={program} />
    </div>
  );
}

// -- status ------------------------------------------------------------------

function StatusSection({ view, program }: { view: OrganizationView; program: ProgramDetailRecord }) {
  const stateDescription = isListingState(program.listingState)
    ? LISTING_STATE_DESCRIPTIONS[program.listingState]
    : null;
  const visibility = publicVisibility(view, program);
  const gaps = completenessGaps(program);
  const showReadiness =
    program.listingState === 'draft' || program.listingState === 'changes_requested';

  return (
    <section aria-labelledby="listing-status-heading" className={styles.section}>
      <h2 id="listing-status-heading" className={styles.sectionTitle}>
        Status
      </h2>
      <div className={styles.sectionCard}>
        <p className={styles.statusState}>{listingStateLabel(program.listingState)}</p>
        {stateDescription !== null ? <p className={styles.bodyText}>{stateDescription}</p> : null}
        {program.publishedAt !== null && program.listingState === 'published' ? (
          <p className={styles.supportingText}>
            First published {formatListingDate(program.publishedAt)}
          </p>
        ) : null}
        {program.archivedAt !== null && program.listingState === 'archived' ? (
          <p className={styles.supportingText}>Archived {formatListingDate(program.archivedAt)}</p>
        ) : null}

        {program.listingState === 'published' ? (
          <div className={styles.visibilityBlock}>
            {visibility.visible ? (
              <p className={styles.visibilityHeadline}>Customers can find this listing on Himma.</p>
            ) : (
              <>
                <p className={styles.visibilityHeadline}>
                  Customers can&rsquo;t see this listing yet.
                </p>
                <p className={styles.supportingText}>
                  A published listing is publicly visible only while all of these hold:
                </p>
                <ul className={styles.visibilityList}>
                  <li className={visibility.listingPublished ? styles.gateMet : styles.gateBlocked}>
                    {visibility.listingPublished ? 'Met — ' : 'Not met — '}the listing is published
                  </li>
                  <li className={visibility.organizationLive ? styles.gateMet : styles.gateBlocked}>
                    {visibility.organizationLive ? 'Met — ' : 'Not met — '}the organization is live
                    on Himma
                  </li>
                  <li
                    className={visibility.storefrontPublished ? styles.gateMet : styles.gateBlocked}
                  >
                    {visibility.storefrontPublished ? 'Met — ' : 'Not met — '}the public storefront
                    is published
                  </li>
                  <li
                    className={
                      visibility.activeBranchAssociation ? styles.gateMet : styles.gateBlocked
                    }
                  >
                    {visibility.activeBranchAssociation ? 'Met — ' : 'Not met — '}it runs at at
                    least one active branch
                  </li>
                </ul>
              </>
            )}
          </div>
        ) : null}

        {showReadiness ? (
          <div className={styles.readinessBlock}>
            {gaps.length === 0 ? (
              <p className={styles.supportingText}>
                This listing meets the submission requirements. Submitting for review arrives in an
                upcoming portal update.
              </p>
            ) : (
              <>
                <p className={styles.supportingText}>
                  Before it can be submitted for Himma review, this listing still needs:
                </p>
                <ul className={styles.readinessList}>
                  {gaps.map((gap) => (
                    <li key={gap}>{COMPLETENESS_GAP_COPY[gap]}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// -- overview ---------------------------------------------------------------

function OverviewSection({ program }: { program: ProgramDetailRecord }) {
  return (
    <section aria-labelledby="listing-overview-heading" className={styles.section}>
      <h2 id="listing-overview-heading" className={styles.sectionTitle}>
        Overview
      </h2>
      <div className={styles.sectionCard}>
        <dl className={styles.definitionList}>
          <div className={styles.definitionRow}>
            <dt>Title</dt>
            <dd>{program.titleEn}</dd>
          </div>
          {program.titleAr !== null ? (
            <div className={styles.definitionRow}>
              <dt>Arabic title</dt>
              <dd lang="ar">{program.titleAr}</dd>
            </div>
          ) : null}
          <div className={styles.definitionRow}>
            <dt>Description</dt>
            <dd>
              {program.descriptionEn !== null && program.descriptionEn.trim() !== ''
                ? program.descriptionEn
                : 'No description yet.'}
            </dd>
          </div>
          {program.descriptionAr !== null ? (
            <div className={styles.definitionRow}>
              <dt>Arabic description</dt>
              <dd lang="ar">{program.descriptionAr}</dd>
            </div>
          ) : null}
          <div className={styles.definitionRow}>
            <dt>Activity type</dt>
            <dd>
              {program.activityType.labelEn}
              {!program.activityType.active
                ? ' (no longer in the Himma catalogue — a current activity type is needed before submission)'
                : ''}
            </dd>
          </div>
          <div className={styles.definitionRow}>
            <dt>Setting</dt>
            <dd>{SETTING_LABELS[program.setting] ?? program.setting}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

// -- eligibility -------------------------------------------------------------

function EligibilitySection({ program }: { program: ProgramDetailRecord }) {
  return (
    <section aria-labelledby="listing-eligibility-heading" className={styles.section}>
      <h2 id="listing-eligibility-heading" className={styles.sectionTitle}>
        Eligibility
      </h2>
      <div className={styles.sectionCard}>
        <dl className={styles.definitionList}>
          <div className={styles.definitionRow}>
            <dt>Ages</dt>
            <dd>{ageSummary(program)}</dd>
          </div>
          <div className={styles.definitionRow}>
            <dt>Who it&rsquo;s for</dt>
            <dd>{GENDER_LABELS[program.genderEligibility] ?? program.genderEligibility}</dd>
          </div>
          {program.skillLevel !== null ? (
            <div className={styles.definitionRow}>
              <dt>Skill level</dt>
              <dd>{SKILL_LABELS[program.skillLevel] ?? program.skillLevel}</dd>
            </div>
          ) : null}
          {program.eligibilityNotes !== null && program.eligibilityNotes.trim() !== '' ? (
            <div className={styles.definitionRow}>
              <dt>Notes</dt>
              <dd>{program.eligibilityNotes}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

// -- pricing options ---------------------------------------------------------

/**
 * ProgramPriceOptions UNDER the one listing (D-S4-1): each row is a
 * commercial way to purchase the SAME program — never its own listing. No
 * authoritative single price exists; the “From …” line is a display
 * convenience derived from the active options at render time.
 */
function PricingSection({ options }: { options: readonly PriceOptionRecord[] }) {
  const fromPrice = fromPriceDisplay(options);
  return (
    <section aria-labelledby="listing-pricing-heading" className={styles.section}>
      <h2 id="listing-pricing-heading" className={styles.sectionTitle}>
        Pricing options
      </h2>
      <div className={styles.sectionCard}>
        {options.length === 0 ? (
          <p className={styles.supportingText}>
            No pricing options yet. A listing needs at least one active price option before it can
            be submitted for review.
          </p>
        ) : (
          <>
            {fromPrice !== null ? <p className={styles.supportingText}>{fromPrice}</p> : null}
            <ul className={styles.optionList} aria-label="Pricing options">
              {options.map((option) => {
                // When no commercial label exists the kind IS the display
                // name — repeating it as meta would be noise.
                const metaParts = [
                  ...(option.labelEn !== null ? [priceOptionKindLabel(option.kind)] : []),
                  ...(option.sessionsCount !== null ? [`${option.sessionsCount} sessions`] : []),
                ];
                return (
                <li key={option.id} className={styles.optionRow}>
                  <span className={styles.optionMain}>
                    <span className={styles.optionName}>{priceOptionName(option)}</span>
                    {metaParts.length > 0 ? (
                      <span className={styles.optionMeta}>{metaParts.join(' · ')}</span>
                    ) : null}
                  </span>
                  <span className={styles.optionAside}>
                    <span className={styles.optionAmount}>{priceOptionAmountDisplay(option)}</span>
                    {option.state === 'archived' ? (
                      <StateChip label="Archived" tone="neutral" />
                    ) : null}
                  </span>
                </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

// -- branches ---------------------------------------------------------------

function branchStatus(branch: ProgramBranchRecord): string {
  if (!branch.associationActive) {
    return 'No longer offered here';
  }
  return branch.branchActive ? 'Active' : 'Branch deactivated';
}

function BranchesSection({
  branches,
  assignedActiveBranchIds,
}: {
  branches: readonly ProgramBranchRecord[];
  assignedActiveBranchIds: readonly string[] | null;
}) {
  return (
    <section aria-labelledby="listing-branches-heading" className={styles.section}>
      <h2 id="listing-branches-heading" className={styles.sectionTitle}>
        Locations
      </h2>
      <div className={styles.sectionCard}>
        {branches.length === 0 ? (
          <p className={styles.supportingText}>
            This listing isn&rsquo;t placed at a branch yet. It needs at least one active branch
            before it can be submitted for review.
          </p>
        ) : (
          <ul className={styles.branchList} aria-label="Branches this listing runs at">
            {branches.map((branch) => (
              <li key={branch.branchId} className={styles.branchRow}>
                <span className={styles.branchMain}>
                  <span className={styles.branchName}>
                    {branch.label}
                    {assignedActiveBranchIds !== null &&
                    assignedActiveBranchIds.includes(branch.branchId) ? (
                      <span className={styles.scopeChip}>Assigned to you</span>
                    ) : null}
                  </span>
                </span>
                <StateChip
                  label={branchStatus(branch)}
                  tone={
                    branch.associationActive && branch.branchActive ? 'positive' : 'neutral'
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// -- media (reference metadata only — Class-C media-backend gap carried) -----

function MediaSection({ media }: { media: readonly ProgramMediaRecord[] }) {
  return (
    <section aria-labelledby="listing-media-heading" className={styles.section}>
      <h2 id="listing-media-heading" className={styles.sectionTitle}>
        Photos
      </h2>
      <div className={styles.sectionCard}>
        {media.length === 0 ? (
          <p className={styles.supportingText}>No photos are attached to this listing yet.</p>
        ) : (
          <ul className={styles.mediaList} aria-label="Listing photos">
            {media.map((entry) => (
              <li key={entry.id} className={styles.mediaRow}>
                <span className={styles.mediaThumb} aria-hidden="true">
                  <ImageOff strokeWidth={1.5} className={styles.mediaThumbIcon} />
                </span>
                <span className={styles.mediaMain}>
                  <span className={styles.mediaAlt}>
                    {entry.altTextEn !== null && entry.altTextEn.trim() !== ''
                      ? entry.altTextEn
                      : 'No photo description provided'}
                  </span>
                </span>
                {!entry.active ? <StateChip label="Removed" tone="neutral" /> : null}
              </li>
            ))}
          </ul>
        )}
        <p className={styles.mediaNote}>
          Photo previews aren&rsquo;t available in the portal yet — these entries reference the
          photos on file for this listing.
        </p>
      </div>
    </section>
  );
}

// -- offers (informational — a separate truth from pricing options) ----------

function offerWindow(offer: OfferRecord): string | null {
  if (offer.effectiveStart === null && offer.effectiveEnd === null) {
    return null;
  }
  const start = offer.effectiveStart !== null ? formatListingDate(offer.effectiveStart) : null;
  const end = offer.effectiveEnd !== null ? formatListingDate(offer.effectiveEnd) : null;
  if (start !== null && end !== null) {
    return `${start} – ${end}`;
  }
  return start !== null ? `From ${start}` : `Until ${end ?? ''}`;
}

function OffersSection({ offers }: { offers: readonly OfferRecord[] }) {
  return (
    <section aria-labelledby="listing-offers-heading" className={styles.section}>
      <h2 id="listing-offers-heading" className={styles.sectionTitle}>
        Offers
      </h2>
      <div className={styles.sectionCard}>
        {offers.length === 0 ? (
          <p className={styles.supportingText}>No offers on this listing.</p>
        ) : (
          <ul className={styles.optionList} aria-label="Offers">
            {offers.map((offer) => {
              const window = offerWindow(offer);
              return (
                <li key={offer.id} className={styles.optionRow}>
                  <span className={styles.optionMain}>
                    <span className={styles.optionName}>{offer.labelEn}</span>
                    <span className={styles.optionMeta}>
                      {offerKindLabel(offer.kind)}
                      {offer.trialAmountFils !== null
                        ? ` · ${formatAedFromFils(offer.trialAmountFils)}`
                        : ''}
                      {window !== null ? ` · ${window}` : ''}
                    </span>
                  </span>
                  <StateChip
                    label={offer.state === 'active' ? 'Active' : 'Ended'}
                    tone={offer.state === 'active' ? 'positive' : 'neutral'}
                  />
                </li>
              );
            })}
          </ul>
        )}
        <p className={styles.supportingText}>
          Offers are highlights customers see on the listing — they&rsquo;re separate from the
          pricing options above.
        </p>
      </div>
    </section>
  );
}

// -- review / pending changes (read-only; decisions are Himma-side) ----------

function ReviewSection({ program }: { program: ProgramDetailRecord }) {
  const reviewGated =
    program.listingState === 'approved' ||
    program.listingState === 'published' ||
    program.listingState === 'paused';
  if (program.openRevision === null && !reviewGated) {
    return null;
  }
  return (
    <section aria-labelledby="listing-review-heading" className={styles.section}>
      <h2 id="listing-review-heading" className={styles.sectionTitle}>
        Protected changes
      </h2>
      <div className={styles.sectionCard}>
        {program.openRevision !== null ? (
          <>
            <p className={styles.bodyText}>Changes pending Himma review.</p>
            <p className={styles.supportingText}>
              Submitted {formatListingDate(program.openRevision.createdAt)}. Sensitive details
              (like pricing and eligibility) keep their current values on the catalogue until
              Himma approves the change.
            </p>
          </>
        ) : (
          <p className={styles.supportingText}>No changes pending Himma review.</p>
        )}
      </div>
    </section>
  );
}
