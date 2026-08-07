import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useBlocker } from 'react-router-dom';
import { usePortalPorts } from '../../app/ports-context';
import { ActionLink } from '../../components/ui/action-link';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { InlineAlert } from '../../components/ui/inline-alert';
import { TextAreaField } from '../../components/ui/textarea-field';
import { TextField } from '../../components/ui/text-field';
import { organizationPath } from '../../navigation/nav-items';
import type { OrganizationView } from '../../profile/contract';
import {
  buildProfilePatch,
  profileFormSchema,
  toFormValues,
  type ProfileFormValues,
} from './profile-form';
import { isStillOnboarding } from './organization-state';
import { StorefrontPreview, type StorefrontPreviewData } from './storefront-preview';
import styles from './business-profile-page.module.css';

type SavePhase =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved' }
  /** Another writer saved first — the canonical staleVersion refusal. */
  | { phase: 'conflict' }
  /** "Load latest" in flight — the fresh base is being fetched. */
  | { phase: 'reloading' }
  /** After "load latest": base reloaded, this editor's edits kept for review. */
  | { phase: 'reloaded' }
  | { phase: 'error'; message: string };

const SUSPENDED_COPY = 'This organization is currently suspended. Changes are unavailable.';

/**
 * The PUBLIC storefront projection (`organization_public_profile`): the only
 * provider-editable profile surface (`profile.edit` — Owner + Organization
 * Manager). The editor and the customer-facing preview sit side by side;
 * saving PATCHes only the fields this editor changed, carrying the profile
 * row's `expectedVersion` (optimistic concurrency — a stale writer gets the
 * conflict flow, never a silent overwrite).
 */
export function StorefrontPanel({
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
  const editable = canEdit && !suspended;

  return editable ? (
    <StorefrontEditor view={view} onRefreshView={onRefreshView} onSaved={onSaved} />
  ) : (
    <StorefrontReadOnly view={view} canEdit={canEdit} suspended={suspended} />
  );
}

function StorefrontEditor({
  view,
  onRefreshView,
  onSaved,
}: {
  view: OrganizationView;
  onRefreshView: () => Promise<unknown>;
  onSaved: () => Promise<unknown>;
}) {
  const { profilePort } = usePortalPorts();
  const [save, setSave] = useState<SavePhase>({ phase: 'idle' });
  const alertRef = useRef<HTMLDivElement>(null);

  const baseValues = useMemo(() => toFormValues(view.profile), [view.profile]);
  const form = useForm<ProfileFormValues>({
    resolver: standardSchemaResolver(profileFormSchema),
    defaultValues: baseValues,
    mode: 'onTouched',
  });
  const { formState, reset, control } = form;
  const { isDirty } = formState;

  // Refetched server state becomes the new base WITHOUT discarding this
  // editor's in-progress edits (they stay dirty against the new base).
  useEffect(() => {
    reset(baseValues, { keepDirtyValues: true });
  }, [baseValues, reset]);

  // A fresh edit clears the previous save confirmation. Deliberately NOT
  // applied to the post-conflict 'reloaded' notice: it must stay visible
  // while the user reviews their kept edits (which are dirty by design, and
  // the keep-dirty reset after a refetch can flicker isDirty).
  useEffect(() => {
    if (isDirty) {
      setSave((current) => (current.phase === 'saved' ? { phase: 'idle' } : current));
    }
  }, [isDirty]);

  // Unsaved-change protection: in-app navigation (sidebar, org switcher,
  // onboarding links) is blocked behind an explicit confirmation…
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname,
  );
  // …and closing/reloading the browser tab gets the native prompt.
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

  const submit = form.handleSubmit(async (values) => {
    if (save.phase === 'saving' || !formState.isDirty) {
      return;
    }
    setSave({ phase: 'saving' });
    const patch = buildProfilePatch(values, formState.dirtyFields);
    const outcome = await profilePort.updateProfile(
      view.organization.id,
      view.profile.version,
      patch,
    );
    switch (outcome.kind) {
      case 'profileUpdated':
        reset(values);
        // Wait for the refreshed view (and its new profile version) before
        // announcing success — an immediate follow-up save must never carry
        // the superseded expectedVersion.
        await onSaved();
        setSave({ phase: 'saved' });
        return;
      case 'staleVersion':
        setSave({ phase: 'conflict' });
        focusAlert();
        return;
      case 'validationError':
        setSave({
          phase: 'error',
          message: 'Some details couldn’t be saved. Review the fields below and try again.',
        });
        focusAlert();
        return;
      case 'organizationSuspended':
        setSave({ phase: 'error', message: SUSPENDED_COPY });
        void onRefreshView();
        focusAlert();
        return;
      case 'forbidden':
        setSave({
          phase: 'error',
          message:
            'Your role can’t change the storefront. An owner or organization manager makes these changes.',
        });
        void onRefreshView();
        focusAlert();
        return;
      default:
        setSave({
          phase: 'error',
          message: 'We couldn’t save your changes right now — your edits are still here. Try again in a moment.',
        });
        focusAlert();
    }
  });

  const loadLatest = async () => {
    if (save.phase === 'reloading') {
      return;
    }
    setSave({ phase: 'reloading' });
    await onRefreshView();
    setSave({ phase: 'reloaded' });
    focusAlert();
  };

  const watched = useWatch({ control });
  const previewData: StorefrontPreviewData = {
    displayName: watched.displayName ?? baseValues.displayName,
    descriptionEn: watched.descriptionEn ?? baseValues.descriptionEn,
    publicPhone: watched.publicPhone ?? baseValues.publicPhone,
    publicEmail: watched.publicEmail ?? baseValues.publicEmail,
    publicWebsite: watched.publicWebsite ?? baseValues.publicWebsite,
    publicInstagram: watched.publicInstagram ?? baseValues.publicInstagram,
  };

  const errors = formState.errors;

  return (
    <div className={styles.storefrontLayout}>
      <div className={styles.editorColumn}>
        <p className={styles.panelIntro}>
          Everything below is <strong>customer-facing</strong>: it appears on your public
          storefront when it&rsquo;s published and your organization is live on Himma.
        </p>

        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          {save.phase === 'conflict' || save.phase === 'reloading' ? (
            <InlineAlert tone="error">
              <p>
                Someone else updated the storefront while you were editing, so your changes
                weren&rsquo;t saved. Load the latest version to continue — your edits here will be
                kept for you to review before saving again.
              </p>
              <div className={styles.alertActions}>
                <Button
                  variant="secondary"
                  busy={save.phase === 'reloading'}
                  busyLabel="Loading…"
                  onClick={() => void loadLatest()}
                >
                  Load the latest profile
                </Button>
              </div>
            </InlineAlert>
          ) : save.phase === 'reloaded' ? (
            <InlineAlert tone="info">
              The latest profile is loaded and your edits are kept below. Review them, then save
              again.
            </InlineAlert>
          ) : save.phase === 'error' ? (
            <InlineAlert tone="error">{save.message}</InlineAlert>
          ) : save.phase === 'saved' ? (
            <InlineAlert tone="success">
              Saved — your storefront is up to date.
              {isStillOnboarding(view.organization.verificationState) ? (
                <>
                  {' '}
                  <ActionLink to={organizationPath(view.organization.id, 'onboarding')}>
                    Back to Getting started
                  </ActionLink>
                </>
              ) : null}
            </InlineAlert>
          ) : null}
        </div>

        <form onSubmit={(event) => void submit(event)} noValidate className={styles.form}>
          <fieldset className={styles.formSection}>
            <legend className={styles.formLegend}>Public identity</legend>
            <TextField
              label="Display name"
              hint="The name customers see across Himma. Required."
              aria-required="true"
              error={errors.displayName?.message ?? null}
              {...form.register('displayName')}
            />
          </fieldset>

          <fieldset className={styles.formSection}>
            <legend className={styles.formLegend}>Your story</legend>
            <TextAreaField
              label="About your business (English)"
              hint="What you offer, who it's for, and what makes it great."
              error={errors.descriptionEn?.message ?? null}
              rows={5}
              {...form.register('descriptionEn')}
            />
            <TextAreaField
              label="About your business (Arabic) — optional"
              hint="Optional for now — Himma launches in English first."
              error={errors.descriptionAr?.message ?? null}
              rows={3}
              dir="auto"
              {...form.register('descriptionAr')}
            />
          </fieldset>

          <fieldset className={styles.formSection}>
            <legend className={styles.formLegend}>Customer contact details</legend>
            <p className={styles.formNote}>
              Only what you add here is shown to customers. Leave a field empty to keep it off
              your storefront.
            </p>
            <TextField
              label="Public phone"
              type="tel"
              autoComplete="off"
              error={errors.publicPhone?.message ?? null}
              {...form.register('publicPhone')}
            />
            <TextField
              label="Public email"
              type="email"
              autoComplete="off"
              error={errors.publicEmail?.message ?? null}
              {...form.register('publicEmail')}
            />
            <TextField
              label="Website"
              error={errors.publicWebsite?.message ?? null}
              {...form.register('publicWebsite')}
            />
            <TextField
              label="Instagram"
              error={errors.publicInstagram?.message ?? null}
              {...form.register('publicInstagram')}
            />
          </fieldset>

          <MediaBoundary view={view} />

          <div className={styles.saveArea}>
            <Button
              type="submit"
              busy={save.phase === 'saving'}
              busyLabel="Saving…"
              aria-disabled={!isDirty || undefined}
            >
              Save changes
            </Button>
            {!isDirty && save.phase !== 'saved' ? (
              <p className={styles.saveNote}>All changes are saved.</p>
            ) : null}
          </div>
        </form>
      </div>

      <div className={styles.previewColumn}>
        <StorefrontPreview
          data={previewData}
          branches={view.branches}
          organizationState={view.organization.verificationState}
          published={view.profile.published}
        />
      </div>

      {blocker.state === 'blocked' ? (
        <ConfirmDialog
          title="Discard unsaved changes?"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        >
          <p>Your storefront has unsaved edits. If you leave now, they&rsquo;ll be lost.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/**
 * Media reference boundary (task §16): the schema stores opaque media
 * references, but no media upload/library backend exists yet — so no
 * upload affordance is pretended here.
 */
function MediaBoundary({ view }: { view: OrganizationView }) {
  const hasAnyReference =
    view.profile.logoMediaRef !== null ||
    view.profile.coverMediaRef !== null ||
    view.profile.galleryMediaRefs.length > 0;
  return (
    <section className={styles.formSection} aria-label="Logo and photos">
      <h2 className={styles.formLegend}>Logo &amp; photos</h2>
      <p className={styles.formNote}>
        {hasAnyReference
          ? 'Your storefront imagery is on file with Himma. Managing photos and your logo yourself arrives in a later production milestone.'
          : 'Adding a logo and photos arrives in a later production milestone. Until then, your storefront shows your initials.'}
      </p>
    </section>
  );
}

const NOT_PROVIDED = 'Not provided yet';

function StorefrontReadOnly({
  view,
  canEdit,
  suspended,
}: {
  view: OrganizationView;
  canEdit: boolean;
  suspended: boolean;
}) {
  const rows = [
    { term: 'Display name', value: view.profile.displayName.trim() },
    { term: 'About (English)', value: view.profile.descriptionEn ?? '' },
    { term: 'About (Arabic)', value: view.profile.descriptionAr ?? '' },
    { term: 'Public phone', value: view.profile.publicPhone ?? '' },
    { term: 'Public email', value: view.profile.publicEmail ?? '' },
    { term: 'Website', value: view.profile.publicWebsite ?? '' },
    { term: 'Instagram', value: view.profile.publicInstagram ?? '' },
  ];

  return (
    <div className={styles.storefrontLayout}>
      <div className={styles.editorColumn}>
        {suspended ? (
          <InlineAlert tone="info">{SUSPENDED_COPY}</InlineAlert>
        ) : !canEdit ? (
          <InlineAlert tone="info">
            You can view the storefront, but changing it needs profile-edit access — an owner or
            organization manager makes these changes.
          </InlineAlert>
        ) : null}
        <p className={styles.panelIntro}>
          Everything below is <strong>customer-facing</strong>: it appears on the public
          storefront when it&rsquo;s published and the organization is live on Himma.
        </p>
        <dl className={styles.recordList} aria-label="Storefront details (read-only)">
          {rows.map((row) => (
            <div key={row.term} className={styles.recordRow}>
              <dt className={styles.recordTerm}>{row.term}</dt>
              <dd className={styles.recordValue}>
                {row.value !== '' ? (
                  row.value
                ) : (
                  <span className={styles.notProvided}>{NOT_PROVIDED}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className={styles.previewColumn}>
        <StorefrontPreview
          data={{
            displayName: view.profile.displayName,
            descriptionEn: view.profile.descriptionEn ?? '',
            publicPhone: view.profile.publicPhone ?? '',
            publicEmail: view.profile.publicEmail ?? '',
            publicWebsite: view.profile.publicWebsite ?? '',
            publicInstagram: view.profile.publicInstagram ?? '',
          }}
          branches={view.branches}
          organizationState={view.organization.verificationState}
          published={view.profile.published}
        />
      </div>
    </div>
  );
}
