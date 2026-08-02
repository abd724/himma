# 17 — Discover + Search Implementation Plan (Milestone 2)

Status: for product-owner approval. No implementation has started. Governing specs: docs/14 (product), docs/15 (IA), docs/16 (states/interactions); permanent rules: docs/12 (native), docs/08 (engineering), docs/07 (tokens).

## 1. Milestone objective

Implement Discover, Search, Results with full filtering, All Categories, category and activity-type pages, and the schematic mock map — deterministically mock-driven, preserving the approved Home visual system unchanged, with the shared catalogue migrated to the confirmed eligibility model. Provider storefront and program details are **not** built; their cards stay inert (docs/09 §17.2).

## 2. Exact routes to implement

Expo Router restructure: a real `Tabs` navigator with the existing `FloatingDock` as its custom tab bar, so the dock keeps correct per-tab state, Android back conventions, and the docs/16 §6 visibility rule.

```text
src/app/
  _layout.tsx                       # root Stack + app-level providers (participant, area, favourites, results-filter)
  (tabs)/
    _layout.tsx                     # Tabs; custom tabBar = FloatingDock (Home + Discover live; Bookings/Saved/Profile inert)
    index.tsx                       # Home (existing screen, unchanged visuals)
    discover/
      _layout.tsx                   # Discover tab stack (headerless; dock visible across it)
      index.tsx                     # HMA-005 Discover feed
      categories.tsx                # HMA-011 All Categories
      category/[categoryId].tsx     # HMA-012
      activity/[activityTypeId].tsx # HMA-013
      results.tsx                   # HMA-010 Results (query/filter driven)
  search.tsx                        # HMA-009 full-screen Search (root push; dock hidden)
  map.tsx                           # HMA-016 schematic map (root push; dock hidden; shares FilterSelection)
```

Concrete paths for catalogue surfaces carry the `/discover/` prefix (e.g. `/discover/category/[id]`) because they live inside the Discover tab stack — this is what keeps the dock visible on browsing surfaces per docs/16 §6. Docs/15 §4.1's logical contracts are unchanged; a one-line concrete-path note is added there (see §19/report). `/search` and `/map` match their contracts exactly.

## 3. Existing Home components to reuse (unchanged visuals)

`PressableFeedback`, `AppImage`, `Chip`, `Badge`, `SectionHeader`, `IconButton`, `SkeletonBlock`, `ProgramCard`, `ProviderCard`, `CategoryGrid` (+ tile), `CreditStrip` (Home only), `EmptyFeedCard`, `LocationSheet`, `FloatingDock` (gains real navigation for Home/Discover; inert press feedback for the other three), `ParticipantChips`, `QuickFilterRow` (gains optional trailing `Filters` chip with count badge), `HomeSkeleton` pattern (generalized per-surface skeletons), `useReducedMotion`, theme tokens.

Home screen changes limited to **activation of approved entries** (docs/15 §4.2): search bar → `/search`; category tiles → `/discover/category/[id]`; `View all` → `/discover/categories`; hero CTA → preset Results (summer collection). Quick filters stay in-place; program/provider cards and credit strip stay inert. No layout, token, or card changes.

## 4. New components to create

| Component | Purpose (spec ref) |
|---|---|
| `SearchEntryButton` | Search-bar-styled pressable used on Home/Discover to push `/search` (real `TextInput` lives only in Search) |
| `DiscoverHeader` | Title `Discover` + location chip + notification action (14 §2.1) |
| `CollectionCard` | ~300×140 editorial card, scrim, title, count (14 §6) |
| `CompactProgramRow` / `CompactProviderRow` | Dense vertical result cards, same family as carousel cards (14 §6) |
| `AgeRangeBadge` | `Ages 6–9` / `Ages 12+` / `All ages` on children's cards (14 §6) |
| `FilterSheet` | Grouped bottom sheet: Who/When/Where/What/Price/More, `Clear all`, live `Show N results` (14 §4) |
| `SortSheet` | HMS-004 options (single-select) |
| `ResultTabs` | All · Programs · Providers · Categories segmented control (tab roles) |
| `ActiveFilterChips` | Removable applied-filter chips above Results (16 §3.7) |
| `LoadMoreButton` | Deterministic next-page append (14 §3.2) |
| `SuggestionRow`, `RecentSearches`, `PopularSearches` | Search pre-typing and typing states (14 §3.1) |
| `MapCanvas` | Schematic area nodes + fictional pins + counts + selectable areas; no geography (14 §7) |
| `ErrorStateCard` | Offline/error with `Retry` (16 §2) |

## 5. Shared catalogue and mock-data migration

1. **Eligibility model** (types/domain.ts): replace `Eligibility {audience,minAge,maxAge,ladiesOnly}` with `{ minimumAge?: number; maximumAge?: number | null; allAges: boolean; genderEligibility: 'men' | 'ladies' | 'mixed'; skillLevel?: SkillLevel; eligibilityNotes?: string }`. Child participants carry `dateOfBirth`; age is computed against a fixed `MOCK_TODAY` constant (determinism, docs/08 §10 — never the device clock).
2. **Suitability helpers** (pure, unit-tested): `childAge(dob)`, `ageRangeLabel(program)`, `suitsChild(program, age)` (hard range check), `isLadiesOnly(program)` (`genderEligibility === 'ladies'`). Adults: no gender-based exclusion anywhere.
3. **Category refactor**: junior programs move to their real categories (junior karate → Martial arts, robotics/coding → Technology & STEM, football → Team & outdoor); `kids-teens` becomes a **collection lens** (filter preset: age-suitable audience) while Home's approved "Kids & Teens" tile look is unchanged — it now opens the lens.
4. **Catalogue size**: extend to **28–36 programs / 10–12 providers** (from 21/9). Focus categories ≥ 4 programs incl. one activity type per focus category with adult + junior variants; secondary categories 1–2 (weak-supply demos); ≥ 1 broad preset exceeding 12 results (Load more); one deliberately thin collection; every filter dimension and every docs/16 state reachable.
5. **Home regression guard**: Home's curated recommendation lists keep equivalent content; `HomeFeedService` consumes the new helpers with identical section output. Before/after Playwright screenshots of Home (top/mid/bottom, 390) are compared in review; Home unit tests updated to the new field names but asserting the same behavior.

## 6. Service contracts and state ownership

Services (all deterministic, docs/08 §8): existing `HomeFeedService` (refactored internals); new `CatalogueService` (lookups, supply counts), `DiscoverFeedService.getDiscoverFeed({areaId,participantId,quickFilterId})`, `SearchService.getSuggestions(...)` / `.search({query,filters,participantId,areaId,tab,sort,page})` with synonym/typo maps and docs/14 §3.3 ranking. Mock failure flag on services for the error state (QA/Playwright only).

State ownership (single sources of truth):

| State | Owner | Notes |
|---|---|---|
| Participant context | App-level `ParticipantProvider` (root layout) | Shared Home/Discover/Search/Results (16 §4); Home refactors from local state, zero visual change |
| Area | App-level `AreaProvider` | Feeds header chips + near-me ranking everywhere |
| Favourites | App-level `FavouritesProvider` | Moves up from Home local state |
| Discover quick chip | Discover screen local | Independent of Results (16 §3.8) |
| `FilterSelection` + query + tab + sort + page | `ResultsSessionProvider` (root) | One active results session; shared by Results ↔ Map ↔ FilterSheet; reset on new search submit |
| Sheet open/closed | Screen local | Dock hidden while open |

## 7. Navigation and back behavior

- Tabs navigator: dock taps switch tabs (Home/Discover) natively; per-tab stacks preserved; Bookings/Saved/Provider dock items inert with feedback (unchanged behavior).
- Push order per docs/15 §4.2; `/search` and `/map` are root-level pushes (dock hidden by structure, not per-screen hacks).
- Android back priority (16 §6): sheet → map (pop to Results) → keyboard/Search → stack pop; implemented via `onRequestClose` on sheets, standard stack pops elsewhere. iOS swipe-back enabled on all pushed routes.
- Back always returns to exact origin; no resets to Discover root (15 §4.3).

## 8. Search implementation sequence

1. `/search` route: auto-focused input, Cancel, keyboard avoidance, `keyboardShouldPersistTaps="handled"`.
2. Pre-typing content: recents (session-local), populars, category shortcuts.
3. `getSuggestions`: grouped, synonym + typo maps, participant-biased-not-hidden.
4. Submit → `/discover/results?q=…` (new results session).
5. Unit tests for ranking/synonyms/typos before UI wiring (service-first, as Home).

## 9. Discover implementation sequence

1. `DiscoverFeedService` + unit tests (sections, conditional collapse, quick-chip semantics — Home parity).
2. Discover screen: header, `SearchEntryButton`, shared participant chips, quick chips + Filters chip, categories grid, collections rail, program/provider carousels, map entry card, skeleton.
3. In-place quick-chip filtering with context line + collapse (Home behavior).
4. Wire Home's activated entries (§3) in the same step as the Discover tab lands.

## 10. Results and filtering implementation sequence

1. `FilterSelection` type + `ResultsSessionProvider` + apply/count/clear logic in `SearchService.search` (unit-tested first, incl. Ladies-only semantics and child age exclusion).
2. Results screen: tabs (All 3/3/3 + See all; Programs/Providers compact rows, 10–12 + Load more; Categories tiles), participant chips visible, quick chips, ActiveFilterChips, sort.
3. FilterSheet: groups per 14 §4.1 (Ladies only pinned; conditional activity-type/skill rows), live `Show N results`, `Clear all`, dock hidden while open.
4. Zero-result recovery states wired (16 §2).

## 11. Category and activity-type implementation sequence

1. All Categories: 12-group image grid, supply-aware order (CatalogueService counts).
2. Category page: featured activity-type chips, popular programs, providers, offers, weak-supply honest state, toolbar (Filter/Sort/Map) reusing the results session.
3. Activity-type page: Programs default, Providers segment, map toggle; adult + junior variants proven on one page (15 §8.5).

## 12. Mock map implementation sequence

1. `MapCanvas`: schematic node layout (styled Views/simple SVG-free shapes) — labeled area nodes positioned abstractly, fictional provider pins, per-area counts, selected-area state. Explicitly no Abu Dhabi geography; no licensed base image planned (if one is ever added, rights go to `docs/ASSET_ATTRIBUTION.md`).
2. `/map` route consuming the shared results session; pin/area tap → area-filtered list return; always-visible `List` control; safe areas.
3. Map entry card on Discover + Map toggle on Results/category toolbars.

## 13. Required states

Implement every row of docs/16 §2 for D/S/R/F/M: default, per-surface skeletons, collapsed sections, search no-results (+ `Did you mean`), filter zero-result recovery, long-list Load more, weak supply, image fallback, offline/error (failure flag), selected filters (count + chips + context line), participant-specific, Ladies-only on/off, location-unavailable contract note. Provider/program-unavailable remain contract-level (detail screens don't exist) — reported as such.

## 14. Accessibility checks

Docs/14 §9 applied: labeled search input and suggestion rows ("Pilates, category"), tab roles with selected state, radio/checkbox semantics in the sheet, "Filters, 2 active" announcements, polite live regions on state changes, recovery actions adjacent in reading order, 44 pt targets, non-color selection indicators, age-range badges readable by screen readers ("Ages six to nine"). Verified per screen in the review pass.

## 15. iOS and Android compatibility checks

Docs/12 walked per screen: safe areas (header top, sheet bottom, map), keyboard behavior on Search, Android back priority order, iOS swipe-back, carousel-vs-vertical-scroll arbitration, Dynamic Type tolerance on rows/tabs/sheet, no DOM/hover APIs, dock visibility per structure. **Native validation remains pending until an iOS Simulator/device pass exists** — web review never upgrades a screen to "native validated" (docs/12 §1). If Xcode becomes available mid-milestone, run the native pass for Home + Discover surfaces together.

## 16. Playwright and unit-test plan

Unit (jest, service-first): eligibility helpers (age calc vs MOCK_TODAY, range edges incl. `maximumAge: null`, allAges), Ladies-only on/off semantics, search ranking matrix (participant × query), synonym/typo resolution, suggestion grouping, filter application + counts + clear, Load-more paging determinism, Discover feed sections/collapse, Home feed regression suite (updated fields, same behavior). Target: every docs/16 §3 rule with a logic component has a test.

Playwright (Expo web, 390×844 + 360×780): search journey (open → type → suggestion → results → tabs → See all), filter sheet apply/count/clear round-trip, quick-chip ↔ sheet sync on Results, participant switch on Results (rank-not-hide check for Me), Ladies-only end-to-end, category → activity type → results, map toggle → area select → list, Load more, error state via failure flag, no horizontal overflow, console-error-free.

## 17. Screenshot review matrix

Saved to `artifacts/discover-review/`:

| # | Capture | Width |
|---|---|---|
| 01 | Discover top (default) | 390 |
| 02 | Discover mid (collections + carousels) | 390 |
| 03 | Discover Ladies-only active | 390 |
| 04 | Discover child context (Adam) with age badges | 390 |
| 05 | Search pre-typing (recents/populars) | 390 |
| 06 | Search typing suggestions | 390 |
| 07 | Results All tab | 390 |
| 08 | Results Programs tab + Load more | 390 |
| 09 | Filter sheet open | 390 |
| 10 | Zero-result recovery | 390 |
| 11 | All Categories | 390 |
| 12 | Category page (weak-supply example too) | 390 |
| 13 | Activity type (adult + junior visible) | 390 |
| 14 | Mock map | 390 |
| 15 | Discover top + Results Programs | 360 |
| 16 | Home top/mid/bottom regression set | 390 |

## 18. Commit boundaries

One focused commit per step, checks green before each:

1. `refactor(catalogue)`: eligibility model + category refactor + catalogue extension + helpers + updated tests + Home regression screenshots.
2. `feat(nav)`: Tabs restructure, dock wiring, `/search` + `/map` shells, providers for participant/area/favourites (Home visually unchanged).
3. `feat(search)`: Search screen + suggestions + SearchService + tests.
4. `feat(results)`: Results tabs, compact cards, FilterSelection/session, FilterSheet, sort, states.
5. `feat(discover)`: Discover feed + collections + Home entry activation.
6. `feat(catalogue-pages)`: All Categories, category, activity type.
7. `feat(map)`: schematic map.
8. `chore(review)`: state/a11y polish, full Playwright pass, screenshot matrix, milestone report.

## 19. Risks and mitigation

| Risk | Mitigation |
|---|---|
| Tabs restructure regresses Home | No visual edits allowed in step 2; Home regression screenshots + unit suite gate every commit |
| Eligibility migration changes Home content | Curated lists preserved; behavior-equivalence tests before/after |
| Filter state divergence chips/sheet/map | Single `ResultsSessionProvider`; round-trip Playwright test |
| Route-path prefix vs docs/15 contract wording | Resolved by concrete-path note in docs/15 §4.1 (reported); logical contracts intact |
| Carousel/scroll gesture conflicts on native | Flagged in docs/16 §6 checklist; stays open under pending native validation |
| Scope creep into storefront/program details | Cards inert per docs/09 §17.2; routes not registered |
| Filter sheet complexity on small screens | Groups collapsible; sheet scrolls; Dynamic-Type-tolerant rows; 360-width Playwright gate |

## 20. Exit criteria

1. All acceptance criteria of docs/14 §11, docs/15 §8, docs/16 §10 pass (native items explicitly marked pending where Xcode is absent).
2. Catalogue at 28–36 programs / 10–12 providers with the confirmed eligibility model; age ranges visible on children's cards; adults never gender-filtered by default; Ladies-only toggle semantics exact.
3. Home pixel-equivalent to approved baseline (regression set) with approved entry activations working.
4. tsc, eslint, jest (full suite), expo-doctor green; Expo web launch clean; zero console errors; screenshot matrix complete.
5. Milestone report states the three approval levels per surface (design approved via docs/14–16; frontend pending owner review; native pending) and stops for approval before any further screen.
