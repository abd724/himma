# 14 — Discover and Search Specification (Milestone 2)

Status: draft for product-owner review. Nothing in this document is implemented yet.

Companion documents: `docs/15_DISCOVER_INFORMATION_ARCHITECTURE.md` (catalogue model and navigation graph) and `docs/16_DISCOVER_STATE_AND_INTERACTION_MATRIX.md` (states and interaction rules). This spec preserves the approved Home design system (docs/11): Orbit Indigo tokens, existing component language, floating dock, and Home's hierarchy are untouched.

## 1. Purpose

Discover (HMA-005) is Himma's visual marketplace catalogue: it shows the breadth of what exists, where Home shows what is personally timely. It must serve exploratory intent ("show me what activities exist") and known intent ("ladies-only Pilates near Khalifa City tonight") without a questionnaire, a forced funnel, or a dead end.

Search (HMA-009/HMA-010) is the known-intent fast path, reachable from Home and Discover, opening as a dedicated full-screen route with the keyboard up.

## 2. Discover screen hierarchy

Scroll order at ~390 × 844. Sections marked *(conditional)* collapse when they have no content (same collapse rule as Home).

1. **Header** — safe-area aware. Screen title `Discover` (screen-title type), location chip (shared area context, opens HMS-001), notification icon. No wordmark (Home owns it); no duplicate profile action.
2. **Search entry** — same visual as Home's search bar but it is a *navigation control*: tapping pushes the Search route. Placeholder: `Search activities, providers or classes`.
3. **Participant context chips** — same shared component and the same app-level selection as Home (one browsing context across tabs; docs/02 §7).
4. **Quick discovery chips** — `Today` · `This weekend` · `Near me` · `Ladies only` · `Camps` · `Offers` + trailing **`Filters`** chip (funnel icon + active-filter count badge) opening the filter sheet (HMS-003). Quick chips re-filter the Discover feed in place, identical semantics to Home (docs/09 §17.4).
5. **Browse categories** — the eight approved tiles in the Home four-column grid + `View all` → All Categories (full taxonomy, docs/15 §2).
6. **Collections** *(conditional)* — horizontal rail of 3–5 editorial collection cards (new card type, §6), e.g. `Ladies only`, `Beat the heat indoors`, `After school`, `Try something new`. Each opens a preset Results view.
7. **Trending near you** *(conditional)* — program-first carousel, ranked by area proximity then rating (deterministic).
8. **Available today** *(conditional)* — program-first carousel, time-led.
9. **Popular providers** *(conditional)* — provider-first carousel.
10. **Offers & trials** *(conditional)* — program-first carousel, badge-led.
11. **Map entry card** — one full-width card `Explore on the map` with a stylized static map illustration; opens mock Map results (HMA-016).
12. **Floating dock** — Discover active (pill moves to Discover on this screen; Home keeps its own pill on Home).

The long category list from the brief (Fitness and gyms, Martial arts, …) is **taxonomy, not feed sections**: it lives in Browse categories → All Categories → category pages (docs/15). Discover's feed stays under ~8 visible sections; the feed-length budgets of docs/11 §10 apply per section (3–5 cards).

## 3. Search experience

### 3.1 Search route (HMA-009)

- Dedicated full-screen route pushed over the current tab; input auto-focused, keyboard visible, `Cancel` returns (iOS swipe-back and Android back also return).
- Content before typing: **Recent searches** (session-local, deterministic; clearable), **Popular searches** (curated mock list, includes `Ladies only pilates`), **Browse by category** shortcut row.
- While typing (≥1 character): grouped suggestions — Activities, Providers, Categories, Areas — max ~8 rows, each row shows a type icon and label; prefix and synonym matches.
- Submit (return key or suggestion tap) → Results route with query.

### 3.2 Results (HMA-010)

- Tabs: `All` · `Programs` · `Providers` · `Categories`.
- **All tab density:** up to 3 programs, up to 3 providers, and up to 3 categories, each group with a `See all` action that jumps to the matching tab.
- **Programs and Providers tabs:** compact vertical result cards optimized for comparison, approximately 10–12 visible results, then a mock `Load more` action (deterministic next page). The oversized Home carousel cards are **not** reused unchanged here; a compact result-card variant reuses their visual language and information hierarchy (§6).
- Toolbar: `Filter` (sheet, count badge), `Sort` (HMS-004), `Map` toggle (Programs/Providers tabs only).
- Quick chips row persists (incl. Ladies only), and the **participant context chips are present on Results** so the browsing participant is always visible and changeable in one tap (never an invisible restriction).
- Category results use the category tile in list form.

### 3.3 Ranking principles (mock, deterministic)

1. Exact/prefix text match on title, activity type, provider name, category, area.
2. Synonym match (§3.4).
3. Participant-aware ranking — personalization must never become an invisible restrictive filter:
   - **Everyone:** full catalogue, eligibility-ranked.
   - **Me:** adult-suitable programs rank first; child-only programs still appear lower in relevant searches (a parent searching "swimming" under Me still finds Junior Swim Squad).
   - **Adam / Lina:** hard-ineligible adult-only programs are excluded; age-suitable programs rank first.
   - The participant control is always visible on Results (§3.2) so the active context is obvious and switchable.
4. Proximity to selected area (area rank as in Home's near-me).
5. Rating, then stable catalogue order for determinism.

Search suggestions may be personalized by context but must never prevent a parent from finding activities for another participant — suggestions bias, they do not hide.
No sponsored results in this milestone; if introduced later they must be labeled (docs/05 §8).

### 3.4 Synonyms, typos, bilingual readiness

- Synonym table keyed by canonical activity-type/category id: `{ id, en: [terms…], ar: [] }`. Arabic arrays exist but stay empty this stage (docs/08 §13).
- Examples: `pilates: [pilates, reformer, mat pilates]`, `women-only: [ladies only, women only, ladies]`, `football: [football, soccer]`, `quran: [quran, hifz, tajweed, memorisation]`.
- Typo handling assumption for the mock: a small curated misspelling map (e.g. `pilaties → pilates`); no fuzzy-matching engine in the frontend milestone. The real backend will own fuzzy search.
- No-results recovery: show "No results for '<query>'" + tappable popular searches + `Browse categories` + (if filters active) `Clear filters`.

### 3.5 Search is mock-driven

A `SearchService` contract with a deterministic implementation over the shared catalogue. No network, no indexing engine.

## 4. Filter experience

### 4.1 Three tiers

- **Quick chips** (Discover feed + Results): Today, This weekend, Near me, Ladies only, Camps, Offers. Single-select on the Discover feed (Home parity); on Results they act as shortcuts that set the equivalent sheet filter and may combine.
- **Filter sheet** (HMS-003, bottom sheet): the complete set, grouped:
  - **Who** — participant (Everyone/Me/each child), session eligibility (single-select: **Ladies only** pinned first, Girls only, Men only, Boys only, Mixed), audience (Adults/Children), age band.
  - **When** — Today, Tomorrow, This weekend, day-of-week, time of day (morning/afternoon/evening/after school), date range.
  - **Where** — area, Near me, distance band, (map bounds when in map mode).
  - **What** — category, activity type *(conditional: appears once a category is chosen)*, program format (drop-in, monthly, term, package, membership, camp, private, group), indoor/outdoor.
  - **Price & offers** — price range, Free, Offers, Trial available.
  - **More** — skill level *(conditional per activity type)*, availability (places left / instant booking), rating, accessibility support.
- **Conditional filters** never render disabled rows; they appear only when their parent selection makes them meaningful.

Eligibility wording (owner-confirmed): one canonical internal value `women-only`, always displayed as **Ladies only**; "women only" and "ladies" are search synonyms. There are never separate visible "Ladies only" and "Women only" filters. Girls only, Men only, Boys only, and Mixed remain distinct eligibility options (docs/05 §7 wording rule).

### 4.2 Sheet behavior

- Header: title `Filters`, `Clear all` (visible only when something is active).
- Footer: primary button `Show N results` with a live deterministic count; disabled never — zero results still applies and lands on the no-results recovery state.
- Active-filter count appears as a badge on every `Filters` chip and in the Results toolbar.
- Clearing: `Clear all` in sheet; per-group clear; active filters also render as removable chips above results.
- Incompatible combinations: options within a mutually exclusive group are radio-style (selecting `Men only` replaces `Ladies only`). Cross-field conflicts (e.g. child participant + Ladies only) are allowed but resolve to the zero-result recovery state with a specific explanation — never silent, never hidden (docs/04 HMA-019 principle).
- Ladies-only prominence: quick chip everywhere, pinned first in Who, a Discover collection, and a popular-search entry (docs/06 §9).

## 5. Program-first and provider-first

- Program-first sections/results answer "what can I book": approved program card unchanged (docs/11 §7).
- Provider-first sections/results answer "who operates here": approved provider card unchanged.
- Every surface that lists programs offers a path to the provider (card provider name → storefront contract) and vice versa (storefront lists its programs — future milestone).

## 6. Card types on Discover surfaces

| Card | Job | Anatomy | Status |
|---|---|---|---|
| Program card | Book this | docs/11 §7 | Approved, reuse |
| Provider card | Browse this business | docs/11 §7 | Approved, reuse |
| Category tile | Enter taxonomy | docs/11 §7 | Approved, reuse |
| Collection card | Editorial entry into a preset Results view | **New**: wide image card (~300 × 140), scrim, title (card-title type, inverse), supporting count line (`14 activities`), no price/rating | To build in milestone 2 |
| Compact result card | Dense vertical comparison in Results lists | **New variant**: full-width row card — small thumbnail (with fallback), title, provider (program) or categories (provider), one meta line (area · schedule or area · rating), price + eligibility/offer badge; same tokens, type roles, and favourite action as the approved cards, compressed | To build in milestone 2 |

Collection cards must be visually distinct from the hero (smaller, no CTA button) and from category tiles (wide, editorial title). Compact result cards must be instantly recognizable as the same family as the carousel cards — identical information hierarchy, smaller footprint.

## 7. Map entry

- Map lives inside Discover (§2.11) and Results (toolbar toggle) — not a dock tab (docs/09 §12).
- **Schematic mock map, not geography.** Do not hand-draw or approximate Abu Dhabi coastlines, districts, or real geography. The milestone map is a clearly schematic discovery canvas containing: labeled area nodes (Khalifa City, Al Raha, …), fictional provider pins, per-area counts, selectable areas (tap → area-filtered Results list), and list equivalents for everything. It must read as a discovery simulation, not an accurate map.
- A licensed static geographic base image may be used **only** if its usage rights and attribution are recorded in `docs/ASSET_ATTRIBUTION.md`; otherwise stay schematic.
- No production map SDK, no geolocation (docs/03 §4). Map screen respects safe areas and provides an always-visible `List` return control.

## 8. Mock-data requirements

- Extend the shared catalogue (single source with Home): target ≈ **28–36 programs across 10–12 fictional providers**. Six focus categories (Fitness, Martial arts, Swimming, Pilates & yoga, Learning incl. Quran, Kids & Teens as a lens) get strong coverage (≥ 4 programs each); secondary categories stay deliberately thin (1–2) to demonstrate the weak-supply state honestly. The goal is demonstrating every filter, navigation path, and state deterministically — not production-scale catalogue volume.
- Every filter dimension in §4 must be satisfiable by at least one program; every zero-state must be reachable by a real combination.
- Deterministic services: `DiscoverFeedService`, `SearchService`, `CatalogueService` (docs/15 §5) following the docs/08 §8 boundary; screens never import raw arrays.
- Collections are data (id, title, imageKey, filter preset), not hard-coded UI.

## 9. Accessibility requirements

Everything in docs/06 §11 and docs/12 §4/§7, plus: search input labeled and focus-managed; suggestion rows are buttons with type context in the label ("Pilates, category"); tabs use tab roles with selected state; filter groups expose radio/checkbox semantics; active-filter count announced ("Filters, 2 active"); map pins have labeled list alternatives (map never the only path); all states announce via polite live regions.

## 10. Native compatibility requirements

Docs/12 applies in full. Specifically: Search route keyboard behavior (auto-focus, `keyboardShouldPersistTaps="handled"`, keyboard avoidance for the suggestion list); Android back closes sheet → then map mode → then pops route; iOS swipe-back enabled on all pushed routes; filter sheet padded by bottom inset with the dock hidden while open; carousels remain native-scroll friendly; Dynamic Type tolerance on all new rows and tabs; 44 pt targets everywhere; no hover/DOM dependencies.

## 11. Acceptance criteria (for the future implementation milestone)

1. Discover renders the §2 hierarchy with conditional sections collapsing per docs/16.
2. Search opens as a full-screen route with keyboard up; suggestions, recents, populars, results tabs, and no-results recovery all work deterministically.
3. The complete filter sheet applies, counts, clears, and round-trips with quick chips per §4; Ladies only is reachable in ≤ 1 tap from Discover.
4. Program/provider/category/collection cards are visually distinct per §6.
5. Map entry opens the mock map; pins filter to area lists; List return always visible.
6. Every state in docs/16 §2 is demonstrable; every navigation contract in docs/15 §4 resolves or is explicitly inert per docs/09 §17.2.
7. All docs/12 native rules hold; checks (tsc, lint, tests, expo-doctor) pass; web review at 390 and 360 widths.

## 12. Explicit exclusions

Not in this specification or its milestone: provider storefront and program details implementation (contracts only), booking/checkout, real search engine or fuzzy matching, real maps or geolocation, Arabic UI (synonym model ready only), notifications, backend, saved-search persistence, sponsored placement.

## 13. Open decisions

- Production map provider and geolocation UX (docs/09 §12 stands).
- Collection editorial strategy and refresh cadence (who curates, how often).
- Whether recent searches persist across sessions (needs native storage decision — AsyncStorage/SecureStore — deferred; session-only in mock).
- Sponsored/promoted content rules (deferred; must be labeled if ever added).
- Arabic synonym content and RTL search UX (structure ready, content later).
- Weak-supply threshold for hiding vs showing a thin category (mock uses: hide section below 2 items on Discover; category pages always open honestly).
