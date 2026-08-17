import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { usePortalPorts } from '../../../app/ports-context';
import type { ProgramDetailRecord, ProgramMediaRecord } from '../../../catalogue/contract';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { InlineAlert } from '../../../components/ui/inline-alert';
import { TextField } from '../../../components/ui/text-field';
import { VisuallyHidden } from '../../../components/ui/visually-hidden';
import type { OrganizationView } from '../../../profile/contract';
import { StateChip } from '../state-chip';
import { commonMutationErrorCopy } from './editor-domain';
import styles from './editor.module.css';

/**
 * ProgramMedia REFERENCE METADATA only (docs/28 §14): photo descriptions,
 * ordering, and removal of the references already on file. No upload,
 * library, cropper, storage, or preview exists — the media-binary backend
 * is a recorded Class-C gap, so no "add photo" control is offered here
 * (there is nowhere truthful for a new reference to come from yet; the
 * adapter itself is contract-complete for W2-12).
 */
export function MediaSection({
  view,
  program,
  readOnly,
}: {
  view: OrganizationView;
  program: ProgramDetailRecord;
  readOnly: boolean;
}) {
  const { listingEditorPort } = usePortalPorts();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ id: string; altText: string } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ProgramMediaRecord | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const ordered = [...program.media].sort(
    (a, b) => a.sortHint - b.sortHint || (a.id < b.id ? -1 : 1),
  );
  const active = ordered.filter((entry) => entry.active);

  const nameOf = (entry: ProgramMediaRecord): string =>
    entry.altTextEn !== null && entry.altTextEn.trim() !== ''
      ? entry.altTextEn
      : 'Photo without a description';

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['listing', view.organization.id, program.id],
    });
    // The index list-card carries the thumbnail summary (W2-12C1) —
    // refresh it so the row reflects the metadata change.
    await queryClient.invalidateQueries({ queryKey: ['listings', view.organization.id] });
  };

  const announce = (tone: 'success' | 'error', text: string) => {
    setNotice({ tone, text });
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  const saveAltText = async () => {
    if (editing === null || busy) {
      return;
    }
    const entry = program.media.find((candidate) => candidate.id === editing.id);
    if (entry === undefined) {
      setEditing(null);
      return;
    }
    setBusy(true);
    const outcome = await listingEditorPort.updateMedia(
      view.organization.id,
      program.id,
      entry.id,
      entry.version,
      { altTextEn: editing.altText.trim() === '' ? null : editing.altText.trim() },
    );
    setBusy(false);
    if (outcome.kind === 'mediaUpdated') {
      setEditing(null);
      await invalidate();
      announce('success', 'Photo description saved.');
      return;
    }
    if (outcome.kind === 'staleVersion') {
      setEditing(null);
      await invalidate();
      announce('error', 'Someone else changed this photo first. Reloaded — try again.');
      return;
    }
    announce('error', commonMutationErrorCopy(outcome.kind));
  };

  const move = async (entry: ProgramMediaRecord, direction: -1 | 1) => {
    if (busy) {
      return;
    }
    const currentIndex = active.findIndex((candidate) => candidate.id === entry.id);
    const targetIndex = currentIndex + direction;
    if (currentIndex === -1 || targetIndex < 0 || targetIndex >= active.length) {
      return;
    }
    const next = [...active];
    next.splice(currentIndex, 1);
    next.splice(targetIndex, 0, entry);
    setBusy(true);
    for (let position = 0; position < next.length; position += 1) {
      const target = next[position]!;
      const sortHint = (position + 1) * 10;
      if (target.sortHint === sortHint) {
        continue;
      }
      const outcome = await listingEditorPort.updateMedia(
        view.organization.id,
        program.id,
        target.id,
        target.version,
        { sortHint },
      );
      if (outcome.kind !== 'mediaUpdated') {
        setBusy(false);
        await invalidate();
        announce('error', commonMutationErrorCopy(outcome.kind));
        return;
      }
    }
    setBusy(false);
    await invalidate();
    announce('success', `“${nameOf(entry)}” moved.`);
  };

  const remove = async (entry: ProgramMediaRecord) => {
    setConfirmRemove(null);
    const outcome = await listingEditorPort.archiveMedia(
      view.organization.id,
      program.id,
      entry.id,
      entry.version,
    );
    if (outcome.kind === 'mediaArchived') {
      await invalidate();
      announce('success', 'Photo reference removed. It stays in your history.');
      return;
    }
    if (outcome.kind === 'staleVersion') {
      await invalidate();
      announce('error', 'Someone else changed this photo first. Reloaded — try again.');
      return;
    }
    announce('error', commonMutationErrorCopy(outcome.kind));
  };

  return (
    <section aria-labelledby="editor-media-heading" className={styles.section}>
      <h2 id="editor-media-heading" className={styles.sectionTitle}>
        Photos
      </h2>
      <div className={styles.sectionCard}>
        <p className={styles.sectionIntro}>
          Descriptions and order of the photos on file for this listing. Uploading new photos
          isn&rsquo;t available in the portal yet.
        </p>
        <div ref={alertRef} tabIndex={-1} className={styles.alertFocus}>
          {notice !== null ? <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert> : null}
        </div>
        {ordered.length === 0 ? (
          <p className={styles.sectionIntro}>No photos are attached to this listing yet.</p>
        ) : (
          <ul className={styles.rowList} aria-label="Listing photos">
            {ordered.map((entry) => (
              <li
                key={entry.id}
                className={
                  entry.active ? styles.childRow : `${styles.childRow} ${styles.archivedRow}`
                }
              >
                <div className={styles.childRowMain}>
                  <span className={styles.childRowName}>
                    {nameOf(entry)}
                    {!entry.active ? <StateChip label="Removed" tone="neutral" /> : null}
                  </span>
                </div>
                {!readOnly && entry.active ? (
                  <div className={styles.childRowActions}>
                    {active.length > 1 ? (
                      <>
                        <Button
                          variant="secondary"
                          disabled={active[0]?.id === entry.id || busy}
                          onClick={() => void move(entry, -1)}
                        >
                          Move up
                          <VisuallyHidden> {nameOf(entry)}</VisuallyHidden>
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={active[active.length - 1]?.id === entry.id || busy}
                          onClick={() => void move(entry, 1)}
                        >
                          Move down
                          <VisuallyHidden> {nameOf(entry)}</VisuallyHidden>
                        </Button>
                      </>
                    ) : null}
                    <Button
                      variant="secondary"
                      onClick={() => setEditing({ id: entry.id, altText: entry.altTextEn ?? '' })}
                    >
                      Edit description
                      <VisuallyHidden> for {nameOf(entry)}</VisuallyHidden>
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirmRemove(entry)}>
                      Remove
                      <VisuallyHidden> {nameOf(entry)}</VisuallyHidden>
                    </Button>
                  </div>
                ) : null}
                {editing !== null && editing.id === entry.id ? (
                  <form
                    className={styles.inlineFormCard}
                    aria-label="Edit photo description"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveAltText();
                    }}
                    noValidate
                  >
                    <TextField
                      label="Photo description"
                      hint="Read by screen readers and shown while photos load."
                      value={editing.altText}
                      onChange={(event) =>
                        setEditing({ id: editing.id, altText: event.target.value })
                      }
                    />
                    <div className={styles.saveArea}>
                      <Button type="submit" busy={busy} busyLabel="Saving…">
                        Save description
                      </Button>
                      <Button variant="secondary" type="button" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className={styles.sectionIntro}>
          Photo files are managed with Himma outside the portal for now — this section manages
          their descriptions and order only.
        </p>
      </div>

      {confirmRemove !== null ? (
        <ConfirmDialog
          title="Remove this photo reference?"
          confirmLabel="Remove"
          cancelLabel="Keep photo"
          destructive
          onConfirm={() => void remove(confirmRemove)}
          onCancel={() => setConfirmRemove(null)}
        >
          <p>The photo stops appearing on this listing. The reference stays in your history.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
