# Himma — Session Handoff

Read this after README.md, CLAUDE.md, and docs/01–23. It captures live project state as of 2026-08-05 so a fresh session can continue without re-deriving anything.

## Where we are: the Booking flow milestone (docs/21) is CLOSED

Three customer milestones are complete and owner-approved:

**Milestone 2 — customer discovery (docs/17 + docs/18), closed at `ec79c7d`.** Home · Navigation shell/dock · Search · Results + filtering · Discover feed · All Categories · Category pages · Activity-type pages · Schematic Map. Details in git history and docs/17–19.

**Milestone 3 — evaluation surfaces (docs/20), closed at `38c5ecb chore(details-review)`.** Program Details · Provider Storefront · Program ↔ Provider cross-navigation with stack reuse · typed favourites · participant suitability with explicit recovery · Blue Wave multi-branch model · mock cancellation-policy presets · informational session lists · save/share. Details in git history and docs/20.

**Milestone 4 — booking flow (docs/21), closed at this commit:**

| Step | Commit | Status |
|---|---|---|
| 12 Booking foundation + session selection (HMA-017) | `c1e5191 feat(booking)` | ✅ approved (design + frontend) |
| 13 Participant selection + eligibility (HMA-018/019 inline) | `df06260 feat(booking)` | ✅ approved (design + frontend + accessibility review) |
| 14 Booking summary + flow connections (HMA-020) | `6d952d0 feat(booking)` | ✅ approved (design + frontend + flow connections + accessibility review) |
| deps | `01b6f73 chore(deps)` | SDK 57 registry re-alignment (docs/13 note) |
| 15 milestone close | `chore(booking-review)` (this commit) | review/polish/documentation pass |

**Delivered by this milestone:** the full pre-checkout booking flow behind the Program Details Book CTA — type-appropriate selection (single session, camp weeks, trial dual options, skip rule for dateless single-option programs) · deterministic availability states (few left, full-disabled-explained, no sessions, registration closed) · single-select participant step with inline eligibility, preselection rule, no-eligible recovery, and the guest sign-in contract · fully re-validated booking summary per program type with `Booking price` wording, informational offer lines, edit round-trips, and the **inert Continue-to-checkout contract** (docs/09 §21.8) · in-memory `BookingDraft` whose lifetime equals the flow's (docs/09 §21.13) · shared session derivation keeping details and booking availability identical (docs/09 §21.5).

**Not implemented (deferred, do not start without owner approval):** checkout · payment · CheckoutIntent or any checkout handoff · booking confirmation · reservation/capacity holds of any kind · multi-participant booking (docs/09 §21.2) · waitlists (§21.4) · promo codes, notes, special requests (§21.16) · draft persistence (§21.13) · cart · written review content · favourites persistence · real provider policies · universal links · real maps · provider support actions · gifts · authentication · profile/participant management UI · Bookings calendar · Saved screen · Credits · Rewards · backend · Arabic/RTL · provider portal · admin portal. The Continue-to-checkout CTA, guest Sign-in action, and Bookings/Saved/Profile dock items stay **inert with press feedback** (docs/09 §17.2, §21.8, §21.9).

**Current work: Phase P0 of the production platform plan.** `docs/23_PRODUCTION_PLATFORM_REBASELINE.md` is **owner-approved and binding (2026-08-05)**, including Amendment A1 (`a315c36`) and Amendment A2 (`a8a4480`): Himma is the final production marketplace — seven workstreams, three connected frontends (customer app, provider portal, admin portal) before backend completion, canonical domain model, lifecycle state machines, authorization model, production architecture, correctness-gated scale tiers, and launch gates. Governance was synchronized across CLAUDE.md, README.md, and the stale strategic docs in the same commit as this note.

Live status:
- **Checkout milestone (docs/22):** Commit 16 (`31f11b9` checkout foundation and price review) **complete and owner-approved**; Commit 17 (payment-method contract and checkout readiness) **complete in this commit, awaiting owner review**; **Commit 18 not started** — it begins only on explicit owner go-ahead. Commit 17 delivered the generic `Card payment` contract method (radio semantics, no card details), the pure `checkoutReducer`/`checkoutReadiness` cores (named blocker `Choose a payment method to continue`), finalized free-vs-paid CTA behavior (`Confirm booking` / `Continue to payment`, both inert and duplicate-press-guarded), clean checkout-local state on re-entry, and a source-scan guard test proving no payment-submission path exists outside the contract declarations. Web note (device-verify): RN-web `Pressable` buttons drop `aria-disabled`, so the unready CTA exposes its state on web through the visible named blocker + disabled styling; `accessibilityState.disabled` ships for native.
- **Phase: P0** (docs/23 §16). Open P0 items: **Batch-1 owner decisions open** (docs/23 §18.1–10 — rebaseline ratified; scale tiers, hosting region, gateway, counsel, brand, commercial model, customer web, language launch, device procurement still open) · **native-validation environment procurement open** (first full device pass pending it) · **provider design-partner recruitment open** (docs/23 §8.6) · **canonical-model specification (docs/23 §5–§7 spec document) not started**.
- The deferral list below still holds item-by-item, but its items are scheduled workstreams under docs/23 §3/§16, not indefinite futures.
- **Real payment submission remains prohibited** platform-wide until every docs/23 §19 condition exists (legal acknowledgments, server-side validation, certified gateway, operational controls).

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
| Booking selection step (HMA-017) | ✅ (docs/21) | ✅ (Commit 12; Commit 14 edit-return wiring; Commit 15 web aria-disabled fix) | ⏳ pending |
| Booking participant step (HMA-018/019 inline) | ✅ (docs/21) | ✅ (Commit 13; Commit 14 Continue wiring; Commit 15 web aria-disabled fix) | ⏳ pending |
| Booking summary (HMA-020) | ✅ (docs/21) | ✅ (Commit 14, incl. accessibility review) | ⏳ pending |

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
| `/booking/[programId]` (root push, nested stack) | Booking selection step (skip rule may `<Redirect>` to participant) | hidden structurally |
| `/booking/[programId]/participant` | Booking participant step | hidden structurally |
| `/booking/[programId]/summary` | Booking summary | hidden structurally |

QA-only params: `?qa-scenario=guest|me-only|me-active|household` (Home/Discover/Booking account fixtures), `?qa-fail=1` (Discover/Results/Map/Program/Provider/Booking-step error state), `?qa-nocount=1` (Map missing counts).

### Detail-route activation matrix (docs/20 §2.4, all verified in QA)

Program Details opens from: Home rails, Discover carousels, Results (All + Programs), Category page, Activity-type page, Provider Storefront program lists, and cold deep links. Provider Storefront opens from: Discover provider carousel, Search provider suggestions (direct, no search submit), Results (All + Providers), Category page, Activity-type page, Program Details provider row, and cold deep links. By design there are **no** program cards on Search/Map and **no** provider cards on Home (docs/20 §2.4 documents each).

### Booking-flow behavior (docs/21 §3, §10 — all verified in QA)

- Single entry: the Program Details Book CTA (`useBookingEntry`, 700 ms double-tap guard). The flow is a root-level nested stack; `BookingSessionProvider` mounts in its `_layout` keyed by `programId`, so the draft's lifetime equals the flow's lifetime — leaving, switching program, or re-entering always yields a fresh draft (abandoned-flow reset is structural).
- Skip rule (docs/09 §21.1): one dateless bookable option ⇒ the index route `<Redirect>`s (replace) to the participant step; back lands on Program Details in one step; the summary shows `Step 2 of 2` and no Change session action.
- Step access policies in `booking-navigation.ts` (pure, unit-tested): `participantStepAccess` and `summaryStepAccess` re-validate the draft at response time — missing option/session or full session → flow start; missing/ineligible participant or guest → participant step; unknown program → recovery state. Cold deep links with an empty draft redirect to the flow start. No silent draft repair anywhere.
- Edit actions: Change participant pops to the participant step; Change session uses `router.dismissTo` to the selection step (participant survives; option switches clear stale session ids in the reducer). The summary CTA price line is a polite live region so edit round-trips re-announce.
- The flow reads `ParticipantProvider` once for preselection and never writes it; `ResultsSessionProvider` and the Program Details instance stay mounted beneath the whole flow (exact-origin back chain Summary → Participant → Selection → Details → origin).

### Stack behavior (docs/20 §2.2–2.3)

- Exact-origin back everywhere; root pushes leave the origin (and the Results session) mounted beneath.
- Cold deep link: back control falls back to `router.replace('/discover')`; unknown ids render recovery states with a `Browse activities` action.
- Program ↔ Provider round-trips resolve as `back` instead of stacking a third route (`detail-navigation.ts`: press-time root-state read via `useNavigationContainerRef` — **press-time, not render-time**, because react-native-screens freezes covered screens and a render-captured state goes stale; the helper also unwraps Expo's synthetic `__root` wrapper, incl. nested wrappers — all unit-tested).
- Double-tap guard (700 ms) prevents duplicate detail routes from one action; QA double-clicks to prove it.
- Storefront taxonomy chips `dismiss()` then push the category/activity route so browsing surfaces never stack on top of a root detail route (cold-link fallback: replace).

## Automated verification (Commit 15 final run, exact totals)

- TypeScript `tsc --noEmit`: clean · ESLint `--max-warnings=0`: clean · Jest: **325/325 across 19 suites** · expo-doctor: **20/20**
- Playwright QA (playwright-core + system Chrome, Expo web :8081): **597 checks, 0 failures** — home 79, discover 64, search 22, results 35, catalogue 36, map 52, details 127, **booking 182**. Every suite asserts zero console errors and no horizontal overflow (390 and 360); the booking suite additionally asserts the inert-checkout contract (no route change, zero dialogs), no reservation/Total/VAT/fee copy, and structural accessibility (radiogroup/radio semantics with explicit checked/disabled states, heading roles, summary reading order).
- Dependency note: `01b6f73 chore(deps)` re-aligned to the current SDK 57 registry (expo ~57.0.10 line; `react-native-gesture-handler` back to ~2.32.0 — the registry reversed its own Commit-11 prescription of 3.1.0; full history in docs/13). npm audit: same 11 known moderate advisories, all under the Expo-tooling `uuid` root — zero in shipped code.

## Screenshot inventory — `artifacts/details-review/` (62 captures, all regenerated in Commit 11)

Every state row exists at both 390 × 844 and 360 × 780 (`-390`/`-360` suffixes) unless noted:

- **Program:** `01-program-adult-{top,mid,bottom,saved}` · `02-program-child-eligible` · `03-program-child-ineligible` · `04-program-ladies-only` · `05-program-offer-weak-availability` · `06-program-free` · `06-program-no-sessions` · `07-program-sticky-cta` (mid-scroll frame, distinct from 01) · `13-program-error` · `13-program-unknown`
- **Provider:** `08-storefront-default-{top,mid,bottom}` · `08-storefront-saved` · `09-storefront-multibranch` · `09-storefront-branch-switched` · `10-storefront-child-eligible` · `10-storefront-child-ineligible-open` · `10-storefront-child-none` · `11-storefront-weak-supply` (scrolled to the one-program list) · `12-storefront-monogram` (top frame) · `13-storefront-error` · `13-storefront-unknown`
- **Flows:** `14-storefront-from-program` (Program → Provider) · `14-program-from-storefront` (Provider → Program) · `16-results-after-program-back` (Results session preserved) · `17-discover-after-storefront-back` (search-suggestion flow return) · `18-crosslink-reuse` (Program A → Provider A → Program X → Provider A resolved by back/reuse)

Known-identical pairs (deliberate, not stale): `13-program-error` ≡ `13-storefront-error` per width — both surfaces render the same shared full-screen `ErrorStateCard`; they document two distinct states that are pixel-identical by design. One-branch (falcon) and no-offers states are demonstrated by the `08` default set (QA asserts no selector and no offers section). Earlier milestone folders (`home-review`, `discover-review`, `search-review`, `home-regression`) are unchanged.

## Screenshot inventory — `artifacts/booking-review/` (52 captures, docs/21 §17 complete)

Every matrix row 01–20 exists at both 390 × 844 and 360 × 780 (`-390`/`-360` suffixes): `01`-single-session · `02`-few-left · `03`-full-session · `04`-no-sessions · `05`-registration-closed · `06`-trial-{free,paid} · `07`-camp-weeks · `08`-participant-preselected · `09`-participant-ineligible · `10`-participant-none · `11`-participant-changed · `12`-summary-single (+ `-bottom` frames both widths) · `13`-summary-{recurring,membership} · `14`-summary-{camp,package,free,trial} · `15`-summary-after-edit · `16`-summary-sticky · `17`-error · `18`-unknown · `19`-cold-link · `20`-guest. Deliberate near-identical pairs: `12-…-bottom` ≡ `16-…-sticky` per width (one scrolled frame documents two matrix rows); the whole summary fits without scrolling at both widths, so top and bottom frames differ only where content height demands it.

## State coverage (Commit 11 audit)

**Program Details — implemented and screenshot-demonstrated:** default/adult, saved + unsaved, child eligible, child ineligible (banner + recovery chips), Ladies-only, offer/trial, free, no sessions, weak availability (`3 places left`), sticky CTA, offline/error + retry, unknown id.
**Provider Storefront — implemented and screenshot-demonstrated:** default, saved + unsaved, one branch, multi-branch + switched branch, adult (eligible-first ranking), child eligible grouping (+ expanded ineligible group), child with no eligible programs (recovery), weak supply, no offers, monogram fallback, offline/error + retry, unknown id.
**Implemented, not screenshot-demonstrated:** loading skeletons on both surfaces (300 ms mock delay — transient, exercised on every QA navigation); missing-image `AppImage` fallback (needs a forced decode failure, same standing limitation as Home); missing-instructor section collapse (data-driven conditional, covered by extras invariants, no dedicated capture).
**Contract-level only:** none — every declared docs/20 §9 state renders.
**Deferred:** favourites persistence across full reload (QA reloads reset saves — session-local by design until the account/backend milestone).

## State coverage — booking flow (Commit 15 audit, docs/21 §13)

**Implemented and QA/screenshot-demonstrated:** every §13 state — default booking per type (single, recurring, term-equivalent, camp incl. multi-week override, package, membership-style, free, free/paid trial, discounted-offer line) · preselected eligible participant · ineligible browsing participant (never preselected, explained) · no eligible participants recovery · few places left · full session (disabled + explained on both booking and details) · no sessions (both surfaces agree) · registration closed · changed participant · changed session (incl. option switch clearing stale sessions) · error + retry on all three steps · unknown program · cold deep links (all three routes) · abandoned-flow reset · guest sign-in contract.
**Implemented, not screenshot-demonstrated:** per-step loading skeletons (300 ms mock delay — transient, exercised on every QA navigation; same standing limitation as the details milestone).
**Copy audit (Commit 15):** QA asserts the rendered flow never contains reservation/hold/charged-today, `Total`, VAT/fee, auto-renewal, or package expiry/redemption wording; a source grep confirms no such customer copy exists in `src/features/booking/` or the booking service.

## Commit 15 review changes (this commit)

- **Accessibility (web parity):** the two disabled radio rows (full session, ineligible participant) now set explicit `aria-checked={false}` / `aria-disabled` — RN-web does not emit aria state from `accessibilityState` (the standing HANDOFF rule PressableFeedback already follows); native behavior is unchanged. Only code change in the commit.
- **QA:** `booking-review.mjs` extended with structural accessibility assertions (radiogroup roles, exactly-one-checked radio, disabled-state exposure, heading roles, summary reading order) and the three missing matrix captures (`12-…-single-bottom-360`, `13-…-membership-360`, `17-…-error-360`); header updated to the Commits 12–15 scope. Booking checks 172 → 182.
- **Docs:** docs/21 status header records the closed milestone and per-commit approvals; docs/13 records the SDK 57 registry drift and the `chore(deps)` alignment; the temporary COMMIT_14_REPORT.md session file was deleted (this HANDOFF is the permanent record).
- Earlier-milestone review notes (Commit 11 ESLint ignore, `AppImage` labels, `providerMonogram` consolidation, deterministic QA scrolling) live in git history.

No approved-screen redesigns; no new product features.

## Known limitations / polish debt (recorded, deliberately NOT fixed in Commit 11)

- **Documented assumptions (details milestone):** branch selector is a wrapping chip row treated as a segmented control and assumes **max two branches per provider** (docs/20 §4.6's "sheet for more than 2" is unimplemented — no provider has >2); session lists render at most **6 upcoming occurrences** from the two-week window (scannability cap in `buildUpcomingSessions`); sessions are informational only on details (docs/09 §20.9 — the booking flow owns selection); provider name inside program cards stays non-interactive (docs/09 §20.2 — path is card → Program Details → provider row).
- **Documented assumptions (booking milestone):** the booking draft is in-memory only — reload, restart, or OS termination discards it (docs/09 §21.13); one participant per booking, contracts keep the multi-participant widening path (docs/09 §21.2); membership-style products book through the `monthly` mapping (docs/09 §21.14); the `freeTrial` price kind stays unused (trials derive from offers); at 360 width the sticky-CTA price line may ellipsize on long cadence labels (`AED 85 per …`) — the full label is in the price block and the accessible CTA label.
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

The booking milestone adds:

10. **Booking flow, iOS:** swipe-back through Summary → Participant → Selection → Details; the skip-rule `<Redirect>` replace keeps one-step back to Details; sticky Continue bars sit above the home indicator on both steps; VoiceOver pass for the radio groups (session/option/participant), disabled-with-reason rows, polite live-region announcements (`Booking for Adam`, summary price after edits), and the spoken `Booking price` CTA label.
11. **Booking flow, Android:** hardware back pops exactly one step (no sheets exist in the flow); TalkBack equivalents of item 10; font-metric tolerance on session rows and the two-line CTA status text.

## Architecture map (stable — see git history for details)

- Routes: `src/app/_layout.tsx` (root Stack + providers: Account → Participant, Area, Favourites, ResultsSession) → `(tabs)/_layout.tsx` (Tabs + `DockTabBar`) → Home, `discover/` stack (`unstable_settings anchor: 'index'` — keep!), root `search.tsx` + `map.tsx` + `program/[programId].tsx` + `provider/[providerId].tsx` + `booking/[programId]/` (nested Stack `_layout` mounting `BookingSessionProvider` keyed by `programId` — the draft-lifetime mechanism, don't lift it).
- Screens in `src/features/{home,discover,search,results,catalogue,map,details,booking}/`; pure navigation rules in `map-navigation.ts`, `search-navigation.ts`, `details/detail-navigation.ts`, and `booking/booking-navigation.ts` (step-access policies + double-tap-guarded entry — all unit-tested), with pure presentation helpers `booking/participant-rows.ts` and `booking/summary-presentation.ts`.
- Services: typed contracts in `services/contracts/`, deterministic mocks in `services/mock/`; screens never import raw catalogue arrays. `MockDetailsService` (300 ms delay) exposes pure `buildProgramDetailPage`/`buildProviderStorefrontPage` cores plus `buildUpcomingSessions` and `providerMonogram`. `MockBookingService` (300 ms delay) exposes pure `buildBookingOptions`/`buildBookingSummary` cores; both surfaces share one session derivation (`sessionSpots`-aware `buildUpcomingSessions`), so details and booking can never disagree about availability.
- Booking state: `src/state/booking-session-context.tsx` — `BookingDraft` + pure `draftReducer` (`selectOption` clears stale session ids, `selectSession`, `selectParticipant`, `preselectParticipant`, `reset`); in-memory only.
- Data: `src/data/mock/catalogue.ts` (**frozen: 36 programs, 11 providers — first 21 programs' order is Home-stability-critical, append only**); details extras live in separate keyed modules `program-details.ts`, `provider-details.ts`, `policies.ts`, and booking overrides in `booking-extras.ts` (structured `trialAmount`, `registrationClosed`, `sessionSpots`, `campWeeks` — sparse, keys ⊆ catalogue ids, enforced by data-invariant tests); `schedule.ts` pinned to `MOCK_TODAY` 2026-08-02 (Sunday).
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
