# Backend Slice 4 — Catalogue, Listings/Offerings, Classification, and Search Foundation

**Status: DRAFT for owner review (2026-08-07). Documentation and technical design only — no migration, service, route, search implementation, portal, or frontend code accompanies this document, and implementation begins only commit-by-commit per §17 after this plan is approved.**

This plan implements docs/24 §13 row 4 (catalogue & search) within the docs/25 engineering contract, on the closed Slice-1/2/3 foundations (Slice 3 closed at `799804a`; commit record in docs/27 §18). It follows the docs/26/27 planning pattern: model → boundaries → lifecycle → authorization → database design → API contracts → search architecture → tests → commit sequence → owner decisions. Where docs/24 already fixed a shape (taxonomy §2.1, Program §2.2, eligibility §2.5, price model §2.6, listing machine §5.3, mock mapping §12), this plan applies it and adds implementation detail; it re-decides nothing that is already owner-approved.

**Product model (binding restatement).** Himma is a multi-provider activities marketplace. Search and discovery operate primarily at the LISTING/OFFERING level across providers: a customer searching `jiu-jitsu` sees jiu-jitsu offerings from multiple academies; opening one shows its provider identity; tapping the provider opens that provider's public storefront with all of that provider's published offerings. The Slice-3 spine is binding and is NOT redesigned:

`Organization → OrganizationPublicProfile (storefront) → Branch → Listing (Program)`

Every listing belongs to exactly ONE organization, resolves its storefront in one hop (`program.organization_id`), and is offerable only at branches of its OWN organization through the composite key `branch (id, organization_id)` that S3-1 shipped and the docs/27 §12.8 structural test already proves. Launch is English-only; every content entity keeps the docs/24 bilingual-column pattern (nullable `_ar`) so Arabic is additive (W7), never a redesign.

---

## 1. Slice boundary

**In Slice 4:**

1. **Taxonomy** — `category`, `activity_type` (with search synonyms), `collection` (admin-curated), and the `area` reference table that S3-1's `branch.area_id` has been waiting for (docs/27 §17 "can wait for Slice 4"), all as admin-owned versioned DATA seeded from the approved docs/15 §3 twelve-entry content — never hard-coded labels in application code.
2. **Program (listing)** — the docs/24 §2.2 canonical entity: organization-owned, activity-typed, branch-associated, with embedded §2.5 eligibility, §2.6 catalogue price model in fils, media references, and the §5.3 publication lifecycle DB-enforced.
3. **Offer** — the structured §2.2 entity (`freeTrial`/`paidTrial`/`discount`/`promo`); discount/promo stay informational per docs/09 §22.5.
4. **Sensitive-field revision flow** — pending revisions of admin-designated sensitive fields (price, eligibility, safety copy) moving through review while the current version stays live (§5.3 note; §7 below).
5. **Provider catalogue management** — activation of the reserved Slice-3 capabilities (`listings.manage`, `media.manage` + new `listings.publish`, `catalogue.read`) on the SAME capability registry and `provider`/`providerStepUp` policy machinery; branch-scope enforcement extends unchanged.
6. **Admin catalogue surface foundation** — the §5.3 admin review transitions (`submitted → in_review → approved | changes_requested`) and taxonomy administration on the existing `admin` policy; the review-queue UI remains W3.
7. **Customer-public read foundation** — public listing detail projection, provider-storefront listings endpoint, catalogue/browse reads, and the search/discovery query API over published-and-eligible listings only.
8. **Search foundation** — PostgreSQL-native search (FTS + trigram + taxonomy synonyms) over a derived, rebuildable search-document projection, with the authoritative visibility predicate applied at query time (§12–§13); outbox events feeding future index/cache consumers.
9. **Audit/outbox vocabulary** for every catalogue state change (§15).
10. **Mock→production mapping closeout** for catalogue surfaces (§20–§21; docs/24 §12 applied).

**Outside Slice 4 (explicit):** RecurringSchedule / Session / CampWeek / EnrolmentCohort, capacity, cutoffs, and every schedule-derived display field (Slice 6) · CapacityHold / PriceQuote / Booking / free-booking confirmation (Slice 7) · payments, refunds, entitlement redemption (`PackageEntitlement`), enrolment/membership billing (W5 + later slices; docs/23 §19 stands) · attendance · reviews/ratings (later slice; projections stay absent-until-built) · recommendation/popularity ranking · waitlists (docs/24 §14.B11 — no schema reserved) · the **Instructor** entity (docs/24 §2.2 — deferred to the sessions slice with its session-bound authorization scope; storefront "team" display stays mock-only per docs/20 §8.5) · media upload/object-storage/CDN infrastructure (docs/23 §10.6 — Slice 4 owns REFERENCES only, §14 below) · provider-portal UI (W2), admin-portal UI (W3), customer-frontend integration (its own later milestone) · online/branchless listings (docs/24 fixes `branch_ids ≥ 1`; a branchless kind would be a NEW owner decision — recorded in §22, not silently added) · Arabic content workflow (docs/24 §14.B12) · production search-engine tier selection (docs/23 §18.20 — the owner's; §12 recommends the staged posture that keeps it open).

## 2. Providers sell different things — one catalogue model

The catalogue model is docs/24's single Program shape; provider diversity is expressed through `activity_type`, `price_model`, offers, and (in later slices) the three capacity-unit kinds — never through parallel per-vertical schemas:

| Provider example | Catalogue representation (Slice 4) | Bookable mechanics (later slices) |
|---|---|---|
| Gym — monthly membership | Program (`price_model = monthly`) | EnrolmentCohort intakes (Slice 6), Enrolment subtype (Slice 7) |
| Gym — 3-month membership | Program (`price_model = term`) — or a price OPTION of one membership listing under D-S4-1 | same |
| Gym — PT package | Program (`price_model = package`, sessions = N) | PackageEntitlement (Slice 7) |
| Gym — group fitness class | Program (`price_model = dropIn`) | Sessions (Slice 6) |
| Academy — adult beginner jiu-jitsu | Program (adult eligibility) — junior variant is a SEPARATE Program, never a duplicated activity type (docs/24 §2.1) | trial via Offer; monthly/term via cohorts |
| Academy — private session | Program (`private/group` metadata, §10) | Sessions |
| Spa — 60/90-minute massage | Programs (`dropIn`) or one listing with duration options under D-S4-1 | appointment Sessions at a selected branch |
| Spa — 5-session package | Program (`package`) | PackageEntitlement |
| Kids provider — after-school program / term enrolment | Program | EnrolmentCohort |
| Camps — summer camp / camp week | Program (`price_model = camp`) | CampWeek units |

No gym-specific, spa-specific, or academy-specific table exists anywhere in this plan.

## 3. Listing versus bookable option (the central design question)

**What canon already resolves (restated, not re-decided).** docs/24 fixes: the customer-facing LISTING is the **Program** — the thing discovered on Home/Search/Results (`Adult Beginner Jiu-Jitsu`). A Program may expose SEVERAL bookable shapes: the mock contract says so explicitly (`BookingOption[]` — "a program may offer several, e.g. trial + enrolment") and docs/24 §12.2 maps it: booking options are **server-computed** from the program's price model + its Offers (trials) + the §2.4 capacity units (sessions / camp weeks / enrolment cohorts). Trials are Offers, never duplicate listings. Sessions/cohorts/camp-weeks are inventory beneath an option, never listings. Enrolment cohorts may carry cohort-level price OVERRIDES (`price_ref`, §2.3). So the canonical hierarchy is:

`Program (listing, discovered) → bookable options (server-computed) → capacity unit (session | camp week | cohort) → hold/booking`

**What canon does NOT resolve — D-S4-1 (blocking).** docs/24 §2.2 stores ONE `price_model` per Program (exactly the mock shape). That cleanly serves one commercial shape per listing plus a trial. It does NOT cleanly serve one listing selling several priced shapes at once — the gym whose "Membership" page offers monthly AND 3-month AND annual, or the spa whose "Massage" listing offers 60 and 90 minutes. Under current canon those are separate Programs. Whether that is the desired product is a genuine commercial/UX decision — §22 presents it (alternatives, tradeoffs, one recommendation). Slice 4's schema is designed so EITHER ruling is additive (§9 seam note); no silent choice is made.

## 4. Listing ownership and branch association

- `program.organization_id` — immutable ownership; every listing belongs to exactly one Organization forever (trigger-enforced like every Slice-3 ownership column).
- `program_branch (program_id, branch_id, organization_id)` with composite FKs BOTH sides — `(program_id, organization_id) → program (id, organization_id)` and `(branch_id, organization_id) → branch (id, organization_id)` — the exact shape the docs/27 §12.8 structural probe already proved against the live S3-1 keys. Cross-organization association is impossible at the database layer, by construction, even under direct SQL.
- ≥ 1 branch association required for submission (service-enforced completeness, mirroring the S3-1 organization-submission rule); a listing may be associated with one or many branches of the SAME organization.
- Online/non-location listings: **not representable** under approved canon (`branch_ids ≥ 1`) and not added here — recorded as a future owner decision (§22 "can wait").
- Deactivating a branch never deletes associations (history) and never transfers reach; public projections simply stop showing the inactive branch, and a listing whose EVERY associated branch is inactive stops being publicly visible (§6 visibility predicate).

## 5. Public listing identity (safe customer contract)

The public listing projection (same structural discipline as the S3-4 storefront: closed column sources, explicit TypeBox schema, no `select *`): listing id · title · short/long description · media refs (ordered, with alt text) · provider identity (organization id + storefront display name — never legal/private data) · storefront link (the S3-4 `GET /providers/:organizationId` contract) · associated ACTIVE branches (public branch fields only) · category/activity type · eligibility (§10) · setting · offer badges · catalogue price representation (§14) · booking-CTA compatibility (option kinds derivable from price model + offers).

Mock-field classification (task rule: nothing mock-displayed becomes authoritative storage by accident):

| Mock field | Class | Production disposition |
|---|---|---|
| `rating`, review count | **later-slice read model** | Review aggregate projection when reviews exist; ABSENT until then (absent-safe rendering already shipped) |
| starting/`from` price | **computed** | Derived from `price_model` (and cohort overrides later); never stored as its own authoritative field |
| `scheduleLabel`, `todayTime`, `availableToday`, `runsOnWeekend`, `runsAfterSchool` | **computed, later-slice inputs** | Server-composed from RecurringSchedule/Session data (Slice 6); ABSENT from Slice-4 projections — never faked |
| `isCamp` | **computed** | Derived from price model/unit kinds (camp) |
| `Provider.categories: string[]` | **mock-only** | Derived from published programs via taxonomy join (docs/24 §12.1) |
| popularity/recommendation labels | **mock-only** | Later ranking work; nothing stored |
| `Offer.label` free text | **canonical (structured)** | Structured Offer entity with typed kind + trial amount in fils |
| title/description/eligibility/setting/price/media | **canonical stored** | Program columns |

## 6. Publication lifecycle (docs/24 §5.3 — applied, not reinvented)

`draft → submitted → in_review → approved | changes_requested (→ submitted on resubmit)`; `approved → published` (provider action, or auto-on-approval as an explicitly CONFIGURABLE value per docs/24 §14.C — default OFF, §22 D-S4-2 confirms the default); `published ⇄ paused` (provider); `published | paused → archived` (provider or admin; terminal). DB-trigger-enforced edges, terminal immutability, timestamp-state ties, optimistic versioning — the exact S3-1/S3-2 pattern. Bulk-import-created listings are always `draft` (docs/24 §2.8); import tooling itself is later work.

- **Who does what:** create/edit/submit — `listings.manage` (owner, org_manager, listings_editor; branch_manager within branch scope, §13); review decisions — admin `operations`; publish/pause — `listings.publish` (owner, org_manager); archive — publisher roles or admin.
- **Himma approval is required before first publication** (draft can never jump to published; trigger-enforced). Whether an already-approved provider's subsequent NON-sensitive edits hot-publish is canon (they do); sensitive-field edits re-enter review via the revision flow (§7).
- **Customer visibility is a compound predicate**, structural in every public query: `program.listing_state = 'published'` AND parent `organization.verification_state = 'live'` AND `organization_public_profile.published = true` AND ≥ 1 associated ACTIVE branch. Suspension/offboarding of the organization removes every listing from public reads and search IMMEDIATELY through the predicate — no cascade write is required for correctness (§13 adds the event-driven index cleanup on top). Branch deactivation removes that branch from the listing's public identity and can remove the listing entirely (previous bullet).
- **Pause is reversible; archive is terminal.** Archived listings are never deleted (retention/history; grants carry no DELETE); future commitments on archived listings are a later-slice concern handled by the §3.6 disruption workflow when sessions exist.

## 7. Sensitive-field revision flow

Per §5.3: edits to admin-designated sensitive fields (price, eligibility, safety copy) on a `published` listing must NOT bypass review, and must not take the current version off the market. Realization: a `program_revision` row holding STRUCTURED copies of exactly the sensitive field set (no free-form payload blob), with its own `submitted → in_review → approved | rejected` machine; approval applies the revision to the program atomically (one transaction: apply + revision state + audit + outbox) and bumps `sensitive_fields_version`. At most one open revision per program (partial unique). Non-sensitive edits on published listings hot-publish directly with their own audit events. The sensitive-field LIST is admin-designated configuration (seeded: price fields, eligibility fields, safety-relevant description) — not hard-coded logic scattered through services.

## 8. Catalogue moderation boundary (Slice 4 vs admin workstream)

Slice 4 owns: the review state machines, the audited admin transition APIs, and the typed outcomes. The admin-portal review QUEUE UI, reviewer tooling, and bulk-import batch views remain W3. **Fail-closed analysis (task §8):** unlike provider verification (D-S3-3), listing review requires no external evidence artifact — the reviewable content IS the database row, and the §5.3 machine already makes approval a mandatory, audited admin action that cannot be bypassed (draft→published has no edge; the trigger refuses it). Therefore no additional capability gate is needed for listing approval, and none is invented; unreviewed content structurally cannot become public. The one production-posture guard retained: `auto-publish-on-approval` defaults OFF (config, §14.C), so nothing becomes customer-visible without an explicit provider (or configured) publication act on top of approval.

## 9. Database model (proposed; final DDL at migration review per docs/25 §9)

Two migrations (one concern each, §17): `0007_taxonomy` and `0008_catalogue`. Slice-1 conventions throughout (UUIDv7, UTC, created/updated/version + shared triggers, CHECK-backed states, `himma_app` SELECT/INSERT/UPDATE only — no DELETE anywhere, append-only history posture).

**0007 — taxonomy/reference:**

1. `area` — id, slug UNIQUE, label_en NOT NULL, label_ar?, city?, sort_hint, active, conventions. Plus the ADDITIVE `branch.area_id → area(id)` FK promised by S3-1 (existing `area_label` stays as denormalized display until reconciliation completes; a backfill/reconciliation note ships with the migration).
2. `category` — id, slug UNIQUE stable identifier, label_en NOT NULL, label_ar?, image_ref?, sort_hint, active, conventions. Launch content = the approved docs/15 §3 twelve entries as SEED data.
3. `activity_type` — id, category_id FK, slug UNIQUE, label_en, label_ar?, synonyms_en text[] (feeds search, docs/14 §3.4), synonyms_ar text[] DEFAULT '{}', active, conventions. One canonical activity per type; adult/junior variants are different Programs (docs/24 §2.1).
4. `collection` — id, title_en/ar?, subtitle_en?, image_ref, filter_preset (TYPED columns mirroring the approved mock preset booleans — not an opaque jsonb), audience CHECK (`all|adults|children`), child_focused, featured, seasonal_label?, state CHECK (`draft|published|archived`), conventions.
5. Taxonomy rules: two visible levels only (Category → ActivityType); deactivation, never deletion; slugs immutable after insert (trigger); admin-owned (§13.3-style admin APIs in §16).

**0008 — catalogue:**

6. `program` — id, organization_id FK (+ `UNIQUE (id, organization_id)` composite target), activity_type_id FK (category derived by join, never stored twice), title_en NOT NULL, title_ar?, description_en?, description_ar?, setting CHECK (`indoor|outdoor`), eligibility columns per §2.5 (min_age?, max_age?, all_ages, gender_eligibility CHECK `men|ladies|mixed`, skill_level? CHECK, eligibility_notes?), price columns per §2.6 in fils (price_kind CHECK over the approved launch subset `dropIn|monthly|term|camp|package|free` — mock `freeTrial` kind dropped per docs/24 §12.1; `membership|weekly` arrive as ADDITIVE CHECK widenings when §14.B7 decides), price_amount_fils? (money_fils domain; NULL for `free`), price_sessions? (package), policy_ref? (template refs arrive with the policy slice), listing_state CHECK per §5.3 + timestamp-state ties, sensitive_fields_version, conventions. Transition trigger: §5.3 edges only, `archived` terminal, ownership/provenance immutable. **D-S4-1 seam:** if the owner rules for multi-option listings, a `program_price_option` child (composite-FK'd to `program (id, organization_id)`) is ADDITIVE and `program.price_*` becomes the default/primary option — no redesign either way.
7. `program_branch` — §4 shape; PK (program_id, branch_id); append-only via `forbid_mutation` (association changes = insert new row / deactivate flag? — associations are re-writable provider data, so instead: plain rows with composite FKs and audited add/remove where remove is an UPDATE `active=false`, keeping history without DELETE).
8. `program_media` — id, program_id (+org composite FK), media_ref (opaque object ref; upload pipeline is later infrastructure), sort_hint, alt_text_en?, alt_text_ar?, active, conventions. Logo/cover remain PROFILE media (S3-1); listing images belong to listings.
9. `offer` — id, program_id (+org composite FK), kind CHECK (`freeTrial|paidTrial|discount|promo`), label_en, label_ar?, trial_amount_fils? (CHECK: required iff `paidTrial`), effective_start?, effective_end?, state CHECK (`active|ended`), conventions.
10. `program_revision` — id, program_id (+org composite FK), structured sensitive-field columns (price_kind/price_amount_fils/price_sessions, eligibility set, safety copy), state CHECK (`submitted|in_review|approved|rejected`), submitted_by, decided_by?, decided_at?, conventions; partial unique: one OPEN revision per program; terminal rows immutable.
11. `program_search_document` — derived projection (§12): program_id PK (+org), search_vector tsvector, denormalized filter columns (category_id, activity_type_id, area_ids uuid[], branch_ids uuid[], age bounds, gender, skill, setting, price_kind, price_amount_fils, has_trial, organization display name), rebuilt_at. Maintained transactionally with its source changes AND fully rebuildable (§13); NEVER consulted for authorization — the §6 visibility predicate joins live tables at query time.
12. Indexes: GIN on search_vector; trigram (pg_trgm) on title/display-name for typo tolerance; partial index on `listing_state='published'`; `program (organization_id, listing_state)`; `program_branch (branch_id)`; taxonomy slug uniques.
13. Grants, SCHEMA_CHECKS, codegen, migrate-from-zero + rollback per policy; §12.8-style forward-compat test now proving the Slice-6 unit shapes (`session/camp_week/enrolment_cohort` with `program_id` + same-org branch composite FKs) attach to `program (id, organization_id)` unchanged.

## 10. Eligibility (levels kept distinct)

Slice 4 stores LISTING-level eligibility only (§2.5 owner-final shape, already the mock shape verbatim). Distinctions preserved and documented in the schema comments: listing-level eligibility (Slice 4, discovery/filtering) ≠ option-level (D-S4-1 dependent) ≠ session-level overrides (Slice 6, `per-session eligibility override`) ≠ booking-time participant validation (Slice 7 — server-side revalidation at hold + confirmation per docs/24 §2.5.3). Search metadata NEVER guarantees eligibility; the booking slice remains authoritative. Gender vocabulary is exactly `men|ladies|mixed` with the docs/16 rules (no automatic adult gender filtering; "Ladies only" is an explicit filter). Optional instruction-language metadata is NOT in canon; recorded in §22 as a can-wait additive column, not silently added.

## 11. Search scope — now versus later

**Implementable in Slice 4 (real data exists):** keyword over title + provider display name + activity-type labels/synonyms (typo-tolerant) · category/activity-type filters · area/branch filters (via `program_branch` → branch → area) · age/gender/skill eligibility filters · indoor/outdoor · trial availability (active `freeTrial|paidTrial` offer) · camps (price_kind `camp`) · price filtering from the catalogue price model · collection presets resolved server-side · child-relevance gating server-side (docs/18 §6). **Deferred until their data exists (never fabricated):** date/time and available-today (Slice 6 sessions) · schedule-derived badges (Slice 6) · rating filters/sort (reviews slice) · popularity/recommendation ranking (later) · private/group filter unless D-S4-1/§22 adds the metadata column · Arabic query surface (W7; `synonyms_ar` columns are ready). Ranking at launch: deterministic relevance (text rank + exact/synonym boosts + published-recency tiebreak) — the mock's deterministic-ranking discipline (docs/14 §3.3) moves server-side; nothing popularity-based is invented.

## 12. Search technology decision (recommendation)

**Recommendation: staged architecture, PostgreSQL-native at launch.** Slice 4 implements search INSIDE PostgreSQL — FTS (`tsvector` + websearch-style parsing) + `pg_trgm` typo tolerance + taxonomy-synonym expansion at query build — over the §9.11 derived document, behind a `SearchReadPort` service boundary so a dedicated engine is a later adapter, not a rewrite. Rationale: docs/23 §10.5 already rules "PostgreSQL FTS acceptable at Tier 1, dedicated engine by Tier 2"; UAE-launch listing volume (hundreds to low thousands) is far below FTS limits; relevance needs (keyword + synonyms + filters) are well served; typo tolerance comes from trigram; operational complexity stays one system with transactional consistency; cost is zero new infrastructure; Arabic later favors a dedicated engine — which is exactly the Tier-2/§18.20 owner decision (docs/24 §14.B14) and is NOT pre-empted here. External engines (OpenSearch/Meilisearch/Typesense) are deliberately deferred: adopting one now adds an availability dependency, index-consistency operations, and cost for no launch-scale benefit. The §18.20 decision remains open and un-blocked.

## 13. Search consistency and fail-safety

PostgreSQL remains the single source of truth. The search document is a projection: (a) maintained in the SAME transaction as publish-affecting catalogue changes (publish/pause/archive, sensitive-revision apply, branch association, taxonomy label/synonym change — cheap at launch scale, impossible to "miss"); (b) fully rebuildable by an idempotent job (`rebuilt_at` watermark) for reconciliation and future engine migration; (c) **never trusted for eligibility** — every customer search/read query JOINs the authoritative §6 visibility predicate (organization live+published, listing published, ≥1 active branch), so a stale or orphaned document can never expose a suspended provider or unpublished listing even for one request — the fail-safe is structural, not eventual. Outbox events (§15) additionally feed future consumers (external index, catalogue cache invalidation, storefront caches) through the existing at-least-once relay + inbox dedup; consumers must be idempotent per docs/24 §9.3. Provider display-name changes and organization lifecycle transitions emit events that trigger document refresh; the predicate covers the window until they apply.

## 14. Media and price relationships

**Media:** references only (§9.8): ordered `program_media` rows with alt text and an opaque `media_ref`; logo/cover stay on the provider profile (S3-1); upload/storage/CDN is docs/23 §10.6 infrastructure assigned elsewhere; deletion is `active=false` retirement (retention). **Price:** the listing carries the CATALOGUE price model (fils) — a display/discovery representation and the input to server-computed booking options; it is never the money truth at checkout: PriceQuote (docs/24 §3.2/§4.2) remains the only authority payment can reference, cohort-level price overrides arrive with Slice 6, `membership|weekly` kinds await §14.B7, and NOTHING here touches the approved checkout/quote architecture. `from`-price displays are computed in projections, never stored. The current UI's single-price cards remain valid under D-S4-1 either way (the projection exposes primary price + option multiplicity when it exists).

## 15. Audit/outbox vocabulary

Same-transaction audit + outbox for every canonical transition (aggregate `program`, ids-only payloads; taxonomy under aggregate `taxonomy`): `listing.created` · `listing.updated` (non-sensitive) · `listing.submitted` · `listing.review_started` · `listing.approved` · `listing.changes_requested` · `listing.published` · `listing.paused` · `listing.archived` · `listing.revision_submitted/approved/rejected` · `listing.branch_association_changed` · `listing.media_changed` · `offer.created/updated/ended` · `taxonomy.category_changed` / `taxonomy.activity_type_changed` / `taxonomy.collection_changed` / `taxonomy.area_changed`. Audit actions mirror in the `org.`/`listing.` namespace pattern established by Slice 3. Later consumers (search projection refresh where not same-transaction, cache invalidation, storefront/recommendation caches) subscribe to these; none is implemented beyond the Slice-4 needs. No payload ever carries provider-private data, tokens, or free-text review notes.

## 16. API contracts (three separated surfaces; TypeBox; every route policy-declared; no field-switching endpoints)

**16.1 Customer-public (policy `public`):** `GET /listings/:programId` (published-and-eligible projection; not-found-shaped otherwise, byte-identical) · `GET /providers/:organizationId/listings` (paginated published listings of one storefront — the §19 recommendation) · `GET /catalogue/categories` / `.../activity-types` / `.../collections` / `.../areas` (active taxonomy) · `GET /search` (typed query object mirroring the mock `FilterSelection`/`SortId` contracts) · discover/browse composition endpoints only as far as the approved mock contracts require. All served exclusively from public projections with the §6 predicate; structural projection locks per surface (§18).

**16.2 Provider-private (policies `provider`/`providerStepUp` + capabilities):** `GET /provider/organizations/:orgId/listings` (own catalogue incl. drafts) · `POST .../listings` · `PATCH .../listings/:id` (CAS; sensitive fields route into the revision flow automatically when published) · `POST .../listings/:id/submit` · `POST .../listings/:id/publish` / `/pause` / `/archive` (`listings.publish`) · branch-association and media management (`listings.manage`/`media.manage`) · `POST .../listings/:id/offers` etc. Staff-management-grade step-up is NOT required for ordinary catalogue editing (it is not in the D-S3-5 higher-risk set); archive is publisher-gated. Cross-org anything stays not-found-shaped.

**16.3 Himma-admin (policy `admin`, `operations` role):** `POST /admin/listings/:id/review/(start|approve|request-changes)` · revision review equivalents · taxonomy CRUD (`/admin/taxonomy/...`) with slug immutability and deactivate-only semantics. Review-queue LISTING endpoints minimal (by state, paginated) — the queue UX is W3.

## 17. Implementation commit sequence (one concern per commit; stop for owner approval after each; do NOT execute now)

| # | Commit | Scope | Acceptance (proportional; each also: tsc/lint clean, focused jest, migrate-from-zero, rollback, `db:verify`, codegen zero drift, prior suites green) |
|---|---|---|---|
| S4-1 | `feat(backend): taxonomy and area reference schema` | Migration 0007 + docs/15 §3 seed + branch.area_id FK + admin taxonomy services/routes | Seed matches approved content; slug immutability; deactivate-only; admin-only negative tests → **stop** |
| S4-2 | `feat(backend): program catalogue schema` | Migration 0008: program + program_branch + program_media + offer + program_revision + search-document table, §5.3 machine + triggers, grants | Machine edge/terminal tests; composite-FK cross-org refusals; price/eligibility CHECKs; §12.8-style Slice-6 forward-compat probe → **stop** |
| S4-3 | `feat(backend): provider catalogue management` | Capability activation (`listings.manage/publish`, `media.manage`, `catalogue.read`), provider listing/media/offer/branch-association services + §16.2 routes, revision flow | Role×route matrix extension; branch-scope negatives; sensitive-edit revision races (CAS single winner); org isolation probes → **stop** |
| S4-4 | `feat(backend): admin review and public listing reads` | §16.3 review/revision transitions, §16.1 listing detail + storefront-listings + taxonomy reads, projection locks | Review races; visibility matrix (all ineligible states byte-identical 404); structural projection locks incl. scratch-column proof; storefront pagination → **stop** |
| S4-5 | `feat(backend): search and discovery foundation` | Search document build/rebuild, FTS+trigram+synonym query service behind `SearchReadPort`, §16.1 search/browse/collection endpoints, outbox consumers' event vocabulary | `jiu-jitsu` cross-provider relevance tests; filter matrix over real columns only; predicate-over-projection fail-safe test (suspended org vanishes with a stale document); rebuild idempotence → **stop** |
| S4-6 | `chore(backend): slice 4 hardening and closeout` | Bounded hardening review, RLS re-check per §21 triggers, docs/28 §status, HANDOFF, mock→production contract-shape tests | Full certification incl. root non-regression → milestone report, **stop before any later slice** |

## 18. Testing / acceptance matrix (real PostgreSQL, Fastify injection; docs/24 §13 row 4 cells included)

Isolation: listing/branch-association/media/offer/revision cannot cross organizations (FK + not-found probes, byte-identical) · provider A cannot see B's drafts through any surface or error difference · branch-scoped roles restricted to scoped branches for listing management. Lifecycle: every §5.3 edge legal/illegal at trigger level; archived terminal; publish requires approved; concurrent review/publish/sensitive-edit races → deterministic single winners via CAS. Visibility: public reads/search return ONLY published listings of live+published orgs with ≥1 active branch; suspension/offboarding/pause/archive/changes_requested all vanish publicly, byte-identically; search can never return an ineligible listing even with a stale/poisoned search document (fail-safe predicate test). Authorization: seven-role matrix extension — exactly the activated capabilities and no others; Finance gains nothing; reserved/later capabilities stay non-executable; Cognito claims inert; customer/admin/provider surface separation re-proven for catalogue routes. Hygiene: no private provider data in any public payload (structural locks + forbidden-pattern scans); taxonomy slugs immutable; grants least-privilege; events atomic with transitions, exactly-once under concurrency. Compatibility: mock→production contract-shape tests for the §12.2 catalogue/search/discover service contracts (shape-level; frontend integration itself is a later milestone — schedule-derived fields explicitly pending Slice 6).

## 19. Provider storefront integration (recommendation)

**Recommendation: a dedicated public `GET /providers/:organizationId/listings` endpoint (paginated, default page ~20, stable ordering), NOT embedding listings in the S3-4 storefront payload.** Rationale: keeps the approved S3-4 projection stable (no churn to a shipped contract); mobile performance (storefront header renders immediately; listings stream separately — matching how the mock `DetailsService` already composes the storefront page); pagination and caching semantics differ (profile vs listing collection); Slice-6 schedule enrichment then touches only the listings endpoint. The storefront response gains NOTHING now (no counts that leak, no empty placeholder arrays); the client composes the two calls behind its existing service contract.

## 20. RLS reconsideration (S3-5 trigger honored)

Re-evaluated for the catalogue tables. **Recommendation: continue deferring.** The Slice-4 additions are (a) admin-owned taxonomy (no per-org isolation dimension), (b) customer-public published projections (RLS adds nothing to public data), and (c) provider-private drafts — which inherit the identical quadruple guard already certified in S3-5 (composite FKs carrying `organization_id` · org-scoped repository predicates · per-request `orgScope` pipeline resolution · the negative isolation suites, extended in §18). The pooled single-`himma_app`-principal constraints, transaction-local-context pooling risks, and cross-org system paths (search, public reads, admin moderation, background rebuild jobs — now MORE numerous, not fewer) are unchanged from the docs/27 §18 analysis; catalogue moderation and indexing would all need bypass policies. **Next reconsideration triggers:** any second database principal or direct-SQL/reporting/analytics access to provider-owned tables · provider-portal production GA · a multi-tenant data-access surface that bypasses the application layer. S4-6 re-checks against these; no partial/decorative policies in between.

## 21. Customer frontend compatibility

docs/24 §12 (owner-approved) is the binding map and needs no re-derivation; Slice 4 confirms it for catalogue surfaces: `Program` core fields map directly; `Provider.categories` derived; schedule flags become Slice-6 computed projections (ABSENT from Slice-4 APIs — the customer app keeps its mocks until the integration milestone, so no screen degrades); `rating` absent until reviews; `PriceModel` moves to fils with the `freeTrial` kind dropped; `Collection.preset` resolves server-side; `SearchService`/`CatalogueService`/`DiscoverFeedService`/`DetailsService` contracts keep their shapes (contract-shape tests in §18). **No customer-page redesign is required or expected**; the docs/24 §12.3 watch-items stand unchanged. The customer app is NOT connected in Slice 4.

## 22. Owner decisions

**Blocking Slice-4 schema (decide before S4-2):**

- **D-S4-1 · Listing ↔ priced-option multiplicity.** Alternatives: **(a) Canon-as-is** — one `price_model` per Program; a gym's monthly/3-month/annual memberships are separate Programs. Pros: zero model change, exact mock parity, simplest provider mental model per listing, unambiguous cards. Cons: duplicate-feeling listings for multi-duration products, diluted search results, no single "Membership" page. **(b) Additive `program_price_option` child** — one listing, several priced options (each mapping to option kinds/units); `program.price_*` becomes primary/from-price. Pros: matches gym/spa reality, one discovery result per product, booking contracts already support multiple options, additive to canon via the §9.6 seam. Cons: amends approved docs/24 §2.2 (owner ruling required), sensitive-field review must cover options, cards need a from-price rule. **(c) Defer** — ship (a) now; add (b) later via the seam. Pros: unblocks Slice 4 instantly. Cons: providers onboarded under (a) may need listing restructuring later. **Recommendation: (b)**, ruled now — it best serves customer discovery simplicity, search relevance (one result per real product), price clarity, and duplicate-listing avoidance, and the booking architecture already models multi-option programs; if the owner prefers not to amend canon yet, (c) is the safe default and the schema seam guarantees additivity.
- **D-S4-2 · Publication act.** Confirm `auto-publish-on-approval` DEFAULT OFF (provider explicitly publishes after approval) and `listings.publish` = owner + org_manager. (Configurable per docs/24 §14.C; this fixes the launch default and the capability holder.) Recommendation: as stated.
- **D-S4-3 · Launch taxonomy content.** Ratify the docs/15 §3 twelve-entry content as the 0007 seed (labels/ordering adjustable later through admin APIs — data, not code). Recommendation: ratify as-is; supply-aware ordering stays behavior.

**Can wait (recorded, not blocking):** `membership|weekly` price kinds vs `monthly` mapping (docs/24 §14.B7 — additive CHECK widening) · private/group and instruction-language listing metadata (additive columns; also feed the deferred filters) · online/branchless listings (would amend `branch_ids ≥ 1` canon) · dedicated search engine tier (docs/23 §18.20; §12 keeps it open) · Arabic content workflow (§14.B12) · review/rating model · recommendation ranking · promotions beyond informational offers · media upload pipeline ownership (infra workstream) · cancellation-policy template content (§14.B6) · facilities vocabulary reconciliation timing (with taxonomy admin tooling).

## 23. Consistency review

Checked against the approved record; no contradiction found. docs/24 §2/§5.3/§12/§13-row-4 applied verbatim (deviations: none; Instructor deferral is a sequencing choice inside row-4 latitude, recorded in §1). docs/23 §10.5 Tier-1 search ruling followed; §18.20 left open. docs/27 spine, composite keys, capability registry, policy categories, and event machinery extended, not duplicated. docs/15 §3 taxonomy is seed content; docs/14 §3.3–3.4 search behavior moves server-side unchanged. docs/18 §6 child gate moves server-side per docs/24 §12.2. English-only launch: nothing in this plan requires Arabic content to create, approve, publish, or search an English listing (`_ar` nullable throughout). CLAUDE.md scope protection: no schools/companies/quotation entities anywhere. The docs/23 §19 payment prohibition is untouched; nothing here prices, quotes, or charges.

---

*This plan writes no code and provisions nothing. Implementation begins only after owner approval — including the §22 blocking rulings — commit by commit per §17, within the docs/23 §16 phase gates. Slice-3 operational dependencies (docs/27 §18) remain independent work.*
