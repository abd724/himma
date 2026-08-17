import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { usePortalPorts } from '../../../app/ports-context';
import type { ProgramDetailRecord } from '../../../catalogue/contract';
import { ActionLink } from '../../../components/ui/action-link';
import { Button } from '../../../components/ui/button';
import { InlineAlert } from '../../../components/ui/inline-alert';
import { organizationPath } from '../../../navigation/nav-items';
import type { OrganizationView } from '../../../profile/contract';
import { StateChip } from '../state-chip';
import { commonMutationErrorCopy, type EditorAuthority } from './editor-domain';
import styles from './editor.module.css';

/**
 * ProgramBranch management over the SHARED W2-5 branch truth: associate /
 * remove are the real commands (no CAS on the association commands — the
 * real bodies carry none); removal keeps the history row; re-associating
 * reactivates it. Same-organization ACTIVE branches only; a branch-scoped
 * manager only ever gets controls for branches they control. A draft with
 * no branches is legitimate — nothing here blocks saving elsewhere.
 *
 * Branches are PROVIDER-OWNED business entities, never a Himma dropdown:
 * the listing selects among the provider's OWN branches, and a missing
 * location routes to the real W2-5 branch-creation workflow (`branch.create`
 * = Owner + Organization Manager) — never an ad-hoc value typed here.
 */
export function LocationsSection({
  view,
  program,
  authority,
  readOnly,
}: {
  view: OrganizationView;
  program: ProgramDetailRecord;
  authority: EditorAuthority;
  readOnly: boolean;
}) {
  const { listingEditorPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const [busyBranchId, setBusyBranchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const associationOf = (branchId: string) =>
    program.branches.find((entry) => entry.branchId === branchId);

  const scopedIds = authority.assignedActiveBranchIds;
  const branchControllable = (branchId: string): boolean =>
    scopedIds === null || scopedIds.includes(branchId);

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['listing', view.organization.id, program.id],
    });
    await queryClient.invalidateQueries({ queryKey: ['listings', view.organization.id] });
  };

  const run = async (branchId: string, operation: 'add' | 'remove') => {
    if (busyBranchId !== null) {
      return;
    }
    setBusyBranchId(branchId);
    setError(null);
    const outcome =
      operation === 'add'
        ? await listingEditorPort.addBranchAssociation(view.organization.id, program.id, branchId)
        : await listingEditorPort.removeBranchAssociation(
            view.organization.id,
            program.id,
            branchId,
          );
    setBusyBranchId(null);
    if (outcome.kind === 'branchAssociated' || outcome.kind === 'branchAssociationRemoved') {
      await invalidate();
      return;
    }
    setError(
      outcome.kind === 'invalidBranch'
        ? 'That branch can’t offer this listing — it may have been deactivated. Reload and try again.'
        : commonMutationErrorCopy(outcome.kind),
    );
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  // Historical associations to branches that are now deactivated still
  // render truthfully (read-only rows) even though they can't be re-added.
  const rows = view.branches.map((branch) => {
    const association = associationOf(branch.id);
    const associated = association?.associationActive === true;
    return { branch, association, associated };
  });

  return (
    <section aria-labelledby="editor-locations-heading" className={styles.section}>
      <h2 id="editor-locations-heading" className={styles.sectionTitle}>
        Locations
      </h2>
      <div className={styles.sectionCard}>
        <p className={styles.sectionIntro}>
          Where this listing runs. A draft doesn&rsquo;t need a branch yet — it needs at least one
          active branch before it can be submitted for review.
        </p>
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          {error !== null ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        </div>
        <ul className={styles.rowList} aria-label="Branches">
          {rows.map(({ branch, association, associated }) => (
            <li key={branch.id} className={styles.childRow}>
              <div className={styles.childRowMain}>
                <span className={styles.childRowName}>
                  {branch.label}
                  {scopedIds !== null && scopedIds.includes(branch.id) ? (
                    <StateChip label="Assigned to you" tone="neutral" />
                  ) : null}
                </span>
                <span className={styles.childRowMeta}>
                  {branch.areaLabel}
                  {' · '}
                  {!branch.active
                    ? associated
                      ? 'Branch deactivated — still associated'
                      : 'Branch deactivated'
                    : associated
                      ? 'Offers this listing'
                      : association !== undefined
                        ? 'No longer offered here'
                        : 'Not offered here'}
                </span>
              </div>
              {readOnly ? null : (
                <div className={styles.childRowActions}>
                  {associated && branchControllable(branch.id) ? (
                    <Button
                      variant="secondary"
                      busy={busyBranchId === branch.id}
                      busyLabel="Removing…"
                      onClick={() => void run(branch.id, 'remove')}
                    >
                      Remove
                    </Button>
                  ) : null}
                  {!associated && branch.active && branchControllable(branch.id) ? (
                    <Button
                      variant="secondary"
                      busy={busyBranchId === branch.id}
                      busyLabel="Adding…"
                      onClick={() => void run(branch.id, 'add')}
                    >
                      {association !== undefined ? 'Offer here again' : 'Offer here'}
                    </Button>
                  ) : null}
                  {!branchControllable(branch.id) ? (
                    <span className={styles.childRowMeta}>Outside your branch scope</span>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
        {!readOnly && view.membership.capabilities.includes('branch.create') ? (
          <div className={styles.addBranchRow}>
            <p className={styles.sectionIntro}>Need a location that isn&rsquo;t listed here yet?</p>
            <ActionLink
              variant="secondary"
              to={`${organizationPath(view.organization.id, 'branches')}/new`}
            >
              <Plus aria-hidden="true" strokeWidth={2} className={styles.addBranchIcon} />
              Add a new branch
            </ActionLink>
          </div>
        ) : null}
      </div>
    </section>
  );
}
