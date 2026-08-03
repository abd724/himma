# Himma — Session Handoff

Read this after README.md, CLAUDE.md, and docs/01–19. It captures live project state as of 2026-08-03 so a fresh session can continue without re-deriving anything.

## Where we are: the customer discovery milestone is CLOSED

All eight docs/17 steps are complete and owner-approved, plus the docs/18 Home rework and the closing review pass:

| Step | Commit | Status |
|---|---|---|
| 1 catalogue migration | `04e41b2 refactor(catalogue)` | ✅ approved |
| 2 navigation restructure | `0af5dbc feat(nav)` | ✅ approved |
| 3 search | `1607077 feat(search)` | ✅ approved |
| 4 results + filtering | `7be5199 feat(results)` | ✅ approved |
| 5 Discover feed | `df423a2 feat(discover)` | ✅ approved |
| 6 catalogue pages | `ad65ff7 feat(catalogue-pages)` | ✅ approved |
| 7 schematic mock map | `bfac2c6 feat(map)` | ✅ approved |
| 8a Home rework (docs/18) | `23c0c78 feat(home)` + `2ca98e1 fix(home)` | ✅ approved (design + frontend + accessibility review) |
| 8b milestone close | `chore(review)` (this commit) | reported, awaiting owner sign-off |

**Completed surfaces:** Home · Navigation shell/dock · Search · Results + filtering · Discover feed · All Categories · Category pages · Activity-type pages · Schematic Map.

**Not implemented (deferred, do not start without owner approval):** Provider storefront (HMA-014) · Program details (HMA-015) · Booking · Checkout · Authentication · Profile & participant management UI · Bookings calendar · Saved screen · Credits details · Gifts · Rewards · Backend · Arabic/RTL · Provider portal · Admin portal. Program/provider cards and Bookings/Saved/Profile dock items stay **inert with press feedback** (docs/09 §17.2).

**Recommended next milestone:** Program details (HMA-015) + Provider storefront (HMA-014) — their contracts already exist in docs/15 §4.1, every inert card is waiting to activate, and they unblock the booking flow after that.

## Approval status per surface (docs/12 three levels)

| Surface | Design | Frontend | Native validation |
|---|---|---|---|
| Home (HMA-004, docs/18 rebuild) | ✅ | ✅ (incl. accessibility review) | ⏳ pending |
| Navigation shell + floating dock | ✅ | ✅ | ⏳ pending |
| Search (HMA-009) | ✅ | ✅ | ⏳ pending |
| Results + filtering (HMA-010) | ✅ | ✅ | ⏳ pending |
| Discover feed (HMA-005) | ✅ | ✅ | ⏳ pending |
| All Categories (HMA-011) | ✅ | ✅ | ⏳ pending |
| Category (HMA-012) | ✅ | ✅ | ⏳ pending |
| Activity type (HMA-013) | ✅ | ✅ | ⏳ pending |
| Map (HMA-016) | ✅ | ✅ | ⏳ pending |

**Native validation is pending for every surface** — this Mac has CommandLineTools only, no Xcode; web review never upgrades a screen to "native validated" (docs/12 §1). All code is written native-safe per docs/12. The 8b native-safety audit produced a device-only checklist (§ "Native validation backlog" below).

## Route inventory (implemented)

| Route | Screen | Dock |
|---|---|---|
| `/` (`(tabs)/index`) | Home | visible |
| `/discover` | Discover feed | visible |
| `/discover/results` | Results (query/filter session) | visible |
| `/discover/categories` | All Categories | visible |
| `/discover/category/[categoryId]` | Category page | visible |
| `/discover/activity/[activityTypeId]` | Activity-type page | visible |
| `/search` (root push) | Full-screen Search | hidden structurally |
| `/map?origin=results\|discover\|category\|activity` (root push) | Schematic map | hidden structurally |

QA-only params: `?qa-scenario=guest|me-only|me-active|household` (Home/Discover account fixtures), `?qa-fail=1` (Discover/Results/Map error state), `?qa-nocount=1` (Map missing counts).

## Automated verification (8b final run, exact totals)

- TypeScript `tsc --noEmit`: clean · ESLint `--max-warnings=0`: clean · Jest: **161/161** across 9 suites · expo-doctor: **20/20**
- Playwright QA (playwright-core + system Chrome, Expo web :8081): **288 checks, 0 failures** — home 79, discover 64, search 22, results 35, catalogue 36, map 52. Every suite asserts zero console errors and no horizontal overflow; home additionally asserts truncation-free week titles and ≥32 px dock clearance across 4 scenarios × 2 sizes.

## Screenshot inventory (final matrix)

`artifacts/home-review/` — Home: `matrix-{household|me-only|me-active|guest}-{top|mid|bottom}-{390|360}` (24 shots) plus numbered 01–11 flow shots (01–04 household, 05–06 me-only, 07 me-active, 08–09 guest, 10 Discover me-only collection gate, 11 household top 360).

`artifacts/discover-review/` — Discover/Results/Catalogue/Map per docs/17 §17: 01–02 Discover top/mid, 03 Ladies-only, 04 child context (+badges), 07 Results All, 08 Results Programs + Load more, 09 filter sheet, `sort-sheet-390`, 10 zero-result recovery, 11 All Categories, 12 category (+weak supply), 13 activity type, 14 map, 15 = 360-width Discover/Results/Map, 16 = Home regression via Results suite; plus unnumbered state shots: `discover-{bottom,camps,today,collection-results,filter-sheet,empty-recovery,error}`, `results-{typo,error,participant-adam}`, `map-{selected-area,adam,ladies-only,empty-area,missing-counts,no-areas,results-session,error}`.

`artifacts/search-review/` — 01 initial, 02 typing suggestions, 03 typo, 04 participant Adam, 05 results handoff, 06 initial 360, 07 short-viewport scroll.

`artifacts/home-regression/` — `home-{top,mid,bottom}-390` only. Stale pre-docs/18 baselines (hero/category-grid Home, nav-*, *-shell) were deleted in 8b.

## State coverage (8b audit)

**Implemented and screenshot-demonstrated:** default (all 9 surfaces); long content (2-line titles, Load more to 23 rows); collapsed empty sections (guest/me-only Home omit schedule sections — builder-driven, also unit-tested); no-filter-match + recovery (`10-zero-result-recovery`); typo correction (`results-typo`, search 03); weak supply (`12-category-weak-supply`); offline/error + retry (Discover/Results/Map via `qa-fail`); selected filters (filter sheet, active chips, combined chips); participant-specific content (`results-participant-adam`, `04-discover-adam`); child-collection visibility gate (`10-discover-me-only-collections`); Ladies only (Discover 03, Map); Map selected/empty-area/missing-count; guest/me-only/me-active/household Home (full matrix).

**Implemented, not screenshot-demonstrated:** loading skeletons (Home/Discover/Results/Category/Activity/Map — transient, exercised on every QA navigation); no-search-result copy on Results (`No results for “…”`); missing-image fallback (`AppImage` branded placeholder — needs a forced decode failure to show).

**Contract-level only:** none — every declared state renders.

**Deferred / known gaps:** Search screen has no zero-suggestion state (empty suggestion groups render nothing — the only surface without one; polish backlog). Account scenarios are unreachable on native (see backlog item 1).

## 8b review changes (this commit)

**Navigation fix (genuine bug):** refining a search from Results stacked a second Results route (Results → query pill → submit pushed onto a discover stack that already held Results; native back would land on a stale duplicate). Results now passes `origin=results` to `/search`, and submission **replaces** instead of pushes (`src/features/search/search-navigation.ts`, unit-tested ×2, QA-checked in results-review). Mirrors `map-navigation.ts`.

**Accessibility fixes:** card labels now speak the badge ("Ladies only" / offer — was invisible to screen readers); favourite hearts are `checkbox` role with `checked` on both card families; week strip exposes per-session rows (`accessible={false}` on the wrapper — nested labels were VoiceOver-dead); filter-sheet age chips speak "Ages 6 to 9" (visual "6–9" unchanged); Results age chip uses canonical wording (`Ages 14+`, was `Ages 14–17+`) with spoken removal labels; sort chip announces "Sort by, …"; providers count line got a live region (parity with programs); error/empty state cards announce via live region; skeletons are `accessible`; dock labels cap font scaling at 1.3 (docs/12 §4); touch targets ≥44 pt via hitSlop/minHeight (results tabs + activity segment 40→44, hearts, active chips, "View all"/"See all", header location chips, recovery links, search clear).

**Visual consistency fixes:** all three sheet titles unified on `typography.sectionTitle` (were 19/25, 19/25, literal 20/26); filter apply label matches the primary-button pattern (chip 14); program-card free price no longer renders an empty unit (and no longer announces "Free ."); star rating 12 everywhere; heart icon 20/`text.primary` on both cards; catalogue not-found states split into title + message with curly apostrophes (`We can’t find that category/activity`), and `EmptyFeedCard` gained a `title` override; `’s age` apostrophes fixed; map `pointerEvents` moved from prop to style.

**QA tooling:** all six shot helpers hide Expo's transient Fast Refresh bubble; results-review gained sort-sheet capture + refine-flow checks; one locator tightened to `exact` (card labels now legitimately contain "Ladies only").

## Known limitations / polish debt (recorded, deliberately NOT fixed in 8b)

- **Token debt (visual audit):** a de-facto 15/20 compact-card-title used in 4 files; two 18 px group-title variants; monogram sizes 16/17; off-scale micro-gaps (1/2/3/4/6/7) on stacked-text and icon rows; badge padding 10/5; dock internal literals; hand-computed circle radii beside `radii.card`; `skeleton-block` default radius 12; triplicated sheet-handle style; `area-node` borderWidth 1.5 and `gap: -6` (negative gap is web-only — margin does the real work); hitSlop split 8/10; `home-header` 26 px title vs `screenTitle`; map/catalogue header 22/28. All invisible-or-tiny; fold into the brand-token pass at rebranding.
- **Copy register drift:** "right now" vs "yet"; `Count unavailable` fragment vs full sentence on Map; "Try Everyone or Me." names the chip (`Me`) while schedule surfaces say `You` (both owner-approved individually); recovery-action label variants enumerated in the audit. A single copy pass belongs with final brand voice.
- **RN-web vs native rendering divergences (device-verify):** `overflow:'hidden'`+shadow on program/collection cards (iOS may clip the shadow); dashed borders on Android with borderRadius render solid (map canvas + empty nodes); `overflow` on the chip count-badge `Text` (Android corners); `shadows.sheet` upward shadow vs directionless Android elevation.
- **`?qa-scenario` is read via a guarded `window.location`** (`src/state/account-context.tsx`) — the only non-router param read; harmless on native (falls back to household) but means guest/me-only/me-active are unreachable in a simulator until it moves to router params (provider sits above the Stack, so this is a small refactor, not a one-liner).
- **Search keyboard on Android** (no avoidance behavior set, `autoFocus` during push transition, no explicit `Keyboard.dismiss()` on submit) and possible double bottom inset on iOS — all device-verify items.
- **Sheets don't set `statusBarTranslucent`/`navigationBarTranslucent`** — Android edge-to-edge backdrop/insets need device verification.
- **Assets:** demo-imagery reuse and four residual photo trademarks recorded in docs/ASSET_ATTRIBUTION.md (pre-release replacements); `assets/images/icon.png` is a 799 KB Expo placeholder and the iOS icon is the Expo logo mark — both blocking for external distribution only. `artifacts/` holds ~11 MB of git-tracked QA screenshots (accepted as review evidence for now).
- **Unused template deps** (`expo-device`, `expo-system-ui`, `expo-web-browser`; `@expo/ui`/`expo-glass-effect`/`expo-symbols` duplicated from expo-router) — removal deferred; no advisories attached (docs/13).
- Sheet swipe-down-to-dismiss remains deferred — never claim it (docs/17 §10).

## Dependency status

11 moderate advisories, all one root (`uuid<11.1.1` under Expo tooling), zero in shipped code, no forced upgrades — recheck recorded 2026-08-03 in docs/13 (path list corrected to 11 packages). `playwright-core` is the only post-docs/13 addition (dev, QA only).

## Native validation backlog (device-only checks, docs/12 §10)

1. iPhone with Dynamic Island: dock above home indicator (`insets.bottom` has never been non-zero), header clearance on all `edges={['top']}` screens, sheet bottom padding, Map's measured bottom bar.
2. iPhone SE / 360 dp: dock 5-destination fit, grids, search placeholder.
3. Dynamic Type ~135%: dock label cap (now in place), chip rows, results tabs, program-card titles, area nodes.
4. iOS swipe-back: `/search` and `/map` from every origin; the fixed refine flow (one Results route); carousel-vs-edge-gesture conflicts.
5. Android: hardware back through every sheet (`onRequestClose` wired, never exercised), back from root pushes and tab switches, predictive-back opt-out (`app.json`) confirmation, keyboard over Search, the rendering divergences above.
6. Both: reduce-motion path (`AccessibilityInfo` always false on web), press-feedback feel, expo-image decode performance, AppImage failure fallback.

## Architecture map (stable — see git history for details)

- Routes: `src/app/_layout.tsx` (root Stack + providers: Account → Participant, Area, Favourites, ResultsSession) → `(tabs)/_layout.tsx` (Tabs + `DockTabBar`) → Home, `discover/` stack (`unstable_settings anchor: 'index'` — keep!), root `search.tsx` + `map.tsx`.
- Screens in `src/features/{home,discover,search,results,catalogue,map}/`; pure navigation rules in `map-navigation.ts` and `search-navigation.ts` (both unit-tested).
- Services: typed contracts in `services/contracts/`, deterministic mocks in `services/mock/`; screens never import raw catalogue arrays except for label/count lookups. `mockSearchEngine` is the one shared engine instance.
- Data: `src/data/mock/catalogue.ts` (**first 21 programs' order is Home-stability-critical — append only**; 36 programs, 11 providers, 11 categories, 24 activity types, 6 collections, 7 areas — Abu Dhabi Island deliberately empty), `schedule.ts` fixtures pinned to `MOCK_TODAY` 2026-08-02 (Sunday; Lina's camp is deliberately outside the 7-day strip), `search-data.ts`.
- Eligibility (owner-final): provider fields `minimumAge`/`maximumAge`/`allAges`/`genderEligibility`/`skillLevel`; adults see ALL classes; only customer gender control is the optional **Ladies only** toggle; children filter purely by age from `dateOfBirth` vs `MOCK_TODAY` (never device clock). Demo participants: Sarah (Me), Adam (8), Lina (12).
- Recommendations: deterministic rule-based only (docs/09 §18); no behavioral/ML signals.
- Search submit: `newSearch` → `router.dismiss()` → push/replace per `search-navigation.ts` — don't "simplify" away.
- Dock: floating capsule as Tabs custom tabBar; active pill never moves to inert Bookings/Saved/Profile.

## QA environment notes

- `playwright-core` + system Chrome (`channel:'chrome'`, headless) against Expo web on 8081 (`.claude/launch.json` → `expo-web`).
- **Locator rule:** react-native-screens keeps covered screens in the DOM — scope text/label locators with `.locator('visible=true')`; prefer `exact: true` for names that appear inside card labels ("Ladies only").
- Expo dev overlay: `clearDevOverlay()` before dock clicks (empty `#error-toast` intercepts); shot helpers hide `.__expo_fast_refresh`.
- RN-web doesn't emit `aria-selected`/`aria-checked` from accessibilityState — `PressableFeedback` sets them explicitly; keep that.
- ESLint (react-hooks v6) forbids sync setState in effects — put setState in async callbacks/event handlers.
- Home feed tests call the pure builder with hand-built inputs (synthetic children) — never scenario ids.

## Owner workflow expectations

Stop and report after every commit with the exact lists the owner asks for; never start the next commit or a deferred surface without approval; report honestly (native pending, inert items, deviations); one focused commit per step with checks green; commit messages follow `feat(x):`/`fix(x):`/`chore(x):` with the Claude co-author line.
