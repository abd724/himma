import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProgramDetailRecord } from '../../catalogue/contract';
import type { CompletenessGap } from '../../catalogue/lifecycle-contract';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { InlineAlert } from '../../components/ui/inline-alert';
import { usePortalPorts } from '../../app/ports-context';
import { organizationPath } from '../../navigation/nav-items';
import type { OrganizationView } from '../../profile/contract';
import {
  ARCHIVE_CONFIRM,
  AWAITING_PUBLISHER_COPY,
  LIFECYCLE_ACTION_BUSY_LABELS,
  LIFECYCLE_ACTION_LABELS,
  LIFECYCLE_INCOMPLETE_INTRO,
  LIFECYCLE_SUCCESS_COPY,
  lifecycleErrorCopy,
  lifecyclePlan,
  ORGANIZATION_NOT_LIVE_COPY,
  PAUSE_CONFIRM,
  PUBLISH_BLOCKED_BY_COMPLETENESS_COPY,
  SUBMIT_READY_COPY,
  type LifecycleActionKind,
} from './lifecycle-domain';
import { completenessGaps, COMPLETENESS_GAP_COPY } from './listing-domain';
import styles from './listings.module.css';

/**
 * The ONE lifecycle action home (task §16): named commands over the
 * dedicated `ListingLifecyclePort`, rendered only where the viewer truly
 * owns the transition (no disabled-theater — absence plus a truthful
 * explanation otherwise). Every command:
 * - carries the loaded Program version (CAS — a stale command never
 *   overwrites; the panel refreshes truth and asks for review instead);
 * - is duplicate-guarded (one in-flight command at a time, the active
 *   button inert with a busy label);
 * - claims success ONLY after the port confirms the outcome, announced in
 *   a focused live region;
 * - confirms first only where that genuinely helps: pause (public
 *   visibility disappears) and archive (permanent).
 */
export function ListingLifecyclePanel({
  view,
  program,
}: {
  view: OrganizationView;
  program: ProgramDetailRecord;
}) {
  const { listingLifecyclePort } = usePortalPorts();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<LifecycleActionKind | null>(null);
  const [notice, setNotice] = useState<
    | { tone: 'success' | 'error' | 'info'; text: string; missing?: readonly CompletenessGap[] }
    | null
  >(null);
  const [confirming, setConfirming] = useState<'pause' | 'archive' | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const focusAlert = () => requestAnimationFrame(() => alertRef.current?.focus());

  const plan = lifecyclePlan(view, program);
  const organizationId = view.organization.id;

  const refreshListingTruth = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['listing', organizationId, program.id] }),
      queryClient.invalidateQueries({ queryKey: ['listings', organizationId] }),
    ]);
  };

  const run = async (action: LifecycleActionKind) => {
    if (busy !== null) {
      return;
    }
    setBusy(action);
    setNotice(null);
    try {
      const outcome = await (action === 'submit' || action === 'resubmit'
        ? listingLifecyclePort.submitProgram(organizationId, program.id, program.version)
        : action === 'publish' || action === 'resume'
          ? listingLifecyclePort.publishProgram(organizationId, program.id, program.version)
          : action === 'pause'
            ? listingLifecyclePort.pauseProgram(organizationId, program.id, program.version)
            : listingLifecyclePort.archiveProgram(organizationId, program.id, program.version));
      if (
        outcome.kind === 'programSubmitted' ||
        outcome.kind === 'programPublished' ||
        outcome.kind === 'programPaused' ||
        outcome.kind === 'programArchived'
      ) {
        await refreshListingTruth();
        setNotice({ tone: 'success', text: LIFECYCLE_SUCCESS_COPY[action] });
      } else if (outcome.kind === 'programIncomplete') {
        setNotice({
          tone: 'error',
          text: LIFECYCLE_INCOMPLETE_INTRO,
          missing: outcome.missing,
        });
        await refreshListingTruth();
      } else {
        if (
          outcome.kind === 'staleVersion' ||
          outcome.kind === 'lifecycleConflict' ||
          outcome.kind === 'notFound'
        ) {
          // Never overwrite over stale truth: reconcile to the current
          // state first, then ask the provider to review before retrying.
          await refreshListingTruth();
        }
        setNotice({ tone: 'error', text: lifecycleErrorCopy(outcome.kind) });
      }
    } finally {
      setBusy(null);
      focusAlert();
    }
  };

  const requestAction = (action: LifecycleActionKind) => {
    if (busy !== null) {
      return;
    }
    if (action === 'pause' || action === 'archive') {
      setConfirming(action);
      return;
    }
    void run(action);
  };

  const gaps = completenessGaps(program);
  const showsAnything =
    plan.actions.length > 0 ||
    plan.awaitingPublisher ||
    plan.publishBlockedByOrganization ||
    plan.publishBlockedByCompleteness ||
    notice !== null;
  if (!showsAnything) {
    return null;
  }

  const awaitingCopy =
    program.listingState === 'approved' || program.listingState === 'paused'
      ? AWAITING_PUBLISHER_COPY[program.listingState]
      : null;

  return (
    <div className={styles.lifecycleBlock}>
      {plan.actions.includes('submit') || plan.actions.includes('resubmit') ? (
        <p className={styles.supportingText}>{SUBMIT_READY_COPY}</p>
      ) : null}
      {plan.awaitingPublisher && awaitingCopy !== null ? (
        <p className={styles.bodyText}>{awaitingCopy}</p>
      ) : null}
      {plan.publishBlockedByOrganization ? (
        <>
          <p className={styles.bodyText}>{ORGANIZATION_NOT_LIVE_COPY}</p>
          <p className={styles.supportingText}>
            <Link
              className={styles.inlineLink}
              to={organizationPath(organizationId, 'onboarding')}
            >
              Check your verification status
            </Link>
          </p>
        </>
      ) : null}
      {plan.publishBlockedByCompleteness ? (
        <>
          <p className={styles.bodyText}>{PUBLISH_BLOCKED_BY_COMPLETENESS_COPY}</p>
          <ul className={styles.readinessList}>
            {gaps.map((gap) => (
              <li key={gap}>{COMPLETENESS_GAP_COPY[gap]}</li>
            ))}
          </ul>
        </>
      ) : null}

      <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
        {notice !== null ? (
          <InlineAlert tone={notice.tone}>
            {notice.text}
            {notice.missing !== undefined ? (
              <ul className={styles.readinessList}>
                {notice.missing.map((gap) => (
                  <li key={gap}>{COMPLETENESS_GAP_COPY[gap]}</li>
                ))}
              </ul>
            ) : null}
          </InlineAlert>
        ) : null}
      </div>

      {plan.actions.length > 0 ? (
        <div className={styles.lifecycleActions}>
          {plan.actions.map((action, index) => (
            <Button
              key={action}
              variant={index === 0 && action !== 'archive' ? 'primary' : 'secondary'}
              busy={busy === action}
              busyLabel={LIFECYCLE_ACTION_BUSY_LABELS[action]}
              onClick={() => requestAction(action)}
            >
              {LIFECYCLE_ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      ) : null}

      {confirming === 'pause' ? (
        <ConfirmDialog
          title={PAUSE_CONFIRM.title}
          confirmLabel={PAUSE_CONFIRM.confirmLabel}
          cancelLabel="Keep it published"
          onConfirm={() => {
            setConfirming(null);
            void run('pause');
          }}
          onCancel={() => setConfirming(null)}
        >
          <p>{PAUSE_CONFIRM.body}</p>
        </ConfirmDialog>
      ) : null}
      {confirming === 'archive' ? (
        <ConfirmDialog
          title={ARCHIVE_CONFIRM.title}
          confirmLabel={ARCHIVE_CONFIRM.confirmLabel}
          cancelLabel="Keep this listing"
          destructive
          onConfirm={() => {
            setConfirming(null);
            void run('archive');
          }}
          onCancel={() => setConfirming(null)}
        >
          <p>{ARCHIVE_CONFIRM.body}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
