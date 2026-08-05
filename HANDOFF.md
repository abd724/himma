# Himma — Session Handoff

Read this after README.md, CLAUDE.md, and docs/01–23. It captures live project state as of 2026-08-05 so a fresh session can continue without re-deriving anything.

## Where we are: the Checkout milestone (docs/22) is CLOSED

Four customer milestones are complete and owner-approved:

**Milestone 2 — customer discovery (docs/17 + docs/18), closed at `ec79c7d`.** Home · Navigation shell/dock · Search · Results + filtering · Discover feed · All Categories · Category pages · Activity-type pages · Schematic Map. Details in git history and docs/17–19.

**Milestone 3 — evaluation surfaces (docs/20), closed at `38c5ecb chore(details-review)`.** Program Details · Provider Storefront · Program ↔ Provider cross-navigation with stack reuse · typed favourites · participant suitability with explicit recovery · Blue Wave multi-branch model · mock cancellation-policy presets · informational session lists · save/share. Details in git history and docs/20.

**Milestone 4 — booking flow (docs/21), closed at `454ee91 chore(booking-review)`:**

| Step | Commit | Status |
|---|---|---|
| 12 Booking foundation + session selection (HMA-017) | `c1e5191 feat(booking)` | ✅ approved (design + frontend) |
| 13 Participant selection + eligibility (HMA-018/019 inline) | `df06260 feat(booking)` | ✅ approved (design + frontend + accessibility review) |
| 14 Booking summary + flow connections (HMA-020) | `6d952d0 feat(booking)` | ✅ approved (design + frontend + flow connections + accessibility review) |
| deps | `01b6f73 chore(deps)` | SDK 57 registry re-alignment (docs/13 note) |
| 15 milestone close | `454ee91 chore(booking-review)` | review/polish/documentation pass |

**Delivered by this milestone:** the full pre-checkout booking flow behind the Program Details Book CTA — type-appropriate selection (single session, camp weeks, trial dual options, skip rule for dateless single-option programs) · deterministic availability states (few left, full-disabled-explained, no sessions, registration closed) · single-select participant step with inline eligibility, preselection rule, no-eligible recovery, and the guest sign-in contract · fully re-validated booking summary per program type with `Booking price` wording, informational offer lines, edit round-trips, and the **inert Continue-to-checkout contract** (docs/09 §21.8) · in-memory `BookingDraft` whose lifetime equals the flow's (docs/09 §21.13) · shared session derivation keeping details and booking availability identical (docs/09 §21.5).

**Milestone 5 — checkout (docs/22), closed at this commit:**

| Step | Commit | Status |
|---|---|---|
| 16 Checkout foundation + price review (HMA-021) | `31f11b9 feat(checkout)` | ✅ approved (design + frontend) |
| 17 Payment-method contract + checkout readiness | `a04df62 feat(checkout)` | ✅ approved (conditional approval resolved by the correction below) |
| 17 accessibility correction | `07b0865 fix(checkout)` | ✅ approved (unready CTA `aria-disabled`/native disabled semantics; pure `ctaPressAllowed` gate) |
| 18 Revalidation states + flow hardening | `00e50de feat(checkout)` | ✅ logic approved (visuals superseded by the correction below) |
| 18 visual correction — CheckoutIssueCard | `fc583d0 fix(checkout)` | ✅ approved: **interaction design approved · provisional Orbit Indigo visual implementation approved · final brand styling pending the design-system engagement** |
| 19 milestone close | `chore(checkout-review)` (this commit) | review/verification/documentation pass |

**Delivered by this milestone:** one-screen checkout at `/booking/[programId]/checkout` inside the booking stack over the re-derived, re-validated `BookingSummary` (no CheckoutDraft copy, no CheckoutSessionProvider) — order recap with guardian context (`Booked by you`) on child bookings and a single `Edit booking` action · price breakdown with structured reconciling amounts, `Booking price` label continuity end-to-end (no `Total`, no VAT, no fees, no discount arithmetic, `Free` never `AED 0`) · cancellation-policy summary displayed with an inert `Full policy` contract and **no acceptance claim of any kind** · the single generic **`Card payment`** contract method (radio semantics, no card details; Apple/Google Pay declared-only) · pure `checkoutReducer`/`checkoutReadiness` with the named blocker `Choose a payment method to continue` in a polite live region · free-vs-paid CTA behavior (`Confirm booking` / `Continue to payment`), production-styled, duplicate-press-guarded (700 ms, pure `ctaPressAllowed`), **inert** — the unready CTA exposes `aria-disabled` + native disabled semantics on web and `accessibilityState.disabled` on native · typed `CheckoutValidation` revalidation states on the dedicated **CheckoutIssueCard** (per-code icon/state label/headline/support, structured `CheckoutPriceComparison` old → new display, `No payment has been made.` reassurance row, one full-width recovery CTA; no checkout CTA and no payment controls while an issue is unresolved; re-derive for review-style codes, owning-step returns otherwise) · `?qa-revalidate` review reachability for all seven issue codes (captured once at flow entry) · `checkoutStepAccess` sharing the summary's validation for cold-link/invalid-draft/unknown-program recovery · a source-scan guard proving `PaymentSubmitRequest`/`PaymentSubmitResult` exist only as contract declarations with no submit path anywhere.

**Not implemented (deferred, scheduled per docs/23 §16 — do not start without owner approval):** payment submission of any kind (prohibited until every docs/23 §19 condition exists) · payment status/confirmation routes (HMA-022/023) · reservation/capacity holds · legal-acceptance UI (required before real submission per docs/09 §22.7) · Marketplace Credit application (§22.12) · promo codes · saved cards, card entry, tokenization, Apple/Google Pay execution · multi-participant booking (docs/09 §21.2) · waitlists (§21.4) · draft persistence (§21.13) · cart · written review content · favourites persistence · real provider policies · universal links · real maps · provider support actions · gifts · authentication · profile/participant management UI · Bookings calendar · Saved screen · Credits · Rewards · backend · Arabic/RTL · provider portal · admin portal. The checkout CTA, `Full policy` row, support row, guest Sign-in action, and Bookings/Saved/Profile dock items stay **inert with press feedback** (docs/09 §17.2, §22.11).

**Current work: Phase P0 of the production platform plan.** `docs/23_PRODUCTION_PLATFORM_REBASELINE.md` is **owner-approved and binding (2026-08-05)**, including Amendment A1 (`a315c36`) and Amendment A2 (`a8a4480`): Himma is the final production marketplace — seven workstreams, three connected frontends (customer app, provider portal, admin portal) before backend completion, canonical domain model, lifecycle state machines, authorization model, production architecture, correctness-gated scale tiers, and launch gates. Governance was synchronized across CLAUDE.md, README.md, and the stale strategic docs in the same commit as this note.

Live status:
- **Checkout milestone (docs/22): CLOSED at this commit** — all four commits plus the two owner-approved corrections (see the Milestone 5 table above). The checkout approval record: **interaction design approved · provisional Orbit Indigo visual implementation approved · final brand styling pending the professional branding/design-system engagement · native validation pending · real payment submission prohibited (docs/23 §19)**. The `?qa-revalidate` demo detail worth remembering: the code rides the flow's *entry* URL and is captured once at `BookingSessionProvider` mount (pushed routes drop search params); the priceChanged demo previous price is current − AED 10 from structured data (the payable amount everywhere remains the catalogue price). docs/22 §16's "rows 16–18" screenshot reference is a recorded doc slip — §15 assigns rows 12–13, and rows 17–19 were added for the extra reviewable states.
- **Next customer work is sequenced by docs/23 §16, not momentum:** the Payment & Confirmation milestone cannot be planned honestly until the W5 gateway selection and docs/23 §18 decisions exist. The Bookings/Saved/Profile mock milestone is the recommended next W1 item (P1, RTL-safe per docs/23 §3.1) — **do not start it without an owner-approved plan document.**
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
| Checkout (HMA-021, docs/22) | ✅ (docs/22 + owner-directed CheckoutIssueCard) | ✅ (Commits 16–18 + `07b0865`/`fc583d0` corrections — interaction design approved; **provisional Orbit Indigo visual implementation approved; final brand styling pending** the design-system engagement) | ⏳ pending |

**Native validation is pending for every surface** — web review never upgrades a screen to "native validated" (docs/12 §1). All code is written native-safe per docs/12; the device-only checklist is under "Native validation backlog" below.

## Native-validation environment (P0 procurement — status 2026-08-05)

**Android: environment complete; first emulator smoke pass done.** Machine: macOS 26.5.2, Apple M3 Pro, 18 GB RAM. Toolchain verified: Android Studio 2024.3 · SDK at `~/Library/Android/sdk` (platforms 33/35/36, build-tools 36.0.0, platform-tools/adb 36.0.0, emulator 35.4.9, cmdline-tools 19.0, NDK 27.1 auto-installed by the Expo template) · JDK Temurin 17 (`JAVA_HOME` now set in `~/.zshrc`) · all SDK licenses accepted. AVDs: `demo_phone` (Pixel 7, API 36, 412 dp, 2 GB) and `Himma_Small_360` (small_phone, API 36, 360×640 dp, 1 GB — the docs/12 §10 ~360-dp target). `npx expo run:android` (debug, prebuild-generated gitignored `android/`, `com.himma.dev` placeholder package uncommitted) built and ran on both AVDs on branch `native-validation`.

**First Android smoke pass (risk discovery, NOT full validation — no screen upgraded):** Home, Discover, Search+suggestions, Results, Program Details, booking participant step (skip rule fired for the dateless package), summary, and checkout all rendered and operated; hardware back popped exactly one step everywhere with state intact; checkout inert-submit contract held natively (unready CTA inert with named blocker; ready CTA inert; method selection persisted); carousels scrolled correctly inside vertical scroll; zero FATAL/JS errors in logcat on both AVDs.

**Findings logged (not fixed — separate task):**
1. **Native defect — camp price unit lost:** cards render `AED 850 /` / `AED 990 /` on Android where web renders `AED 850/week` / `AED 990/week` (verified same-build web comparison). Font-metric/wrap divergence class (docs/12 §4).
2. **QA-affordance gap:** `?qa-revalidate` (and `?qa-scenario`) are guarded `window.location` reads — native deep links (`himma://booking/...?qa-revalidate=...`, warm and cold) cannot trigger the CheckoutIssueCard review states on device until the params move to router params.
3. **Environment notes:** emulator Gboard sits in floating-toolbar mode, so docked-keyboard avoidance is still unexercised (low risk — transactional flows have no text inputs); the small AVD needed a wifi toggle (`svc wifi disable/enable`) after first cold boot before Metro was reachable.

**iOS: environment complete; launch verified; interactive smoke pass pending one owner command.** Xcode 26.6 (17F113) installed and selected (`/Applications/Xcode.app/Contents/Developer`), first-launch components done, iOS 26.5 simulator runtime (23F77) installed via `xcodebuild -downloadPlatform iOS`. Simulators: the default iOS 26.5 set (incl. **iPhone 17**, primary/Dynamic-Island class) plus created **`Himma-SE`** (iPhone SE 3rd gen, 375×667, no notch — docs/12 small-iOS target). CocoaPods installed via Homebrew (Expo auto-installed it; `pod install` needs `LANG=en_US.UTF-8`). `npx expo run:ios` **Build Succeeded**; Himma launched and Home render-verified on **both** iPhone 17 and Himma-SE (evidence in `artifacts/native-smoke-ios/`). Notably iOS renders `Your week` and `/week` correctly — narrowing finding 1 above to an **Android-only loss of the trailing word "week"** (headings and price units). **Interactive iOS smoke pass (2026-08-05, after the owner's `xcode-select` fix): DONE on iPhone 17** — deep-link `Open in "Himma"?` acceptance routed correctly into the booking flow (skip rule fired on the cold link); participant step contract (disabled Continue inert with `Choose who is attending`, explained `Not suitable` rows, selection → `Booking for you`); summary intact; checkout unready CTA inert with named blocker; `Card payment` selection → ready CTA with price label; **ready CTA inert (no-submit contract holds on iOS)**; edge-swipe-back popped checkout → intact summary → participant → Home; Search live suggestions working with typed input. Evidence: `artifacts/native-smoke-ios/` (8 captures). Caveats: the iOS Simulator defaults to hardware-keyboard mode, so on-screen-keyboard avoidance is still unexercised on both platforms (device-pass item); `simctl openurl` custom-scheme links always raise the system open dialog (expected iOS behavior). **Himma-SE abbreviated interactive pass (2026-08-05): DONE** — driven via `idb` (facebook/fb Homebrew tap: `idb-companion` + `fb-idb` in a scratchpad venv) because the Claude Code simulator-panel device grant for Himma-SE never registered. Verified at 375×667: Home/Discover/Search/Results/Details render with no clipping (chip rows scroll horizontally by design; provider names ellipsize gracefully) · skip-rule cold link → participant → summary → checkout · disabled Continue and checkout CTAs inert with correct blockers (blocker wraps to three lines in full) · participant + `Card payment` selection updates readiness · ready CTA inert (no-submit) · swipe-back pops one step at a time with the draft preserved (participant stays selected) · back from the cold-linked flow start lands on Discover (the documented fallback) · search typing + grouped suggestions work · checkout bottom scroll padding is sufficient (payment card + support row clear the sticky footer fully) · sticky-footer price label wraps to two/three lines on SE-width — readable, nothing obscured (item 3 visual debt, now with SE evidence) · dock fits all five items with Home/Discover pill behavior intact · zero native errors for the app process (`log show --level error`: 0) and zero Metro JS errors. Evidence: `artifacts/native-smoke-ios/se-*.png` (16 captures).

**New native visual finding (both iOS devices, discovered in this pass): scrolled Program Details content passes under the transparent status bar with no scrim** — page text collides with the status-bar clock/carrier text on iPhone 17 and Himma-SE (evidence: `se-15-home-carousel.png` predecessor frame `se-14`-adjacent capture and `17pro-details-scrolled2.png`). Android likely shares the hero edge-to-edge design; verify during the fix. Detail screens only (Home's pinned opaque header masks correctly). Recorded as native visual debt — do not fix in the environment task.

Physical-device testing (both platforms) not started.

## Native correction task (2026-08-05, post-P0-smoke, on `native-validation` — UNCOMMITTED pending owner review)

**A — status-bar collision (Program Details + Provider Storefront): FIXED on all platforms.** Root cause: both detail surfaces scroll content under the transparent status bar with no top mask. Fix: shared **[StatusBarScrim](src/components/domain/status-bar-scrim.tsx)** — a safe-area-height `Animated.View` (`pointerEvents="none"`, native-driver opacity) that fades in over the 56-pt band before the hero/cover bottom reaches `insets.top`; renders nothing when the top inset is 0 (web preview unchanged). Wired into [program-details-screen.tsx](src/features/details/program-details-screen.tsx) (`HERO_HEIGHT` 264) and [provider-storefront-screen.tsx](src/features/details/provider-storefront-screen.tsx) (`COVER_HEIGHT` 220 — owner-directed extension after the collision reproduced there; identical structure). Verified: no collision when scrolled and edge-to-edge hero intact at rest on Pixel 7, 360-dp Android, iPhone 17, and Himma-SE, both surfaces; long + short content; no jump/flicker/duplicate header; back/swipe navigation unaffected.

**B — Android trailing-word loss ("Your" / "AED 850 /"): FIXED, single root cause.** RN-Android (Fabric) lays a `Text` out at its measured width; fractional widths (Manrope advances, negative letterSpacing) get floored by Android's integer text layout, silently wrapping the last word onto a clipped second line. String-dependent — "Your week" broke while "My week" didn't. Three structural fixes, no per-string or per-platform copy: [section-header.tsx](src/components/ui/section-header.tsx) title `flexGrow: 1` (layout width > measured width; letterSpacing kept); [program-card.tsx](src/components/domain/program-card.tsx) amount+unit merged into one nested `Text` (single paragraph, true text baselines); [compact-program-row.tsx](src/components/domain/compact-program-row.tsx) unit `paddingRight: 1` (floor loss < 1pt; preserves the documented whole-unit wrap at 360). Verified: 412-dp + 360-dp Android (incl. font scale 1.3), iPhone 17, Himma-SE, web QA suites. **Watch for:** the same latent defect class exists for any tightly-measured standalone `Text` — if a trailing word vanishes on Android again, reach for these three patterns.

**C — QA params are now Expo Router params (dev-gated): DONE.** `?qa-scenario` ([account-context.tsx](src/state/account-context.tsx)) and `?qa-revalidate` ([booking-session-context.tsx](src/state/booking-session-context.tsx) + [booking/_layout.tsx](src/app/booking/[programId]/_layout.tsx)) no longer read `window.location`; they read `useGlobalSearchParams` (query params ride the *focused* route — a layout's `useLocalSearchParams` never sees them on native) behind `__DEV__` gates, so production builds compile the affordance out. Capture is a **first-valid-wins latch** (conditional setState during render): native navigation state hydrates a render *after* mount, so mount-time capture misses cold deep links; once latched, the value is fixed for the provider's lifetime — the same boundaries as before (account: session; revalidate: booking-flow lifetime via the `key={programId}` remount). All seven revalidation codes now render on native — verified priceChanged/sessionFull/participantIneligible on Android and iPhone 17 via `himma://booking/<id>?qa-revalidate=<code>` cold links. `qa-fail`/`qa-nocount` were already router-param reads. Pure validators `scenarioFromParam`/`qaRevalidateFromParam` replace the search-string parsers (unit tests updated, 408 total).

**Correction-task verification (final, incl. the storefront/Android scrim extension):** tsc clean · ESLint `--max-warnings=0` clean · Jest 408/408 (23 suites) · expo-doctor 20/20 · all nine Playwright QA suites 808/808 (checkout 210 exercising every revalidation state through the router-param path on web; Playwright baselines with sub-pixel/decode-noise-only diffs were reverted per the screenshot policy) · native builds and launches re-verified on demo_phone, Himma_Small_360, iPhone 17, Himma-SE · zero fatal native or JS errors on any target. Curated evidence: `artifacts/native-fix-review/` (per-fix, per-device), `artifacts/native-smoke-{android,ios}/` (representative smoke subset). No screen is upgraded to "native validated" — that requires the full docs/12 §10 checklist (Dynamic Type, VoiceOver/TalkBack, reduce motion, per-screen sweep), which is the next scheduled native-validation task.

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
| `/booking/[programId]/checkout` | Checkout (HMA-021) | hidden structurally |

QA-only params: `?qa-scenario=guest|me-only|me-active|household` (Home/Discover/Booking account fixtures), `?qa-fail=1` (Discover/Results/Map/Program/Provider/Booking-step/Checkout error state), `?qa-nocount=1` (Map missing counts), `?qa-revalidate=<CheckoutIssueCode>` on the **booking flow's entry URL** (all seven codes; captured once at `BookingSessionProvider` mount because pushed routes drop search params — surfaces at checkout as the typed revalidation review state).

### Detail-route activation matrix (docs/20 §2.4, all verified in QA)

Program Details opens from: Home rails, Discover carousels, Results (All + Programs), Category page, Activity-type page, Provider Storefront program lists, and cold deep links. Provider Storefront opens from: Discover provider carousel, Search provider suggestions (direct, no search submit), Results (All + Providers), Category page, Activity-type page, Program Details provider row, and cold deep links. By design there are **no** program cards on Search/Map and **no** provider cards on Home (docs/20 §2.4 documents each).

### Booking-flow behavior (docs/21 §3, §10 — all verified in QA)

- Single entry: the Program Details Book CTA (`useBookingEntry`, 700 ms double-tap guard). The flow is a root-level nested stack; `BookingSessionProvider` mounts in its `_layout` keyed by `programId`, so the draft's lifetime equals the flow's lifetime — leaving, switching program, or re-entering always yields a fresh draft (abandoned-flow reset is structural).
- Skip rule (docs/09 §21.1): one dateless bookable option ⇒ the index route `<Redirect>`s (replace) to the participant step; back lands on Program Details in one step; the summary shows `Step 2 of 2` and no Change session action.
- Step access policies in `booking-navigation.ts` (pure, unit-tested): `participantStepAccess` and `summaryStepAccess` re-validate the draft at response time — missing option/session or full session → flow start; missing/ineligible participant or guest → participant step; unknown program → recovery state. Cold deep links with an empty draft redirect to the flow start. No silent draft repair anywhere.
- Edit actions: Change participant pops to the participant step; Change session uses `router.dismissTo` to the selection step (participant survives; option switches clear stale session ids in the reducer). The summary CTA price line is a polite live region so edit round-trips re-announce.
- The flow reads `ParticipantProvider` once for preselection and never writes it; `ResultsSessionProvider` and the Program Details instance stay mounted beneath the whole flow (exact-origin back chain Summary → Participant → Selection → Details → origin).

### Checkout behavior (docs/22 §3–§9 — all verified in QA)

- Checkout is the booking stack's fourth screen over the **re-derived** `BookingSummary` (docs/22 §2 model A): the summary's Continue-to-checkout CTA pushes it behind the 700 ms guard; back pops to the intact summary; `Edit booking` is just back (the summary owns Change participant/session); returning re-derives everything with clean checkout-local state.
- `checkoutStepAccess` = `summaryStepAccess` (shared deliberately): invalid/missing drafts, full sessions, guests, ineligible participants, and cold links all redirect to the owning step; unknown programs render the standard recovery. Checkout-local state is only `{ paymentMethodId? }` in a screen-level reducer — no provider.
- CTA readiness (`checkoutReadiness`): free → always ready; paid → the generic `Card payment` contract method must be selected and `contractOnly` — otherwise the CTA is disabled-styled with `aria-disabled`/native disabled semantics and the polite live region names `Choose a payment method to continue`. Every press path (click, Enter, Space, native, repeated) is inert through the Pressable-layer block plus the pure `ctaPressAllowed` gate.
- Revalidation: a not-ok `CheckoutValidation` replaces the content with the `CheckoutIssueCard` (no CTA bar, no payment controls); `checkoutIssueRecovery` maps all seven codes — priceChanged/offerExpired re-derive in place, sessionFull/branchUnavailable/invalidDraft return to the flow start, participantIneligible to the participant step, registrationClosed to Program Details. Deterministic mock issues are QA-param demonstrations only; `priceComparison` labels come from structured amounts (demo previous = current − AED 10; never rendered on any customer-reachable path).

### Stack behavior (docs/20 §2.2–2.3)

- Exact-origin back everywhere; root pushes leave the origin (and the Results session) mounted beneath.
- Cold deep link: back control falls back to `router.replace('/discover')`; unknown ids render recovery states with a `Browse activities` action.
- Program ↔ Provider round-trips resolve as `back` instead of stacking a third route (`detail-navigation.ts`: press-time root-state read via `useNavigationContainerRef` — **press-time, not render-time**, because react-native-screens freezes covered screens and a render-captured state goes stale; the helper also unwraps Expo's synthetic `__root` wrapper, incl. nested wrappers — all unit-tested).
- Double-tap guard (700 ms) prevents duplicate detail routes from one action; QA double-clicks to prove it.
- Storefront taxonomy chips `dismiss()` then push the category/activity route so browsing surfaces never stack on top of a root detail route (cold-link fallback: replace).

## Automated verification (Commit 19 final run, exact totals)

- TypeScript `tsc --noEmit`: clean · ESLint `--max-warnings=0`: clean · Jest: **407/407 across 23 suites** · expo-doctor: **20/20**
- Playwright QA (playwright-core + system Chrome, Expo web :8081): **808 checks, 0 failures** — home 79, discover 64, search 22, results 35, catalogue 36, map 52, details 127, booking 183, **checkout 210**. Every suite asserts zero console errors and no horizontal overflow (390 and 360). The checkout suite additionally asserts: `Booking price` continuity with no `Total`/VAT/fee/discount/`AED 0`/card-detail/acceptance copy · payment-method radiogroup semantics with explicit aria state · CTA readiness (unready `aria-disabled="true"` + native disabled semantics, named blocker, focus refusal, Enter/Space/forced-click inertness; ready enabled semantics with focus acceptance and inert presses; repeated activation swallowed) · method-selection persistence through ordinary interactions and clean state on re-entry/edit round-trips/abandonment · all revalidation states on the CheckoutIssueCard (per-state copy, structured old → new comparison, reassurance, no CTA/no payment controls, recovery navigation, re-derivation) · exact-origin back chains and cold-link/unknown/error recovery · the inert-submit contract (zero route changes, zero dialogs). A source-scan unit guard proves `PaymentSubmitRequest`/`PaymentSubmitResult` exist only as declarations in `services/contracts/checkout.ts` with no submit-like call site anywhere in `src/`.
- Note: earlier commit messages counted the QA banner line, inflating totals by one (e.g. "211" = 210 checks); this section uses exact `^PASS`-line counts.

## Automated verification (Commit 15 booking-milestone run, historical)

- TypeScript `tsc --noEmit`: clean · ESLint `--max-warnings=0`: clean · Jest: **325/325 across 19 suites** · expo-doctor: **20/20**
- Playwright QA (playwright-core + system Chrome, Expo web :8081): **597 checks, 0 failures** — home 79, discover 64, search 22, results 35, catalogue 36, map 52, details 127, **booking 182**. Every suite asserts zero console errors and no horizontal overflow (390 and 360); the booking suite additionally asserts the inert-checkout contract (no route change, zero dialogs), no reservation/Total/VAT/fee copy, and structural accessibility (radiogroup/radio semantics with explicit checked/disabled states, heading roles, summary reading order).
- Dependency note: `01b6f73 chore(deps)` re-aligned to the current SDK 57 registry (expo ~57.0.10 line; `react-native-gesture-handler` back to ~2.32.0 — the registry reversed its own Commit-11 prescription of 3.1.0; full history in docs/13). npm audit: same 11 known moderate advisories, all under the Expo-tooling `uuid` root — zero in shipped code.

## Screenshot inventory — `artifacts/checkout-review/` (38 captures, docs/22 §15 complete + extensions)

Every row at both 390 × 844 and 360 × 780 (`-390`/`-360` suffixes): `01`-single (readiness-blocker entry state) · `02`-monthly · `03`-camp · `04`-package · `05`-free (`Confirm booking`, no payment section) · `06`-free-trial · `07`-paid-trial · `08`-child (guardian context) · `09`-offer (informational line) · `10`-method-selected (= matrix row 11's "ready" frame — deliberate pairing) · `11`-readiness-blocker · `12`-revalidate-sessionfull · `13`-revalidate-pricechanged (structured old → new) · `14`-error · `15`-cold-link · `16`-sticky · extension rows `17`-revalidate-ineligible · `18`-revalidate-closed · `19`-revalidate-invalid (owner-directed CheckoutIssueCard review set). Deferred states (submitting, payment failure, saved cards) are **not captured** — deferred states are never faked for screenshots (docs/22 §15).

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

## Commit 15 review changes (`454ee91`, historical)

- **Accessibility (web parity):** the two disabled radio rows (full session, ineligible participant) now set explicit `aria-checked={false}` / `aria-disabled` — RN-web does not emit aria state from `accessibilityState` (the standing HANDOFF rule PressableFeedback already follows); native behavior is unchanged. Only code change in the commit.
- **QA:** `booking-review.mjs` extended with structural accessibility assertions (radiogroup roles, exactly-one-checked radio, disabled-state exposure, heading roles, summary reading order) and the three missing matrix captures (`12-…-single-bottom-360`, `13-…-membership-360`, `17-…-error-360`); header updated to the Commits 12–15 scope. Booking checks 172 → 182.
- **Docs:** docs/21 status header records the closed milestone and per-commit approvals; docs/13 records the SDK 57 registry drift and the `chore(deps)` alignment; the temporary COMMIT_14_REPORT.md session file was deleted (this HANDOFF is the permanent record).
- Earlier-milestone review notes (Commit 11 ESLint ignore, `AppImage` labels, `providerMonogram` consolidation, deterministic QA scrolling) live in git history.

No approved-screen redesigns; no new product features.

## State coverage — checkout (Commit 19 audit, docs/22 §8)

**Implemented and QA/screenshot-demonstrated:** every §8 in-scope state — paid one-off/monthly/term/camp/package/free/free-trial/paid-trial checkouts · offer informational-only · child booking with guardian context and no consent artifacts · policy displayed with no checkbox and no acceptance claim · generic `Card payment` selected / not-yet-selected with the named readiness blocker · registration-closed and ineligible entry redirects via the access policy · missing-draft/cold-link/unknown-program recovery · error/retry and the offline-equivalent deterministic failure · abandoned checkout and re-entry with clean state · duplicate-submit protection (real 700 ms mechanics, inert contract).
**Contract-only (QA-param-reachable):** all seven `CheckoutValidation` revalidation states on the CheckoutIssueCard (`?qa-revalidate` — sessionFull/priceChanged/offerExpired per the spec plus the four additional codes made review-reachable for the visual approval round).
**Deferred (never rendered, never faked):** submitting state, payment success/failure UI, Apple/Google Pay as usable methods, saved cards (docs/22 §8) — `PaymentSubmitRequest`/`PaymentSubmitResult` remain declarations only, enforced by the source-scan guard test.

## Visual-branding debt register (for the design-system engagement — do not re-polish provisional styling)

Owner decision (2026-08-05): the CheckoutIssueCard and checkout surfaces are approved as the **provisional Orbit Indigo implementation**; final typography, iconography, shadows, colors, spacing polish, and brand expression belong to the professional branding engagement (docs/23 §18.6). Register (append here instead of iterating on provisional styling):

1. CheckoutIssueCard: Ionicons glyph choices per issue code, icon-chip tile treatment, uppercase state-label letter-spacing, comparison-block `primarySoft` tint, struck-through previous-price treatment, reassurance shield glyph/`status.success` pairing.
2. Checkout screen: recap card `primarySoft` surface, price/policy/method block border treatment vs. the issue card's shadow treatment (two card languages on one screen — unify at rebrand), sticky-CTA bar shadow (`shadows.sheet`) and 132 px scroll-clearance literal, blocker-line multi-line wrap at 360.
3. Booking/checkout shared: `letterSpacing: -0.3` heading de-facto style, CTA button 52 px height literal vs. a token, `EmptyFeedCard` magnifier glyph reused for program-missing recovery states across surfaces.
4. The pre-existing 8b token-debt list below stands unchanged; all of it folds into the same brand-token pass.

## Known limitations / polish debt (recorded, deliberately NOT fixed in Commit 11)

- **Documented assumptions (details milestone):** branch selector is a wrapping chip row treated as a segmented control and assumes **max two branches per provider** (docs/20 §4.6's "sheet for more than 2" is unimplemented — no provider has >2); session lists render at most **6 upcoming occurrences** from the two-week window (scannability cap in `buildUpcomingSessions`); sessions are informational only on details (docs/09 §20.9 — the booking flow owns selection); provider name inside program cards stays non-interactive (docs/09 §20.2 — path is card → Program Details → provider row).
- **Documented assumptions (booking milestone):** the booking draft is in-memory only — reload, restart, or OS termination discards it (docs/09 §21.13); one participant per booking, contracts keep the multi-participant widening path (docs/09 §21.2); membership-style products book through the `monthly` mapping (docs/09 §21.14); the `freeTrial` price kind stays unused (trials derive from offers); at 360 width the sticky-CTA price line may ellipsize on long cadence labels (`AED 85 per …`) — the full label is in the price block and the accessible CTA label (the checkout readiness *blocker* deliberately wraps in full instead — the reason a CTA is unready is never truncated).
- **Documented assumptions (checkout milestone):** the unready checkout CTA carries the browser's native disabled semantics on web (RN-web structurally couples `aria-disabled` with the `disabled` attribute on button hosts), so it is not tab-focusable while unready — screen readers reach it in browse mode and the live region announces the blocker; `registrationClosed` recovery replaces checkout with a new Program Details instance on top of the stack (back from it lands on the summary — acceptable for this future-backend-only path, revisit if it ever becomes deterministic-reachable); the priceChanged headline is booking-generic (`Your booking price has changed`, owner decision 2026-08-05); `react-test-renderer` (shipped inside jest-expo) is used by the PressableFeedback contract test — no new dependency.
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

The checkout milestone adds:

12. **Checkout, iOS:** swipe-back from checkout to the intact summary; sticky CTA above the home indicator; VoiceOver pass for the payment-method radiogroup (explicit checked state), the disabled-CTA state with the live-region blocker announcement and its resolution on selection, the spoken CTA label (`Continue to payment, Booking price, …`), the CheckoutIssueCard reading order (state label → headline → support → price comparison with its paired spoken label → reassurance → recovery action), and guardian-context grouping on child bookings.
13. **Checkout, Android:** hardware back pops to the summary; TalkBack equivalents of item 12; Dynamic Type tolerance on the price-comparison rows, the multi-line readiness blocker, and the issue-card headline; `shadows.card` on the CheckoutIssueCard vs Android elevation.

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
