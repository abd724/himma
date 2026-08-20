import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTaxonomyPort } from '../../app/app';
import { useSessionActions } from '../../auth/session-context';
import type {
  ActivityTypeView,
  AreaView,
  CategoryView,
  CollectionView,
  TaxonomyActionOutcome,
  TaxonomyAdminView,
} from '../../taxonomy/contract';
import pageStyles from '../pages.module.css';
import styles from '../providers/providers.module.css';

/**
 * W3-7 taxonomy administration workspace (AD-06) over the CERTIFIED S4
 * admin taxonomy surface. The four resource types keep their distinct
 * identities and semantics — never a flattened universal record. The
 * workspace supports exactly what the backend supports: navigation across
 * all rows (inactive included), creation, editing the certified mutable
 * fields, activation/deactivation (collections: draft/published/archived
 * state), CAS stale handling, and the typed dependency/conflict refusals.
 * Deliberately ABSENT because the domain does not support them: deletion,
 * slug/identifier changes, activity-type re-parenting, and arbitrary
 * reordering beyond the certified sortHint data.
 */

export const TAXONOMY_SECTIONS = [
  { key: 'categories', label: 'Categories' },
  { key: 'activity-types', label: 'Activity types' },
  { key: 'areas', label: 'Areas' },
  { key: 'collections', label: 'Collections' },
] as const;

type SectionKey = (typeof TAXONOMY_SECTIONS)[number]['key'];

const ACTION_MESSAGES: Record<
  Exclude<TaxonomyActionOutcome['kind'], 'completed' | 'stepUpRequired'>,
  string
> = {
  staleVersion:
    'This item changed while you were editing it. The view has been refreshed — re-check and try again.',
  slugConflict: 'That slug is already used by another item of this type. Choose a different one.',
  invalidTaxonomy: 'The selected parent category no longer exists. Refresh and re-check.',
  invalidInput:
    'Those values were refused by the catalogue rules — check required labels, lengths, and the slug format (lowercase letters, digits, hyphens).',
  forbidden: 'Your roles don’t include taxonomy management.',
  notFound: 'This item could not be found. Refresh the view.',
  unavailable: 'The taxonomy service is temporarily unavailable. Try again shortly.',
};

function statusBadge(active: boolean): ReactNode {
  return (
    <span className={`${styles.badge} ${active ? styles.badgeLive : styles.badgeBlocked}`}>
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

function collectionBadge(state: string): ReactNode {
  const tone =
    state === 'published'
      ? styles.badgeLive
      : state === 'archived'
        ? styles.badgeBlocked
        : styles.badgeNeutral;
  return <span className={`${styles.badge} ${tone}`}>{state}</span>;
}

/** One shared mutation runner: typed refusal → message, completion →
 *  authoritative refetch; step-up opens the action-level re-verification
 *  seam (D-W3-5) — never a bypass. */
function useTaxonomyActions() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpNeeded, setStepUpNeeded] = useState(false);
  const sessionActions = useSessionActions();
  const [stepUpCode, setStepUpCode] = useState('');

  const afterAction = async (outcome: TaxonomyActionOutcome): Promise<boolean> => {
    if (outcome.kind === 'completed') {
      setNotice(null);
      setStepUpNeeded(false);
      await queryClient.invalidateQueries({ queryKey: ['admin-taxonomy'] });
      return true;
    }
    if (outcome.kind === 'stepUpRequired') {
      setStepUpNeeded(true);
      setNotice(
        'This change needs a fresh verification of your identity. Enter your authenticator code, then try the change again.',
      );
      return false;
    }
    if (outcome.kind === 'staleVersion') {
      await queryClient.invalidateQueries({ queryKey: ['admin-taxonomy'] });
    }
    setNotice(ACTION_MESSAGES[outcome.kind]);
    return false;
  };

  const submitStepUp = async (event: FormEvent) => {
    event.preventDefault();
    const result = await sessionActions.completeStepUpTotp(stepUpCode.trim());
    if (result.kind === 'completed') {
      setStepUpNeeded(false);
      setStepUpCode('');
      setNotice('Identity re-verified — you can run the change again now.');
    } else {
      setNotice('That code wasn’t accepted. Try again.');
    }
  };

  const noticePanel = (
    <>
      {notice !== null ? (
        <p className={styles.actionNotice} role="alert">
          {notice}
        </p>
      ) : null}
      {stepUpNeeded ? (
        <form className={styles.stepUpForm} onSubmit={(event) => void submitStepUp(event)}>
          <label className={styles.fieldLabel} htmlFor="taxonomy-step-up">
            Verification code
          </label>
          <input
            id="taxonomy-step-up"
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
    </>
  );

  return { afterAction, noticePanel };
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

/** The immutable stable identifier — shown, never editable (the backend
 *  cannot express a slug change; the trigger is the final authority). */
function ImmutableSlug({ slug }: { slug: string }) {
  return (
    <p className={styles.subSecondary}>
      Slug: <code>{slug}</code> — stable identifier, cannot be changed.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

function AreasSection({
  areas,
  actions,
}: {
  areas: readonly AreaView[];
  actions: ReturnType<typeof useTaxonomyActions>;
}) {
  const port = useTaxonomyPort();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ labelEn: '', city: '', sortHint: '' });
  const [create, setCreate] = useState({ slug: '', labelEn: '', city: '', sortHint: '' });
  const selected = areas.find((area) => area.id === selectedId) ?? null;

  const select = (area: AreaView) => {
    setSelectedId(area.id);
    setDraft({ labelEn: area.labelEn, city: area.city ?? '', sortHint: String(area.sortHint) });
  };

  const save = useMutation({
    mutationFn: (input: { areaId: string; expectedVersion: number; active?: boolean }) =>
      port.updateArea(input.areaId, {
        expectedVersion: input.expectedVersion,
        patch:
          input.active !== undefined
            ? { active: input.active }
            : {
                labelEn: draft.labelEn.trim(),
                city: draft.city.trim() === '' ? null : draft.city.trim(),
                ...(draft.sortHint.trim() !== '' ? { sortHint: Number(draft.sortHint) } : {}),
              },
      }),
    async onSuccess(outcome) {
      if (await actions.afterAction(outcome)) setSelectedId(null);
    },
  });
  const add = useMutation({
    mutationFn: () =>
      port.createArea({
        slug: create.slug.trim(),
        labelEn: create.labelEn.trim(),
        ...(create.city.trim() !== '' ? { city: create.city.trim() } : {}),
        ...(create.sortHint.trim() !== '' ? { sortHint: Number(create.sortHint) } : {}),
      }),
    async onSuccess(outcome) {
      if (await actions.afterAction(outcome)) {
        setCreate({ slug: '', labelEn: '', city: '', sortHint: '' });
      }
    },
  });
  const busy = save.isPending || add.isPending;

  return (
    <div className={styles.detailGrid}>
      <section className={styles.sectionPanel} aria-labelledby="areas-title">
        <h2 id="areas-title" className={styles.sectionTitle}>
          Areas
        </h2>
        <p className={styles.subSecondary}>
          Geographic discovery areas. Retirement is deactivation — existing branches keep their
          area; deactivated areas simply stop being selectable for new use.
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Area</th>
                <th scope="col">Slug</th>
                <th scope="col">City</th>
                <th scope="col">Sort</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {areas.map((area) => (
                <tr key={area.id} className={styles.rowLink} onClick={() => select(area)}>
                  <td data-label="Area">
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={(event) => {
                        event.stopPropagation();
                        select(area);
                      }}
                    >
                      {area.labelEn}
                    </button>
                  </td>
                  <td data-label="Slug">
                    <code>{area.slug}</code>
                  </td>
                  <td data-label="City">{area.city ?? '—'}</td>
                  <td data-label="Sort">{area.sortHint}</td>
                  <td data-label="Status">{statusBadge(area.active)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected !== null ? (
          <form
            aria-label={`Edit ${selected.labelEn}`}
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate({ areaId: selected.id, expectedVersion: selected.version });
            }}
          >
            <h3 className={styles.subPrimary}>Edit area</h3>
            <ImmutableSlug slug={selected.slug} />
            <Field id="area-label" label="Label (English)">
              <input
                id="area-label"
                className={styles.searchInput}
                required
                value={draft.labelEn}
                onChange={(event) => setDraft({ ...draft, labelEn: event.target.value })}
              />
            </Field>
            <Field id="area-city" label="City">
              <input
                id="area-city"
                className={styles.searchInput}
                value={draft.city}
                onChange={(event) => setDraft({ ...draft, city: event.target.value })}
              />
            </Field>
            <Field id="area-sort" label="Sort hint">
              <input
                id="area-sort"
                className={styles.searchInput}
                inputMode="numeric"
                value={draft.sortHint}
                onChange={(event) => setDraft({ ...draft, sortHint: event.target.value })}
              />
            </Field>
            <div className={styles.actionRow}>
              <button type="submit" className={styles.primaryButton} disabled={busy}>
                Save area
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={busy}
                onClick={() =>
                  save.mutate({
                    areaId: selected.id,
                    expectedVersion: selected.version,
                    active: !selected.active,
                  })
                }
              >
                {selected.active ? 'Deactivate' : 'Reactivate'}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setSelectedId(null)}
              >
                Close
              </button>
            </div>
          </form>
        ) : null}
      </section>
      <section className={styles.sectionPanel} aria-labelledby="areas-new-title">
        <h2 id="areas-new-title" className={styles.sectionTitle}>
          New area
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <Field id="area-new-slug" label="Slug (permanent identifier)">
            <input
              id="area-new-slug"
              className={styles.searchInput}
              required
              placeholder="e.g. business-bay"
              value={create.slug}
              onChange={(event) => setCreate({ ...create, slug: event.target.value })}
            />
          </Field>
          <Field id="area-new-label" label="Label (English)">
            <input
              id="area-new-label"
              className={styles.searchInput}
              required
              value={create.labelEn}
              onChange={(event) => setCreate({ ...create, labelEn: event.target.value })}
            />
          </Field>
          <Field id="area-new-city" label="City">
            <input
              id="area-new-city"
              className={styles.searchInput}
              value={create.city}
              onChange={(event) => setCreate({ ...create, city: event.target.value })}
            />
          </Field>
          <Field id="area-new-sort" label="Sort hint">
            <input
              id="area-new-sort"
              className={styles.searchInput}
              inputMode="numeric"
              value={create.sortHint}
              onChange={(event) => setCreate({ ...create, sortHint: event.target.value })}
            />
          </Field>
          <div className={styles.actionRow}>
            <button type="submit" className={styles.primaryButton} disabled={busy}>
              Create area
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function CategoriesSection({
  categories,
  actions,
}: {
  categories: readonly CategoryView[];
  actions: ReturnType<typeof useTaxonomyActions>;
}) {
  const port = useTaxonomyPort();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ labelEn: '', sortHint: '' });
  const [create, setCreate] = useState({ slug: '', labelEn: '', sortHint: '' });
  const selected = categories.find((category) => category.id === selectedId) ?? null;

  const select = (category: CategoryView) => {
    setSelectedId(category.id);
    setDraft({ labelEn: category.labelEn, sortHint: String(category.sortHint) });
  };

  const save = useMutation({
    mutationFn: (input: { categoryId: string; expectedVersion: number; active?: boolean }) =>
      port.updateCategory(input.categoryId, {
        expectedVersion: input.expectedVersion,
        patch:
          input.active !== undefined
            ? { active: input.active }
            : {
                labelEn: draft.labelEn.trim(),
                ...(draft.sortHint.trim() !== '' ? { sortHint: Number(draft.sortHint) } : {}),
              },
      }),
    async onSuccess(outcome) {
      if (await actions.afterAction(outcome)) setSelectedId(null);
    },
  });
  const add = useMutation({
    mutationFn: () =>
      port.createCategory({
        slug: create.slug.trim(),
        labelEn: create.labelEn.trim(),
        ...(create.sortHint.trim() !== '' ? { sortHint: Number(create.sortHint) } : {}),
      }),
    async onSuccess(outcome) {
      if (await actions.afterAction(outcome)) setCreate({ slug: '', labelEn: '', sortHint: '' });
    },
  });
  const busy = save.isPending || add.isPending;

  return (
    <div className={styles.detailGrid}>
      <section className={styles.sectionPanel} aria-labelledby="categories-title">
        <h2 id="categories-title" className={styles.sectionTitle}>
          Categories
        </h2>
        <p className={styles.subSecondary}>
          Top-level catalogue classification. Deactivating a category never touches existing
          listings — their activity types keep their references; the category stops being offered
          for new discovery use.
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Slug</th>
                <th scope="col">Sort</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <tr key={category.id} className={styles.rowLink} onClick={() => select(category)}>
                  <td data-label="Category">
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={(event) => {
                        event.stopPropagation();
                        select(category);
                      }}
                    >
                      {category.labelEn}
                    </button>
                  </td>
                  <td data-label="Slug">
                    <code>{category.slug}</code>
                  </td>
                  <td data-label="Sort">{category.sortHint}</td>
                  <td data-label="Status">{statusBadge(category.active)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected !== null ? (
          <form
            aria-label={`Edit ${selected.labelEn}`}
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate({ categoryId: selected.id, expectedVersion: selected.version });
            }}
          >
            <h3 className={styles.subPrimary}>Edit category</h3>
            <ImmutableSlug slug={selected.slug} />
            <Field id="category-label" label="Label (English)">
              <input
                id="category-label"
                className={styles.searchInput}
                required
                value={draft.labelEn}
                onChange={(event) => setDraft({ ...draft, labelEn: event.target.value })}
              />
            </Field>
            <Field id="category-sort" label="Sort hint">
              <input
                id="category-sort"
                className={styles.searchInput}
                inputMode="numeric"
                value={draft.sortHint}
                onChange={(event) => setDraft({ ...draft, sortHint: event.target.value })}
              />
            </Field>
            <div className={styles.actionRow}>
              <button type="submit" className={styles.primaryButton} disabled={busy}>
                Save category
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={busy}
                onClick={() =>
                  save.mutate({
                    categoryId: selected.id,
                    expectedVersion: selected.version,
                    active: !selected.active,
                  })
                }
              >
                {selected.active ? 'Deactivate' : 'Reactivate'}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setSelectedId(null)}
              >
                Close
              </button>
            </div>
          </form>
        ) : null}
      </section>
      <section className={styles.sectionPanel} aria-labelledby="categories-new-title">
        <h2 id="categories-new-title" className={styles.sectionTitle}>
          New category
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <Field id="category-new-slug" label="Slug (permanent identifier)">
            <input
              id="category-new-slug"
              className={styles.searchInput}
              required
              placeholder="e.g. martial-arts"
              value={create.slug}
              onChange={(event) => setCreate({ ...create, slug: event.target.value })}
            />
          </Field>
          <Field id="category-new-label" label="Label (English)">
            <input
              id="category-new-label"
              className={styles.searchInput}
              required
              value={create.labelEn}
              onChange={(event) => setCreate({ ...create, labelEn: event.target.value })}
            />
          </Field>
          <Field id="category-new-sort" label="Sort hint">
            <input
              id="category-new-sort"
              className={styles.searchInput}
              inputMode="numeric"
              value={create.sortHint}
              onChange={(event) => setCreate({ ...create, sortHint: event.target.value })}
            />
          </Field>
          <div className={styles.actionRow}>
            <button type="submit" className={styles.primaryButton} disabled={busy}>
              Create category
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity types
// ---------------------------------------------------------------------------

function ActivityTypesSection({
  activityTypes,
  categories,
  actions,
}: {
  activityTypes: readonly ActivityTypeView[];
  categories: readonly CategoryView[];
  actions: ReturnType<typeof useTaxonomyActions>;
}) {
  const port = useTaxonomyPort();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ labelEn: '', synonymsEn: '' });
  const [create, setCreate] = useState({ slug: '', labelEn: '', categoryId: '', synonymsEn: '' });
  const selected = activityTypes.find((type) => type.id === selectedId) ?? null;
  const categoryLabel = (categoryId: string): string =>
    categories.find((category) => category.id === categoryId)?.labelEn ?? categoryId;

  const parseSynonyms = (value: string): string[] =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');

  const select = (type: ActivityTypeView) => {
    setSelectedId(type.id);
    setDraft({ labelEn: type.labelEn, synonymsEn: type.synonymsEn.join(', ') });
  };

  const save = useMutation({
    mutationFn: (input: { activityTypeId: string; expectedVersion: number; active?: boolean }) =>
      port.updateActivityType(input.activityTypeId, {
        expectedVersion: input.expectedVersion,
        patch:
          input.active !== undefined
            ? { active: input.active }
            : { labelEn: draft.labelEn.trim(), synonymsEn: parseSynonyms(draft.synonymsEn) },
      }),
    async onSuccess(outcome) {
      if (await actions.afterAction(outcome)) setSelectedId(null);
    },
  });
  const add = useMutation({
    mutationFn: () =>
      port.createActivityType({
        slug: create.slug.trim(),
        categoryId: create.categoryId,
        labelEn: create.labelEn.trim(),
        ...(create.synonymsEn.trim() !== ''
          ? { synonymsEn: parseSynonyms(create.synonymsEn) }
          : {}),
      }),
    async onSuccess(outcome) {
      if (await actions.afterAction(outcome)) {
        setCreate({ slug: '', labelEn: '', categoryId: '', synonymsEn: '' });
      }
    },
  });
  const busy = save.isPending || add.isPending;

  return (
    <div className={styles.detailGrid}>
      <section className={styles.sectionPanel} aria-labelledby="types-title">
        <h2 id="types-title" className={styles.sectionTitle}>
          Activity types
        </h2>
        <p className={styles.subSecondary}>
          The classification providers select for a listing. Each type belongs to ONE category for
          life — re-parenting does not exist. Deactivating a type stops NEW listings from choosing
          it; existing listings keep it, truthfully.
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Activity type</th>
                <th scope="col">Slug</th>
                <th scope="col">Category</th>
                <th scope="col">Synonyms</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {activityTypes.map((type) => (
                <tr key={type.id} className={styles.rowLink} onClick={() => select(type)}>
                  <td data-label="Activity type">
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={(event) => {
                        event.stopPropagation();
                        select(type);
                      }}
                    >
                      {type.labelEn}
                    </button>
                  </td>
                  <td data-label="Slug">
                    <code>{type.slug}</code>
                  </td>
                  <td data-label="Category">{categoryLabel(type.categoryId)}</td>
                  <td data-label="Synonyms">
                    {type.synonymsEn.length === 0 ? '—' : type.synonymsEn.join(', ')}
                  </td>
                  <td data-label="Status">{statusBadge(type.active)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected !== null ? (
          <form
            aria-label={`Edit ${selected.labelEn}`}
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate({ activityTypeId: selected.id, expectedVersion: selected.version });
            }}
          >
            <h3 className={styles.subPrimary}>Edit activity type</h3>
            <ImmutableSlug slug={selected.slug} />
            <p className={styles.subSecondary}>
              Category: {categoryLabel(selected.categoryId)} — fixed at creation, cannot be
              changed.
            </p>
            <Field id="type-label" label="Label (English)">
              <input
                id="type-label"
                className={styles.searchInput}
                required
                value={draft.labelEn}
                onChange={(event) => setDraft({ ...draft, labelEn: event.target.value })}
              />
            </Field>
            <Field id="type-synonyms" label="Search synonyms (comma-separated)">
              <input
                id="type-synonyms"
                className={styles.searchInput}
                value={draft.synonymsEn}
                onChange={(event) => setDraft({ ...draft, synonymsEn: event.target.value })}
              />
            </Field>
            <div className={styles.actionRow}>
              <button type="submit" className={styles.primaryButton} disabled={busy}>
                Save activity type
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={busy}
                onClick={() =>
                  save.mutate({
                    activityTypeId: selected.id,
                    expectedVersion: selected.version,
                    active: !selected.active,
                  })
                }
              >
                {selected.active ? 'Deactivate' : 'Reactivate'}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setSelectedId(null)}
              >
                Close
              </button>
            </div>
          </form>
        ) : null}
      </section>
      <section className={styles.sectionPanel} aria-labelledby="types-new-title">
        <h2 id="types-new-title" className={styles.sectionTitle}>
          New activity type
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <Field id="type-new-slug" label="Slug (permanent identifier)">
            <input
              id="type-new-slug"
              className={styles.searchInput}
              required
              placeholder="e.g. kitesurfing"
              value={create.slug}
              onChange={(event) => setCreate({ ...create, slug: event.target.value })}
            />
          </Field>
          <Field id="type-new-label" label="Label (English)">
            <input
              id="type-new-label"
              className={styles.searchInput}
              required
              value={create.labelEn}
              onChange={(event) => setCreate({ ...create, labelEn: event.target.value })}
            />
          </Field>
          <Field id="type-new-category" label="Category (fixed after creation)">
            <select
              id="type-new-category"
              className={styles.stateSelect}
              required
              value={create.categoryId}
              onChange={(event) => setCreate({ ...create, categoryId: event.target.value })}
            >
              <option value="">Choose a category…</option>
              {categories
                .filter((category) => category.active)
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.labelEn}
                  </option>
                ))}
            </select>
          </Field>
          <Field id="type-new-synonyms" label="Search synonyms (comma-separated)">
            <input
              id="type-new-synonyms"
              className={styles.searchInput}
              value={create.synonymsEn}
              onChange={(event) => setCreate({ ...create, synonymsEn: event.target.value })}
            />
          </Field>
          <div className={styles.actionRow}>
            <button type="submit" className={styles.primaryButton} disabled={busy}>
              Create activity type
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

function CollectionsSection({
  collections,
  actions,
}: {
  collections: readonly CollectionView[];
  actions: ReturnType<typeof useTaxonomyActions>;
}) {
  const port = useTaxonomyPort();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    titleEn: '',
    subtitleEn: '',
    audience: 'all',
    featured: false,
    seasonalLabel: '',
    state: 'draft',
  });
  const [create, setCreate] = useState({ titleEn: '', subtitleEn: '', audience: 'all' });
  const selected = collections.find((collection) => collection.id === selectedId) ?? null;

  const select = (collection: CollectionView) => {
    setSelectedId(collection.id);
    setDraft({
      titleEn: collection.titleEn,
      subtitleEn: collection.subtitleEn ?? '',
      audience: collection.audience,
      featured: collection.featured,
      seasonalLabel: collection.seasonalLabel ?? '',
      state: collection.state,
    });
  };

  const save = useMutation({
    mutationFn: (input: { collectionId: string; expectedVersion: number }) =>
      port.updateCollection(input.collectionId, {
        expectedVersion: input.expectedVersion,
        patch: {
          titleEn: draft.titleEn.trim(),
          subtitleEn: draft.subtitleEn.trim() === '' ? null : draft.subtitleEn.trim(),
          audience: draft.audience as 'all' | 'adults' | 'children',
          featured: draft.featured,
          seasonalLabel: draft.seasonalLabel.trim() === '' ? null : draft.seasonalLabel.trim(),
          // D-W3-5: `state` is the AVAILABILITY seam (step-up server-side)
          // — send it only when this save actually changes it, so ordinary
          // metadata edits stay ordinary.
          ...(selected !== null && draft.state !== selected.state
            ? { state: draft.state as 'draft' | 'published' | 'archived' }
            : {}),
        },
      }),
    async onSuccess(outcome) {
      if (await actions.afterAction(outcome)) setSelectedId(null);
    },
  });
  const add = useMutation({
    mutationFn: () =>
      port.createCollection({
        titleEn: create.titleEn.trim(),
        ...(create.subtitleEn.trim() !== '' ? { subtitleEn: create.subtitleEn.trim() } : {}),
        audience: create.audience as 'all' | 'adults' | 'children',
      }),
    async onSuccess(outcome) {
      if (await actions.afterAction(outcome)) {
        setCreate({ titleEn: '', subtitleEn: '', audience: 'all' });
      }
    },
  });
  const busy = save.isPending || add.isPending;

  return (
    <div className={styles.detailGrid}>
      <section className={styles.sectionPanel} aria-labelledby="collections-title">
        <h2 id="collections-title" className={styles.sectionTitle}>
          Collections
        </h2>
        <p className={styles.subSecondary}>
          Editorial discovery collections. Lifecycle is draft → published → archived — archiving
          retires a collection without deleting anything.
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Collection</th>
                <th scope="col">Audience</th>
                <th scope="col">Featured</th>
                <th scope="col">Seasonal</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {collections.map((collection) => (
                <tr
                  key={collection.id}
                  className={styles.rowLink}
                  onClick={() => select(collection)}
                >
                  <td data-label="Collection">
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={(event) => {
                        event.stopPropagation();
                        select(collection);
                      }}
                    >
                      {collection.titleEn}
                    </button>
                  </td>
                  <td data-label="Audience">{collection.audience}</td>
                  <td data-label="Featured">{collection.featured ? 'Featured' : '—'}</td>
                  <td data-label="Seasonal">{collection.seasonalLabel ?? '—'}</td>
                  <td data-label="State">{collectionBadge(collection.state)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected !== null ? (
          <form
            aria-label={`Edit ${selected.titleEn}`}
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate({ collectionId: selected.id, expectedVersion: selected.version });
            }}
          >
            <h3 className={styles.subPrimary}>Edit collection</h3>
            <Field id="collection-title" label="Title (English)">
              <input
                id="collection-title"
                className={styles.searchInput}
                required
                value={draft.titleEn}
                onChange={(event) => setDraft({ ...draft, titleEn: event.target.value })}
              />
            </Field>
            <Field id="collection-subtitle" label="Subtitle (English)">
              <input
                id="collection-subtitle"
                className={styles.searchInput}
                value={draft.subtitleEn}
                onChange={(event) => setDraft({ ...draft, subtitleEn: event.target.value })}
              />
            </Field>
            <Field id="collection-audience" label="Audience">
              <select
                id="collection-audience"
                className={styles.stateSelect}
                value={draft.audience}
                onChange={(event) => setDraft({ ...draft, audience: event.target.value })}
              >
                <option value="all">All</option>
                <option value="adults">Adults</option>
                <option value="children">Children</option>
              </select>
            </Field>
            <Field id="collection-seasonal" label="Seasonal label">
              <input
                id="collection-seasonal"
                className={styles.searchInput}
                value={draft.seasonalLabel}
                onChange={(event) => setDraft({ ...draft, seasonalLabel: event.target.value })}
              />
            </Field>
            <Field id="collection-state" label="Lifecycle state">
              <select
                id="collection-state"
                className={styles.stateSelect}
                value={draft.state}
                onChange={(event) => setDraft({ ...draft, state: event.target.value })}
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            </Field>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="collection-featured">
                <input
                  id="collection-featured"
                  type="checkbox"
                  checked={draft.featured}
                  onChange={(event) => setDraft({ ...draft, featured: event.target.checked })}
                />{' '}
                Featured
              </label>
            </div>
            <div className={styles.actionRow}>
              <button type="submit" className={styles.primaryButton} disabled={busy}>
                Save collection
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setSelectedId(null)}
              >
                Close
              </button>
            </div>
          </form>
        ) : null}
      </section>
      <section className={styles.sectionPanel} aria-labelledby="collections-new-title">
        <h2 id="collections-new-title" className={styles.sectionTitle}>
          New collection
        </h2>
        <p className={styles.subSecondary}>New collections start as drafts.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <Field id="collection-new-title" label="Title (English)">
            <input
              id="collection-new-title"
              className={styles.searchInput}
              required
              value={create.titleEn}
              onChange={(event) => setCreate({ ...create, titleEn: event.target.value })}
            />
          </Field>
          <Field id="collection-new-subtitle" label="Subtitle (English)">
            <input
              id="collection-new-subtitle"
              className={styles.searchInput}
              value={create.subtitleEn}
              onChange={(event) => setCreate({ ...create, subtitleEn: event.target.value })}
            />
          </Field>
          <Field id="collection-new-audience" label="Audience">
            <select
              id="collection-new-audience"
              className={styles.stateSelect}
              value={create.audience}
              onChange={(event) => setCreate({ ...create, audience: event.target.value })}
            >
              <option value="all">All</option>
              <option value="adults">Adults</option>
              <option value="children">Children</option>
            </select>
          </Field>
          <div className={styles.actionRow}>
            <button type="submit" className={styles.primaryButton} disabled={busy}>
              Create collection
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function TaxonomyPage() {
  const port = useTaxonomyPort();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSection = searchParams.get('type');
  const section: SectionKey = TAXONOMY_SECTIONS.some((entry) => entry.key === rawSection)
    ? (rawSection as SectionKey)
    : 'categories';
  const actions = useTaxonomyActions();

  const query = useQuery({
    queryKey: ['admin-taxonomy'],
    async queryFn(): Promise<TaxonomyAdminView> {
      const outcome = await port.getTaxonomy();
      if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
      return outcome.view;
    },
    retry: (failureCount, error) => error.message !== 'forbidden' && failureCount < 1,
  });

  let content: ReactNode;
  if (query.isPending) {
    content = (
      <div className={styles.statusPanel} role="status">
        Loading taxonomy…
      </div>
    );
  } else if (query.isError) {
    content =
      query.error.message === 'forbidden' ? (
        <div className={styles.statusPanel}>Your roles don’t include taxonomy management.</div>
      ) : (
        <div className={styles.statusPanel} role="alert">
          <p style={{ marginTop: 0 }}>We couldn’t load the taxonomy.</p>
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
    content = (
      <>
        {actions.noticePanel}
        {section === 'areas' ? <AreasSection areas={view.areas} actions={actions} /> : null}
        {section === 'categories' ? (
          <CategoriesSection categories={view.categories} actions={actions} />
        ) : null}
        {section === 'activity-types' ? (
          <ActivityTypesSection
            activityTypes={view.activityTypes}
            categories={view.categories}
            actions={actions}
          />
        ) : null}
        {section === 'collections' ? (
          <CollectionsSection collections={view.collections} actions={actions} />
        ) : null}
      </>
    );
  }

  return (
    <>
      <h1 className={pageStyles.pageTitle}>Taxonomy</h1>
      <p className={pageStyles.lead}>
        The catalogue’s shared classification data. Items are retired by deactivation — nothing is
        ever deleted, and existing listings always keep their references.
      </p>
      <div className={styles.controls}>
        <div className={styles.viewToggle} role="group" aria-label="Taxonomy type">
          {TAXONOMY_SECTIONS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={
                entry.key === section
                  ? `${styles.viewButton} ${styles.viewButtonActive}`
                  : styles.viewButton
              }
              aria-pressed={entry.key === section}
              onClick={() => {
                setSearchParams((previous) => {
                  const next = new URLSearchParams(previous);
                  next.set('type', entry.key);
                  return next;
                });
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      {content}
    </>
  );
}
