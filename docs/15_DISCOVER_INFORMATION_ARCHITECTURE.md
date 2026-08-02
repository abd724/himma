# 15 — Discover Information Architecture

Status: draft for product-owner review. Companion to docs/14 (product spec) and docs/16 (states and interactions).

## 1. Purpose

Defines the catalogue model, the customer-visible taxonomy, the navigation graph with destination contracts, and the rules that keep customers from ever feeling trapped in nested navigation. It refines docs/04 and docs/05 without changing their intent.

## 2. Catalogue model

Ten concepts stay distinct. The customer never sees these terms (docs/06 §3); they structure data and navigation.

| Concept | Definition | Example |
|---|---|---|
| Category | Top-level browse group | Martial arts & combat sports |
| Activity type | One canonical activity inside a category | Kickboxing |
| Provider | A verified business | Falcon Combat Academy |
| Program | One bookable offering of an activity type by a provider | Junior Kickboxing Belts, U12 |
| Session | A dated/timed occurrence or recurring slot of a program | Tue 5:30 PM |
| Program format | The commercial shape | drop-in, monthly, term, package, membership, camp, private, group |
| Eligibility | Who may attend, per program or session — provider-defined structured fields: `minimumAge`, `maximumAge` (nullable), `allAges`, `genderEligibility: men \| ladies \| mixed`, `skillLevel`, optional notes | Ages 6–12; `genderEligibility: ladies` (shown as "Ladies only") |
| Location | Area and branch | Khalifa City · Branch 1 |
| Availability | Places/date reality | 4 places left, available today |
| Collection | Editorial grouping defined by a filter preset | "After school", "Ladies only" |

Rules:

- **One catalogue for everyone.** Kickboxing is a single activity type; adult and junior kickboxing are different *programs* differing in eligibility, skill level, schedule, price, and format — never a duplicated "kids kickboxing" activity type (docs/05 §5).
- "Kids & Teens" and "Camps & seasonal" are **collections/browse lenses over the shared catalogue**, not parallel taxonomies (docs/05 §5).
- Eligibility attaches to programs and can vary per session (docs/06 §9). Adults see all classifications (men/ladies/mixed) by default; the optional Ladies-only filter is the only customer-facing gender control, and children's suitability is computed from age versus the provider-defined range (docs/05 §7).
- Collections are data (`id`, title, image, filter preset) resolving to Results — deletable without schema change.

## 3. Customer-visible taxonomy

Twelve categories (from docs/05 §5), each with representative activity types. Only two levels are ever visible: **Category → Activity type**. Programs and providers appear inside both levels immediately.

1. Fitness & gyms — weight training, calisthenics, functional fitness, cross-training, personal training, group fitness
2. Martial arts & combat — boxing, kickboxing, Muay Thai, jiu-jitsu, karate, taekwondo, judo, self-defence
3. Swimming & water — swimming, water safety, diving, kayaking, sailing
4. Padel & racquet — padel, tennis, badminton, squash
5. Pilates, yoga & movement — Pilates, reformer, yoga, mobility, dance
6. Team & outdoor sports — football, basketball, volleyball, athletics, cycling, horse riding, climbing
7. Wellness & recovery — massage, sports massage, recovery, sauna, meditation, breathwork (non-medical only, docs/09 §16)
8. Learning & languages — Arabic, English, public speaking, academic support
9. Quran & Islamic learning — Quran reading, memorisation, Tajweed, Islamic studies
10. Technology & STEM — coding, robotics, AI, engineering, game development
11. Arts, music & creativity — drawing, painting, pottery, photography, music, theatre, cooking
12. Kids & Teens *(collection lens)* and Camps & seasonal *(format lens)* — prominent browse entries that resolve to filtered Results, not duplicate trees

Home's eight-tile grid (docs/11) remains the approved subset; All Categories shows the full set with supply-aware ordering (docs/04 HMA-011).

## 4. Navigation graph and destination contracts

### 4.1 Routes

| Surface | Route contract | Milestone-2 status |
|---|---|---|
| Discover (HMA-005) | `(tabs)/discover` | Build |
| Search (HMA-009) | `/search` (full-screen push, keyboard up) | Build |
| Results (HMA-010) | `/search/results?q=…&filters=…` | Build |
| All Categories (HMA-011) | `/categories` | Build |
| Category (HMA-012) | `/category/[categoryId]` | Build |
| Activity type (HMA-013) | `/activity/[activityTypeId]` | Build |
| Map results (HMA-016) | map mode of Results + `/map` entry | Build (mock) |
| Provider storefront (HMA-014) | `/provider/[providerId]` | **Contract only — not built**; entry points inert per docs/09 §17.2 until it ships |
| Program details (HMA-015) | `/program/[programId]` | **Contract only — not built**; entry points inert per docs/09 §17.2 until it ships |

### 4.2 Connections (exact)

From **Home** (activating previously inert entries as their destinations ship):

- Search bar → `/search`
- Category tile → `/category/[id]`; `View all` → `/categories`
- Quick filters → remain in-place on Home (approved, docs/09 §17.4) — they do not navigate
- Program card → `/program/[id]` (contract; inert until HMA-015 ships)
- Provider card / program-card provider name → `/provider/[id]` (contract; inert until HMA-014 ships)
- Hero CTA → preset Results (summer collection) once Results exists
- Dock Discover → `(tabs)/discover`

From **Discover**: search bar → `/search`; category tile → `/category/[id]`; `View all` → `/categories`; collection card → Results with preset filters; program/provider cards → contracts as above; map card → map results; quick chips → in-place feed filtering; `Filters` chip → filter sheet → apply → Results.

From **Search**: suggestion/submit → Results (query + type preselects the matching tab); category suggestion → `/category/[id]`; area suggestion → Results filtered to area.

From **Results**: program card → `/program/[id]` (contract); provider card → `/provider/[id]` (contract); category result → `/category/[id]`; map toggle ↔ list, same filter state.

From **Category**: activity-type chip → `/activity/[id]`; program/provider cards → contracts; `Filter`/`Sort`/`Map` toolbar as Results.

From **Activity type**: default Programs list; segment to Providers; map toggle; cards → contracts.

### 4.3 No-trap rules

- Maximum two taxonomy levels; programs are bookable-from (and visible at) every level — the funnel `Category → Subcategory → Type → Provider → Program` is never mandatory (docs/06 §4).
- Every surface carries search in the header area; search is always an exit from any depth.
- Back always returns to the exact origin (native stack); no forced reset to Discover root. iOS swipe-back and Android back behave identically to the header back.
- Cross-links go sideways without restarting: program ↔ provider ↔ category in one tap each (once detail surfaces ship).
- Entry is equivalent from search, category, provider, recommendation, collection, or map — no entry path sees a reduced catalogue.

## 5. Service contracts (mock, deterministic)

- `CatalogueService`: categories, activity types, providers, programs, collections; lookups by id; supply counts per category/area (drives weak-supply states and All Categories ordering).
- `DiscoverFeedService.getDiscoverFeed({ areaId, participantId, quickFilterId })`: ordered conditional sections (docs/14 §2) — same input semantics as Home's feed service.
- `SearchService.getSuggestions({ query, participantId, areaId })` and `.search({ query, filters, participantId, areaId, tab, sort })`: deterministic ranking per docs/14 §3.3, synonym/typo maps per §3.4.
- Filter state is one typed `FilterSelection` object shared by quick chips, the sheet, Results, and map mode — a single source of truth so counts and chips never disagree.

## 6. Mock-data requirements

As docs/14 §8 (28–36 programs, 10–12 fictional providers), plus: in each **focus** category, at least one activity type has ≥ 2 programs with different eligibility (adult vs junior) to prove the single-catalogue rule; at least one provider spans two categories; at least two collections resolve to non-empty presets and one (deliberately) to a thin result to exercise recovery; Programs/Providers result lists exceed 10–12 items for at least one query so the mock `Load more` behavior is demonstrable.

## 7. Accessibility and native requirements

Inherited wholesale from docs/14 §9–10 and docs/12. IA-specific: the navigation graph must keep Android back and iOS swipe-back consistent at every node; taxonomy depth limits also serve screen-reader users (shallow trees, labeled levels: "Martial arts, category" / "Kickboxing, activity type").

## 8. Acceptance criteria

1. Every §4.1 route resolves (or is contract-inert per docs/09 §17.2) exactly as tabled.
2. No customer path requires more than two taxonomy levels before seeing bookable programs.
3. The same program is reachable via ≥ 3 entry paths (search, category, collection/recommendation) in the mock data.
4. Filter state round-trips losslessly between chips, sheet, Results, and map mode.
5. Adult and junior variants of one activity type demonstrably share the activity-type page, differing only at program level.

## 9. Explicit exclusions

Provider storefront and program details (contracts only), real map/geolocation, real search backend, breadcrumbs UI (native back model instead), Arabic taxonomy labels (structure ready), any admin/provider-side taxonomy tooling.

## 10. Open decisions

- Final launch category ordering per real Abu Dhabi supply (docs/09 §3 stands).
- Whether "Team & outdoor sports" merges into fewer tiles at launch.
- Collection governance (owner-curated list vs data-driven).
- Deep-link URL scheme finalization for marketing use (`himma://` paths exist; public https links belong to the future customer web surface, docs/03 §5).
