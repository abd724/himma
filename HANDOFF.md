# Himma — Session Handoff

Read this after README.md, CLAUDE.md, and docs/01–17. It captures live project state as of 2026-08-03 so a fresh session can continue without re-deriving anything.

## Where we are

Milestone 1 (Home) is complete and approved. Milestone 2 (Discover + Search, docs/14–17) is following the docs/17 commit plan **sequentially with an owner stop-and-report after every commit**:

| docs/17 step | Commit | Status |
|---|---|---|
| 1 catalogue migration | `04e41b2 refactor(catalogue)` | ✅ approved |
| 2 navigation restructure | `0af5dbc feat(nav)` | ✅ approved |
| 3 search | `1607077 feat(search)` | ✅ approved |
| 4 results + filtering | `7be5199 feat(results)` | ✅ approved |
| 5 Discover feed + Home entry activation | `df423a2 feat(discover)` | ✅ approved |
| 6 All Categories / category / activity-type pages | `ad65ff7 feat(catalogue-pages)` | ✅ approved |
| 7 schematic mock map | `feat(map)` | ✅ approved |
| 8a Home rework (docs/18 differentiation) | `feat(home)` | ✅ done, **reported, awaiting owner approval** |
| 8b review polish + full screenshot matrix + milestone report | `chore(review)` | pending, follows 8a approval — **do not start without it** |

## Approval status per surface (docs/12 three levels)

| Surface | Design | Frontend implementation | Native validation |
|---|---|---|---|
| Home (HMA-004, rebuilt per docs/18) | ✅ approved (docs/18/19) | ⏳ rebuilt, pending owner review | ⏳ pending |
| Navigation shell + floating dock | ✅ approved | ✅ approved | ⏳ pending |
| Search (HMA-009) | ✅ approved | ✅ approved | ⏳ pending |
| Results + filtering (HMA-010) | ✅ approved | ✅ approved | ⏳ pending |
| Discover feed (HMA-005) | ✅ approved | ✅ approved | ⏳ pending |
| All Categories (HMA-011) | ✅ approved | ✅ approved | ⏳ pending |
| Category (HMA-012) | ✅ approved | ✅ approved | ⏳ pending |
| Activity type (HMA-013) | ✅ approved | ✅ approved | ⏳ pending |
| Map (HMA-016) | ✅ approved (docs/14 §7) | ⏳ built, pending owner review | ⏳ pending |

**Native validation is pending for every surface.** No iOS Simulator or physical-device pass has occurred (this Mac has CommandLineTools only, no Xcode). Web review never upgrades a screen to "native validated" (docs/12 §1). All code is written native-safe per docs/12.

## Recommendation scope (owner decision 2026-08-03, docs/09 §18 + docs/05 §9)

- **Current: simple deterministic rule-based recommendations only.** Authoritative eligibility first (provider-defined `minimumAge`/`maximumAge`/`allAges` vs participant age, location, availability, explicit restrictions; `Ladies only` only when the customer selects it), then declared interests, then simple ranking factors (interest match, area proximity, relevant schedule, availability, rating/popularity, offers/trials), preserving discovery diversity.
- **Deferred: behavioral and machine-learning recommendations.** Do not model or implement ranking on search history, view history, dwell time, clicks, bookings, attendance, reviews, dismissals, similar-user behavior, or ML.
- Architecture stays replaceable behind a typed `RecommendationService`-style contract. Recommendation weighting is an open future decision.
- Deterministic mock interests: Sarah — Calisthenics, Pilates, Padel; Adam — Swimming, Football, Robotics; Lina — Coding, Art, Languages.

## Current catalogue

**36 programs across 11 fictional providers** (owner range 28–36 / 10–12 — do not exceed). 11 categories, 24 activity types, 6 collections, 7 areas — Abu Dhabi Island is deliberately without supply so the map's honest "no activities in this area" state is always demonstrable. Demo participants: Sarah (Me), Adam (8, dob 2018-03-14), Lina (12, dob 2013-11-02). All names fictional; no real provider logos or implied affiliations.

## Not built / out of current scope

- **Program details (HMA-015) and provider storefronts (HMA-014) are not built.** Their contracts exist in docs/15 §4.1; every program card, provider card, and provider name stays **inert with press feedback** (docs/09 §17.2). Routes are not registered. Do not begin them without explicit owner approval.
- Out of the whole current frontend stage: production backend, database, real authentication, payment gateway, real capacity transactions, push notifications, real calendar/maps/geolocation, provider integrations, provider web portal, administration portal, public website, school/university/company accounts, institutional trips, RFQs, purchase orders, Arabic/RTL, final company branding.

## Non-negotiable decisions already made (owner-confirmed)

- **Eligibility**: provider-defined structured fields `minimumAge`/`maximumAge`(nullable)/`allAges`/`genderEligibility: men|ladies|mixed`/`skillLevel`/notes. Adults see ALL classes by default — never auto-filter by gender. The ONLY customer gender filter is the optional **Ladies only** toggle (= `genderEligibility === 'ladies'`). Children filter purely by age (from `dateOfBirth` vs `MOCK_TODAY` in `src/utils/eligibility.ts` — never the device clock). Age ranges display on children's cards (`Ages 6–9`, `Ages 12+`, `All ages`). No Men/Mixed/Boys/Girls filter controls.
- **Search participant rules**: Everyone = full catalogue eligibility-ranked; Me = adult-suitable first but child programs still findable (never hidden); Adam/Lina = hard-exclude out-of-age-range only. Suggestions bias, never hide.
- **Home quick filters stay in-place** (docs/09 §17.4); Discover quick-chip state independent of the Results session; Results quick chips DO combine.
- **Dock**: floating capsule = custom tabBar of Expo Router Tabs. Visible on browsing surfaces (Discover stack incl. Results, All Categories, category, activity type); hidden structurally on `/search`, `/map`, and under sheets. Active pill never moves to inert Bookings/Saved/Profile.
- **Sheets**: hand-built Modal only; backdrop-tap + Android-back dismissal; **swipe-down deferred — never claim it** (docs/17 §10). No bottom-sheet dependency.
- **Map (Commit 7)**: clearly schematic area-node canvas — labeled area nodes, fictional pins, counts, selectable areas, list equivalents. NO Abu Dhabi geography, coastline, districts, roads, or approximate real-world positions. Licensed base only with attribution recorded in `docs/ASSET_ATTRIBUTION.md`.
- **Results density**: All tab 3/3/3 + See all; Programs/Providers tabs ~12/10 then Load more; compact row cards (not Home carousel cards).
- No Coming Soon/scaffold/dev wording ever reaches the customer.

## Architecture map (current)

- Routes: `src/app/_layout.tsx` (root Stack + providers) → `(tabs)/_layout.tsx` (Tabs + `DockTabBar`) → `(tabs)/index.tsx` Home, `(tabs)/discover/` stack (`_layout` has `unstable_settings initialRouteName/anchor: 'index'` — keep!): `discover/index.tsx` feed, `discover/results.tsx`, `discover/categories.tsx`, `discover/category/[categoryId].tsx`, `discover/activity/[activityTypeId].tsx`; root `search.tsx`, root `map.tsx` (neutral shell — Commit 7 replaces).
- Screens live in `src/features/{home,discover,search,results,catalogue}/`.
- State (`src/state/`): ParticipantProvider, AreaProvider, FavouritesProvider, ResultsSessionProvider (query/tab/filters/sort/page; `newSearch` resets). Search submit calls `newSearch` then **`router.dismiss()` before `router.push('/discover/results')`** — this keeps the discover stack sane; don't "simplify" it away.
- Services: `contracts/` (home-feed, discover-feed, search incl. `getResults`/`countResults`, filters incl. `FilterSelection`/`activeFilterCount`/`sortOptions`, catalogue) and `mock/` (mock-home-feed, mock-discover-feed, mock-search, mock-catalogue, results-engine). All deterministic; screens never import raw arrays (catalogue imports in screens are for label/count lookups only).
- Data: `src/data/mock/catalogue.ts` (first 21 programs' order is Home-stability-critical — append only), `search-data.ts` (synonyms/typos/populars/recents seeds).
- Key components: compact-program-row / compact-provider-row / category-result-row / category-grid (`columns`, `labelLines` props) / collection-card / filter-sheet / sort-sheet / error-state-card / map-entry-card / search-entry-button + all Home-era components (unchanged visuals).
- Tests: 159 passing across 9 suites (jest preset `jest-expo`, tests import `@jest/globals`). Sync cores (`buildHomeFeed`/`buildFeed`/`buildResults`/`buildCategoryPage`/`resolveAccountScenario`, constructor delay 0) are the test surface. Home feed tests call the pure builder with hand-built `HomeFeedBuildInput` values (synthetic `Lena`/`Omar`/toddler/teen children) — never scenario ids.
- State additions (8a): `AccountProvider` (`src/state/account-context.tsx`) above `ParticipantProvider` in `_layout`; `ParticipantProvider` derives browsing chips from the account (`Everyone` + account participants; empty for guest). Home ignores the browsing context entirely (context-complete, docs/18 §8).

## QA tooling (important environment notes)

- Browser QA runs via **`playwright-core` + system Chrome** (`channel: 'chrome'`, headless): `scripts/qa/search-review.mjs` (22 checks), `results-review.mjs` (33), `discover-review.mjs`, `catalogue-review.mjs` (36). Run with Expo web on 8081 (`.claude/launch.json` → `expo-web`, or `npx expo start --web`).
- **Locator rule**: react-native-screens keeps covered screens in the DOM, so text/label locators must scope with `.locator('visible=true')` or they match a hidden screen beneath. This caused a false failure once already.
- Expo dev overlay quirk: an empty `#error-toast` div intercepts clicks over the dock in headless Chrome — scripts call `clearDevOverlay()` before dock clicks. Not an app bug.
- Error-state QA: `/discover/results?q=…&qa-fail=1` and `/discover?qa-fail=1` (QA-only; Retry recovers).
- RN-web doesn't emit `aria-selected`/`aria-checked` from accessibilityState — PressableFeedback sets them explicitly; keep that.
- Screenshots: `artifacts/home-review/` (approved Home baseline), `artifacts/home-regression/`, `artifacts/search-review/`, `artifacts/discover-review/` (docs/17 §17 numbering: 01–06 Discover/search, 07–10 results, 11–13 catalogue pages, 14 map, 15 = 360 width, 16 = Home regression).
- Checks per commit: `npx tsc --noEmit`, `npx eslint src scripts --max-warnings=0`, `npx jest`, `npx expo-doctor`, all QA scripts, zero console errors, Home regression screenshots byte-identical.
- ESLint (react-hooks v6) forbids sync setState in effects — put setState in async callbacks/event handlers.

## Home rework notes (Commit 8a — `feat(home)`)

- **Data flow (docs/19 §3):** `?qa-scenario=guest|me-only|me-active|household` (default household) → `AccountProvider` resolves the fixture once via `resolveAccountScenario` (`src/services/mock/mock-schedule-service.ts`) → `toHomeFeedBuildInput(resolved, areaId)` → pure `buildHomeFeed`. Scenario ids never reach screens or the builder; every condition reads resolved data (null account = guest, empty scheduleEntries = no history).
- **Schedule fixtures** (`src/data/mock/schedule.ts`) pinned to `MOCK_TODAY` (Sunday 2026-08-02): Adam swim Sun/Sat 10:00 AM (Sun = Upcoming activity), Sarah reformer Mon/Wed 6:30 PM + package plan `6 of 10 sessions left`. **Lina's Teen Coding Summer Camp runs 10–14 Aug (catalogue label) = offsets 8–12, next week — deliberately outside the 7-day strip**, so the household week shows Adam + Sarah only. Reported as a deviation from the docs/19 table's "this week" wording (the brief's schedule-label consistency clause wins).
- **Popular near {area}** renders only when the resolved account/guest has zero booked sessions (owner decision 2026-08-03); it yields to schedule content on active accounts.
- **Discover gate:** `DiscoverFeedInput.childParticipants: Participant[] | null` — the account's FULL child composition (never the browsing participant; owner caution 2026-08-03). `null` = guest → gate off (docs/18 §18 assumption); `[]` = signed-in me-only → child-focused collections (`childFocused: true` flags on camps/after-school/kids-teens) hidden; else require age-eligible supply for ≥ 1 account child. Browsing-context rules (docs/16 §4) compose on top. Guest also hides the Discover chip row (no profiles).
- **No add-child card anywhere** (docs/09 §19.6); guest gets one `setup` action card. `AccountScenarioId` lives only in fixtures + `ScheduleService` mock API.
- **Quick-filter types moved** to `contracts/filters.ts`; `quickFilters` const moved to `mock-discover-feed-service.ts`; Home contract v2 has `getHomeFeed(HomeFeedBuildInput)` + `getAreas()` only.
- New Home components: `upcoming-activity-card`, `week-strip`, `plan-card`, `home-action-card` (tokens/idioms reused; no new visual language). Home program rails pass `showAgeRange` (docs/14 §6).
- **Screenshots:** `artifacts/home-review/` re-baselined by design (11 scenario shots, docs/19 §8.10); `home-regression/` + `16-home-*` refreshed. All Discover-surface screenshots byte-identical except: stale `home-hero-results-390.png` deleted (hero gone), and `11-all-categories`/`15-discover-top-360`/`discover-collection-results`/`02-typing` proved **nondeterministic across identical runs** (photo resampling) — kept at baseline after pixel-level verification of identical content.
- **QA script updates:** new `scripts/qa/home-review.mjs` (58 checks, scenario matrix + gate). `discover-review.mjs`/`results-review.mjs`/`search-review.mjs` Home-era steps updated (no Home chips/hero; search-review now selects Adam on Discover — the old Home-chip step silently no-opped and two search shots are byte-identical to baseline again after the fix).

## Next step (after 8a approval)

**`chore(review)` (step 8b):** state and accessibility polish, the full Playwright pass, the complete docs/17 §17 screenshot matrix, and the milestone report with the three approval levels per surface.

## Map implementation notes (Commit 7)

`/map?origin=results|discover|category|activity` — the origin decides only how `List` returns (`results` pops back onto the existing list; every other origin dismisses the map and opens the session's list), so exactly one Results route ever exists. `src/features/map/map-navigation.ts` holds those pure rules and is unit-tested. `MockMapService` derives every node count from `MockSearchService.buildResults` with the area filter lifted, so map and list can never disagree; `mockSearchEngine` exports the one shared engine instance. Area selection writes `filters.areaId` into the shared session — there is no second filter state. QA flags: `?qa-fail=1` (error) and `?qa-nocount=1` (missing-count fallback).

## Owner workflow expectations

Stop and report after every commit with the exact lists the owner asks for; never start the next commit without approval; report honestly (native pending, inert items, deviations); one focused commit per step with checks green; commit messages follow the established `feat(x):` pattern with the Claude co-author line.
