import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { usePortalPorts } from '../../app/ports-context';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { PageHeader } from '../../components/ui/page-header';
import { usePageTitle } from '../../hooks/use-page-title';
import { useActiveOrganization } from '../../organization/organization-context';
import type {
  CheckInAttendance,
  CheckInPreview,
  CheckInRefusalKind,
} from '../../checkin/contract';
import styles from './check-in.module.css';

/**
 * Front-desk check-in (W2-13 §8–17, route `/o/:organizationId/check-in`) —
 * the provider surface over the two S6-2 routes. The staff member types
 * the customer's 8-digit code (numeric-first entry; QR is a LATER
 * presentation over the same authority — no scanner here), VERIFIES it
 * (a pure server read that grants nothing), reviews who/what it is for,
 * and CONFIRMS. Confirm is the single atomic authority: the backend
 * revalidates everything and records attendance in one transaction — the
 * page never decrements balances optimistically, never treats the preview
 * as permission, and renders success ONLY from the server's recorded
 * attendance. A code consumed between preview and confirm surfaces the
 * truthful refusal and clears the stale preview.
 */

const CODE_SHAPE = /^\d{8}$/;

/** Provider-facing copy per typed refusal kind. Server prose/codes are
 *  never rendered; the generic not-found stays generic (S6-2 shaping). */
const REFUSAL_COPY: Record<CheckInRefusalKind, string> = {
  codeNotFound:
    'That code doesn’t match a current check-in code for this organization. Ask the customer to open their latest code in the Himma app and read it again.',
  codeExpired:
    'That code has expired. Ask the customer to refresh their code in the Himma app and read the new one.',
  codeAlreadyUsed: 'That code has already been used for a check-in.',
  notAuthorized:
    'You don’t have access to check this customer in — it may be outside your branch or your assigned session.',
  entitlementNotActive: 'This customer’s pass isn’t active right now.',
  entitlementExhausted: 'This pass has no visits left.',
  tooManyAttempts: 'Too many invalid attempts. Try again shortly.',
  unavailable:
    'We couldn’t reach Himma right now. Nothing was recorded. Try again in a moment.',
};

/** Confirm-time refusals that mean the previewed credential is no longer
 *  redeemable — the stale preview must clear (truthful race UX, §14). */
const PREVIEW_CLEARING_REFUSALS: readonly CheckInRefusalKind[] = [
  'codeNotFound',
  'codeExpired',
  'codeAlreadyUsed',
  'entitlementNotActive',
  'entitlementExhausted',
];

const timeFormatter = new Intl.DateTimeFormat('en-AE', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

const dateFormatter = new Intl.DateTimeFormat('en-AE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const targetLabel = (preview: Pick<CheckInPreview, 'targetKind'>): string =>
  preview.targetKind === 'session'
    ? 'Scheduled session'
    : preview.targetKind === 'reservedEntitlementUse'
      ? 'Reserved visit'
      : 'Walk-in visit';

type CheckInPhase =
  | { phase: 'entry' }
  | { phase: 'verifying' }
  | { phase: 'preview'; code: string; preview: CheckInPreview; idempotencyKey: string }
  | { phase: 'confirming'; code: string; preview: CheckInPreview; idempotencyKey: string }
  | { phase: 'recorded'; attendance: CheckInAttendance };

export function CheckInPage() {
  usePageTitle('Check-In');
  const organization = useActiveOrganization();
  const { profilePort } = usePortalPorts();

  const viewQuery = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });

  return (
    <>
      <PageHeader
        title="Check-In"
        description="Enter the customer’s 8-digit code from the Himma app to record their visit."
      />
      {viewQuery.isPending ? (
        <p className={styles.loading} role="status">
          Preparing check-in…
        </p>
      ) : !viewQuery.isError && viewQuery.data && viewQuery.data.kind === 'loaded' ? (
        viewQuery.data.view.membership.capabilities.includes('attendance.manage') ? (
          <CheckInDesk organizationId={organization.id} />
        ) : (
          <InlineAlert tone="info">
            Your role can’t check customers in. Ask a manager to check this customer in at the
            desk.
          </InlineAlert>
        )
      ) : (
        <div className={styles.unavailable}>
          <InlineAlert tone="error">
            We couldn’t load this workspace. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void viewQuery.refetch()}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

function CheckInDesk({ organizationId }: { organizationId: string }) {
  const { checkinPort } = usePortalPorts();
  const [codeInput, setCodeInput] = useState('');
  const [state, setState] = useState<CheckInPhase>({ phase: 'entry' });
  const [error, setError] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  // Same-tick duplicate-gesture lock (mirrors the invite form): a queued
  // second click must not re-verify or re-redeem within the same phase.
  const busyRef = useRef(false);

  const focusAlert = () => {
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  const resetToEntry = (message: string | null) => {
    setState({ phase: 'entry' });
    setError(message);
    if (message !== null) focusAlert();
  };

  const verify = async () => {
    if (busyRef.current || state.phase === 'verifying' || state.phase === 'confirming') return;
    const code = codeInput.trim();
    if (!CODE_SHAPE.test(code)) {
      setError('Enter the full 8-digit code shown in the customer’s Himma app.');
      focusAlert();
      return;
    }
    busyRef.current = true;
    setError(null);
    setState({ phase: 'verifying' });
    const outcome = await checkinPort.previewCheckIn(organizationId, code);
    busyRef.current = false;
    if (outcome.kind === 'preview') {
      // One idempotency key per verified intent: retries of THIS confirm
      // reuse it; a fresh verification mints a fresh one.
      setState({
        phase: 'preview',
        code,
        preview: outcome.preview,
        idempotencyKey: crypto.randomUUID(),
      });
      return;
    }
    resetToEntry(REFUSAL_COPY[outcome.kind]);
  };

  const confirm = async () => {
    if (busyRef.current || state.phase !== 'preview') return;
    busyRef.current = true;
    const { code, preview, idempotencyKey } = state;
    setState({ phase: 'confirming', code, preview, idempotencyKey });
    const outcome = await checkinPort.redeemCheckIn(organizationId, {
      code,
      credentialId: preview.credentialId,
      idempotencyKey,
    });
    busyRef.current = false;
    if (outcome.kind === 'attendanceRecorded') {
      // SERVER-confirmed only — this branch is the sole success rendering.
      setCodeInput('');
      setError(null);
      setState({ phase: 'recorded', attendance: outcome.attendance });
      focusAlert();
      return;
    }
    if (PREVIEW_CLEARING_REFUSALS.includes(outcome.kind)) {
      // The credential changed under us (used elsewhere, expired, replaced)
      // — the preview is stale and must not look confirmable.
      setCodeInput('');
      resetToEntry(`This check-in wasn’t recorded. ${REFUSAL_COPY[outcome.kind]}`);
      return;
    }
    // Retryable refusals (unavailable / rate limit / scope): keep the
    // preview so the staff member can retry the SAME intent explicitly.
    setState({ phase: 'preview', code, preview, idempotencyKey });
    setError(`This check-in wasn’t recorded. ${REFUSAL_COPY[outcome.kind]}`);
    focusAlert();
  };

  if (state.phase === 'recorded') {
    const attendance = state.attendance;
    return (
      <div className={styles.successCard} ref={alertRef} tabIndex={-1} role="status">
        <h2 className={styles.cardTitle}>Checked in</h2>
        <p className={styles.successLead}>
          <strong>{attendance.participantFirstName}</strong> is checked in for{' '}
          {attendance.programTitle} ({targetLabel(attendance)}) at{' '}
          {timeFormatter.format(new Date(attendance.occurredAt))}.
        </p>
        {attendance.remaining !== undefined ? (
          attendance.entitlementExhausted === true || attendance.remaining === 0 ? (
            <InlineAlert tone="info">
              That was the last visit on this pass — it now has no visits left.
            </InlineAlert>
          ) : (
            <p className={styles.remainingNote}>
              {attendance.remaining} {attendance.remaining === 1 ? 'visit' : 'visits'} left on
              this pass after this check-in.
            </p>
          )
        ) : null}
        <div className={styles.actions}>
          <Button
            onClick={() => {
              setState({ phase: 'entry' });
              setError(null);
            }}
          >
            Check in the next customer
          </Button>
        </div>
      </div>
    );
  }

  const preview =
    state.phase === 'preview' || state.phase === 'confirming' ? state.preview : null;

  return (
    <div className={styles.desk}>
      <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
        {error !== null ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      </div>

      {preview === null ? (
        <form
          className={styles.codeForm}
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
          noValidate
        >
          <label className={styles.codeLabel} htmlFor="check-in-code">
            Customer’s check-in code
          </label>
          <p className={styles.codeHint} id="check-in-code-hint">
            The 8-digit code the customer shows you from the Himma app.
          </p>
          <input
            id="check-in-code"
            className={styles.codeInput}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            placeholder="00000000"
            aria-describedby="check-in-code-hint"
            value={codeInput}
            onChange={(event) => {
              setCodeInput(event.target.value.replace(/\D/g, '').slice(0, 8));
            }}
            disabled={state.phase === 'verifying'}
          />
          <Button
            type="submit"
            busy={state.phase === 'verifying'}
            busyLabel="Verifying…"
            disabled={!CODE_SHAPE.test(codeInput.trim())}
          >
            Verify code
          </Button>
        </form>
      ) : (
        <div className={styles.previewCard}>
          <h2 className={styles.cardTitle}>Confirm this check-in</h2>
          <dl className={styles.previewList}>
            <div className={styles.previewRow}>
              <dt>Customer</dt>
              <dd>{preview.participantFirstName}</dd>
            </div>
            <div className={styles.previewRow}>
              <dt>Program</dt>
              <dd>{preview.programTitle}</dd>
            </div>
            <div className={styles.previewRow}>
              <dt>Visit</dt>
              <dd>{targetLabel(preview)}</dd>
            </div>
            {preview.sessionStartAt !== undefined ? (
              <div className={styles.previewRow}>
                <dt>Session</dt>
                <dd>{timeFormatter.format(new Date(preview.sessionStartAt))}</dd>
              </div>
            ) : null}
            {preview.branchLabel !== undefined ? (
              <div className={styles.previewRow}>
                <dt>Branch</dt>
                <dd>{preview.branchLabel}</dd>
              </div>
            ) : null}
            {preview.usage !== undefined ? (
              <div className={styles.previewRow}>
                <dt>Pass</dt>
                <dd>
                  {preview.usage.usageKind === 'unlimited'
                    ? 'Unlimited visits'
                    : preview.usage.remaining !== undefined &&
                        preview.usage.usesTotal !== undefined
                      ? `${preview.usage.remaining} of ${preview.usage.usesTotal} visits left`
                      : 'Limited visits'}
                </dd>
              </div>
            ) : null}
            {preview.validity?.validUntil !== undefined ? (
              <div className={styles.previewRow}>
                <dt>Valid until</dt>
                <dd>{dateFormatter.format(new Date(preview.validity.validUntil))}</dd>
              </div>
            ) : null}
          </dl>
          <div className={styles.actions}>
            <Button
              onClick={() => void confirm()}
              busy={state.phase === 'confirming'}
              busyLabel="Recording…"
            >
              Confirm Check-In
            </Button>
            <Button
              variant="secondary"
              disabled={state.phase === 'confirming'}
              onClick={() => {
                setCodeInput('');
                resetToEntry(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
