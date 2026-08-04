# Himma — Session Handoff

Read this after README.md, CLAUDE.md, and docs/01–20. It captures live project state as of 2026-08-04 so a fresh session can continue without re-deriving anything.

## Where we are: the Evaluation milestone (Program Details + Provider Storefront) is CLOSED

Two customer milestones are complete and owner-approved:

**Milestone 2 — customer discovery (docs/17 + docs/18), closed at `ec79c7d`.** Home · Navigation shell/dock · Search · Results + filtering · Discover feed · All Categories · Category pages · Activity-type pages · Schematic Map. Details in git history and docs/17–19.

**Milestone 3 — evaluation surfaces (docs/20), closed at this commit:**

| Step | Commit | Status |
|---|---|---|
| 9 Program Details (HMA-015) | `b985456 feat(program-details)` | ✅ approved (design + frontend) |
| 10 Provider Storefront (HMA-014) | `5a7b176 feat(provider-storefront)` | ✅ approved (design + frontend + accessibility review) |
| 11 milestone close | `chore(details-review)` (this commit) | review/polish/documentation pass |

**Delivered by this milestone:** Program Details page · Provider Storefront page · Program ↔ Provider cross-navigation with stack reuse · typed program/provider favourites (one shared system) · participant suitability with explicit recovery (no silent switching) · Blue Wave multi-branch model with branch selector · mock cancellation-policy presets · informational session lists (docs/09 §20.9) · save/share on both surfaces · every previously inert program/provider card activated.

**Not implemented (deferred, do not start without owner approval):** functional session selection · Booking · cart · checkout · payment · confirmation · written review content · favourites persistence across reload/login (session-local until the account/backend milestone) · real provider policies (mock presets only) · universal links (share URLs are placeholder `https://himma.app/...` — nothing is configured or claimed) · real branch/geographic mapping (schematic areas only) · provider support actions (support row is an inert contract, HMA-032) · gifts · authentication · profile/participant management UI · Bookings calendar · Saved screen · Credits · Rewards · backend · Arabic/RTL · provider portal · admin portal. The Book CTA and Bookings/Saved/Profile dock items stay **inert with press feedback** (docs/09 §17.2, §20.1).

**Recommended next milestone: Booking flow** (session selection → participant selection → booking summary), the natural continuation now that evaluation surfaces and the Book CTA exist. Requires an owner-approved plan document first (docs/20 pattern).

## Approval status per surface (docs/12 three levels)

| Surface | Design | Frontend | Native validation |
|---|---|---|---|
| Home (HMA-004, docs/18 rebuild) | ✅ | ✅ | ⏳ pending |
| Navigation shell + floating dock | ✅ | ✅ | ⏳ pending |
| Search (HMA-009) | ✅ | ✅ | ⏳ pending |
| Results + filtering (HMA-010) | ✅ | ✅ | ⏳ pending |
| Discover feed (HMA-005) | ✅ | ✅ | ⏳ pending |
| All Categories (HMA-011) | ✅ | ✅ | ⏳ pending |
| Category (HMA-012) | ✅ | ✅ | ⏳ pending |
| Activity type (HMA-013) | ✅ | ✅ | ⏳ pending |
| Map (HMA-016) | ✅ | ✅ | ⏳ pending |
| Program Details (HMA-015) | ✅ | ✅ (incl. Commit 11 accessibility/consistency fixes) | ⏳ pending |
| Provider Storefront (HMA-014) | ✅ | ✅ (incl. Commit 11 accessibility/consistency fixes) | ⏳ pending |

**Native validation is pending for every surface** — this Mac has CommandLineTools only, no Xcode; web review never upgrades a screen to "native validated" (docs/12 §1). All code is written native-safe per docs/12; the device-only checklist is under "Native validation backlog" below.

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
| `/map?origin=results\|discover\|category\|activity\|provider` (root push) | Schematic map | hidden structurally |
| `/program/[programId]` (root push) | Program Details | hidden structurally |
| `/provider/[providerId]` (root push) | Provider Storefront | hidden structurally |

QA-only params: `?qa-scenario=guest|me-only|me-active|household` (Home/Discover account fixtures), `?qa-fail=1` (Discover/Results/Map/Program/Provider error state), `?qa-nocount=1` (Map missing counts).

### Detail-route activation matrix (docs/20 §2.4, all verified in QA)

Program Details opens from: Home rails, Discover carousels, Results (All + Programs), Category page, Activity-type page, Provider Storefront program lists, and cold deep links. Provider Storefront opens from: Discover provider carousel, Search provider suggestions (direct, no search submit), Results (All + Providers), Category page, Activity-type page, Program Details provider row, and cold deep links. By design there are **no** program cards on Search/Map and **no** provider cards on Home (docs/20 §2.4 documents each).

### Stack behavior (docs/20 §2.2–2.3)

- Exact-origin back everywhere; root pushes leave the origin (and the Results session) mounted beneath.
- Cold deep link: back control falls back to `router.replace('/discover')`; unknown ids render recovery states with a `Browse activities` action.
- Program ↔ Provider round-trips resolve as `back` instead of stacking a third route (`detail-navigation.ts`: press-time root-state read via `useNavigationContainerRef` — **press-time, not render-time**, because react-native-screens freezes covered screens and a render-captured state goes stale; the helper also unwraps Expo's synthetic `__root` wrapper, incl. nested wrappers — all unit-tested).
- Double-tap guard (700 ms) prevents duplicate detail routes from one action; QA double-clicks to prove it.
- Storefront taxonomy chips `dismiss()` then push the category/activity route so browsing surfaces never stack on top of a root detail route (cold-link fallback: replace).

## Automated verification (Commit 11 final run, exact totals)

- TypeScript `tsc --noEmit`: clean · ESLint `--max-warnings=0`: clean · Jest: **230/230 across 14 suites** · expo-doctor: **20/20**
- Playwright QA (playwright-core + system Chrome, Expo web :8081): **415 checks, 0 failures** — home 79, discover 64, search 22, results 35, catalogue 36, map 52, **details 127**. Every suite asserts zero console errors and no horizontal overflow (390 and 360).
- Dependency note: `react-native-gesture-handler` was upgraded 2.32.0 → ~3.1.0 in Commit 11 because expo-doctor's SDK 57 registry now prescribes it (no direct imports in `src/`; full suite re-verified). npm audit: same 11 known moderate advisories, all under the Expo-tooling `uuid` root recorded in docs/13 — zero in shipped code.

## Screenshot inventory — `artifacts/details-review/` (62 captures, all regenerated in Commit 11)

Every state row exists at both 390 × 844 and 360 × 780 (`-390`/`-360` suffixes) unless noted:

- **Program:** `01-program-adult-{top,mid,bottom,saved}` · `02-program-child-eligible` · `03-program-child-ineligible` · `04-program-ladies-only` · `05-program-offer-weak-availability` · `06-program-free` · `06-program-no-sessions` · `07-program-sticky-cta` (mid-scroll frame, distinct from 01) · `13-program-error` · `13-program-unknown`
- **Provider:** `08-storefront-default-{top,mid,bottom}` · `08-storefront-saved` · `09-storefront-multibranch` · `09-storefront-branch-switched` · `10-storefront-child-eligible` · `10-storefront-child-ineligible-open` · `10-storefront-child-none` · `11-storefront-weak-supply` (scrolled to the one-program list) · `12-storefront-monogram` (top frame) · `13-storefront-error` · `13-storefront-unknown`
- **Flows:** `14-storefront-from-program` (Program → Provider) · `14-program-from-storefront` (Provider → Program) · `16-results-after-program-back` (Results session preserved) · `17-discover-after-storefront-back` (search-suggestion flow return) · `18-crosslink-reuse` (Program A → Provider A → Program X → Provider A resolved by back/reuse)

Known-identical pairs (deliberate, not stale): `13-program-error` ≡ `13-storefront-error` per width — both surfaces render the same shared full-screen `ErrorStateCard`; they document two distinct states that are pixel-identical by design. One-branch (falcon) and no-offers states are demonstrated by the `08` default set (QA asserts no selector and no offers section). Earlier milestone folders (`home-review`, `discover-review`, `search-review`, `home-regression`) are unchanged.

## State coverage (Commit 11 audit)

**Program Details — implemented and screenshot-demonstrated:** default/adult, saved + unsaved, child eligible, child ineligible (banner + recovery chips), Ladies-only, offer/trial, free, no sessions, weak availability (`3 places left`), sticky CTA, offline/error + retry, unknown id.
**Provider Storefront — implemented and screenshot-demonstrated:** default, saved + unsaved, one branch, multi-branch + switched branch, adult (eligible-first ranking), child eligible grouping (+ expanded ineligible group), child with no eligible programs (recovery), weak supply, no offers, monogram fallback, offline/error + retry, unknown id.
**Implemented, not screenshot-demonstrated:** loading skeletons on both surfaces (300 ms mock delay — transient, exercised on every QA navigation); missing-image `AppImage` fallback (needs a forced decode failure, same standing limitation as Home); missing-instructor section collapse (data-driven conditional, covered by extras invariants, no dedicated capture).
**Contract-level only:** none — every declared docs/20 §9 state renders.
**Deferred:** favourites persistence across full reload (QA reloads reset saves — session-local by design until the account/backend milestone).

## Commit 11 review changes (this commit)

- **ESLint:** generated `.expo/*` added to ignores (a regenerated `router.d.ts` carried an unused eslint-disable that broke `--max-warnings=0`).
- **Dependencies:** `react-native-gesture-handler` → ~3.1.0 (expo-doctor SDK-prescribed; restores 20/20).
- **Accessibility:** `AppImage` gained an optional `accessibilityLabel`; the program hero (`{title} photo`) and provider cover (`{name} cover photo`) are now meaningfully labelled per docs/20 §10 while card thumbnails stay decorative/hidden; storefront expanded-group ineligibility reasons now *display* the canonical compact age label (`Ages 16+ — Adam is 8`, matching the Program Details banner and docs/05 §7) and *speak* the expanded form (`Ages 16 and up…`) via accessibilityLabel — previously the spoken form was rendered visibly.
- **Consistency:** the three in-milestone copies of monogram-initials logic collapsed onto the exported `providerMonogram` (provider row + instructor avatar on Program Details; the storefront already used the service value — team-member initials still inline the same rule inside the screen).
- **Tests:** +2 stack-edge tests (`rootStackRoutes` nested-wrapper unwrapping and single-route cold-link stacks; cold-link → push policy resolution). Jest 228 → 230.
- **QA/screenshots:** `details-review.mjs` scrolling is now deterministic (`scrollTop` assignment on the visible RN-web scroller — `mouse.wheel` was position-dependent and `Element.scrollTo` is swallowed by RN-web, both produced duplicate frames); full matrix completed (+19 captures: program saved state, sticky-CTA and error at 360, storefront bottom/saved/expanded-ineligible/child-none at 360, and all five flow proofs at both widths); weak-supply vs monogram captures differentiated; duplicate frames eliminated (checked by md5).

No approved-screen redesigns; no new product features.

## Known limitations / polish debt (recorded, deliberately NOT fixed in Commit 11)

- **Documented assumptions (details milestone):** branch selector is a wrapping chip row treated as a segmented control and assumes **max two branches per provider** (docs/20 §4.6's "sheet for more than 2" is unimplemented — no provider has >2); session lists render at most **6 upcoming occurrences** from the two-week window (scannability cap in `buildUpcomingSessions`); sessions are informational only (docs/09 §20.9); provider name inside program cards stays non-interactive (docs/09 §20.2 — path is card → Program Details → provider row).
- **Token debt (8b visual audit)** stands unchanged: compact-card-title 15/20 de-facto style, two 18 px group-title variants, monogram sizes, off-scale micro-gaps, badge padding, dock literals, sheet-handle triplication, etc. The details screens add: `letterSpacing: -0.3` on section titles (both screens, consistent), price block 26/32 hero variant, CTA 96 px content-clearance literal. All fold into the brand-token pass at rebranding.
- **Copy register drift** (8b list) unchanged; details copy follows the same register. One copy pass belongs with final brand voice.
- **RN-web vs native rendering divergences (device-verify):** 8b list plus: hero/cover `AppImage` heights (264/220) under `contentFit: cover` on device; scrim-chip overlay contrast over bright photos; `shadows.sheet` on the sticky CTA bar vs Android elevation.
- **`?qa-scenario` guarded `window.location` read** (`src/state/account-context.tsx`) — unchanged; account scenarios unreachable on native until it moves to router params.
- **Search keyboard on Android / sheet translucency flags** — unchanged 8b device-verify items.
- **Assets:** demo-imagery reuse means some heroes/covers repeat across entities and don't always depict the specific program (e.g. the Ladies Aqua hero photo shows a male swimmer — flagged for pre-release imagery replacement in docs/ASSET_ATTRIBUTION.md, alongside the four residual photo trademarks and the placeholder app icon). `artifacts/` now holds ~14 MB of git-tracked QA screenshots (accepted as review evidence).
- **Unused template deps** unchanged (docs/13; no advisories).
- Sheet swipe-down-to-dismiss remains deferred — never claim it (docs/17 §10).

## Native validation backlog (device-only checks, docs/12 §10)

Items 1–6 from the 8b backlog stand (Dynamic Island/dock, SE fit, Dynamic Type ~135%, iOS swipe-back, Android hardware back, reduce-motion/press-feel/decode). The details milestone adds:

7. **Detail routes, iOS:** swipe-back from `/program/*` and `/provider/*` to every origin; swipe-back through a Program ↔ Provider chain honors the reuse policy; overlay back/save/share chips clear the Dynamic Island; sticky CTA sits above the home indicator (`insets.bottom` has never been non-zero in this environment); native `Share.share()` sheet for both entity kinds (web path uses Web Share/copy-link and never runs on native).
8. **Detail routes, Android:** hardware back pops exactly one detail route (no sheets exist on these screens); share intent carries the URL in `message`; dashed/shadow divergences on session rows and policy cards.
9. **Both:** hero/cover image decode performance on device; VoiceOver/TalkBack pass for the new labels (hero photo, save checkbox state, radio branch selector, expanded/collapsed ineligible group, live-region suitability updates, spoken price/age forms); Dynamic Type on the key-facts strip, session rows, and CTA bar.

## Architecture map (stable — see git history for details)

- Routes: `src/app/_layout.tsx` (root Stack + providers: Account → Participant, Area, Favourites, ResultsSession) → `(tabs)/_layout.tsx` (Tabs + `DockTabBar`) → Home, `discover/` stack (`unstable_settings anchor: 'index'` — keep!), root `search.tsx` + `map.tsx` + `program/[programId].tsx` + `provider/[providerId].tsx`.
- Screens in `src/features/{home,discover,search,results,catalogue,map,details}/`; pure navigation rules in `map-navigation.ts`, `search-navigation.ts`, and `details/detail-navigation.ts` (all unit-tested).
- Services: typed contracts in `services/contracts/`, deterministic mocks in `services/mock/`; screens never import raw catalogue arrays. `MockDetailsService` (300 ms delay) exposes pure `buildProgramDetailPage`/`buildProviderStorefrontPage` cores plus `buildUpcomingSessions` and `providerMonogram`.
- Data: `src/data/mock/catalogue.ts` (**frozen: 36 programs, 11 providers — first 21 programs' order is Home-stability-critical, append only**); details extras live in separate keyed modules `program-details.ts`, `provider-details.ts`, `policies.ts` (every id covered — enforced by data-invariant tests); `schedule.ts` pinned to `MOCK_TODAY` 2026-08-02 (Sunday).
- Eligibility (owner-final): children hard-check provider age ranges; adults never gender-filtered; Ladies-only is a badge/filter only. Presentation layer `participantSuitability`/`householdSuitability` in `src/utils/eligibility.ts`. Demo participants: Sarah (Me), Adam (8), Lina (12).
- Favourites: one typed store (`program:<id>` / `provider:<id>`), session-local, `src/state/favourites-context.tsx` with pure `toggledFavourites` core.
- Share: `share-entity.ts` (native `Share`) with `.web.ts` platform split (Web Share → clipboard fallback) — the only file pair allowed to touch browser APIs; URLs from `share-url.ts` (`https://himma.app/...`, never `himma://`).
- Search submit: `newSearch` → `router.dismiss()` → push/replace per `search-navigation.ts` — don't "simplify" away.
- Dock: floating capsule as Tabs custom tabBar; active pill never moves to inert Bookings/Saved/Profile.

## QA environment notes

- `playwright-core` + system Chrome (`channel:'chrome'`, headless) against Expo web on 8081 (`.claude/launch.json` → `expo-web`).
- **Locator rule:** react-native-screens keeps covered screens in the DOM — scope text/label locators with `.locator('visible=true')`; prefer `exact: true` where names nest inside card labels.
- **Scrolling rule (Commit 11):** never `mouse.wheel` (position-dependent) or `Element.scrollTo` (swallowed by RN-web) in QA scripts — use `details-review.mjs`'s `scrollToY` pattern (direct `scrollTop` assignment on the visible scroller).
- Expo dev overlay: `clearDevOverlay()` before dock clicks; shot helpers hide `.__expo_fast_refresh`.
- RN-web doesn't emit `aria-selected`/`aria-checked` from accessibilityState — `PressableFeedback` sets them explicitly; keep that.
- ESLint (react-hooks v6) forbids sync setState in effects — put setState in async callbacks/event handlers. Generated `.expo/` is lint-ignored.
- Home feed tests call the pure builder with hand-built inputs — never scenario ids.

## Owner workflow expectations

Stop and report after every commit with the exact lists the owner asks for; never start the next commit or a deferred surface without approval; report honestly (native pending, inert items, deviations); one focused commit per step with checks green; commit messages follow `feat(x):`/`fix(x):`/`chore(x):` with the Claude co-author line.
