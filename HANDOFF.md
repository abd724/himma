# Himma — Session Handoff

Read this after README.md, CLAUDE.md, and docs/01–17. It captures live project state as of 2026-08-02 so a fresh session can continue without re-deriving anything.

## Where we are

Milestone 2 (Discover + Search, docs/14–17) is mid-flight, following the docs/17 commit plan **sequentially with an owner stop-and-report after every commit**:

| docs/17 step | Commit | Status |
|---|---|---|
| 1 catalogue migration | `04e41b2 refactor(catalogue)` | ✅ approved |
| 2 navigation restructure | `0af5dbc feat(nav)` | ✅ approved |
| 3 search | `1607077 feat(search)` | ✅ approved |
| 4 results + filtering | `7be5199 feat(results)` | ✅ done, **reported, awaiting owner approval** |
| 5 Discover feed + Home entry activation | `feat(discover)` | ⏳ next — do NOT start until owner approves Commit 4 / says go |
| 6 All Categories / category / activity-type pages | `feat(catalogue-pages)` | pending |
| 7 schematic mock map | `feat(map)` | pending |
| 8 review polish + full screenshot matrix + milestone report | `chore(review)` | pending |

Home (milestone 1) approval levels: design ✅, frontend ✅, **native pending** (this Mac has only CommandLineTools — no Xcode/simulator; never claim "native validated" without a simulator/device pass, docs/12).

## Non-negotiable decisions already made (owner-confirmed)

- **Eligibility**: provider-defined structured fields `minimumAge`/`maximumAge`(nullable)/`allAges`/`genderEligibility: men|ladies|mixed`/`skillLevel`/notes. Adults see ALL classes by default — never auto-filter by gender. The ONLY customer gender filter is the optional **Ladies only** toggle (= `genderEligibility === 'ladies'`). Children filter purely by age (from `dateOfBirth` vs `MOCK_TODAY` in `src/utils/eligibility.ts` — never the device clock). Age ranges display on children's cards (`Ages 6–9`, `Ages 12+`, `All ages`). No Men/Mixed/Boys/Girls filter controls.
- **Search participant rules**: Everyone = full catalogue eligibility-ranked; Me = adult-suitable first but child programs still findable (never hidden); Adam/Lina = hard-exclude out-of-age-range only. Suggestions bias, never hide.
- **Home quick filters stay in-place** (docs/09 §17.4); Discover quick-chip state independent of Results session; Results quick chips DO combine.
- **Dock**: floating capsule = custom tabBar of Expo Router Tabs. Visible on browsing surfaces (Discover stack incl. Results/categories); hidden structurally on `/search`, `/map`, and under sheets. Active pill never moves to inert Bookings/Saved/Profile.
- **Sheets**: hand-built Modal only; backdrop-tap + Android-back dismissal; **swipe-down deferred — never claim it** (docs/17 §10). No bottom-sheet dependency.
- **Map (Commit 7)**: clearly schematic area-node canvas — labeled area nodes, fictional pins, counts, selectable areas, list equivalents. NO Abu Dhabi geography. Licensed base only with attribution recorded.
- **Results density**: All tab 3/3/3 + See all; Programs/Providers tabs ~12/10 then Load more; compact row cards (not Home carousel cards).
- Program/provider detail screens do not exist; their cards stay **inert with press feedback** (docs/09 §17.2). Category result rows inert until Commit 6. No Coming Soon/scaffold/dev wording ever.
- Demo participants: Sarah (Me), Adam (8, dob 2018-03-14), Lina (12, dob 2013-11-02). Catalogue: **36 programs / 11 fictional providers** (owner range 28–36 / 10–12; do not exceed).

## Architecture map (current)

- Routes: `src/app/_layout.tsx` (root Stack + providers) → `(tabs)/_layout.tsx` (Tabs + `DockTabBar`) → `(tabs)/index.tsx` Home, `(tabs)/discover/` stack (`_layout` has `unstable_settings initialRouteName/anchor: 'index'` — keep!), `discover/index.tsx` (still the minimal shell — Commit 5 replaces), `discover/results.tsx` (full Results), root `search.tsx`, root `map.tsx` (neutral shell — Commit 7 replaces).
- State (`src/state/`): ParticipantProvider, AreaProvider, FavouritesProvider, ResultsSessionProvider (query/tab/filters/sort/page; `newSearch` resets). Search submit calls `newSearch` then **`router.dismiss()` before `router.push('/discover/results')`** — this keeps the discover stack sane; don't "simplify" it away.
- Services: `contracts/` (home-feed, search incl. `getResults`/`countResults`, filters incl. `FilterSelection`/`activeFilterCount`/`sortOptions`) and `mock/` (mock-home-feed-service, mock-search-service, results-engine). All deterministic; screens never import raw arrays (catalogue imports in results-screen are for label/count lookups only).
- Data: `src/data/mock/catalogue.ts` (first 21 programs' order is Home-stability-critical — append only), `search-data.ts` (synonyms/typos/populars/recents seeds).
- Key components: compact-program-row / compact-provider-row / category-result-row / filter-sheet / sort-sheet / error-state-card / search-entry-button + all Home-era components (unchanged visuals).
- Tests: 61 passing (jest preset `jest-expo`, tests import `@jest/globals`). Sync cores (`buildFeed`/`buildResults`, constructor delay 0) are the test surface.

## QA tooling (important environment notes)

- Browser QA runs via **`playwright-core` + system Chrome** (`channel: 'chrome'`, headless) — scripts `scripts/qa/search-review.mjs` (22 checks) and `scripts/qa/results-review.mjs` (33 checks). Run with Expo web on 8081 (`.claude/launch.json` → `expo-web`, or `npx expo start --web`). The Playwright MCP plugin may or may not be connected; the scripts work regardless.
- Expo dev overlay quirk: an empty `#error-toast` div intercepts clicks over the dock in headless Chrome — scripts call `clearDevOverlay()` before dock clicks. Not an app bug.
- Error-state QA: `/discover/results?q=…&qa-fail=1` (QA-only; Retry recovers).
- RN-web doesn't emit `aria-selected`/`aria-checked` from accessibilityState — PressableFeedback sets them explicitly; keep that.
- Screenshots: `artifacts/home-review/` (approved Home baseline), `artifacts/home-regression/`, `artifacts/search-review/`, `artifacts/discover-review/` (docs/17 §17 numbering: 01–06 Discover/search, 07–10 results, 11–13 catalogue pages, 14 map, 15 = 360 width, 16 = Home regression).
- Checks per commit: `npx tsc --noEmit`, `npx eslint src scripts --max-warnings=0`, `npx jest`, `npx expo-doctor`, QA script, zero console errors, Home regression screenshots. ESLint (react-hooks v6) forbids sync setState in effects — put setState in async callbacks/event handlers.

## Commit 5 scope (next, after owner approval)

Per docs/17 §9 + docs/14 §2: replace the Discover shell with the full feed — header (done), SearchEntryButton (done), shared participant chips, quick chips + trailing Filters?? (NO — Discover quick chips are single-select in-place like Home; the Filters-chip-to-sheet flow belongs to Results), Browse categories grid (8 approved tiles → targets), **CollectionCard rail (new component, ~300×140, scrim, title, count)** from `collections` data, Trending near you / Available today / Popular providers / Offers & trials conditional carousels (3–5 cards, collapse when empty), map entry card → `/map`, DiscoverFeedService + unit tests first. Plus **Home entry activation**: search bar → `/search`, category tiles → `/discover/category/[id]` (only if pages exist — they arrive in Commit 6, so likely tiles → collection/results presets or stay inert until 6; check docs/15 §4.2 and report the choice), View all → `/discover/categories` (Commit 6), hero CTA → summer preset Results. Collection card taps → Results preset (empty-query results with filters — engine already supports empty query = full catalogue).
Screenshot numbering: 01–04 Discover states, plus Home regression re-capture.

## Owner workflow expectations

Stop and report after every commit with the exact lists the owner asks for; never start the next commit without approval; report honestly (native pending, inert items, deviations); one focused commit per step with checks green; commit messages follow the established `feat(x):` pattern with Claude co-author line.
