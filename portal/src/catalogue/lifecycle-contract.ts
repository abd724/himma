/**
 * Provider listing LIFECYCLE seam (W2-9) — mirrors the REAL S4 named
 * lifecycle actions (backend/src/modules/catalogue/http/catalogue-routes.ts,
 * "Named lifecycle actions" section) operation for operation. W2-12
 * implements this port over the live API; until then the semantic fixture
 * stands behind the same contract.
 *
 * Operations and their real routes (capability in parentheses):
 * - `submitProgram`  ⇄ POST .../listings/:programId/submit  (`listings.manage`)
 * - `publishProgram` ⇄ POST .../listings/:programId/publish (`listings.publish`)
 * - `pauseProgram`   ⇄ POST .../listings/:programId/pause   (`listings.publish`)
 * - `archiveProgram` ⇄ POST .../listings/:programId/archive (`listings.publish`)
 *
 * These four are the ONLY provider lifecycle actions that exist. There is no
 * separate resume/unpublish route (resume from `paused` IS the publish
 * action; pause IS unpublish), no provider approval/decision action, no
 * revision decision or withdrawal, and no restore from `archived`
 * (terminal). Publication is never a state patch — a smuggled
 * `listingState` is structurally inexpressible here, exactly like the wire.
 *
 * Semantics preserved from the shipped services (program-management.ts):
 * - submit: legal from `draft` and `changes_requested` only (resubmission
 *   after changes-requested is the SAME submit action); branch-scoped seats
 *   must hold the STRICTER every-rule mutation scope (`forbidden`
 *   otherwise); completeness is service-enforced (`programIncomplete` with
 *   the structured `missing[]`).
 * - publish: legal from `approved` (first publication) and `paused`
 *   (resume) only; requires the parent organization's verification state to
 *   be `live` (`organizationNotLive`); completeness re-checked at publish
 *   time. Branch scope is NOT consulted (no branch-scoped role holds
 *   `listings.publish`), so the union carries no scope refusal.
 * - pause: legal from `published` only.
 * - archive: legal from `published` and `paused` only; terminal — the
 *   archived row is permanently frozen and the response carries no version.
 * - Every action operates on the versioned Program (`expectedVersion` CAS);
 *   a stale command never overwrites (`staleVersion`).
 * - Per-action check order mirrors the services exactly:
 *   submit  → notFound → scope forbidden → lifecycleConflict → staleVersion → programIncomplete
 *   publish → notFound → lifecycleConflict → organizationNotLive → staleVersion → programIncomplete
 *   pause   → notFound → lifecycleConflict → staleVersion
 *   archive → notFound → lifecycleConflict → staleVersion
 * - Policy layer ahead of all of that (the same pipeline as the editor
 *   port): session/org/membership not-found shaping → capability
 *   `forbidden` → suspended-organization mutation refusal.
 *
 * Deliberately ABSENT because no backend contract exists for them: reviewer
 * feedback of any kind for `changes_requested` (the admin reason code is
 * audit-only and provider-unreadable — recorded contract gap), revision
 * decisions/history, and any restore/reactivation of archived listings.
 */

/** The exact backend CompletenessGap vocabulary (program-management.ts),
 *  service-enforced at submit AND publish. */
export const COMPLETENESS_GAPS = [
  'title',
  'activeTaxonomy',
  'activeBranch',
  'activePriceOption',
] as const;
export type CompletenessGap = (typeof COMPLETENESS_GAPS)[number];

/** Shared policy-layer refusals (exact pipeline order documented above). */
type PolicyRefusal =
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'organizationSuspended' }
  | { readonly kind: 'unavailable' };

export type SubmitProgramOutcome =
  | { readonly kind: 'programSubmitted'; readonly version: number }
  | { readonly kind: 'programIncomplete'; readonly missing: readonly CompletenessGap[] }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

export type PublishProgramOutcome =
  | { readonly kind: 'programPublished'; readonly version: number }
  | { readonly kind: 'programIncomplete'; readonly missing: readonly CompletenessGap[] }
  | { readonly kind: 'organizationNotLive' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

export type PauseProgramOutcome =
  | { readonly kind: 'programPaused'; readonly version: number }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

/** Terminal: the real response carries no version (the row is frozen). */
export type ArchiveProgramOutcome =
  | { readonly kind: 'programArchived' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

export interface ListingLifecyclePort {
  submitProgram(
    organizationId: string,
    programId: string,
    expectedVersion: number,
  ): Promise<SubmitProgramOutcome>;
  publishProgram(
    organizationId: string,
    programId: string,
    expectedVersion: number,
  ): Promise<PublishProgramOutcome>;
  pauseProgram(
    organizationId: string,
    programId: string,
    expectedVersion: number,
  ): Promise<PauseProgramOutcome>;
  archiveProgram(
    organizationId: string,
    programId: string,
    expectedVersion: number,
  ): Promise<ArchiveProgramOutcome>;
}

/** The 4 real lifecycle actions — the exact structural surface, used by the
 *  contract lock test and the fail-closed unconfigured port. */
export const LISTING_LIFECYCLE_OPERATIONS = [
  'submitProgram',
  'publishProgram',
  'pauseProgram',
  'archiveProgram',
] as const;
