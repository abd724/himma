# 34 — W1-RI · Customer App Real-API Integration / Production-Like Customer Experience — Workstream Plan (W1-RI-0)

**Status: PLANNING ONLY — this document awaits owner approval (W1-RI-0). NO application, schema, or frontend code was changed. The repository checkpoint is `3c0bb45`; all backend workstreams remain frozen except the bounded prerequisite gaps this plan identifies (§7). Implementation does NOT start without owner approval of this plan and the §12 rulings it requests.**

Authority: owner direction 2026-08-25 (W1-RI activation; binding product direction: production-like Customer App on real authoritative APIs, minimum intervention, approved UX preserved; customer use of Himma is FREE — no subscription/service/platform fee, customer pays only the provider's listed price; launch marketplace commission 12% of the provider sale via the certified D-W5-7 provider-specific mechanism at `1200 bps` for normal launch providers — never customer-visible); docs/23 §3 (W1 = Customer application: "…then API integration and native hardening"; W4 = backend platform; each workstream plans on the docs/20–22 pattern as it activates), §16 (P2 "customer app integrates identity + catalogue slices behind existing contracts", P3 "W1 Payment & Confirmation milestone"); docs/24 (canonical domain: §1.2 Participant, §2.2/§2.6 ProgramPriceOption + Amendment A2, §3.4 Booking/Enrolment/PackageEntitlement, §3.5 AttendanceRecord, §13 slice table, §14.B5/B7); docs/32 (Slice-5 closure: certified booking/capacity authority + recorded package-purchase discrepancy + deferred inventory); docs/33 (certified W5 payment core + W5-5 customer contract); docs/04 (approved 32-screen IA), docs/08 (frontend engineering contract), docs/12 (native compatibility), docs/17–22 (closed mock milestones), docs/09 (open decisions incl. §21.7/§21.14/§6/§22).

---

## 1. Customer App as built (reconciled inventory, verified at `3c0bb45`)

**Stack:** Expo SDK 57 / React Native 0.86 / React 19, expo-router (file-based, typed routes), React Context + local state (no Redux/query lib), `StyleSheet` over central Orbit-Indigo tokens (`src/theme/`), Manrope, light-only, scheme `himma`. **Data fetching:** screens call directly-imported MOCK service singletons in `useEffect` — there is NO dependency-injection seam and NO HTTP client anywhere (grep-verified: zero `fetch`/axios/env-URL usage; all imagery is bundled assets; the only external URL is the `https://himma.app/...` share placeholder). **Tests:** 413 Jest cases across 24 files (pure logic + mock-service determinism + structural locks incl. the payment-submission-absence lock); no component-render tests, no Playwright suite. **Localization/RTL:** none (English literals; RTL-hostile physical properties) — consistent with the English-only stage ruling; W7 debt recorded, not W1-RI scope.

**Screens (14 of the approved 32 built):** Home (HMA-004) · Discover (005) · All categories (011) · Category (012) · Activity type (013) · Results (010) · Search (009) · Map (016) · Program details (015) · Provider storefront (014) · Booking selection (017) · Participant (018, eligibility inline = 019) · Summary (020) · Checkout (021, CTA deliberately inert). **Dock destinations `Bookings` / `Saved` / `Profile` exist but are inert (no routes).**

**Per-surface classification (owner §1 vocabulary):**

| Surface | Classification |
|---|---|
| Home, Discover, categories/activity/results, Search, Map, Program details, Provider storefront, Booking selection/participant/summary, Checkout page | **Mock/fixture-backed** (deterministic services behind typed contracts; UI production-approved) |
| Checkout SUBMIT, payment | **UI exists, backend authority missing on the wire by design** — `PaymentSubmitRequest/Result` declared, never invoked (test-locked); the certified real contract now exists server-side (W5-5) |
| Sign-in / onboarding (HMA-002/003) | **Missing required V1 surface** (two decorative "Sign in" affordances only) |
| Bookings tab (006), Booking detail (024), Payment status (022), Confirmation (023) | **Missing required V1 surface** |
| Passes & Memberships (026 "Package or membership detail") + check-in credential UX | **Missing required V1 surface** (only a mock `ActivePlan` card on Home) |
| Profile (008) + Participants (030) | **Missing required V1 surface** |
| Saved (007) | Partially present (in-memory favourites toggle works; no route, no persistence) |
| Credit strip, reviews count, rewards accents, gifts | **Obsolete/deferred UI → HIDE, do not connect** (decorative; credits/gifts/reviews/loyalty are deferred product areas) |
| Cancellation (025), Credits (027), Gifts (028), Referrals (029), Notifications (031), Settings (032 beyond a minimal shell) | **Deferred** (not V1 blockers; §8) |
| REAL API already integrated | **NONE — 0 surfaces.** |

**Mock → real authority matrix (all 23 contract methods are mock-only today):**

| App contract method | Real authority (certified route(s)) | Status |
|---|---|---|
| `catalogue.getAllCategories` | `GET /catalogue/categories` + `/catalogue/activity-types` | REAL EXISTS — adapter only |
| `catalogue.getCategoryPage` / `getActivityTypePage` | compose `/catalogue/*` + `GET /search` (+collections) | REAL EXISTS — client-side composition |
| `search.getSuggestions` / `search` / `getResults` / `countResults` | `GET /search` (closed vocabulary) | REAL EXISTS — adapter + mapping |
| `search.getPreSearchContent` / `addRecentSearch` / `clearRecentSearches` | client-local (recents on device) + taxonomy reads | no backend needed (deliberate) |
| `details.getProgramDetailPage` | `GET /listings/:programId` (+ occurrence display — §12 D-RI-4) | REAL EXISTS (occurrence display gap §4.5) |
| `details.getProviderStorefrontPage` | `GET /providers/:organizationId` + `/providers/:organizationId/listings` | REAL EXISTS — adapter only |
| `homeFeed.getHomeFeed` / `getAreas`; `discoverFeed.*`; `map.getMapView` | client-side composition over `/catalogue/*`, `/search`, own bookings/entitlements | REAL EXISTS for parts; no aggregate endpoint (deliberate — minimum intervention; add server aggregates only if measured performance demands) |
| `schedule.getUpcomingActivity` / `getWeekSchedule` / `getActivePlans` | `GET /customer/bookings` + **S6 entitlement/occurrence reads (§4)** | PARTIAL — entitlement/occurrence authority missing |
| `booking.getBookingOptions` | `GET /listings/:programId` + `GET /customer/programs/:programId/availability` | REAL EXISTS (availability is auth-gated — §12 D-RI-4) |
| `booking.getBookingSummary` | `POST /customer/quotes` | REAL EXISTS — adapter |
| `checkout.getCheckoutPage` | quote + policy snapshot presentation | REAL EXISTS (D-8 policy CONTENT remains a launch prerequisite — §11) |
| *(no method yet)* auth/session/account/participants | `POST /auth/session`, `GET /me`, refresh/logout/step-up | REAL EXISTS **except participant management (§4.1)** |
| *(no method yet)* hold/confirm/initiate/payment status/bookings | `POST /customer/holds`(+release/status), `confirm-free`, `initiate`, `GET /customer/bookings/:id/payment`, `GET /customer/bookings(/:id)` | REAL EXISTS (certified S5-5/W5-5) — new app contracts |
| *(no method yet)* entitlements / check-in / attendance / calendar | **DOES NOT EXIST — S6 prerequisite (§4)** | MISSING backend authority |

---

## 2. Certified backend available to W1-RI (verified route inventory)

Public: `/listings/:programId` · `/providers/:organizationId` (+`/listings`) · `/catalogue/{categories,activity-types,collections,areas}` · `/search` · `/internal/health` · `POST /payments/webhook/<provider>` (Stripe-authenticated). Auth flow: `POST /auth/session` (Cognito access token → Himma session; first login atomically creates user + account + `self` participant) · `GET /auth/csrf` · `POST /auth/refresh` · `POST /auth/password/reset-request`. Authenticated customer: `GET /me` · session management (`/auth/sessions`, logout, logout-all, step-up, identity linking) · the certified S5-5 booking surface (availability · quotes · holds claim/status/release · confirm-free · initiate · booking reads) · the certified W5-5 payment surface (real checkout initiation behind composed payment capability + the converged `GET /customer/bookings/:bookingId/payment` projection). Conventions W1-RI consumes as-is: bearer auth (access token, ID tokens refused), body-field `idempotencyKey` (8–128), not-found-shaped cross-account refusals, typed outcome codes (docs/22 §22.10-compatible), fils-integer money, `Asia/Dubai` server time authority, effective-hold-expiry projections. **No new backend endpoint is invented where these exist.**

---

## 3. The V1 fulfillment model (owner-confirmed) vs the canonical domain

Owner-confirmed V1 product shapes: **(a)** single scheduled session; **(b)** multi-use package (buy once, no upfront date selection, `purchased → used → remaining`); **(c)** limited-use membership (e.g. 8 visits / 30 days); **(d)** unlimited time-based membership/pass (e.g. one month unlimited); **(e)** recurring scheduled program (term/academy; attendance per occurrence; absence ≠ attended). Automatic recurring Stripe billing is NOT V1 (manual renewal; schema stays recurring-billing-compatible per docs/24 §14.B5 — untouched).

**Vocabulary reconciliation (before any new enum):** the certified `program_price_option.kind` set is `dropIn · monthly · term · camp · package · free`. Mapping: (a)=`dropIn` (+`free` for genuinely free offerings; `freeTrial`/`paidTrial` Offers remain provider discounts, never a Himma subscription); (b)=`package` (+`sessions_count` — already certified and publicly served); (e)=`monthly`/`term` cohort enrolment (certified units + D-10-adjacent flow); (c)/(d)= **no certified representation** — `membership` was explicitly reserved as an additive CHECK widening pending docs/24 §14.B7 / docs/09 §21.14 (current ruling "monthly remains the membership representation" predates this owner direction and is now ripe for revision — §12 D-RI-2). Validity windows (30/60/90 days/fixed date/none) and reservation-mode (`reservationRequired` vs `walkIn`) have **no representation anywhere** and are provider/product configuration, not global rules.

---

## 4. Backend V1 gap analysis (the bounded prerequisite inventory)

The certified backend is COMPLETE for auth/catalogue/search/storefront/availability/quote/hold/free-booking/paid-checkout/payment-status/booking-reads. Genuine gaps, each verified against schema + source + structural locks:

**4.1 Customer participant management — GAP (unshipped certified-plan scope).** docs/24 §13 slice "Participants" specified participant CRUD; the executed slices shipped only implicit `self` creation at first login. `participant` supports `kind='child'` + `date_of_birth` (quote eligibility already consumes DOB), but **no route creates/edits/archives a participant and `/me` returns only `self`**. Without it a parent cannot book for a child — a V1 blocker. Bounded addition: customer participant routes (create/edit/archive child; list), one-`self` invariant already structural. No migration expected.

**4.2 Entitlement purchase — GAP (recorded Slice-5 discrepancy, now ripe).** `package_entitlement` exists as structure only (booking-subtype PK, `sessions_total/used`, valueless `expiry_policy`, INSERT-only grants — `sessions_used` is deliberately un-incrementable); **no path reaches it**, because a package sale has no dated capacity unit and the certified commercial spine requires Booking = exactly-one unit + hold, with `payment_intent` composite-FK-bound to that Booking. Packages/passes therefore CANNOT ride the spine unchanged. This is THE S6-0 design decision (§12 D-RI-1): extend the commercial spine so a unit-less entitlement purchase can carry a PriceQuote + PaymentIntent + D-W5-7 economics + the certified W5 checkout/saga unchanged in semantics (options: unit-less Booking subtype vs parallel purchase aggregate anchored into `payment_intent` the way Booking is). The W5 invariants (one live intent per purchase, hold-TTL-as-backstop → replaced by a purchase-window backstop for unit-less sales, compensation on unconfirmable fulfillment) must be preserved, not redesigned.

**4.3 Entitlement/pass domain — GAP.** Required and absent: participant-bound entitlement records (finite `total/used/remaining` AND explicitly-modeled unlimited semantics — never a fake large count); snapshotted validity (days-from-purchase/fixed-date/none — later provider changes never rewrite sold entitlements, the certified quote/policy-snapshot precedent); reservation-mode semantics (`reservationRequired` products book units against the entitlement via the certified hold flow at zero incremental price; `walkIn` products redeem without a preselected occurrence); customer entitlement reads ("Passes & Memberships"). Participant ownership must be structural (composite FKs on the certified `participant(id, account_id)` spine — cross-account/cross-participant substitution impossible, the 0015 precedent).

**4.4 Redemption credential + attendance — GAP (tables structurally FORBIDDEN until their owning slice).** `attendance_record` and any `*redemption*` table (besides `trial_redemption`) are lock-forbidden; `attendance.manage`/`roster.view` provider capabilities are RESERVED, awaiting exactly this slice. Required per owner §8–13: short-lived one-time redemption credential (default TTL 10 min, server-configurable; numeric code first, representable as QR later without redesign — the credential is a domain row, the rendering is presentation); generation consumes nothing; regeneration after expiry; at most one live credential per redemption intent; single-use forever after successful validation; concurrent double-redeem consumes exactly one (PostgreSQL authority, the S5-2 locking discipline); scheduled check-in window (~start−60 min → start+60 min, configurable) vs flexible-entitlement generation while valid; provider validation routes gated by org/branch/capability scope (owner/org-manager/branch-manager/front-desk/coach — activating the reserved capabilities); atomic attendance + consumption; append-only attendance history; V1 auto-consumption ONLY via successful provider validation (no-show policies deferred). AttendanceRecord's canonical §3.5 shape is the starting point; the credential entity is NEW canonical vocabulary → docs/24 amendment at S6-0.

**4.5 Occurrence/calendar reads — GAP (read-side only).** `session` rows carry real instants; `camp_week` carries date ranges; **cohort meeting patterns are NOT materialized into occurrences** (pattern = `enrolment_cohort_schedule` → `recurring_schedule` weekdays/times/exceptions ∩ cohort range). Per owner §14 (prefer deriving from authoritative data): a customer calendar read derives occurrences from Booking→unit joins + cohort-pattern expansion at read time — NO duplicate calendar truth, no new occurrence tables. Unscheduled entitlements appear under Passes & Memberships, never as fake calendar entries. Also here: guest-visible occurrence display on program details (docs/32 recorded "public availability exposure" as deferred/open — §12 D-RI-4).

**4.6 Runnable server composition — GAP (operational, bounded).** `buildApp` is composed ONLY by tests: backend has no entrypoint/`start` script. W1-RI needs a dev-server composition (env-driven `buildApp` + deterministic-or-Cognito identity adapters + deterministic payment provider + checkout URLs + seeded dev data). Bounded, no schema, no new authority.

**Explicitly NOT gaps (already certified):** paid checkout + processing/compensation truth (W5); free/zero-price flow + D-10; availability projections; cross-account shaping; idempotency; commission economics (12% = an `organization_commission_term` row at `1200` bps per launch provider — operational data, no code change, customer-invisible).

---

## 5. Prerequisite backend workstream: W4 Backend Slice 6 (S6) — Fulfillment, Entitlements & Attendance

Per docs/23 §3, backend work activates as a W4 slice with its own plan on the docs/20–22 pattern. The executed convention (docs/26/27/28/32 = Slices 2–5) makes this **Backend Slice 6 (S6)** — no new workstream name invented. Gaps 4.2–4.5 (+4.1, see §7 sequencing) are S6 scope; S6-0 authors `docs/35` (spec + docs/24 amendment + owner rulings D-RI-1/2 and ratification of the §8–9 credential defaults) before any S6 code. S6 must preserve untouched: the frozen Slice-5 capacity/booking authority, the certified W5 payment core (checkout/saga/economics consumed, never duplicated), D-10, and every structural lock (amended only by the owning-slice pattern). Expected magnitude: one migration family (entitlement purchase anchor + entitlement + redemption credential + attendance_record + vocabulary widenings), domain services (purchase→entitlement creation through the certified checkout; credential issue/validate/redeem; attendance), provider routes (validation/roster under activated capabilities), customer routes (entitlements read, credential issue, calendar read), full RED→GREEN concurrency proofs (double-redeem storm, TTL races, finite-balance floor, credential single-use).

**Provider-side consequence (recorded, not planned here):** providers must configure validity/reservation-mode and staff must validate check-ins → one bounded W2 Provider Portal slice ("check-in & product-config", after S6) and later Admin oversight reads. The portal slice gates the end-to-end package/membership journey, not the customer-app build.

---

## 6. Customer account IA + calendar (minimum intervention)

The approved IA already contains the owner's structure: **Bookings (HMA-006)** = Upcoming / Calendar-agenda / Past + "package or membership status"; **Package/membership detail (HMA-026)** = the Passes & Memberships detail (+ check-in credential UX added as a bounded extension of this approved screen); **Profile (HMA-008)** + **Participants (HMA-030)** = account hub. No redesign — W1-RI builds the missing approved screens and wires the built ones. Calendar = the §4.5 derived read across providers (sessions at instants; camps as date-span entries; cohort enrolments expanded from patterns; scheduled entitlement uses as they are booked). Redemption UX truth (owner §16): after provider validation the app re-reads server truth (`Checked in`, updated remaining/attendance) — never optimistic decrement; the existing payment-status polling pattern (`processing` → `confirmed`) is the precedent.

---

## 7. Proposed implementation sequence (each slice: implement → certify → commit → STOP → owner review)

| # | Slice | Scope (bounded) | Gate / depends |
|---|---|---|---|
| **W1-RI-0** | THIS PLAN | owner approval + §12 rulings | — |
| **RI-1** | **Integration foundation + auth + account** | The service seam (contract-conformant real-API adapters behind an injection boundary — screens keep their contracts, mock stays for tests/QA); typed HTTP client (bearer/refresh/typed outcomes/idempotency); env config; **bounded backend companions (identified prerequisite gaps): dev-server composition (§4.6) + customer participant management routes (§4.1)**; sign-in/onboarding screens (HMA-002/003) on the certified `POST /auth/session` flow (email/password via Cognito — D-RI-3); Profile shell (HMA-008) + Participants (HMA-030); guest browsing preserved (auth only at participants/booking/account per owner §17) | plan approved |
| **RI-2** | **Discovery on real APIs** | catalogue/search/results/details/storefront/map/home/discover feeds onto the §1 matrix authorities; contract-parity tests (mock vs real adapter shape); hide-not-connect sweep (credit strip, review counts, gifts affordances); Saved: local persistence + route (no backend) | RI-1 |
| **RI-3** | **Booking + paid/free checkout on real APIs** | availability→quote→hold (visible authoritative 10-min countdown; truthful expiry, no silent re-reserve)→confirm-free / initiate→Stripe-hosted redirect (expo-web-browser + `himma://` return as navigation only)→payment-status polling (processing/confirmed/compensated vocabulary — copy for compensation states fulfils the recorded W1 requirement)→confirmation (HMA-023)→Bookings tab v1 (HMA-006 upcoming/past)+Booking detail (HMA-024)+Payment status (HMA-022) | RI-2 (runs against dev payment composition; D-W5-6 unaffected) |
| **S6-0** | **docs/35 — S6 spec + docs/24 amendment** | §4.2–4.5 model + rulings D-RI-1/2 + credential-semantics ratification | may start in parallel any time after W1-RI-0 |
| **S6-1…n** | **S6 implementation** (its own plan's slicing; expect 2–3 slices: schema+purchase→entitlement; redemption/attendance+provider routes; customer reads/calendar) | S6-0 |
| **W2-13** | **Provider Portal check-in + product-config slice** | staff validation UI on the S6 provider routes; validity/reservation-mode editing | S6 |
| **RI-4** | **Passes & Memberships + check-in UX** | package/membership purchase flows (certified checkout over the S6 anchor); entitlement list/detail (HMA-026); credential generation (TTL countdown display only — server truth); post-redemption truth refresh; attendance history | S6 (+W2-13 for E2E) |
| **RI-5** | **Calendar + My Himma completion** | unified calendar (§6); home real-schedule surfaces (upcoming/week/plans on real reads); Profile completion (minimal Settings/help/privacy shell — HMA-032 minimal) | RI-3 + S6 reads |
| **RI-6** | **Production-like E2E hardening/closeout** | Playwright journeys (§8 acceptance set) + mobile viewports; native validation pass (docs/12 three levels; iOS Simulator); cross-account security regression at the app layer; performance/error/empty-state sweep; closeout audit (S5-6/W5-6 pattern) | all above |

Rationale: RI-1→RI-3 deliver the complete certified-backend value (auth→discovery→paid booking) with zero dependence on S6; S6/W2-13 proceed as the only new backend/portal authority; RI-4/5 consume it; nothing is built twice. Larger vertical slices per owner efficiency guidance; every authority-bearing milestone keeps the commit→STOP→review gate.

## 8. V1 / deferred matrix + final acceptance

**V1:** everything in §7. **Deferred (hide, don't connect; owners recorded):** automatic recurring billing (B5) · self-service cancellation/refunds (§18 #14 + refunds slice) · automatic no-show charging (provider policy capability) · disruption execution (D-5) · waitlists (§21.4) · reviews/ratings · loyalty/credits/gifts/referrals · medical/allergy sharing (counsel; ParticipantLegalProfile) · gender eligibility (no server rule exists) · Stripe Connect/payouts · Admin commission mutations (D-W3-5) · native PaymentSheet (D-W5-2 fast-follow) · Arabic/RTL implementation (W7; no new RTL-hostile surfaces in new screens — logical properties required) · customer web (§18 #8, open).

**Final production-like acceptance (RI-6, Playwright + native pass):** (1) paid single-session journey: browse→sign-in→participant→quote→hold(countdown)→hosted checkout→processing→confirmed→My Bookings/detail; (2) finite package journey: purchase→Passes→generate code→provider validates (portal)→remaining decrements→attendance visible; (3) time-membership journey: purchase→active pass→recurring calendar occurrences→check-in→attendance history; (4) free/zero-price journey: atomic non-payment confirmation (D-10 intact); (5) cross-account/cross-participant security probes around every journey; (6) truthful failure states (hold expiry, payment processing, compensation vocabulary, offline/error). All app-side money displays are provider list prices only; commission/economics never on the wire (already server-pinned).

## 9. Testing strategy

Per slice: Jest for adapters/pure logic (existing 413-case suite preserved; contract-parity suites pin mock↔real shape equivalence); backend companions certified on real PostgreSQL with the standing conventions (full backend Jest + tsc + ESLint + `db:verify` + route/security locks); S6 concurrency proofs RED→GREEN on real PostgreSQL (double-redeem, credential single-use, balance floor, purchase storms) on the S5-2 harness pattern; Playwright journey suites (introduced at RI-3, completed RI-6) at 390×844-first plus tablet/web-preview viewports; docs/12 native validation levels reported per screen (native validated only with a real Simulator/device pass); security tests at both layers (backend certified suites re-run + app-level cross-account probes).

## 10. Explicitly NOT in W1-RI (carried gates — do not weaken)

Production payment launch prerequisites stay exactly as recorded at W5 closure: D-W5-6 real Stripe certification · live activation · UAE VAT/principal-agent/invoicing · production commission-term administration · W6 wind-down runner · gateway-fee decision. Production-like ≠ production-live payments: W1-RI proves the complete app against certified contracts with deterministic/test payment composition; real-Stripe smoke remains separately reported. Also carried: D-8 cancellation-policy template CONTENT (production confirmation fail-closed until owner-approved content exists) · production Cognito pool + real-pool smoke (docs/26 §14.E′) · content-safety/storage operational items (W3) · Apple/Google sign-in operational setup (structurally supported; not a blocker per owner §17).

## 11. Operational/launch prerequisites NEW to this direction (recorded)

Launch commission terms seeded at `1200 bps` per launch provider (operational data via the recorded commission-administration prerequisite — no code) · dev/staging Cognito pool or documented deterministic dev-auth composition (RI-1) · dev payment composition (deterministic provider + checkout URLs; later Stripe TEST keys per D-W5-6) · seeded realistic dev catalogue/schedule data (mock fixtures graduate to seeds — docs/24 §13 slice-1 intent) · production checkout success/cancel deep-link URLs (with RI-3 shape, configured at launch) · S6 credential TTL/check-in-window configuration defaults (10 min / ±60 min).

## 12. Owner decisions genuinely required (none resolved silently)

| ID | Question | Options / recommendation | Blocks |
|---|---|---|---|
| **D-RI-1** | **Entitlement purchase commercial anchor** (§4.2): how unit-less package/membership purchases join the certified quote→payment→saga spine | (a) unit-less Booking variant (relax exactly-one-unit for entitlement kinds; hold-backstop replaced by a purchase window); (b) parallel `entitlement purchase` aggregate anchored into `payment_intent` beside Booking (Booking stays untouched). **Recommend (b)** — preserves every frozen Slice-5 invariant verbatim; W5 orchestration gains one bounded alternative T1. Final ruling at S6-0 with the full schema design | S6-1+ |
| **D-RI-2** | **Product vocabulary widening** (§3; re-opens docs/09 §21.14 / §14.B7 under the new direction): represent limited/unlimited time passes | **Recommend:** additive `membership` price-option kind + product config columns (validity days/fixed-date/none · finite `uses_count?` · `reservation_mode`) snapshotted into sold entitlements; `monthly`/`term` stay the recurring-program kinds; no customer-visible vocabulary change | S6-0/S6-1; W2-13 editor |
| **D-RI-3** | **V1 sign-in methods** | **Recommend:** email/password via Cognito at RI-1 (adapter certified; reset flow exists); Apple/Google = structurally-ready operational fast-follow (entitlements/OAuth setup), never blocking integration | RI-1 |
| **D-RI-4** | **Guest-visible occurrence display** (docs/32 recorded "public availability exposure" open): may program details show real session times/availability bands pre-login? | (a) bounded PUBLIC occurrence/availability projection (times + coarse band, never counters) — **recommended**: choosing a class time is discovery, and the binding default is browse-without-login; (b) schedule orientation only until sign-in. | RI-2 (a→one bounded backend read) |
| **D-RI-5** | **Compensation/processing customer copy** (recorded W1 requirement from W5-5) | approve the RI-3 copy set for `processing`/`compensationPending`/`compensated` at the RI-3 review (machine states are certified; only words are open) | RI-3 closeout |

Adopted as planning defaults needing only S6-0 ratification (owner already directed): credential TTL 10 min · scheduled check-in window ±60 min · walk-in generation while valid · numeric-code-first/QR-ready · validation authority = provider staff per §4.4 scope · no-show consumption deferred.

## 13. Definition of done — met by this planning task

Complete as-built inventory + classification (§1) · mock→real authority matrix (§1) · certified backend contract map (§2) · fulfillment-model reconciliation against canonical vocabulary (§3) · bounded backend gap analysis with structural-lock verification (§4) · entitlement/attendance/redemption/credential model reconciliation (§4.3–4.4) · calendar authority design (§4.5/§6) · account IA mapping with minimum intervention (§6) · sequenced slice plan with acceptance gates (§7–§8) · testing strategy (§9) · carried + new operational prerequisites (§10–§11) · genuine owner decisions only (§12) · **no application/schema/frontend code changed**. Next step after owner approval + rulings: **RI-1 (and S6-0 in parallel) — and not before.**
