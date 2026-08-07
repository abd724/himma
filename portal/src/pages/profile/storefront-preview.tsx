import { BadgeCheck, Globe, Instagram, Mail, MapPin, Phone } from 'lucide-react';
import { useId } from 'react';
import type { BranchRecord } from '../../profile/contract';
import styles from './storefront-preview.module.css';

/**
 * Customer-facing storefront PREVIEW (task §8) — a frontend rendering of the
 * canonical PUBLIC projection only (`GET /providers/:organizationId`):
 * display name, English description, verified indicator (derived from
 * `live`, never claimed earlier), the four public contact fields, and
 * ACTIVE branches (label, area, address, facilities). Private fields (legal
 * name, trade name, lifecycle, publication flag) never enter this
 * component's props. Nothing is fabricated: no ratings, review counts,
 * listing totals, opening hours, distances, or booking affordances — those
 * either don't exist yet or belong to later slices.
 */
export interface StorefrontPreviewData {
  readonly displayName: string;
  readonly descriptionEn: string;
  readonly publicPhone: string;
  readonly publicEmail: string;
  readonly publicWebsite: string;
  readonly publicInstagram: string;
}

function monogram(displayName: string): string {
  const letters = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  return letters || '•';
}

export function StorefrontPreview({
  data,
  branches,
  organizationState,
  published,
}: {
  data: StorefrontPreviewData;
  branches: readonly BranchRecord[];
  organizationState: string;
  published: boolean;
}) {
  const headingId = useId();
  const isLive = organizationState === 'live';
  const activeBranches = branches.filter((branch) => branch.active);
  const displayName = data.displayName.trim();
  const description = data.descriptionEn.trim();

  const contacts = [
    { icon: Phone, label: 'Phone', value: data.publicPhone.trim() },
    { icon: Mail, label: 'Email', value: data.publicEmail.trim() },
    { icon: Globe, label: 'Website', value: data.publicWebsite.trim() },
    { icon: Instagram, label: 'Instagram', value: data.publicInstagram.trim() },
  ].filter((contact) => contact.value !== '');

  const caption = isLive
    ? published
      ? 'This is how your storefront appears to customers on Himma.'
      : 'How your storefront will appear to customers once you publish it.'
    : 'How your storefront will appear to customers once Himma takes your organization live and your storefront is published.';

  return (
    <section className={styles.preview} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.previewHeading}>
        Storefront preview
      </h2>
      <p className={styles.caption}>{caption}</p>
      <div className={styles.card}>
        <div className={styles.cover} aria-hidden="true">
          <span className={styles.monogram}>{monogram(displayName)}</span>
        </div>
        <div className={styles.cardBody}>
          <p className={styles.name}>
            {displayName !== '' ? (
              displayName
            ) : (
              <span className={styles.namePlaceholder}>Add your display name</span>
            )}
            {isLive ? (
              <span className={styles.verified}>
                <BadgeCheck aria-hidden="true" strokeWidth={2} />
                Verified
              </span>
            ) : null}
          </p>
          {description !== '' ? <p className={styles.description}>{description}</p> : null}
          {contacts.length > 0 ? (
            <ul className={styles.contacts}>
              {contacts.map((contact) => (
                <li key={contact.label} className={styles.contact}>
                  <contact.icon className={styles.contactIcon} aria-hidden="true" strokeWidth={1.75} />
                  <span className={styles.contactLabel}>{contact.label}</span>
                  <span className={styles.contactValue}>{contact.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {activeBranches.length > 0 ? (
            <div className={styles.branches}>
              <h3 className={styles.branchesHeading}>Locations</h3>
              <ul className={styles.branchList}>
                {activeBranches.map((branch) => (
                  <li key={branch.id} className={styles.branch}>
                    <MapPin className={styles.branchIcon} aria-hidden="true" strokeWidth={1.75} />
                    <div>
                      <p className={styles.branchLabel}>{branch.label}</p>
                      <p className={styles.branchMeta}>
                        {[branch.areaLabel, branch.addressLine].filter(Boolean).join(' · ')}
                      </p>
                      {branch.facilities.length > 0 ? (
                        <ul className={styles.facilities} aria-label={`${branch.label} facilities`}>
                          {branch.facilities.map((facility) => (
                            <li key={facility} className={styles.facility}>
                              {facility}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className={styles.noBranches}>
              Your locations appear here once you add an active branch.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
