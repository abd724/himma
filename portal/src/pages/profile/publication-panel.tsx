import { CheckCircle2, CircleDashed, Eye, EyeOff } from 'lucide-react';
import { useRef, useState } from 'react';
import { usePortalPorts } from '../../app/ports-context';
import { ActionLink } from '../../components/ui/action-link';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { InlineAlert } from '../../components/ui/inline-alert';
import { organizationPath } from '../../navigation/nav-items';
import type { OrganizationView } from '../../profile/contract';
import { isStillOnboarding } from './organization-state';
import styles from './business-profile-page.module.css';

type PublicationPhase =
  | { phase: 'idle' }
  | { phase: 'working' }
  | { phase: 'done'; published: boolean }
  | { phase: 'error'; message: string };

/**
 * Storefront publication (task §9): the provider-controlled `published`
 * flag of the SAME profile PATCH (capability `profile.edit` — there is no
 * separate publish endpoint). Publication is content readiness only —
 * customers see the storefront IFF the organization is live (Himma-controlled
 * go-live) AND the storefront is published. This panel never offers, or
 * implies, a go-live control.
 */
export function PublicationPanel({
  view,
  canEdit,
  suspended,
  onRefreshView,
  onSaved,
}: {
  view: OrganizationView;
  canEdit: boolean;
  suspended: boolean;
  onRefreshView: () => Promise<unknown>;
  onSaved: () => Promise<unknown>;
}) {
  const { profilePort } = usePortalPorts();
  const [state, setState] = useState<PublicationPhase>({ phase: 'idle' });
  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);

  const published = view.profile.published;
  const isLive = view.organization.verificationState === 'live';
  const visibleToCustomers = isLive && published;

  const setPublished = async (nextPublished: boolean) => {
    if (state.phase === 'working') {
      return;
    }
    setState({ phase: 'working' });
    const outcome = await profilePort.updateProfile(view.organization.id, view.profile.version, {
      published: nextPublished,
    });
    switch (outcome.kind) {
      case 'profileUpdated':
        // Wait for the refreshed view so the status chips and the next
        // action's expectedVersion reflect the new truth before announcing.
        await onSaved();
        setState({ phase: 'done', published: nextPublished });
        break;
      case 'staleVersion':
        await onRefreshView();
        setState({
          phase: 'error',
          message:
            'Your storefront changed since this page loaded. We’ve refreshed it — review the current state and try again.',
        });
        break;
      case 'organizationSuspended':
        setState({
          phase: 'error',
          message: 'This organization is currently suspended. Changes are unavailable.',
        });
        void onRefreshView();
        break;
      case 'forbidden':
        setState({
          phase: 'error',
          message:
            'Your role can’t change publication. An owner or organization manager makes this change.',
        });
        void onRefreshView();
        break;
      default:
        setState({
          phase: 'error',
          message: 'We couldn’t update your storefront right now. Try again in a moment.',
        });
    }
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  return (
    <section aria-label="Publication" className={styles.panelSection}>
      <p className={styles.panelIntro}>
        Publishing marks your storefront content as ready for customers. Your storefront appears
        on Himma only when <strong>both</strong> are true: your storefront is published (you
        control this) and your organization is live (Himma controls this after verification).
      </p>

      <dl className={styles.recordList}>
        <div className={styles.recordRow}>
          <dt className={styles.recordTerm}>Storefront published</dt>
          <dd className={styles.recordValue}>
            <span className={styles.stateChip}>
              {published ? (
                <CheckCircle2 className={styles.chipIcon} aria-hidden="true" strokeWidth={2} />
              ) : (
                <CircleDashed className={styles.chipIcon} aria-hidden="true" strokeWidth={2} />
              )}
              {published ? 'Published' : 'Not published'}
            </span>
            <span className={styles.recordHint}>You control this.</span>
          </dd>
        </div>
        <div className={styles.recordRow}>
          <dt className={styles.recordTerm}>Organization live</dt>
          <dd className={styles.recordValue}>
            <span className={styles.stateChip}>
              {isLive ? (
                <CheckCircle2 className={styles.chipIcon} aria-hidden="true" strokeWidth={2} />
              ) : (
                <CircleDashed className={styles.chipIcon} aria-hidden="true" strokeWidth={2} />
              )}
              {isLive ? 'Live' : 'Not live yet'}
            </span>
            <span className={styles.recordHint}>
              Himma controls this.
              {!isLive && isStillOnboarding(view.organization.verificationState) ? (
                <>
                  {' '}
                  <ActionLink to={organizationPath(view.organization.id, 'onboarding')}>
                    View setup status
                  </ActionLink>
                </>
              ) : null}
            </span>
          </dd>
        </div>
        <div className={styles.recordRow}>
          <dt className={styles.recordTerm}>Visible to customers</dt>
          <dd className={styles.recordValue}>
            <span className={styles.stateChip}>
              {visibleToCustomers ? (
                <Eye className={styles.chipIcon} aria-hidden="true" strokeWidth={2} />
              ) : (
                <EyeOff className={styles.chipIcon} aria-hidden="true" strokeWidth={2} />
              )}
              {visibleToCustomers ? 'Visible' : 'Not visible'}
            </span>
            {!visibleToCustomers && published && !isLive ? (
              <span className={styles.recordHint}>
                Your storefront is ready — it appears to customers once Himma takes your
                organization live.
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
        {state.phase === 'error' ? (
          <InlineAlert tone="error">{state.message}</InlineAlert>
        ) : state.phase === 'done' ? (
          <InlineAlert tone="success">
            {state.published
              ? isLive
                ? 'Storefront published — customers can now find you on Himma.'
                : 'Storefront published — it appears to customers once Himma takes your organization live.'
              : 'Storefront unpublished — customers can no longer see it.'}
          </InlineAlert>
        ) : null}
      </div>

      {suspended ? (
        <InlineAlert tone="info">
          This organization is currently suspended. Changes are unavailable.
        </InlineAlert>
      ) : !canEdit ? (
        <p className={styles.formNote}>
          An owner or organization manager changes storefront publication.
        </p>
      ) : (
        <div className={styles.saveArea}>
          {published ? (
            <Button
              variant="secondary"
              busy={state.phase === 'working'}
              busyLabel="Working…"
              onClick={() => {
                if (isLive) {
                  setConfirmingUnpublish(true);
                } else {
                  void setPublished(false);
                }
              }}
            >
              Unpublish storefront
            </Button>
          ) : (
            <Button
              busy={state.phase === 'working'}
              busyLabel="Publishing…"
              onClick={() => void setPublished(true)}
            >
              Publish storefront
            </Button>
          )}
        </div>
      )}

      {confirmingUnpublish ? (
        <ConfirmDialog
          title="Unpublish your storefront?"
          confirmLabel="Unpublish"
          cancelLabel="Keep it published"
          destructive
          onConfirm={() => {
            setConfirmingUnpublish(false);
            void setPublished(false);
          }}
          onCancel={() => setConfirmingUnpublish(false)}
        >
          <p>
            Customers will no longer find {view.profile.displayName.trim() || 'your storefront'} on
            Himma until you publish it again.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
