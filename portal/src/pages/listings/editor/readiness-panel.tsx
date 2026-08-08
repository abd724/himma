import type { ProgramDetailRecord } from '../../../catalogue/contract';
import { VisuallyHidden } from '../../../components/ui/visually-hidden';
import { completenessGaps, type CompletenessGap } from '../listing-domain';
import styles from './editor.module.css';

const ALL_REQUIREMENTS: readonly CompletenessGap[] = [
  'title',
  'activeTaxonomy',
  'activeBranch',
  'activePriceOption',
];

/** Neutral requirement labels (state-independent — the met/missing state is
 *  announced separately); the exact backend CompletenessGap vocabulary. */
const REQUIREMENT_COPY: Record<CompletenessGap, string> = {
  title: 'An English title',
  activeTaxonomy: 'A current activity type from the Himma catalogue',
  activeBranch: 'At least one active branch where it runs',
  activePriceOption: 'At least one active price option',
};

/**
 * READINESS indicator only (task §21): the exact structured S4 completeness
 * rules a listing must meet before the NEXT lifecycle step — rendered as
 * information, never as an action. Submitting for review is W2-9's; no
 * control here changes lifecycle state. Shown on draft and
 * changes-requested listings, where the provider can still act on it.
 */
export function ReadinessPanel({ program }: { program: ProgramDetailRecord }) {
  if (program.listingState !== 'draft' && program.listingState !== 'changes_requested') {
    return null;
  }
  const gaps = completenessGaps(program);
  return (
    <section aria-labelledby="editor-readiness-heading" className={styles.section}>
      <h2 id="editor-readiness-heading" className={styles.sectionTitle}>
        Ready for review?
      </h2>
      <div className={styles.sectionCard}>
        {gaps.length === 0 ? (
          <p className={styles.sectionIntro}>
            This listing meets the submission requirements. Submitting it for Himma review arrives
            in an upcoming portal update.
          </p>
        ) : (
          <p className={styles.sectionIntro}>
            Before it can be submitted for Himma review, a listing needs all of these:
          </p>
        )}
        <ul className={styles.readinessList}>
          {ALL_REQUIREMENTS.map((requirement) => {
            const missing = gaps.includes(requirement);
            return (
              <li key={requirement} className={styles.readinessRow}>
                <span
                  className={missing ? styles.readinessMissing : styles.readinessMet}
                  aria-hidden="true"
                >
                  {missing ? 'Missing' : 'Done'}
                </span>
                <span>
                  {REQUIREMENT_COPY[requirement]}
                  <VisuallyHidden>{missing ? ' — missing' : ' — done'}</VisuallyHidden>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
