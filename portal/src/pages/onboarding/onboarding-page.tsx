import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Clock,
  FileText,
  Lock,
  PartyPopper,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePortalPorts } from '../../app/ports-context';
import { ActionLink } from '../../components/ui/action-link';
import { Button } from '../../components/ui/button';
import { InlineAlert } from '../../components/ui/inline-alert';
import { PageHeader } from '../../components/ui/page-header';
import { usePageTitle } from '../../hooks/use-page-title';
import { organizationPath } from '../../navigation/nav-items';
import {
  deriveOnboarding,
  type OnboardingItem,
  type OnboardingStage,
  type OnboardingView,
} from '../../onboarding/derive-onboarding';
import type { OnboardingSnapshot } from '../../onboarding/contract';
import { useActiveOrganization } from '../../organization/organization-context';
import styles from './onboarding-page.module.css';

/**
 * Onboarding hub (docs/29 §9, route §6 `/o/:organizationId/onboarding`):
 * the ORCHESTRATION/STATUS surface. Editing workflows stay with their own
 * tasks (profile W2-4 · branches W2-5 · team W2-6 · listings W2-7+); this
 * page links to them and tells the truth about what remains, what Himma
 * holds, and what cannot progress yet.
 */
export function OnboardingPage() {
  usePageTitle('Getting started');
  const organization = useActiveOrganization();
  const { onboardingPort } = usePortalPorts();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['onboarding', organization.id],
    queryFn: () => onboardingPort.loadSnapshot(organization.id),
  });

  return (
    <>
      <PageHeader
        title="Getting started"
        description={`Set up ${organization.displayName} on Himma and follow your verification status.`}
      />
      {query.isPending ? (
        <p className={styles.loading} role="status">
          Loading your setup status…
        </p>
      ) : query.isError || !query.data ? (
        <UnavailableState onRetry={() => void query.refetch()} />
      ) : query.data.kind === 'loaded' ? (
        <OnboardingContent
          snapshot={query.data.snapshot}
          onChanged={() =>
            void queryClient.invalidateQueries({ queryKey: ['onboarding', organization.id] })
          }
        />
      ) : (
        <UnavailableState onRetry={() => void query.refetch()} />
      )}
    </>
  );
}

function UnavailableState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={styles.unavailable}>
      <InlineAlert tone="error">
        We couldn&rsquo;t load your setup status. Try again in a moment.
      </InlineAlert>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

const STAGE_COPY: Record<OnboardingStage, { badge: string; heading: string; body: string }> = {
  setup: {
    badge: 'Setup in progress',
    heading: 'Set up your workspace',
    body: 'Complete the steps below, then submit your organization for Himma’s review.',
  },
  submitted: {
    badge: 'Submitted',
    heading: 'Submitted for review',
    body: 'Himma is reviewing your organization — no action is needed from you right now. You can keep preparing your workspace in the meantime.',
  },
  inReview: {
    badge: 'In review',
    heading: 'Himma is reviewing your organization',
    body: 'No action is needed from you right now. You can keep preparing your workspace in the meantime.',
  },
  rejected: {
    badge: 'Changes needed',
    heading: 'Your submission needs attention',
    body: 'Himma couldn’t approve your organization yet. Once the points below are addressed, you can submit again.',
  },
  verified: {
    badge: 'Verified',
    heading: 'Verified — final steps with Himma',
    body: 'Your organization has been verified. Himma completes the final checks before your business goes live, and your Himma contact will be in touch if anything more is needed.',
  },
  live: {
    badge: 'Live',
    heading: 'You’re live on Himma',
    body: 'Customers can now discover your business on Himma. Manage your presence from your workspace.',
  },
  suspended: {
    badge: 'Suspended',
    heading: 'This organization is currently suspended',
    body: 'Changes are unavailable while the suspension is in place. Contact Himma support for help.',
  },
  unknown: {
    badge: 'Status unavailable',
    heading: 'We can’t show your status right now',
    body: 'Try again shortly, or contact Himma support if this keeps happening.',
  },
};

function OnboardingContent({
  snapshot,
  onChanged,
}: {
  snapshot: OnboardingSnapshot;
  onChanged: () => void;
}) {
  const view = deriveOnboarding(snapshot);
  const copy = STAGE_COPY[view.stage];

  return (
    <div className={styles.content}>
      <section
        className={`${styles.statusCard} ${view.stage === 'live' ? styles.statusCardLive : ''}`}
        aria-label="Verification status"
      >
        <div className={styles.statusHead}>
          {view.stage === 'live' ? (
            <PartyPopper className={styles.statusIcon} aria-hidden="true" strokeWidth={1.75} />
          ) : null}
          <span className={styles.badge}>{copy.badge}</span>
        </div>
        <h2 className={styles.statusHeading}>{copy.heading}</h2>
        <p className={styles.statusBody}>{copy.body}</p>
        {view.stage === 'rejected' ? <RejectionFeedback snapshot={snapshot} /> : null}
        <SubmitArea snapshot={snapshot} view={view} onChanged={onChanged} />
        {view.stage === 'live' ? (
          <p className={styles.statusAction}>
            <ActionLink to={organizationPath(snapshot.organization.id)}>
              Go to your dashboard
            </ActionLink>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="onboarding-steps-heading" className={styles.checklist}>
        <h2 id="onboarding-steps-heading" className={styles.sectionTitle}>
          Your setup steps
        </h2>
        <ol className={styles.items}>
          {view.items.map((item) => (
            <ChecklistRow key={item.id} item={item} organizationId={snapshot.organization.id} />
          ))}
        </ol>
      </section>

      <section aria-labelledby="onboarding-documents-heading" className={styles.documents}>
        <h2 id="onboarding-documents-heading" className={styles.sectionTitle}>
          Verification documents
        </h2>
        <div className={styles.documentsCard}>
          <FileText className={styles.documentsIcon} aria-hidden="true" strokeWidth={1.75} />
          <p className={styles.documentsBody}>
            If Himma needs documents to verify your business, your Himma contact will arrange it
            with you directly. Uploading documents in the portal is coming in a later production
            milestone.
          </p>
        </div>
      </section>
    </div>
  );
}

/**
 * W3-8 (docs/31 §5): the REAL provider-safe correction feedback from the
 * latest verification decision — the reviewer-authored message and the
 * machine reason, nothing internal (the backend seam cannot even select
 * internal notes or reviewer identity). Renders only in the rejected
 * stage; when no reviewer message exists the truthful Support fallback
 * copy remains.
 */
function RejectionFeedback({ snapshot }: { snapshot: OnboardingSnapshot }) {
  const decision = snapshot.verification?.latestDecision;
  if (decision === null || decision === undefined || decision.outcome !== 'rejected') {
    return (
      <div className={styles.feedbackCard} role="note" aria-label="What needs to change">
        <p className={styles.feedbackBody}>
          Your Himma contact will share what needs to change. If you haven’t heard from us,
          contact Himma support.
        </p>
      </div>
    );
  }
  const decidedOn = new Intl.DateTimeFormat('en-AE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(decision.decidedAt));
  return (
    <div className={styles.feedbackCard} role="note" aria-label="What needs to change">
      <p className={styles.feedbackTitle}>What needs to change</p>
      {decision.providerMessage !== null ? (
        <p className={styles.feedbackBody}>{decision.providerMessage}</p>
      ) : (
        <p className={styles.feedbackBody}>
          Your Himma contact will share the details. If you haven’t heard from us, contact Himma
          support.
        </p>
      )}
      <p className={styles.feedbackMeta}>
        Reviewed on {decidedOn}
        {decision.reasonCode !== null ? (
          <>
            {' · reference '}
            <code className={styles.feedbackCode}>{decision.reasonCode}</code>
          </>
        ) : null}
      </p>
    </div>
  );
}

type SubmitPhase =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'submitted' }
  | { phase: 'error'; message: string };

function SubmitArea({
  snapshot,
  view,
  onChanged,
}: {
  snapshot: OnboardingSnapshot;
  view: OnboardingView;
  onChanged: () => void;
}) {
  const { onboardingPort } = usePortalPorts();
  const [state, setState] = useState<SubmitPhase>({ phase: 'idle' });
  const alertRef = useRef<HTMLDivElement>(null);
  const { submission } = view;

  if (submission.kind === 'notApplicable') {
    return state.phase === 'submitted' ? (
      <p role="status" className={styles.submitDone}>
        Submitted — Himma will take it from here.
      </p>
    ) : null;
  }

  if (submission.kind === 'notAllowed') {
    return (
      <p className={styles.submitNote}>
        Your organization&rsquo;s owner submits it for review when setup is complete.
      </p>
    );
  }

  const submit = async () => {
    if (state.phase === 'submitting') {
      return;
    }
    setState({ phase: 'submitting' });
    const outcome = await onboardingPort.submitForVerification(
      snapshot.organization.id,
      snapshot.organization.version,
    );
    switch (outcome.kind) {
      case 'organizationSubmitted':
        setState({ phase: 'submitted' });
        onChanged();
        return;
      case 'organizationIncomplete':
        setState({
          phase: 'error',
          message:
            'Your organization isn’t ready to submit yet. Complete your business profile and add at least one active branch first.',
        });
        break;
      case 'staleVersion':
        setState({
          phase: 'error',
          message: 'Your organization changed since this page loaded. We’ve refreshed it — review and try again.',
        });
        onChanged();
        break;
      case 'lifecycleConflict':
        setState({
          phase: 'error',
          message: 'Your organization can’t be submitted right now. We’ve refreshed your status.',
        });
        onChanged();
        break;
      case 'organizationSuspended':
        setState({
          phase: 'error',
          message: 'This organization is currently suspended. Changes are unavailable.',
        });
        break;
      case 'forbidden':
        setState({
          phase: 'error',
          message: 'Your organization’s owner submits it for review.',
        });
        break;
      default:
        setState({ phase: 'error', message: 'Something went wrong. Please try again.' });
    }
    alertRef.current?.focus();
  };

  return (
    <div className={styles.submitArea}>
      {state.phase === 'error' ? (
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          <InlineAlert tone="error">{state.message}</InlineAlert>
        </div>
      ) : null}
      {submission.kind === 'incomplete' ? (
        <>
          <Button aria-disabled="true" onClick={(event) => event.preventDefault()}>
            {view.stage === 'rejected' ? 'Submit again' : 'Submit for review'}
          </Button>
          <p className={styles.submitNote}>
            Before you can submit:{' '}
            {submission.missing
              .map((gap) =>
                gap === 'profile' ? 'complete your business profile' : 'add an active branch',
              )
              .join(' and ')}
            .
          </p>
        </>
      ) : (
        <Button onClick={() => void submit()} busy={state.phase === 'submitting'} busyLabel="Submitting…">
          {view.stage === 'rejected' ? 'Submit again' : 'Submit for review'}
        </Button>
      )}
    </div>
  );
}

const ITEM_COPY: Record<
  OnboardingItem['id'],
  { title: string; body: string; segment: string | null; cta: string | null }
> = {
  profile: {
    title: 'Business profile',
    body: 'Your display name, story, and contact details — what customers will see.',
    segment: 'profile',
    cta: 'Open Business Profile',
  },
  branches: {
    title: 'Branches',
    body: 'Add at least one active branch so customers know where you run.',
    segment: 'branches',
    cta: 'Open Branches',
  },
  team: {
    title: 'Team',
    body: 'Invite staff when you’re ready — team management arrives in an upcoming portal update.',
    segment: 'team',
    cta: 'Open Team',
  },
  review: {
    title: 'Himma review',
    body: 'Himma reviews your organization before it can go live.',
    segment: null,
    cta: null,
  },
  goLive: {
    title: 'Go live',
    body: 'Himma takes your storefront live once verification is complete.',
    segment: null,
    cta: null,
  },
  firstListing: {
    title: 'Create your first listing',
    body: 'Add a program or activity so customers can find and book you.',
    segment: 'listings',
    cta: 'Open Listings',
  },
};

const STATE_LABEL: Record<OnboardingItem['state'], string> = {
  complete: 'Done',
  actionRequired: 'To do',
  awaitingHimma: 'With Himma',
  blocked: 'Waiting',
  optional: 'Optional',
};

function ChecklistRow({ item, organizationId }: { item: OnboardingItem; organizationId: string }) {
  const copy = ITEM_COPY[item.id];

  const icon =
    item.state === 'complete' ? (
      <CheckCircle2 className={`${styles.itemIcon} ${styles.iconComplete}`} aria-hidden="true" strokeWidth={1.75} />
    ) : item.state === 'actionRequired' ? (
      <CircleAlert className={`${styles.itemIcon} ${styles.iconAction}`} aria-hidden="true" strokeWidth={1.75} />
    ) : item.state === 'awaitingHimma' ? (
      <Clock className={`${styles.itemIcon} ${styles.iconWaiting}`} aria-hidden="true" strokeWidth={1.75} />
    ) : item.state === 'blocked' ? (
      <Lock className={`${styles.itemIcon} ${styles.iconWaiting}`} aria-hidden="true" strokeWidth={1.75} />
    ) : (
      <CircleDashed className={`${styles.itemIcon} ${styles.iconOptional}`} aria-hidden="true" strokeWidth={1.75} />
    );

  const showCta =
    copy.segment !== null &&
    item.actionable &&
    (item.state === 'actionRequired' || item.state === 'optional');

  return (
    <li className={styles.item}>
      {icon}
      <div className={styles.itemBody}>
        <p className={styles.itemTitle}>
          {copy.title}
          <span className={`${styles.stateChip} ${styles[`chip-${item.state}`]}`}>
            {STATE_LABEL[item.state]}
          </span>
        </p>
        <p className={styles.itemText}>{copy.body}</p>
        {!item.actionable && item.state === 'actionRequired' ? (
          <p className={styles.itemNote}>An owner or organization manager completes this step.</p>
        ) : null}
      </div>
      {showCta && copy.segment ? (
        <Link className={styles.itemCta} to={organizationPath(organizationId, copy.segment)}>
          {copy.cta}
        </Link>
      ) : null}
    </li>
  );
}
