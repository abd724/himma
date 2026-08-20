import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useModerationPort } from '../../app/app';
import { useSessionActions } from '../../auth/session-context';
import type {
  ModerationActionOutcome,
  ModerationListingView,
} from '../../moderation/contract';
import pageStyles from '../pages.module.css';
import styles from '../providers/providers.module.css';
import { LISTING_STATE_LABELS, listingBadgeClass } from './moderation-queue-page';

/**
 * W3-6 moderation workspace (AD-05): the reviewer's decision surface over
 * ONE listing — the authoritative current listing truth, provider
 * identity, and (when a ProgramRevision is open) the current-vs-proposed
 * change-set, with the certified decisions only: listing start-review /
 * approve / request-changes, and revision start / apply / reject.
 * The TWO mutation models never blur: an Admin action can never edit
 * provider catalogue fields directly — approval of a revision applies the
 * provider's own submitted change-set through the S4 service, atomically.
 * Feedback stays the certified machine reasonCode slug.
 */

const ACTION_MESSAGES: Record<
  Exclude<ModerationActionOutcome['kind'], 'completed' | 'stepUpRequired'>,
  string
> = {
  lifecycleConflict:
    'The listing/revision is not in a state that allows this action anymore. Refresh and re-check.',
  staleVersion: 'This item changed while you were reviewing it. Refresh and re-check.',
  revisionInvalid:
    'The proposed change no longer applies cleanly to the listing (it was refused by the catalogue rules).',
  forbidden: 'Your roles don’t include catalogue moderation.',
  notFound: 'This listing or revision no longer exists.',
  unavailable: 'The moderation service is temporarily unavailable. Try again shortly.',
};

const dateFormat = new Intl.DateTimeFormat('en-AE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function fils(amount: number | null): string {
  return amount === null ? '—' : `AED ${(amount / 100).toFixed(2)}`;
}

function eligibilitySummary(program: ModerationListingView['program']): string {
  const age = program.allAges
    ? 'All ages'
    : `Ages ${program.minAge ?? '?'}–${program.maxAge ?? 'open'}`;
  return [age, program.genderEligibility, program.skillLevel ?? undefined]
    .filter((part) => part !== undefined)
    .join(' · ');
}

/** The current-vs-proposed rows for exactly the fields the revision
 *  proposes to change (null = unchanged, never rendered). */
function changeRows(view: ModerationListingView): Array<{ label: string; current: string; proposed: string }> {
  const revision = view.revision;
  if (revision === null) return [];
  const rows: Array<{ label: string; current: string; proposed: string }> = [];
  const push = (label: string, current: unknown, proposed: unknown) => {
    rows.push({ label, current: String(current ?? '—'), proposed: String(proposed) });
  };
  if (revision.descriptionEn !== null) {
    push('Description (EN)', view.program.descriptionEn, revision.descriptionEn);
  }
  if (revision.descriptionAr !== null) push('Description (AR)', '—', revision.descriptionAr);
  if (revision.minAge !== null) push('Minimum age', view.program.minAge, revision.minAge);
  if (revision.maxAge !== null) push('Maximum age', view.program.maxAge, revision.maxAge);
  if (revision.allAges !== null) push('All ages', view.program.allAges, revision.allAges);
  if (revision.genderEligibility !== null) {
    push('Gender eligibility', view.program.genderEligibility, revision.genderEligibility);
  }
  if (revision.skillLevel !== null) push('Skill level', view.program.skillLevel, revision.skillLevel);
  if (revision.eligibilityNotes !== null) {
    push('Eligibility notes', view.program.eligibilityNotes, revision.eligibilityNotes);
  }
  if (revision.option !== null) {
    push(
      'Price option',
      'see current options',
      `${revision.option.kind ?? 'option'} ${revision.option.amountFils !== null ? fils(revision.option.amountFils) : ''} (${revision.option.state ?? 'active'})`,
    );
  }
  return rows;
}

export function ModerationDetailPage() {
  const port = useModerationPort();
  const sessionActions = useSessionActions();
  const queryClient = useQueryClient();
  const { programId } = useParams<{ programId: string }>();
  const [actionError, setActionError] = useState<string | null>(null);
  const [stepUpNeeded, setStepUpNeeded] = useState(false);
  const [stepUpCode, setStepUpCode] = useState('');
  const [reasonCode, setReasonCode] = useState('');

  const query = useQuery({
    queryKey: ['admin-moderation-listing', programId],
    enabled: programId !== undefined,
    async queryFn() {
      const outcome = await port.getListing(programId ?? '');
      if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
      return outcome.view;
    },
    retry: (failureCount, error) =>
      error.message !== 'forbidden' && error.message !== 'notFound' && failureCount < 1,
  });

  const afterAction = async (outcome: ModerationActionOutcome) => {
    if (outcome.kind === 'completed') {
      setActionError(null);
      setStepUpNeeded(false);
      setReasonCode('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-moderation-listing', programId] }),
        queryClient.invalidateQueries({ queryKey: ['admin-moderation-queue'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-revision-queue'] }),
      ]);
      return;
    }
    if (outcome.kind === 'stepUpRequired') {
      setStepUpNeeded(true);
      setActionError(
        'This action needs a fresh verification of your identity. Enter your authenticator code, then try the action again.',
      );
      return;
    }
    setActionError(ACTION_MESSAGES[outcome.kind]);
  };

  const listingAction = useMutation({
    mutationFn: (input: {
      action: 'start_review' | 'approve' | 'request_changes';
      expectedVersion: number;
    }) =>
      port.reviewListing(programId ?? '', input.action, {
        expectedVersion: input.expectedVersion,
        ...(input.action === 'request_changes' && reasonCode.trim() !== ''
          ? { reasonCode: reasonCode.trim() }
          : {}),
      }),
    onSuccess: afterAction,
  });
  const revisionStart = useMutation({
    mutationFn: (input: { revisionId: string; expectedVersion: number }) =>
      port.startRevisionReview(programId ?? '', input.revisionId, {
        expectedVersion: input.expectedVersion,
      }),
    onSuccess: afterAction,
  });
  const revisionDecision = useMutation({
    mutationFn: (input: {
      revisionId: string;
      decision: 'approve' | 'reject';
      expectedVersion: number;
    }) =>
      port.decideRevision(programId ?? '', input.revisionId, input.decision, {
        expectedVersion: input.expectedVersion,
        ...(input.decision === 'reject' && reasonCode.trim() !== ''
          ? { reasonCode: reasonCode.trim() }
          : {}),
      }),
    onSuccess: afterAction,
  });
  const busy =
    listingAction.isPending || revisionStart.isPending || revisionDecision.isPending;

  const submitStepUp = async (event: FormEvent) => {
    event.preventDefault();
    const result = await sessionActions.completeStepUpTotp(stepUpCode.trim());
    if (result.kind === 'completed') {
      setStepUpNeeded(false);
      setStepUpCode('');
      setActionError('Identity re-verified — you can run the action again now.');
    } else {
      setActionError('That code wasn’t accepted. Try again.');
    }
  };

  let content: ReactNode;
  if (query.isPending) {
    content = (
      <div className={styles.statusPanel} role="status">
        Loading listing…
      </div>
    );
  } else if (query.isError) {
    content =
      query.error.message === 'notFound' ? (
        <div className={styles.statusPanel}>There’s no listing at this address.</div>
      ) : query.error.message === 'forbidden' ? (
        <div className={styles.statusPanel}>Your roles don’t include catalogue moderation.</div>
      ) : (
        <div className={styles.statusPanel} role="alert">
          <p style={{ marginTop: 0 }}>We couldn’t load this listing.</p>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </div>
      );
  } else {
    const view = query.data;
    const { program, organization, revision } = view;
    const proposed = changeRows(view);
    content = (
      <>
        <h1 className={pageStyles.pageTitle}>{program.titleEn}</h1>
        <div className={styles.detailGrid}>
          <section className={styles.sectionPanel} aria-labelledby="listing-title">
            <h2 id="listing-title" className={styles.sectionTitle}>
              Listing
            </h2>
            <dl className={styles.factList}>
              <dt>Status</dt>
              <dd>
                <span className={listingBadgeClass(program.listingState)}>
                  {LISTING_STATE_LABELS[program.listingState] ?? program.listingState}
                </span>
              </dd>
              <dt>Provider</dt>
              <dd>
                {organization.displayName}{' '}
                <span className={styles.muted}>({organization.verificationState})</span>
              </dd>
              <dt>Eligibility</dt>
              <dd>{eligibilitySummary(program)}</dd>
              <dt>Setting</dt>
              <dd>{program.setting}</dd>
              {program.eligibilityNotes !== null ? (
                <>
                  <dt>Notes</dt>
                  <dd>{program.eligibilityNotes}</dd>
                </>
              ) : null}
              <dt>Description</dt>
              <dd>{program.descriptionEn ?? '—'}</dd>
              <dt>Prices</dt>
              <dd>
                {program.priceOptions.length === 0
                  ? 'No price options.'
                  : program.priceOptions
                      .map(
                        (option) =>
                          `${option.labelEn ?? option.kind} ${fils(option.amountFils)} (${option.state})`,
                      )
                      .join(' · ')}
              </dd>
              <dt>Branches</dt>
              <dd>
                {program.branches
                  .map(
                    (branch) => `${branch.label}${branch.associationActive ? '' : ' (inactive)'}`,
                  )
                  .join(' · ') || '—'}
              </dd>
              {program.publishedAt !== null ? (
                <>
                  <dt>Published</dt>
                  <dd>{dateFormat.format(new Date(program.publishedAt))}</dd>
                </>
              ) : null}
              <dt>Updated</dt>
              <dd>{dateFormat.format(new Date(program.updatedAt))}</dd>
            </dl>

            {actionError !== null ? (
              <p className={styles.actionNotice} role="alert">
                {actionError}
              </p>
            ) : null}
            {stepUpNeeded ? (
              <form className={styles.stepUpForm} onSubmit={(event) => void submitStepUp(event)}>
                <label className={styles.fieldLabel} htmlFor="moderation-step-up">
                  Verification code
                </label>
                <input
                  id="moderation-step-up"
                  className={styles.searchInput}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={stepUpCode}
                  onChange={(event) => setStepUpCode(event.target.value)}
                />
                <button type="submit" className={styles.secondaryButton}>
                  Confirm identity
                </button>
              </form>
            ) : null}

            {program.listingState === 'submitted' ||
            program.listingState === 'in_review' ||
            revision !== null ? (
              <div className={styles.field} style={{ marginTop: 'var(--hp-space-sm)' }}>
                <label className={styles.fieldLabel} htmlFor="moderation-reason">
                  Reason code (machine, used on request-changes / reject)
                </label>
                <input
                  id="moderation-reason"
                  className={styles.searchInput}
                  placeholder="e.g. incomplete_description"
                  value={reasonCode}
                  onChange={(event) => setReasonCode(event.target.value)}
                />
              </div>
            ) : null}
            <div className={styles.actionRow}>
              {program.listingState === 'submitted' ? (
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={busy}
                  onClick={() =>
                    listingAction.mutate({
                      action: 'start_review',
                      expectedVersion: program.version,
                    })
                  }
                >
                  Start review
                </button>
              ) : null}
              {program.listingState === 'in_review' ? (
                <>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={busy}
                    onClick={() =>
                      listingAction.mutate({ action: 'approve', expectedVersion: program.version })
                    }
                  >
                    Approve listing
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={busy}
                    onClick={() =>
                      listingAction.mutate({
                        action: 'request_changes',
                        expectedVersion: program.version,
                      })
                    }
                  >
                    Request changes
                  </button>
                </>
              ) : null}
            </div>
          </section>

          {revision !== null ? (
            <section className={styles.sectionPanel} aria-labelledby="revision-title">
              <h2 id="revision-title" className={styles.sectionTitle}>
                Proposed change (revision)
              </h2>
              <p className={styles.subSecondary}>
                Submitted {dateFormat.format(new Date(revision.createdAt))} ·{' '}
                {revision.state === 'in_review' ? 'under review' : revision.state}. Approving
                applies exactly this change-set; the listing stays{' '}
                {LISTING_STATE_LABELS[program.listingState]?.toLowerCase() ?? program.listingState}{' '}
                throughout.
              </p>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Current</th>
                    <th scope="col">Proposed</th>
                  </tr>
                </thead>
                <tbody>
                  {proposed.map((row) => (
                    <tr key={row.label}>
                      <td data-label="Field">{row.label}</td>
                      <td data-label="Current">{row.current}</td>
                      <td data-label="Proposed">{row.proposed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className={styles.actionRow}>
                {revision.state === 'submitted' ? (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={busy}
                    onClick={() =>
                      revisionStart.mutate({
                        revisionId: revision.id,
                        expectedVersion: revision.version,
                      })
                    }
                  >
                    Start revision review
                  </button>
                ) : null}
                {revision.state === 'in_review' ? (
                  <>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      disabled={busy}
                      onClick={() =>
                        revisionDecision.mutate({
                          revisionId: revision.id,
                          decision: 'approve',
                          expectedVersion: revision.version,
                        })
                      }
                    >
                      Apply revision
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={busy}
                      onClick={() =>
                        revisionDecision.mutate({
                          revisionId: revision.id,
                          decision: 'reject',
                          expectedVersion: revision.version,
                        })
                      }
                    >
                      Reject revision
                    </button>
                  </>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <>
      <Link className={styles.backLink} to="/moderation">
        ← Catalogue moderation
      </Link>
      {content}
    </>
  );
}
