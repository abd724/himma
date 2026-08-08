import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useBlocker } from 'react-router-dom';
import { usePortalPorts } from '../../../app/ports-context';
import type { ProgramDetailRecord } from '../../../catalogue/contract';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { InlineAlert } from '../../../components/ui/inline-alert';
import type { OrganizationView } from '../../../profile/contract';
import type { ActivityTypeRecord } from '../../../taxonomy/contract';
import { commonMutationErrorCopy } from './editor-domain';
import {
  buildProgramPatch,
  programFormSchema,
  programFormValuesOf,
  type ProgramFormValues,
} from './program-form';
import { ProgramFormFields } from './program-form-fields';
import styles from './editor.module.css';

/** Provider words for the wire field names in revision outcomes. */
const FIELD_LABELS: Record<string, string> = {
  titleEn: 'English title',
  titleAr: 'Arabic title',
  setting: 'setting',
  activityTypeId: 'activity type',
  descriptionEn: 'English description',
  descriptionAr: 'Arabic description',
  minAge: 'youngest age',
  maxAge: 'oldest age',
  allAges: 'all-ages flag',
  genderEligibility: 'who it’s for',
  skillLevel: 'skill level',
  eligibilityNotes: 'eligibility notes',
};

type SavePhase =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved'; message: string }
  | { phase: 'reviewSubmitted'; message: string }
  | { phase: 'stale' }
  | { phase: 'error'; message: string };

/**
 * The Program record form (Basics + Eligibility): ONE dirty-field PATCH
 * against `PATCH .../listings/:programId` with `expectedVersion` CAS. On
 * review-gated listings the protected fields are marked; saving them sends
 * a revision to Himma (live values stand) — exactly the real outcome.
 */
export function ProgramDetailsSection({
  view,
  program,
  taxonomy,
  reviewGated,
  revisionPending,
  readOnly,
}: {
  view: OrganizationView;
  program: ProgramDetailRecord;
  taxonomy: readonly ActivityTypeRecord[];
  reviewGated: boolean;
  revisionPending: boolean;
  readOnly: boolean;
}) {
  const { listingEditorPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const [save, setSave] = useState<SavePhase>({ phase: 'idle' });
  const alertRef = useRef<HTMLDivElement>(null);
  // After a revision submission the deferred fields must SNAP BACK to the
  // live values (they were not applied) — a full reset, not a merge.
  const fullResetRef = useRef(false);

  const form = useForm<ProgramFormValues>({
    resolver: standardSchemaResolver(programFormSchema),
    defaultValues: programFormValuesOf(program),
    mode: 'onTouched',
  });
  const { isDirty } = form.formState;

  // Reconcile the baseline whenever fresher truth arrives: untouched
  // fields adopt the latest saved values, the user's edits stay put
  // (keepDirtyValues) — reload never silently discards work.
  const baselineKey = `${program.version}:${program.updatedAt}:${program.openRevision?.id ?? ''}`;
  useEffect(() => {
    if (fullResetRef.current) {
      fullResetRef.current = false;
      form.reset(programFormValuesOf(program));
      return;
    }
    form.reset(programFormValuesOf(program), { keepDirtyValues: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- baselineKey captures the record identity
  }, [baselineKey]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!isDirty) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  const focusAlert = () => {
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['listing', view.organization.id, program.id] }),
      queryClient.invalidateQueries({ queryKey: ['listings', view.organization.id] }),
    ]);
  };

  const submit = form.handleSubmit(async (values) => {
    if (save.phase === 'saving') {
      return;
    }
    const patch = buildProgramPatch(programFormValuesOf(program), values);
    if (Object.keys(patch).length === 0) {
      setSave({ phase: 'saved', message: 'Nothing to save — everything is up to date.' });
      focusAlert();
      return;
    }
    setSave({ phase: 'saving' });
    const outcome = await listingEditorPort.updateProgram(
      view.organization.id,
      program.id,
      program.version,
      patch,
    );
    switch (outcome.kind) {
      case 'programUpdated':
        setSave({ phase: 'saved', message: 'Changes saved.' });
        await invalidate();
        focusAlert();
        return;
      case 'revisionSubmitted': {
        const deferred = outcome.deferredFields
          .map((field) => FIELD_LABELS[field] ?? field)
          .join(', ');
        const applied = outcome.appliedFields
          .map((field) => FIELD_LABELS[field] ?? field)
          .join(', ');
        fullResetRef.current = true;
        setSave({
          phase: 'reviewSubmitted',
          message:
            (applied !== '' ? `Saved: ${applied}. ` : '') +
            `Sent to Himma for review: ${deferred}. The live listing keeps its current values until Himma approves the change.`,
        });
        await invalidate();
        focusAlert();
        return;
      }
      case 'revisionPending':
      case 'lifecycleConflict':
      case 'organizationSuspended':
      case 'forbidden':
      case 'notFound':
        setSave({ phase: 'error', message: commonMutationErrorCopy(outcome.kind) });
        await invalidate();
        focusAlert();
        return;
      case 'staleVersion':
        setSave({ phase: 'stale' });
        focusAlert();
        return;
      case 'invalidTaxonomy':
        setSave({
          phase: 'error',
          message:
            'That activity type isn’t available any more. Choose a current activity type and try again.',
        });
        focusAlert();
        return;
      case 'invalidEligibility':
        setSave({
          phase: 'error',
          message: 'The age settings don’t work together. Review the eligibility fields.',
        });
        focusAlert();
        return;
      default:
        setSave({ phase: 'error', message: commonMutationErrorCopy(outcome.kind) });
        focusAlert();
    }
  });

  const reloadLatest = async () => {
    setSave({ phase: 'idle' });
    await invalidate();
  };

  return (
    <section aria-labelledby="editor-details-heading" className={styles.section}>
      <h2 id="editor-details-heading" className={styles.sectionTitle}>
        Details
      </h2>
      <div className={styles.sectionCard}>
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          {save.phase === 'saved' ? <InlineAlert tone="success">{save.message}</InlineAlert> : null}
          {save.phase === 'reviewSubmitted' ? (
            <InlineAlert tone="info">{save.message}</InlineAlert>
          ) : null}
          {save.phase === 'error' ? <InlineAlert tone="error">{save.message}</InlineAlert> : null}
          {save.phase === 'stale' ? (
            <>
              <InlineAlert tone="error">
                Someone else saved this listing while you were editing. Reload the latest version —
                the fields you changed keep your values so you can review and save again.
              </InlineAlert>
              <div className={styles.alertActions}>
                <Button variant="secondary" onClick={() => void reloadLatest()}>
                  Reload latest version
                </Button>
              </div>
            </>
          ) : null}
        </div>

        {readOnly ? (
          <ProgramReadOnlySummary program={program} />
        ) : (
          <form onSubmit={(event) => void submit(event)} noValidate className={styles.form}>
            <ProgramFormFields
              form={form}
              activityTypes={taxonomy}
              currentActivityType={program.activityType}
              showSensitiveChip={reviewGated}
              sensitiveDisabled={reviewGated && revisionPending}
            />
            <div className={styles.saveArea}>
              <Button type="submit" busy={save.phase === 'saving'} busyLabel="Saving…">
                Save changes
              </Button>
              <p className={styles.saveNote}>Only the fields you changed are saved.</p>
            </div>
          </form>
        )}
      </div>

      {blocker.state === 'blocked' ? (
        <ConfirmDialog
          title="Discard unsaved changes?"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        >
          <p>Your listing details have unsaved changes. If you leave now, they&rsquo;re lost.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

/** Suspended organizations read their record truthfully — no disabled-form
 *  theater, no mutation affordance. */
function ProgramReadOnlySummary({ program }: { program: ProgramDetailRecord }) {
  return (
    <dl className={styles.form}>
      <div>
        <dt className={styles.saveNote}>Title</dt>
        <dd className={styles.sectionIntro}>{program.titleEn}</dd>
      </div>
      <div>
        <dt className={styles.saveNote}>Activity type</dt>
        <dd className={styles.sectionIntro}>{program.activityType.labelEn}</dd>
      </div>
      <div>
        <dt className={styles.saveNote}>Description</dt>
        <dd className={styles.sectionIntro}>
          {program.descriptionEn !== null && program.descriptionEn.trim() !== ''
            ? program.descriptionEn
            : 'No description yet.'}
        </dd>
      </div>
    </dl>
  );
}
