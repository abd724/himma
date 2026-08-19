import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useVerificationPort } from '../../app/app';
import { useSessionActions } from '../../auth/session-context';
import type {
  OrganizationVerificationView,
  VerificationActionOutcome,
  VerificationCaseView,
} from '../../verification/contract';
import pageStyles from '../pages.module.css';
import styles from './providers.module.css';
import { STATE_LABELS } from './providers-index-page';
import type { OrganizationState } from '../../providers/contract';

/**
 * W3-5 verification review panel (AD-03): the reviewer's case workspace on
 * the provider detail page — canonical org state, round history, the
 * requirement/evidence checklist with authorized downloads, and the
 * review/decision actions over the ONE backend path. Truthful by
 * construction: content-safety unavailability disables review with the
 * real reason; a missing policy (D-W3-3) blocks opening rounds with the
 * real reason; readiness is shown but never auto-approves; every typed
 * backend refusal surfaces distinctly; step-up demands route through the
 * W3-1 re-verification seam. READ truth lives in `latestCase`; no second
 * state machine exists here.
 */

const ACTION_MESSAGES: Record<Exclude<VerificationActionOutcome['kind'], 'completed' | 'stepUpRequired' | 'notReady'>, string> = {
  caseConflict: 'The case is not in a state that allows this action anymore. Refresh and re-check.',
  lifecycleConflict:
    'The organization is not in a state that allows this action anymore. Refresh and re-check.',
  staleVersion: 'This case changed while you were looking at it. Refresh and re-check.',
  safetyUnavailable:
    'Evidence review is unavailable: the content-safety capability is not active, so documents can’t be opened and decisions can’t be recorded.',
  policyUnavailable:
    'No evidence requirement policy is configured (owner decision D-W3-3 is pending), so review rounds can’t operate.',
  invalidDecision: 'A rejection needs a reason code and a provider-facing message.',
  forbidden: 'Your roles don’t include provider verification operations.',
  notFound: 'This case no longer exists.',
  unavailable: 'The verification service is temporarily unavailable. Try again shortly.',
};

function formatBytes(byteSize: number | null): string {
  if (byteSize === null) return '';
  if (byteSize < 1024) return `${byteSize} B`;
  return `${Math.round(byteSize / 1024)} KB`;
}

const dateFormat = new Intl.DateTimeFormat('en-AE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function VerificationPanel({ organizationId }: { organizationId: string }) {
  const port = useVerificationPort();
  const sessionActions = useSessionActions();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [stepUpNeeded, setStepUpNeeded] = useState(false);
  const [stepUpCode, setStepUpCode] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState('');
  const [providerSafeMessage, setProviderSafeMessage] = useState('');
  const [internalNote, setInternalNote] = useState('');

  const query = useQuery({
    queryKey: ['admin-verification', organizationId],
    async queryFn() {
      const outcome = await port.getVerification(organizationId);
      if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
      return outcome.view;
    },
    retry: (failureCount, error) =>
      error.message !== 'forbidden' && error.message !== 'notFound' && failureCount < 1,
  });

  const afterAction = async (outcome: VerificationActionOutcome) => {
    if (outcome.kind === 'completed') {
      setActionError(null);
      setStepUpNeeded(false);
      setRejectOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-verification', organizationId] }),
        queryClient.invalidateQueries({ queryKey: ['admin-organization', organizationId] }),
        queryClient.invalidateQueries({ queryKey: ['admin-organizations'] }),
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
    if (outcome.kind === 'notReady') {
      setActionError(
        `The case can’t be approved yet — missing: ${outcome.missing
          .map((entry) => entry.labelEn)
          .join(', ')}.`,
      );
      return;
    }
    setActionError(ACTION_MESSAGES[outcome.kind]);
  };

  const openCase = useMutation({
    mutationFn: () => port.openCase(organizationId),
    onSuccess: afterAction,
  });
  const startReview = useMutation({
    mutationFn: (input: { caseId: string; expectedCaseVersion: number }) =>
      port.startReview(organizationId, input),
    onSuccess: afterAction,
  });
  const decide = useMutation({
    mutationFn: (input: Parameters<typeof port.decide>[1]) => port.decide(organizationId, input),
    onSuccess: afterAction,
  });
  const goLive = useMutation({
    mutationFn: (input: { expectedVersion: number }) => port.goLive(organizationId, input),
    onSuccess: afterAction,
  });
  const busy =
    openCase.isPending || startReview.isPending || decide.isPending || goLive.isPending;

  const download = async (evidenceId: string) => {
    const outcome = await port.downloadEvidence(evidenceId);
    if (outcome.kind !== 'document') {
      setActionError(
        outcome.kind === 'safetyUnavailable'
          ? ACTION_MESSAGES.safetyUnavailable
          : 'The document could not be retrieved.',
      );
      return;
    }
    setActionError(null);
    if (typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(outcome.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = outcome.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    }
  };

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

  if (query.isPending) {
    return (
      <section className={styles.sectionPanel} aria-labelledby="verification-title">
        <h2 id="verification-title" className={styles.sectionTitle}>
          Verification
        </h2>
        <p className={pageStyles.panelBody} role="status">
          Loading verification…
        </p>
      </section>
    );
  }
  if (query.isError) {
    return (
      <section className={styles.sectionPanel} aria-labelledby="verification-title">
        <h2 id="verification-title" className={styles.sectionTitle}>
          Verification
        </h2>
        <p className={pageStyles.panelBody} role="alert">
          {query.error.message === 'forbidden'
            ? 'Your roles don’t include provider verification operations.'
            : 'We couldn’t load the verification workspace.'}
        </p>
        {query.error.message !== 'forbidden' ? (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        ) : null}
      </section>
    );
  }

  const view = query.data;
  return (
    <section className={styles.sectionPanel} aria-labelledby="verification-title">
      <h2 id="verification-title" className={styles.sectionTitle}>
        Verification
      </h2>

      {!view.contentSafetyReady ? (
        <p className={styles.safetyBanner} role="status">
          Evidence review is unavailable: the content-safety capability is not active. Documents
          can’t be opened and review decisions can’t be recorded until it is.
        </p>
      ) : null}

      <dl className={styles.factList}>
        <dt>Organization</dt>
        <dd>{STATE_LABELS[view.organizationState as OrganizationState] ?? view.organizationState}</dd>
        <dt>Rounds</dt>
        <dd>
          {view.rounds.length === 0
            ? 'No review rounds yet.'
            : view.rounds
                .map(
                  (round) =>
                    `Round ${round.round}: ${round.state}${round.outcome !== null ? ` (${round.outcome})` : ''}`,
                )
                .join(' · ')}
        </dd>
      </dl>

      {actionError !== null ? (
        <p className={styles.actionNotice} role="alert">
          {actionError}
        </p>
      ) : null}

      {stepUpNeeded ? (
        <form className={styles.stepUpForm} onSubmit={(event) => void submitStepUp(event)}>
          <label className={styles.fieldLabel} htmlFor="verification-step-up">
            Verification code
          </label>
          <input
            id="verification-step-up"
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

      {view.latestCase === null || view.latestCase.state === 'decided' ? (
        <div className={styles.actionRow}>
          {view.organizationState === 'submitted' || view.organizationState === 'in_review' ? (
            view.policyConfigured ? (
              <button
                type="button"
                className={styles.primaryButton}
                disabled={busy}
                onClick={() => openCase.mutate()}
              >
                Open review round
              </button>
            ) : (
              <p className={pageStyles.panelBody}>
                No evidence requirement policy is configured (owner decision D-W3-3 is pending), so
                a review round can’t be opened.
              </p>
            )
          ) : null}
          {view.organizationState === 'verified' ? (
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy}
              onClick={() => goLive.mutate({ expectedVersion: view.organizationVersion })}
            >
              Go live
            </button>
          ) : null}
        </div>
      ) : null}

      {view.latestCase !== null ? (
        <CaseCard
          view={view}
          caseView={view.latestCase}
          busy={busy}
          safetyReady={view.contentSafetyReady}
          onStartReview={() =>
            startReview.mutate({
              caseId: view.latestCase!.caseId,
              expectedCaseVersion: view.latestCase!.version,
            })
          }
          onApprove={(note) =>
            decide.mutate({
              caseId: view.latestCase!.caseId,
              expectedCaseVersion: view.latestCase!.version,
              outcome: 'approved',
              ...(note !== '' ? { internalNote: note } : {}),
            })
          }
          rejectOpen={rejectOpen}
          onToggleReject={() => setRejectOpen((open) => !open)}
          onReject={() =>
            decide.mutate({
              caseId: view.latestCase!.caseId,
              expectedCaseVersion: view.latestCase!.version,
              outcome: 'rejected',
              ...(reasonCode.trim() !== '' ? { reasonCode: reasonCode.trim() } : {}),
              ...(providerSafeMessage.trim() !== ''
                ? { providerSafeMessage: providerSafeMessage.trim() }
                : {}),
              ...(internalNote.trim() !== '' ? { internalNote: internalNote.trim() } : {}),
            })
          }
          rejectFields={{
            reasonCode,
            setReasonCode,
            providerSafeMessage,
            setProviderSafeMessage,
            internalNote,
            setInternalNote,
          }}
          onDownload={(evidenceId) => void download(evidenceId)}
        />
      ) : null}
    </section>
  );
}

function CaseCard(props: {
  view: OrganizationVerificationView;
  caseView: VerificationCaseView;
  busy: boolean;
  safetyReady: boolean;
  onStartReview: () => void;
  onApprove: (internalNote: string) => void;
  rejectOpen: boolean;
  onToggleReject: () => void;
  onReject: () => void;
  rejectFields: {
    reasonCode: string;
    setReasonCode: (value: string) => void;
    providerSafeMessage: string;
    setProviderSafeMessage: (value: string) => void;
    internalNote: string;
    setInternalNote: (value: string) => void;
  };
  onDownload: (evidenceId: string) => void;
}) {
  const { caseView, busy, safetyReady } = props;
  const ready = caseView.readiness.kind === 'ready';
  return (
    <div className={styles.caseCard}>
      <h3 className={styles.subPrimary}>
        Round {caseView.round} — {caseView.state === 'in_review' ? 'under review' : caseView.state}
      </h3>
      <ul className={styles.subList} aria-label="Evidence checklist">
        {caseView.requirements.map((requirement) => (
          <li key={requirement.requirementId} className={styles.subItem}>
            <span className={styles.subPrimary}>{requirement.labelEn}</span>
            <span className={styles.subSecondary}>
              {requirement.required ? 'Required' : 'Optional'}
              {' · '}
              {requirement.currentEvidence === null
                ? 'Not submitted'
                : requirement.currentEvidence.state === 'stored'
                  ? `Stored · ${requirement.currentEvidence.originalFilename} (${formatBytes(requirement.currentEvidence.byteSize)})`
                  : `Upload pending · ${requirement.currentEvidence.originalFilename}`}
            </span>
            {requirement.currentEvidence?.state === 'stored' ? (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => props.onDownload(requirement.currentEvidence!.evidenceId)}
              >
                Download
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className={styles.subSecondary}>
        {caseView.readiness.kind === 'ready'
          ? 'All required evidence is stored — ready for a decision. Approval is always an explicit reviewer action.'
          : caseView.readiness.kind === 'missingRequirements'
            ? `Missing required evidence: ${caseView.readiness.missing.map((entry) => entry.labelEn).join(', ')}.`
            : 'The requirement policy for this round is unavailable.'}
      </p>

      {caseView.decision !== null ? (
        <dl className={styles.factList}>
          <dt>Outcome</dt>
          <dd>{caseView.decision.outcome}</dd>
          {caseView.decision.reasonCode !== null ? (
            <>
              <dt>Reason code</dt>
              <dd>{caseView.decision.reasonCode}</dd>
            </>
          ) : null}
          {caseView.decision.providerSafeMessage !== null ? (
            <>
              <dt>Provider message</dt>
              <dd>{caseView.decision.providerSafeMessage}</dd>
            </>
          ) : null}
          {caseView.decision.internalNote !== null ? (
            <>
              <dt>Internal note (staff-only)</dt>
              <dd>{caseView.decision.internalNote}</dd>
            </>
          ) : null}
          <dt>Decided</dt>
          <dd>{dateFormat.format(new Date(caseView.decision.decidedAt))}</dd>
        </dl>
      ) : null}

      <div className={styles.actionRow}>
        {caseView.state === 'open' ? (
          <button
            type="button"
            className={styles.primaryButton}
            disabled={busy || !safetyReady}
            onClick={props.onStartReview}
          >
            Start review
          </button>
        ) : null}
        {caseView.state === 'in_review' ? (
          <>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy || !safetyReady || !ready}
              onClick={() => props.onApprove('')}
            >
              Approve
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={busy || !safetyReady}
              onClick={props.onToggleReject}
            >
              Reject…
            </button>
          </>
        ) : null}
      </div>

      {props.rejectOpen && caseView.state === 'in_review' ? (
        <form
          className={styles.rejectForm}
          onSubmit={(event) => {
            event.preventDefault();
            props.onReject();
          }}
        >
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="reject-reason-code">
              Reason code (machine)
            </label>
            <input
              id="reject-reason-code"
              className={styles.searchInput}
              value={props.rejectFields.reasonCode}
              onChange={(event) => props.rejectFields.setReasonCode(event.target.value)}
              placeholder="e.g. expired_document"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="reject-provider-message">
              Provider-facing message
            </label>
            <textarea
              id="reject-provider-message"
              className={styles.searchInput}
              rows={2}
              value={props.rejectFields.providerSafeMessage}
              onChange={(event) => props.rejectFields.setProviderSafeMessage(event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="reject-internal-note">
              Internal note (never shown to the provider)
            </label>
            <textarea
              id="reject-internal-note"
              className={styles.searchInput}
              rows={2}
              value={props.rejectFields.internalNote}
              onChange={(event) => props.rejectFields.setInternalNote(event.target.value)}
            />
          </div>
          <button type="submit" className={styles.secondaryButton} disabled={busy}>
            Record rejection
          </button>
        </form>
      ) : null}
    </div>
  );
}
