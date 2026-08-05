# 23 — Production Platform Rebaseline (Master Plan)

Status: **draft for product-owner approval — binding on the whole platform once approved.** Prepared 2026-08-05 after full re-analysis of the repository, docs/01–22, HANDOFF.md, the git history, and the implemented customer application (through Commit 16, `31f11b9`).

**Amendment A1 (2026-08-05, documentation-only corrective review).** The first draft contained production-critical gaps, corrected in place before approval: a server-side capacity-hold model (§5, §6.4) so customers can never be charged without guaranteed capacity; an auditable multi-entity payment model replacing the single Payment record (§5, §6.6); removal of the universal super-admin, strict separation of technical/business powers, enforced dual control, and full provider role granularity (§7); the first real device pass moved from P2 to P0/P1 (§14, §16); backend vertical slices starting after canonical-model + first-workflow approval instead of after all portal mocks (§4, §16); explicit owner decisions on customer web at launch and English-only versus bilingual launch (§18), with a full Arabic/RTL production work package (§3.1) connected to the launch gates (§15); bulk catalogue/scheduling tooling for the portals (§8.5); service-specific recovery objectives replacing the single platform RPO/RTO (§10.11); correctness- and latency-based scale gates beyond account counts (§11.1); and a provider design-partner discovery step gating final portal approval (§8.6, §16). The superseded first-draft positions are recorded in the contradiction register (C16).

**What this document changes.** The owner has clarified that Himma is the **final production marketplace** — not a prototype, not a disposable MVP, not a customer-app-only build. This document rebaselines the roadmap accordingly. It does not restart anything: every approved milestone, decision, and screen stands. It re-anchors them inside a platform-wide plan in which the customer app is one of three frontends, and the backend is one of six workstreams.

**What this document does not do.** It writes no application code, changes no approved screen, and does not claim the current frontend is production-ready because its tests pass (§2 separates verified from inferred). It does not lift any standing prohibition: **real payment submission remains prohibited until all required legal acknowledgments, server-side validations, payment integration, and operational controls exist** (§19, docs/09 §22.7/§22.11).

---

## 1. The rebaselined strategy: frontend-first, redefined

The frontend-first strategy is preserved — it has demonstrably worked (three approved customer milestones with zero redesign churn). What changes is its scope:

> **Frontend-first now means: the final customer application, the provider management portal, and the admin/operations portal are all specified, mock-driven, and owner-approved before backend implementation is considered complete.**

Rules:

1. The **customer app** continues its milestone cadence (checkout finishes first — §16).
2. The **provider portal** and **admin portal** get the same treatment the customer app received: written specs, deterministic mock services behind typed contracts, owner approval per surface, automated QA. They are responsive web applications (docs/03 §7–8), so the docs/12 native rules do not apply to them; an equivalent web-quality contract (§8.4) does.
3. The **backend is implemented against all three approved frontends.** Backend implementation cannot be declared complete while any approved workflow in any of the three applications lacks a real API behind its mock contract. Vertical backend slices may land earlier (§4), but "backend done" is defined by three-frontend coverage.
4. The **canonical domain model (§5) becomes the single vocabulary** for all future contracts. Existing customer mock contracts are conforming subsets; new contracts must not invent parallel nouns.
5. Nothing already approved is reopened without an owner decision. Where the domain model extends an existing frontend type (e.g. `Session` gaining capacity semantics), the extension lands behind the existing service contract, not as a screen redesign.

---

## 2. Verified versus inferred (honesty ledger)

This rebaseline is explicit about epistemic status. "Tests pass" is evidence of behavioral consistency on **Expo web at two viewport widths** — nothing more.

**Verified (evidence exists in-repo):**
- Deterministic behavior of every implemented customer flow on Expo web at 390×844 and 360×780: ~690 Playwright checks across 9 suites, 353 unit tests, zero console errors, no horizontal overflow, screenshot evidence in `artifacts/` (~24 MB).
- Copy honesty invariants (no Total/VAT/fee/reservation/acceptance claims) — enforced by tests, verified on every run.
- TypeScript strictness, zero-warning lint, expo-doctor 20/20, dependency advisory state (docs/13).
- Structural accessibility on web: roles, aria states, reading order, labels — asserted in DOM.

**Inferred, plausible, unverified:**
- All native behavior. **No surface has ever rendered on an iOS or Android device or simulator.** Safe areas on real notches, keyboard behavior, swipe-back, carousel gesture arbitration, Dynamic Type at scale, press feel, image decode performance — all designed-for per docs/12, none observed.
- Real assistive-technology experience (VoiceOver/TalkBack) — aria structure is verified; the spoken experience is not.
- Performance beyond a 36-program catalogue. List virtualization needs are known-unknowns at production supply.
- Every service contract's fitness against a real backend: contracts were designed for replaceability, but no contract has ever been implemented twice.

**Not merely unverified — nonexistent:** backend, database, authentication, payments, real availability, provider portal, admin portal, legal text, final branding (the iOS icon still composes the Expo logo), Arabic/RTL, monitoring, support tooling. §15's gates hold "live" hostage to these.

---

## 3. Workstreams

Six workstreams. Each gets its own planning documents on the docs/20–22 pattern (spec → owner decisions → staged commits → closeout) as it activates.

| # | Workstream | Contents | Current state |
|---|---|---|---|
| W1 | **Customer application** | The Expo iOS/Android app: remaining milestones (checkout close-out, Bookings/Saved/Profile, onboarding/auth screens, confirmation, cancellations, credits/gifts/referrals, notifications UI, settings/privacy), then API integration and native hardening | ~14 of 32 screens shipped, mock-driven, 3 dock tabs inert |
| W2 | **Provider portal** | Responsive web app for provider organizations: onboarding, storefront, branches, staff, programs, schedules, capacity, pricing, offers, bookings, attendance, refund actions, reports (§8) | Not started; docs/03 §7 sketch only |
| W3 | **Admin/operations portal** | Internal web app: provider verification, catalogue/taxonomy, content moderation, customers, bookings, payments/refunds oversight, credits, support, finance, roles, audit (§9) | Not started; docs/03 §8 sketch only |
| W4 | **Backend platform** | The production API and domain services implementing §5–§7 on the §10 architecture; owns all authority the frontends currently mock | Not started; contracts anticipate it |
| W5 | **Payments & integrations** | Payment gateway (cards + Apple Pay/Google Pay), refunds, provider payouts, webhooks; auth identity providers (Apple/Google sign-in); push notifications; maps; calendar export; email/SMS | Not started; UI readiness per docs/12 §9 |
| W6 | **Infrastructure & operations** | Environments, CI/CD, IaC, observability, backups/DR, security operations, support runbooks, on-call, store release management | Not started beyond local CI-equivalent checks |
| W7 | **Localization — Arabic/RTL** (cross-cutting work package, §3.1) | Localization architecture, Arabic content pipeline, RTL layouts, bilingual search, typography, QA — across all three frontends and provider content | Not started; English-only with localization-ready string discipline (docs/08 §13) |

### 3.1 Arabic/RTL production work package (W7)

Arabic is not a string-swap in a UAE consumer product; it is a work package with architecture consequences that get more expensive the longer they are deferred. Scope (activation timing set by owner decision §18 — launch-bilingual versus fast-follow — but the *architecture* items are required regardless, because retrofit is the expensive path):

1. **Localization architecture (required now-ish, all frontends):** central string catalogue with ICU plural/format support replacing ad-hoc English literals; locale-aware number/currency/date formatting through the existing single seam (`src/utils/price.ts` precedent); no concatenated sentence fragments; pseudo-locale build for hardcoded-string detection in CI.
2. **RTL layouts:** logical (start/end) layout properties across all three frontends; RN `I18nManager` RTL pass for the customer app; mirrored navigation, carousels, progress and back affordances; icon mirroring policy; per-screen RTL QA snapshots added to the existing screenshot matrices.
3. **Typography:** Arabic typeface selection paired with the brand work (§18 decision 6 — the brand engagement must deliver a bilingual type system); line-height/metric tolerance rules per docs/12 §4 extended to Arabic script.
4. **Provider content:** bilingual field strategy on Program/Organization (title/description ar+en), portal editing UX, §8.5 import template columns, translation workflow ownership (provider-supplied vs Himma-managed vs machine-assisted+review — owner decision), and moderation of Arabic content (AD-14 capability).
5. **Search:** Arabic analyzers (normalization, diacritics), the existing synonym architecture's `ar` arrays populated (docs/14 §3.4 anticipated exactly this), bilingual query handling, transliteration heuristics for activity names.
6. **Notifications/legal:** bilingual templates; counsel decides Arabic legal-text requirements (§13).
7. **QA:** RTL/Arabic rows in every QA suite; native RTL device pass items added to §14; Arabic-speaking review before any bilingual launch.

**Gate connection (§15):** if the owner chooses bilingual launch, G9 applies in full. If English-first launch is chosen, items 1–2 (architecture + logical layouts) still gate G1 for new surfaces — building more RTL-hostile screens is the one option this plan forecloses — and G9 converts to the fast-follow release gate.

---

## 4. Dependency graph

```text
DECIDE FIRST (owner, §18):            scale tiers · VAT/fee model · payment gateway ·
                                      provider commercial terms · legal counsel engagement ·
                                      hosting/region (data residency) · brand timing

     ┌────────────────────────────────────────────────────────────────────┐
     │ §5 Canonical domain model + §6 state machines + §7 authorization   │  ← gates everything below
     └────────────────────────────────────────────────────────────────────┘
        │                │                 │                  │
        ▼                ▼                 ▼                  ▼
  W1 customer      W2 provider        W3 admin          W4 backend schema &
  (continues       portal spec +      portal spec +     API contract design
  in parallel      mock build         mock build        (from §5–§7; no code
  now — §16)       (parallel to W1)   (after W2 spec —  until model approved)
        │                │            shares patterns)        │
        │                │                 │                   │
        │                │                 │                   ▼
        │                │                 │        W4 vertical slices start on
        │                │                 │        model approval + FIRST approved
        │                │                 │        workflows (identity → catalogue →
        │                │                 │        booking/capacity → payments W5
        │                │                 │        → payouts/refunds) — slices land
        │                │                 │        per approved workflow; they do
        │                │                 │        NOT wait for all portal mocks
        │                │                 │                   ▲
        │                │                 │            W6 environments/CI/CD
        │                │                 │            (parallel, early)
        │                └──────┬──────────┘
        │                       ▼
        │         Portal mock approvals continue per surface
        │         (design-partner walkthroughs §8.6 gate the
        │          FINAL provider-portal approval + provider-API
        │          contract freeze — later slices track them)
        │                       │
        └───────────┬───────────┘
                    ▼
        Frontend API integration (all three apps, slice by slice,
        starting as soon as each slice + its approved workflow exist)
                    ▼
        Remaining native validation (§14 — FIRST device pass already
        ran in P0/P1 over existing screens) + load/security/reliability
        gates (§15, incl. §11.1 correctness gates)
                    ▼
        LAUNCH (gated, §15)
```

**Can run in parallel now:** W1 checkout completion (§16) · W2 provider-portal specification + design-partner recruitment (§8.6) · §5–§7 modeling · W6 environment/CI groundwork · **native-validation environment procurement + first device pass (§14)** · legal engagement · brand engagement.
**Must be decided first (blocking):** the §18 owner decisions — every one of them blocks a workstream noted there; the customer-web and language decisions (§18 items 8–9) shape W1/W7 scope directly.
**Hard sequencing:** no backend code before the §5–§7 model is owner-approved — but backend slices then start against the **first** approved workflows (customer flows are already approved today) rather than waiting for the full portal mock set; provider-API contracts freeze only after §8.6 design-partner validation; no payment integration before legal text and gateway selection; no launch before every §15 gate.

---

## 5. Canonical shared domain model

The single vocabulary for all workstreams. Entities, key fields, and ownership. (Frontend mock types are conforming subsets; the backend schema implements this model on §10's PostgreSQL.)

| Entity | Essentials | Notes |
|---|---|---|
| **Organization** (provider) | id, legal name, trade name, verification status (§6.1), commercial terms ref, default policies, created/suspended timestamps | The commercial counterparty. What customers see as "provider". |
| **Branch** | org id, label, area, geo point, address, opening hours, facilities, active flag | Customer app already models branch display (docs/20 §8). |
| **StaffMember / StaffRole** | user id, org id, branch scope (all or subset), role (§7), invitation state | Provider-portal identities. |
| **Category / ActivityType** | taxonomy per docs/15 §2–3 — admin-owned, versioned | Existing 12-category taxonomy stands. |
| **Program** (listing) | org id, branch id(s), activity type, title, description, media, eligibility (below), price model, policies ref, listing state (§6.2) | The bookable offering. Current 7 `PriceModel` kinds are the launch subset; `membership` and weekly kinds are model-ready extensions (owner decision). |
| **RecurringSchedule** | program id, weekday/time pattern, timezone (Asia/Dubai), effective range, exceptions | Replaces the mock `scheduleLabel` derivation as authority. |
| **Session** (occurrence) | program id, schedule id?, branch id, start/end datetime, capacity, booked count, session state (§6.3), per-session eligibility override? | Capacity truth lives here, guarded by DB constraints (§10.2). |
| **CampWeek** | program id, date range, daily time, capacity | Week-granularity bookable unit (docs/09 §21.7). |
| **Customer / Account** | id, auth identities (Apple/Google/email), contact, notification prefs, consent records, status | One adult account per docs/02 §1. |
| **Participant** | account id, kind (self/child), name, date of birth, interests, accessibility prefs; child-specific legal fields **pending counsel** (docs/02 §5) | Age computed server-side against session date, not "today". |
| **Eligibility** | minimumAge, maximumAge?, allAges, genderEligibility (men/ladies/mixed), skillLevel, notes | Owner-final model (docs/05 §7); attaches to program, overridable per session. |
| **PriceModel / PriceQuote** | catalogue price per kind; **PriceQuote** = server-computed breakdown (base, discount, fee, tax, credit lines) with quote id + expiry | The quote is what checkout displays and what payment references — the frontend never computes money (docs/09 §22.4–5 become quote rules). |
| **CapacityHold** (InventoryReservation) | id, session/campweek ref, booking-draft ref, account id, quantity (1 now), state (§6.4), created at, expires at (TTL), consumed-by booking id? | The server-side reservation that makes paying safe: payment may only be captured against an `active` hold, and confirmation consumes the hold and the capacity **in one transaction** (§6.4, §10.2). |
| **Booking** | id, account id, participant id, program id, option kind, session/campweek/enrolment ref, quote ref, hold ref, state (§6.5), reference code, timestamps, audit trail | One participant per booking now; schema allows a booking group later (docs/09 §21.2). |
| **Enrolment** | booking subtype for monthly/term: billing anchor, cadence, renewal policy (owner-open, docs/09 §6) | |
| **PaymentIntent** | booking id, quote ref, hold ref, amount, currency (AED), state (§6.6), idempotency key, expiry | One per checkout confirmation attempt-series; the customer-facing "payment" object. |
| **PaymentAttempt** | intent id, sequence no, method, gateway ref, state (§6.6), failure code?, 3-DS data ref | Append-only — every retry is a new attempt; attempts are never mutated after terminal state. |
| **PaymentTransaction** | attempt id, kind (authorization/capture/refund/reversal/adjustment), amount, gateway transaction id, posted at | **Append-only financial ledger** — the auditable money history; corrections are compensating entries, never edits. |
| **GatewayEvent** | raw webhook payload digest, signature-verified flag, gateway event id (unique — replay-safe), received at, processing state, linked attempt/transaction | Append-only inbox; processing is idempotent by gateway event id. |
| **Refund** | originating payment transaction ref, booking id, amount, destination (original method / marketplace credit), reason, state (§6.7), **initiated-by actor, approved-by actor (must differ — §7)**, resulting refund transaction ref | |
| **ReconciliationEvent** | run id, scope (day/gateway), expected vs observed diffs, resolution state, actor | Daily reconciliation output; unresolved diffs alert finance (§13). |
| **CreditLedgerEntry** | account id, class (refund/promo/referral/gift), amount, direction, expiry policy ref, booking ref? | Append-only ledger; balance is a projection (docs/09 §8). |
| **Payout** | org id, period, gross, commission, adjustments, net, state (§6.8), statement ref | Provider settlement. |
| **VerificationCase** | org id, submitted documents, checklist, state, reviewing admin, decision notes | Admin-owned (§9). |
| **SupportCase** | reporter (customer/provider), subject refs, state, assignee, thread | |
| **Notification** | recipient, channel (push/email/SMS/in-app), template, payload, delivery state | |
| **AuditEvent** | actor (user/system), action, entity ref, before/after digest, timestamp, request id | Append-only; every state transition in §6 emits one. |

Cross-cutting model rules: all money in fils (integer minor units), AED only at launch; all timestamps UTC with Asia/Dubai presentation; all ids opaque and non-enumerable; soft-delete only where legally permitted, with audit; every table carries created/updated/actor columns.

---

## 6. Lifecycle state machines

Authoritative states and the only valid transitions. Anything not listed is invalid and must be rejected server-side (and must never be faked client-side).

**6.1 Provider organization**
`draft → submitted → in_review → verified → live` · `in_review → rejected (→ submitted on resubmit)` · `live ↔ suspended (admin)` · `live|suspended → offboarded`. Only `live` orgs appear in the customer catalogue.

**6.2 Listing (program)**
`draft → submitted → in_review → approved → published` · `in_review → changes_requested (→ submitted)` · `published ↔ paused (provider)` · `published|paused → archived`. Edits to a published listing re-enter review only for admin-designated sensitive fields (price, eligibility, safety copy); others hot-publish. Only `published` listings are searchable.

**6.3 Session**
`scheduled → open → full (auto, capacity) → open (on cancellation)` · `open|full → closed (registration cutoff)` · `scheduled|open|full → cancelled_by_provider` · `closed → completed (after end time)`. Capacity changes must transition state atomically with the booked count (§10.2).

**6.4 Capacity hold (InventoryReservation)**
`created (atomically decrements available capacity, TTL started) → active` · `active → consumed (atomic with booking confirmation — same DB transaction writes hold=consumed, booking=confirmed, booked_count final)` · `active → expired (TTL lapse, capacity released) | released (customer abandons / payment terminally fails, capacity released)`. Rules: a hold is created when the customer commits to pay (checkout confirmation begins), **before** any charge; **payment capture is only permitted against an `active` hold** (a lapsed hold aborts the attempt pre-charge, or triggers an automatic same-amount reversal in the §12.4 race window — the customer is never left charged without capacity); hold creation fails fast with `sessionFull` when no capacity remains (§12.3); expiry/release restore capacity atomically; holds are short-TTL (minutes, tuned per gateway flow) and never presented to customers as "reserved" beyond the truthful in-checkout window. This is the mechanism that closes the pay-without-capacity gap: capacity is guaranteed for exactly the interval money can move, and both are settled in one transaction.

**6.5 Booking**
`draft (client-only, never persisted) → pending_payment (hold active, intent open) → confirmed (hold consumed)` · `pending_payment → expired (hold/quote TTL) | payment_failed (→ pending_payment on retry with a fresh or still-active hold)` · `confirmed → cancelled_by_customer | cancelled_by_provider | completed | no_show` · free bookings: `draft → confirmed` via the same hold-consumption transaction, no payment (server-confirmed, still never client-claimed). `confirmed` is the only state the customer app may ever call "booked".

**6.6 Payment (intent → attempt → transaction)**
- **PaymentIntent:** `created → in_progress → succeeded | failed | expired | cancelled`. One intent per checkout confirmation; idempotency-keyed so a retried request rejoins the same intent.
- **PaymentAttempt:** `started → requires_action (3-DS) → started` · `started → authorized → captured` · `started|authorized → declined | errored` (terminal per attempt; a retry is a **new** attempt under the same intent; authorized-not-captured attempts are voided by a reversal transaction).
- **PaymentTransaction:** append-only postings (authorization, capture, refund, reversal, adjustment) — no state machine, no edits; the sum of postings is the financial truth.
- **GatewayEvent:** `received → verified → processed | quarantined (signature/replay failure, alerting)`; processing is idempotent by gateway event id; webhooks are authoritative — intent/attempt states converge to them via reconciliation, never the reverse.

**6.7 Cancellation & refund**
Cancellation request evaluates the booking's policy snapshot (frozen at confirmation): `requested → policy_evaluated → {refund_due(amount) | no_refund}` · refund: `initiated (support/ops actor) → approved (finance actor — must be a different principal, enforced server-side, §7) → processing → completed | failed (→ approved, alerting)`; completion posts a refund PaymentTransaction; destination original-method or marketplace credit per policy/owner rules (docs/09 §7 remains owner-open on templates).

**6.8 Payout**
`accrued (per completed booking) → statement_drafted (period close) → approved (finance role, different actor than drafter — enforced server-side) → processing → paid` · `processing → failed (→ approved, alerting)` · adjustments (refund clawbacks) post to the next statement as append-only entries.

---

## 7. Server-side authorization model

All authorization is enforced server-side per request; client UI state is convenience only. Model: role-based with organization/branch scoping, deny-by-default.

| Principal | Scope | Can | Cannot |
|---|---|---|---|
| **Customer** | own account | manage own profile/participants, browse public catalogue, book/pay for own participants, view/cancel own bookings, own credits/gifts, own support cases | see other customers, any provider internals, any admin surface |
| **Guest** | none | browse public catalogue only (docs/02 §2) | any account-scoped action |
| **Provider: Owner** | their org (all branches) | everything Org manager can, plus staff role management, commercial/payout bank settings, offboarding request | other orgs; admin functions; editing platform taxonomy |
| **Provider: Org manager** | their org (all branches) | listings, schedules, sessions, capacity, offers, bookings view, attendance oversight, provider-initiated cancellations, org-wide reports, bulk import (§8.5) | staff role grants, payout bank details |
| **Provider: Branch manager** | assigned branch(es) | the Org-manager set scoped to their branch(es) | org-wide settings, other branches, bank details |
| **Provider: Listings editor / Scheduler** | org or assigned branches | create/edit listings and schedules, submit for review, media, bulk import previews | publishing overrides, bookings PII, reports, finance |
| **Provider: Coach / Instructor** | own assigned sessions | roster view (minimal PII: first name + age band), attendance marking for own sessions | any other session, pricing, listings, reports, exports |
| **Provider: Front-desk** | assigned branch(es) | today's sessions, attendance marking, booking lookup (minimal PII: name + age band + booking ref) | pricing, listings, reports, exports, payout data |
| **Provider: Finance** | their org | statements, payout history, refund impact reports | listing/schedule mutation |
| **Admin: Operations** | platform, business ops | verification cases, listing review, content moderation, taxonomy, provider suspension | payment/refund execution, payouts, role grants, platform configuration |
| **Admin: Support** | platform, read-heavy | customer/booking lookup, support cases, goodwill credit within a capped budget, **initiating** refunds | **approving/executing** refunds, verification decisions, payouts, role grants |
| **Admin: Finance** | platform, financial | **approving/executing** refunds (never ones they initiated), payout approval (never statements they drafted), reconciliation resolution, fee configuration | content/verification actions, role grants, initiating what they approve |
| **Admin: Access administrator** | platform, identity only | role grants/revocations for admin and support staff — each grant requiring a second access-admin approval for finance-capable roles | any business data mutation, customer PII beyond identity records, payments, content |
| **Platform engineer (technical administration)** | infrastructure | deployments, infrastructure/configuration, feature flags, break-glass incident access (time-boxed, ticket-referenced, fully audited, post-reviewed) | routine business-data access; no standing customer-PII, payment, refund, payout, verification, or role-grant powers |
| **Auditor** | platform, read-only | all records + full audit trail, exports | any mutation |

**There is no universal super-admin.** No single principal combines business-data mutation, financial execution, role granting, and infrastructure power. Technical administration (platform engineers) is separated from business administration entirely; emergency access is break-glass only — time-boxed, dual-acknowledged, and reviewed after the fact.

Cross-cutting rules: **dual control is enforced server-side as an invariant — the initiating and approving principal of any refund, payout statement, finance-role grant, or goodwill-credit-above-cap must differ** (checked on the records themselves: `initiated_by ≠ approved_by`); child-participant PII is visible to providers only for confirmed bookings and only the minimum delivery fields (docs/02 §11), with coach/front-desk roles further minimized; support/admin access to PII is logged per-view; all admin and provider-portal access requires MFA; provider staff sessions are org-bound tokens scoped to role + branch.

---

## 8. Provider portal (W2)

### 8.1 Screen inventory

| # | Surface |
|---|---|
| PP-01 | Sign in / staff invitation acceptance / MFA |
| PP-02 | Onboarding & verification submission (documents, branches, bank details) |
| PP-03 | Dashboard (today's sessions, pending actions, booking volume, alerts) |
| PP-04 | Storefront profile (identity, description, media, facilities, policies) |
| PP-05 | Branches (list/edit, hours, facilities) |
| PP-06 | Staff & roles (invite, scope, revoke) |
| PP-07 | Programs list + program editor (details, eligibility, media, pricing model, policy, submit-for-review states per §6.2) |
| PP-08 | Schedules & sessions (recurring patterns, exceptions, per-session capacity, cutoffs, camp weeks) |
| PP-09 | Offers & trials (informational offers, trial configuration) |
| PP-10 | Bookings (per session/day/program; participant minimal-PII list; provider-cancel flow with policy consequences) |
| PP-11 | Attendance (per-session check-in, no-show marking) |
| PP-12 | Reviews (read + response, when review content ships) |
| PP-13 | Reports (bookings, occupancy, revenue) |
| PP-14 | Statements & payouts (read; bank details maintenance — Owner only) |
| PP-15 | Support (cases with Himma) |
| PP-16 | Settings & notifications |
| PP-17 | Bulk import & batch operations (§8.5) |

### 8.2 End-to-end workflows (each must be specced, mocked, approved)

1. **Onboard:** expression of interest → invitation → PP-02 submission → §6.1 review loop → verified → build storefront → first listing → §6.2 review → published → appears in customer app.
2. **Operate weekly:** maintain schedules/capacity → watch bookings arrive → run sessions with PP-11 attendance → handle provider-initiated changes (cancel session → §12.7 customer notification/refund path).
3. **Get paid:** completed bookings accrue → period statement → finance approval (W3) → payout → PP-14 reconciliation.
4. **Handle problems:** full session inquiries, customer no-shows, refund disputes → PP-15 → W3 support.

### 8.3 Build approach
Same discipline as the customer app: spec doc → owner approval → deterministic mock services over the §5 model → staged commits with QA → approval per surface. Stack decision (§18): recommended Expo web/React reusing the design system versus a separate web stack.

### 8.4 Web-quality contract
Responsive (desktop-first, tablet-usable), keyboard-navigable, WCAG 2.1 AA targets, same zero-console-error/QA gates as the customer app.

### 8.5 Bulk catalogue and scheduling tooling (required, PP-17)

Real providers migrate existing catalogues (spreadsheets, other systems); hand-entering 40 programs row by row is a non-starter. Required capabilities, all mock-specced and owner-approved like every other surface:

1. **CSV/XLSX catalogue import** — downloadable template, column mapping, listings created as `draft` (never auto-published; the §6.2 review loop is not bypassable by import).
2. **Bulk scheduling** — pattern-based generation of recurring schedules, session batches, and camp weeks across a date range, with per-batch capacity and cutoff defaults.
3. **Validation preview** — every import/batch shows a full dry-run preview (per-row parse results, computed sessions, price/eligibility interpretation) before anything is written; nothing partial commits — a batch applies atomically or not at all.
4. **Error reports** — per-row errors with line numbers and reasons, downloadable; a batch with errors can apply valid rows only after an explicit reviewed choice, never silently.
5. **Duplicate detection** — same-title/same-schedule/same-branch heuristics flag likely duplicates at preview (warn, never auto-merge) against both the batch and the live catalogue.
6. **Batch media operations** — multi-file upload with per-listing assignment, format/size validation, processing status, and re-usable media library per organization.

Admin side: AD-05's review queue must group batch-submitted listings and support batch-level approve/request-changes with per-item overrides.

### 8.6 Provider design-partner discovery (gates final portal approval)

Before the provider portal's final owner approval, its workflows must be validated with real prospective providers — the portal is the one surface we cannot design purely from our own product judgment, because its users run businesses we don't operate.

- Recruit **5–8 design partners** covering the marketplace's representative shapes: a multi-branch sports academy, a ladies-only fitness studio, a swim school, a camps operator, an after-school learning/STEM provider, and a family-activity/wellness provider.
- Method: structured discovery interviews on current tooling and catalogue shape → walkthroughs of the mock portal (PP-02→PP-11 journeys, §8.5 import with **their real spreadsheet data**, anonymized) → recorded findings → spec revisions.
- Output: a findings report per partner cohort; portal spec amendments recorded as owner decisions.
- **Gate:** final provider-portal approval (and therefore backend contract freeze for provider APIs) requires at least one completed design-partner walkthrough round with findings dispositioned. Recruitment terms/incentives are an owner decision (§18).

---

## 9. Admin/operations portal (W3)

### 9.1 Screen inventory

| # | Surface |
|---|---|
| AD-01 | Sign in + MFA + role display |
| AD-02 | Operations dashboard (queues: verifications, listing reviews, support, refunds, alerts) |
| AD-03 | Provider verification cases (§6.1 checklist, documents, decision + notes) |
| AD-04 | Provider directory (status, suspension controls, audit view) |
| AD-05 | Listing review queue (§6.2, diffs on sensitive-field edits) |
| AD-06 | Taxonomy & catalogue management (categories, activity types, collections, featured ordering) |
| AD-07 | Customer lookup (account, participants — PII-logged, bookings, credits) |
| AD-08 | Booking operations (search, detail, admin cancel with policy override + reason) |
| AD-09 | Payments & reconciliation (gateway events vs ledger, stuck states) |
| AD-10 | Refund queue (initiate/support vs approve/finance, §7 dual control) |
| AD-11 | Credit administration (classes, grants, caps, expiry policies) |
| AD-12 | Payout administration (statements, approval, failures) |
| AD-13 | Support case management (assignment, thread, linked entities) |
| AD-14 | Content moderation (media, descriptions, review content later) |
| AD-15 | Notification templates & campaign sends (transactional first) |
| AD-16 | Platform configuration (fees/VAT once decided, policy presets, feature flags) |
| AD-17 | Roles & staff administration (admin-side) |
| AD-18 | Audit log explorer |

### 9.2 Core workflows
Provider verification end-to-end (AD-03→04) · listing review loop (AD-05) · refund with dual control (AD-10, §6.7) · payout period close (AD-12, §6.8) · support resolution with entity links (AD-13) · incident-driven suspension (AD-04) with customer-impact handling (§12).

---

## 10. Production architecture requirements (W4/W6)

Binding requirements, not implementation choices; stack details are proposed for owner sign-off in the W4 plan.

1. **Database:** PostgreSQL as the system of record. All multi-entity mutations in ACID transactions. Integrity in the schema: FKs, check constraints, unique constraints on natural keys and idempotency keys, and **capacity enforced at the database layer** (`booked_count + active_holds <= capacity` guarded by row-level locking or equivalent, with hold creation/expiry/consumption (§6.4) inside the same transactional discipline) so overselling is impossible regardless of application bugs — proven under contention by the §11.1 final-seat gate.
2. **Idempotency:** every mutating API accepts an idempotency key; payment/webhook handlers are idempotent and safely re-runnable; retries never double-book or double-charge.
3. **Application tier:** stateless, horizontally scalable API services; no session affinity; config via environment; secrets from a managed secret store, never in code or images.
4. **Async processing:** durable queue for notifications, webhook processing, statement generation, media processing; dead-letter queues with alerting; scheduled jobs (session completion, quote expiry, payout accrual) as idempotent workers.
5. **Caching & search:** read-side caching for catalogue/discovery with explicit invalidation on publish events; search served by an indexed engine (PostgreSQL FTS acceptable at Tier 1, dedicated engine by Tier 2 — §11) fed from the system of record.
6. **Object storage & CDN:** provider media in object storage, served via CDN with image resizing; upload scanning; no user media on app servers.
7. **Rate limiting & abuse controls:** per-IP and per-account limits on auth, search, and booking endpoints; bot controls on account creation.
8. **Environments:** local → staging → production, config-identical topology; production data never in lower environments; seeded deterministic staging data (the mock catalogue graduates to a seed).
9. **CI/CD:** every merge runs typecheck, lint, unit, contract, and E2E suites for all three frontends and the API; migrations applied automatically with backward-compatible, two-phase patterns; deploys are one-command with **tested rollback** (deploy + rollback rehearsed in staging); database migration rollback plans documented per release.
10. **Observability:** structured logs with request ids end-to-end, metrics (RED per endpoint + business metrics: bookings, payment success rate, webhook lag), distributed traces, error tracking in all three frontends and API, uptime checks, alerting with an on-call rotation before launch.
11. **Backups & DR — service-specific recovery objectives** (proposed, owner approval §18; a single platform-wide number is not acceptable because losing a paid booking and losing a search index are not the same class of event):

    | Service class | RPO | RTO | Basis |
    |---|---|---|---|
    | **Bookings, payments, holds, ledger, audit** | **0 for committed transactions** (synchronous/quorum replication; PITR as backstop) | **≤ 1 hour** | Financial truth: no committed charge, refund, or confirmed booking may ever be lost; checkout downtime is revenue-and-trust critical |
    | **Catalogue, accounts, provider/admin data** | ≤ 5 minutes | ≤ 2 hours | Recreatable only at high human cost |
    | **Search indexes, caches, feeds** | n/a — rebuildable projections | ≤ 4 hours to full rebuild; degraded browse (§12.9) immediately | Derived data; the system of record survives |
    | **Async queues, notifications, media processing** | ≤ 15 minutes (durable queue replication) | ≤ 8 hours with replay; no user-facing action blocked | Deliveries may delay, never silently drop — DLQ replay covers gaps |
    | **Object storage (media)** | ≤ 15 minutes (versioning + cross-region copy) | ≤ 8 hours | Fallback imagery renders meanwhile (§12.9) |

    Restores rehearsed quarterly **per class** (financial-class restore rehearsed first and most often); documented region-failure runbook; failover behavior itself is load-gate-tested (§11.1).
12. **Payments infrastructure (W5):** gateway webhooks with signature verification, replay protection, and reconciliation jobs; the platform never stores PAN data (SAQ-A scope via gateway-hosted fields/native SDKs).

---

## 11. Proposed scale tiers (owner approval required)

Deliberately conservative launch numbers with headroom; each tier is a load-test target (§15), not a hope.

| Metric | Tier 1 — Abu Dhabi launch | Tier 2 — UAE growth | Tier 3 — scale |
|---|---|---|---|
| Registered customers | 25,000 | 150,000 | 750,000 |
| Monthly active customers | 8,000 | 50,000 | 250,000 |
| Live provider organizations | 75 | 400 | 1,500 |
| Published listings | 600 | 4,000 | 20,000 |
| Sessions scheduled / week | 5,000 | 35,000 | 150,000 |
| Peak concurrent app sessions | 500 | 3,000 | 15,000 |
| Searches / minute (peak) | 300 | 2,000 | 10,000 |
| Checkouts / hour (peak) | 200 | 1,500 | 8,000 |
| Payment webhooks / hour (peak) | 500 | 4,000 | 20,000 |
| Notifications / day | 20,000 | 200,000 | 1,000,000 |
| Object storage | 100 GB | 1 TB | 5 TB |
| API p95 latency target | < 300 ms | < 300 ms | < 300 ms |
| Checkout availability target | 99.9 % | 99.9 % | 99.95 % |

Owner approves Tier 1 as the launch gate target (§15) and the tier ladder as the capacity-planning basis. Architecture (§10) must reach Tier 2 without redesign; Tier 3 without re-platforming.

### 11.1 Correctness and quality gates (load-tested at the active tier — volume alone proves nothing)

The volume table above is meaningless without behavioral targets under that volume. G5 (§15) requires **all** of the following, demonstrated in staging at Tier-1 load on production topology:

| Gate | Target |
|---|---|
| API latency | p95 < 300 ms **and p99 < 800 ms** on search, catalogue, and checkout paths at peak load |
| Error rate | < 0.1 % 5xx on customer-facing endpoints sustained through peak; zero 5xx on payment capture paths during the test window |
| Queue lag | async queue p95 lag < 30 s at peak; DLQ empty at test end (all replays succeed) |
| Webhook convergence | 99 % of gateway webhooks processed < 60 s; 100 % converged (incl. simulated outage backlog) < 15 min after recovery |
| Search-index delay | publish → searchable p95 < 60 s; browse-by-catalogue unaffected during index rebuild |
| **Final-seat concurrency** | N concurrent checkouts (N ≥ 50) against a session with 1 seat: exactly 1 `confirmed`, N−1 receive typed `sessionFull` pre-charge, **zero charges without capacity** (§6.4 proven under contention) |
| **Zero overselling** | property-based load run across many sessions: `booked_count ≤ capacity` invariant never violated (DB-verified after the run, §10.1) |
| **Zero duplicate charges/refunds** | retry-storm test (client retries, duplicate webhooks, replayed events): PaymentTransaction ledger shows no duplicate capture or refund postings; idempotency proven, not assumed |
| Failover behavior | database primary failover during active checkout load: in-flight requests fail cleanly (no partial writes, no lost committed transactions — §10.11 class-1 RPO 0 demonstrated), recovery within RTO, reconciliation clean afterward |

These are pass/fail gates, re-run on any architecture change and before each tier promotion.

---

## 12. Failure and recovery scenarios (binding on all frontend service contracts)

Every frontend contract — customer, provider, admin — must support these outcomes explicitly. The customer app's deterministic `?qa-fail`/`CheckoutValidation` patterns become the standard: every scenario has a typed result, honest customer copy, and a recovery action. None may be silently repaired.

1. **Network loss / timeout mid-request:** idempotent retry with the same key; UI distinguishes "not sent" from "unknown outcome" and offers safe retry.
2. **Stale read (price/availability changed since render):** server rejects with a typed issue (`priceChanged`, `sessionFull`, `offerExpired` — the docs/09 §22.10 codes are the platform vocabulary); UI re-derives and explains; never books at a stale price.
3. **Capacity lost at hold creation:** the hold request fails fast (`sessionFull`) before any charge (§6.4); nothing half-written; UI offers alternatives (other sessions).
4. **Payment succeeded but response lost:** webhook + reconciliation converge the intent and consume the still-active hold into `confirmed` (§6.4/§6.6); if the hold lapsed in the race window, an automatic same-amount reversal posts and the UI explains honestly — the customer is never left charged without capacity, never double-charged on retry (idempotency), and the UI shows "payment received, confirming…" pending state, never a fake success.
5. **Payment failed / requires action:** typed failure with retry path; 3-D Secure round-trips modeled in the contract.
6. **Quote expiry:** checkout quotes carry TTLs; expiry forces visible re-quote, not silent refresh.
7. **Provider cancels a session/enrolment:** affected bookings transition with notification + refund path (§6.7); customer app surfaces it in Bookings, not just email.
8. **Provider suspension with future bookings:** admin workflow triggers mass-handling (cancel + refund/credit per policy); customer copy honest (`This provider is no longer on Himma` precedent).
9. **Partial infrastructure degradation:** search down ⇒ browse-by-catalogue still works; media CDN down ⇒ fallback images (existing `AppImage` pattern); queue backlog ⇒ user-facing actions unaffected, notifications delayed.
10. **Webhook outage:** reconciliation job converges states; stuck `processing` payments alert operations within minutes.
11. **App killed mid-flow:** drafts are in-memory by decision (docs/09 §21.13); confirmed state is always server-recoverable on next launch.
12. **Clock/timezone edge cases:** all cutoffs computed server-side in Asia/Dubai business time; the client never decides whether registration "is closed".

---

## 13. Security, privacy, child data, payment, legal, operational requirements

**Security:** OWASP ASVS-aligned review before launch; MFA for all provider/admin access; short-lived tokens with rotation; per-request server-side authorization (§7); encrypted at rest and in transit; secret rotation; dependency and container scanning in CI; production `npm audit` policy upgraded — the docs/13 "tooling-only, low risk" acceptance is stage-scoped and expires at backend start (§17); third-party penetration test as a launch gate (§15).

**Privacy:** applicable-law review (UAE PDPL as baseline; counsel to confirm) covering lawful basis, consent records, retention schedules, data-subject requests (export + deletion — deletion already a product requirement, docs/04 HMA-032), breach notification runbook, and a data map. Data residency/hosting region is an owner decision (§18). PII minimization to providers stands (§7).

**Child-related data:** children have no accounts and no logins (docs/02); child profiles carry only delivery-necessary fields; the child-profile field set, guardian-consent mechanics, waivers, and health/emergency data **remain undefined pending counsel** (docs/02 §5, docs/09 §22.8) — a blocking legal workstream, not a frontend task. Provider access limited to confirmed-booking minimums; no child data in analytics; child imagery policy required from counsel.

**Payment:** PCI scope minimized to SAQ-A (gateway-hosted fields / native SDKs; the platform never touches PANs — docs/22 §13's binding constraint); webhook signature verification; refund and payout dual control (§7); reconciliation daily; fraud posture (velocity checks, gateway tooling) decided with the gateway (§18).

**Legal:** Himma T&C, privacy notice, provider agreement (commercial terms, liability, cancellation obligations), customer cancellation/refund policy framework, guardian consent text, waiver framework — **none exist; all require counsel**; the docs/09 §22.7 rule stands: no acceptance UI until authoritative text exists, and no real payment without the acknowledgments (§19).

**Operational:** support tooling (W3) before launch; on-call with runbooks for §12 scenarios; incident severity ladder + comms templates; provider operational SLAs (response to booking issues); status page; store-release management (phased rollout, crash-rate monitoring, rollback-by-release).

---

## 14. Native iOS and Android validation requirements (W1)

Unchanged in substance from docs/12, now scheduled instead of indefinitely pending:

1. Acquire a validation environment (Mac with Xcode + simulators, plus at least one physical iPhone and one Android device — HANDOFF backlog items 1–11 stand). **Procurement is a P0 action and the first full device pass over all existing surfaces runs in P0/early P1 (§16)** — ~14 screens of native-inferred work already exist, and every further milestone compounds the risk of building on unverified native assumptions. Findings from the first pass feed the checkout and Bookings milestones directly.
2. Full per-screen device pass: safe areas/notch/Dynamic Island, dock positioning, keyboard behavior, swipe-back and hardware back, carousel gesture arbitration, Dynamic Type ≈135%, reduced motion, press feel, image decode performance.
3. Full VoiceOver and TalkBack pass per flow (structural aria verification does not count — §2).
4. Real-device performance profiling with a production-scale catalogue seed (search, long lists, image-heavy feeds) — expected outcome: FlatList virtualization work.
5. Store-compliance dry runs: TestFlight + Play internal tracks, privacy manifests/data-safety forms, account-deletion flows, Apple Pay/Google Pay entitlement checks (with W5).
6. **No surface is reported "native validated" without this pass** (docs/12 §1 stands verbatim), and launch gate G6 (§15) requires it for every shipped screen.

---

## 15. Production launch gates

Launch requires **every** gate green. No gate may be waived silently; owner may waive one only as a recorded decision.

- **G1 Product completeness:** all three applications' approved workflows implemented against the real API; no inert placeholder reachable in production builds; the docs/04 32-screen inventory (as amended by owner) shipped or explicitly descoped by decision.
- **G2 Data & migration:** real catalogue loaded via provider onboarding (not seeds); taxonomy finalized; imagery rights clean (ASSET_ATTRIBUTION items replaced — including the Expo-logo iOS icon).
- **G3 Security & privacy:** pen test passed with criticals/highs closed; ASVS review; PDPL compliance sign-off; child-data counsel sign-off; secrets/access audit.
- **G4 Payments:** gateway live-mode certification; reconciliation running; refund and payout dual-control tested with real money in a controlled pilot; §19 prohibition formally lifted by owner decision with counsel confirmation.
- **G5 Load & reliability:** Tier 1 volume targets (§11) **and every §11.1 correctness/quality gate** met in staging with production topology — including final-seat concurrency, zero overselling, zero duplicate charges/refunds, webhook convergence, and clean DB failover; §12 failure drills executed; per-class backup restores rehearsed; §10.11 service-specific RPO/RTO demonstrated.
- **G6 Native quality:** §14 pass complete on every shipped screen; crash-free sessions ≥ 99.5 % in pre-launch tracks; store review passed on both stores.
- **G7 Legal & policy:** all §13 legal documents executed and rendered in-product; acceptance UX implemented per counsel; provider agreements signed for launch providers.
- **G8 Operations:** on-call staffed; runbooks tested; support tooling live; status page live; analytics/crash reporting verified end-to-end.
- **G9 Localization (per §3.1 and the §18 language decision):** bilingual launch ⇒ full Arabic/RTL pass (content, layouts, search, legal, native RTL device pass) before launch. English-first launch ⇒ localization architecture and logical-layout compliance still gate G1 for all shipped surfaces, and G9 becomes the binding gate for the Arabic fast-follow release.

---

## 16. Roadmap rescope: Commit 17 onward

**Principle:** the current checkout milestone finishes exactly as approved — it is one commit-pair from closeout and its contracts feed §5 — but the customer app stops consuming the whole roadmap afterward. The next planning capacity goes to the platform.

**Unchanged (customer track, W1):**
- **Commit 17** — payment-method contract and checkout readiness (docs/22 §16, as rescoped by docs/09 §22.13). Awaiting owner go-ahead as before; this rebaseline does not start it.
- **Commit 18** — revalidation states and flow hardening.
- **Commit 19** — checkout review and milestone closeout.

**Rescoped (after Commit 19):** the previously implied "next customer milestone by default" pattern ends. Post-checkout customer milestones (Bookings/Saved/Profile, onboarding/auth screens, Payment & Confirmation) are **sequenced by the §4 dependency graph, not by momentum**. In particular, Payment & Confirmation cannot be planned honestly until W5 gateway selection and §18 decisions exist — attempting it next would fabricate payment behavior. The Bookings/Saved/Profile milestone remains mock-buildable and is scheduled in the recommended sequence below, in parallel with W2 planning, because Bookings' schedule surfaces already have deterministic mock foundations (docs/18 §10).

**Recommended execution sequence (for owner approval):**

| Phase | Work (parallel tracks) |
|---|---|
| **P0 — now** | Owner decisions §18 batch 1 (incl. **native-environment procurement**, **customer-web-at-launch**, **language launch**) · W1 Commits 17–19 (finish checkout) · **acquire Mac/Xcode + devices and run the first full §14 device pass over all existing screens** (findings feed checkout closeout and every later milestone) · start §5–§7 canonical-model specification · §8.6 design-partner recruitment begins |
| **P1** | Owner approves §5–§7 · **W4 backend slices begin against the approved model + already-approved customer workflows: identity/auth, then catalogue/search** · W2 provider-portal spec informed by design-partner discovery interviews · W1 Bookings/Saved/Profile mock milestone (RTL-safe per §3.1.1–2) · W6 environment + CI/CD groundwork · legal drafting begins · complete the first device pass if not finished in P0 |
| **P2** | W4 booking/capacity slice (holds, §6.4, proven against §11.1-style concurrency tests early) · W2 provider-portal mock build + design-partner walkthroughs (§8.6) · W3 admin-portal spec, then mock build · W1 onboarding/auth screens (mock) · customer app integrates identity + catalogue slices behind existing contracts · W5 gateway sandbox integration starts |
| **P3** | Provider-API contract freeze after §8.6 validation · portal frontends integrate their slices · W4 payments slice with W5 (sandbox end-to-end) · W1 Payment & Confirmation milestone (now honestly plannable) · localization work package items per the §18 language decision |
| **P4** | Payments end-to-end in staging · W3 finance/refund/payout workflows live against the real ledger (§6.6–6.8, dual control exercised) · §15 gate work: §11.1 correctness/load gates, security review + pen test, per-class DR drills · full §14 native pass over the integrated app |
| **P5** | Launch-provider onboarding via W2 with §8.5 bulk import (real catalogue) · store submission tracks · gate reviews G1–G9 · **launch** |

Every phase ends with a stop-and-report; no phase starts implementation without its planning document approved (the docs/20–22 pattern, now platform-wide). The change from the first draft: backend work is pulled forward two phases (slices track approved workflows, not the completion of every mock), and native validation is pulled forward two phases (first device pass before more native-inferred work accumulates).

---

## 17. Contradiction register

Existing statements that still frame the product as a prototype-stage, customer-only, or non-production build. **None of these documents is edited by this rebaseline** — the register records what each statement now means, and which require owner-approved amendment.

| # | Location | Statement | Status under rebaseline |
|---|---|---|---|
| C1 | `CLAUDE.md` "Current delivery strategy" | "Do not implement the production backend, database, authentication, payment gateway, provider portal, administration portal … during the current frontend stage." | **Amendment required (owner).** Correct today; wrong the moment W2–W6 activate. Must be rewritten to reference this plan's phase gating rather than a customer-frontend-only stage. |
| C2 | `README.md` "Current stage" + read order | "Building the real customer mobile frontend first"; read order ends at docs/17 + FIRST_PROMPT. | **Amendment required.** Stage wording stale after P0; read order already missing docs/18–23. |
| C3 | `docs/03` §1 | Strategy list: approve customer frontend → backend later in vertical slices. | **Superseded in part by §1 here:** backend follows *three* approved frontends. §3 amendment note needed. |
| C4 | `docs/03` §4 "Explicitly not being built now" | Blanket exclusion of backend, portals, payments, auth, notifications, maps. | **Re-anchored:** exclusions remain true per-phase but are now scheduled (§16), not indefinite. The list must gain a pointer to this plan. |
| C5 | `docs/03` §§5–9 "Future product surface" | Provider portal, admin portal, customer web framed as unscheduled futures. | **Superseded:** W2/W3 are planned workstreams with sequence positions. (Customer web + Himma for Business remain genuinely future/unscheduled.) |
| C6 | `docs/04` §8 / `docs/11` | "First milestone builds only Home…" and Home-milestone acceptance framing. | Historical record — no amendment; superseded by progression (existing pattern). |
| C7 | `docs/07` §1 | "Temporary working identity… not the final company branding." | **Still true — but now deadline-bound:** brand engagement is a P0 decision (§18); provisional branding cannot survive to G2/G6. |
| C8 | `docs/08` §1/§15 | Engineering contract written for the customer app stage (e.g. "before reporting a milestone complete, run … Expo web preview"). | **Extension required:** W2/W3 need the §8.4 web-quality contract; W4/W6 need their own engineering contracts. docs/08 stays authoritative for W1. |
| C9 | `docs/09` §§2–16 "Temporary assumption" wording | Multiple assumptions scoped to "the first Home milestone" or "current frontend stage". | Each stands until its owning workstream activates; the §18 decision list carries the ones that must now be decided for real (credit classes, refund templates, recurring billing). |
| C10 | `docs/13` assessment | Advisory risk accepted because tooling code "ships no customer data" in a frontend-only stage. | **Expires at W4 start:** production dependency/security policy (§13) supersedes; docs/13 gains a note at that point. |
| C11 | `docs/12` §1 status table | Home-only status snapshot dated 2026-08-02. | Stale snapshot; HANDOFF is the live status authority (existing rule). No amendment needed beyond noting it. |
| C12 | `HANDOFF.md` "Not implemented (deferred, do not start without owner approval)" | Deferral list treats portals/backend/payments as a flat "later". | **Re-anchored by this plan:** the list's items now map to workstreams and phases (§3, §16). HANDOFF updated to say so (this commit). |
| C13 | `FIRST_PROMPT.md` | Bootstrap instructions for the original Home-only milestone. | Historical artifact; no amendment. |
| C14 | `docs/17–22` per-milestone exclusion lists | "Not in this milestone: backend, payments…" phrasing throughout. | Correct as milestone scoping; the established superseded-by-progression pattern covers them. |
| C15 | `docs/05` §9 / `docs/09` §18 | Rule-based recommendations "current scope"; behavioral engine future. | Stands — this is a real product decision, not stage framing. Revisit as a product choice post-launch, not as part of this rebaseline. |
| C16 | **docs/23 first draft (this document, pre-A1)** | Contained: no capacity-hold entity (bookings could theoretically charge without guaranteed capacity) · a single Payment record · an "Admin: Super-admin" universal role · first device pass deferred to P2 · backend slices gated on the full three-frontend mock set · Arabic/RTL and customer web silently absent from decisions · one platform-wide RPO/RTO · scale gates measured in volumes only · no provider design-partner step. | **Superseded in place by Amendment A1** (§5, §6.4–6.8, §7, §8.5–8.6, §10.11, §11.1, §14, §16, §18). Recorded so the correction trail is auditable; no first-draft position survives unamended. |

`CLAUDE.md` and `README.md` amendments (C1, C2) are owner-approval items — this rebaseline does not edit permanent instructions on its own authority.

---

## 18. Owner decisions required before implementation can proceed safely

**Batch 1 — blocks P0/P1 (decide first):**
1. **Approve this rebaseline as amended** (§1 redefined frontend-first, §3 workstreams, §16 sequence, A1 corrections) as binding.
2. **Scale tier ladder** (§11) with the §11.1 correctness/quality gates, and Tier 1 as the launch target.
3. **Hosting region / data residency** (UAE-region requirement or not) — blocks W6 and privacy counsel.
4. **Payment gateway selection** (UAE cards + Apple Pay/Google Pay + payout capability) — blocks W5 and the Payment & Confirmation milestone.
5. **Legal counsel engagement** — blocks T&C, provider agreement, child-data model, consent UX, refund templates (docs/09 §7), Arabic legal-text requirements (§3.1.6), and ultimately G4/G7.
6. **Brand engagement timing** — provisional brand cannot reach launch (C7); the engagement must deliver a **bilingual (Latin + Arabic) type system** (§3.1.3); rebrand lands best before store assets and portal theming.
7. **Provider commercial model** — commission/fee structure and payout cadence (blocks §6.8, §9 finance surfaces, docs/09 §22.3's "no fees" placeholder).
8. **Customer web at launch** — is a responsive customer web surface (discovery/SEO/shareable pages, possibly browser checkout — docs/03 §5) part of the launch scope or not? **Not silently deferred**: yes ⇒ it becomes a W1 sibling deliverable with its own plan; no ⇒ recorded as a launch-scope decision with share-link behavior defined (today's `https://himma.app/...` placeholders must resolve to *something* at launch).
9. **Language launch: English-only versus bilingual English/Arabic** — **not silently deferred**: bilingual ⇒ §3.1 in full and G9 gates launch; English-first ⇒ §3.1 items 1–2 still bind all new surfaces and G9 gates the committed Arabic fast-follow. Either way the owner sets the Arabic date.
10. **Native validation environment procurement** (Mac/Xcode + simulators + physical iPhone/Android) — a P0 purchase; blocks the §16 P0/P1 first device pass, §14, and G6.

**Batch 2 — blocks specific workstreams (decide during P1/P2):**
11. **VAT treatment** (docs/09 §22.2 stands until this) — with counsel/accounting; blocks real PriceQuote design.
12. **Recurring billing semantics** (docs/09 §6): auto-renew vs manual, first-collection rules — blocks Enrolment model and store-policy review.
13. **Marketplace Credit classes and expiry** (docs/09 §8) — blocks ledger design and AD-11.
14. **Cancellation/refund policy templates** (docs/09 §7) — blocks §6.7 and provider agreement.
15. **Provider portal stack** (§8.3) and admin portal stack.
16. **Design-partner program terms** (§8.6) — recruitment targets, incentives, confidentiality; blocks the P0/P1 recruitment start.
17. **Arabic provider-content workflow** (§3.1.4) — provider-supplied vs Himma-managed vs machine-assisted translation with review; blocks bilingual catalogue fields and the §8.5 import template.
18. **Multi-participant booking** timing (docs/09 §21.2) — schema supports it; decide whether launch includes it.
19. **Waitlists** (docs/09 §21.4) — remain deferred or enter the backlog with the capacity model.
20. **Search engine tier** (§10.5) and notification channels (push/email/SMS providers).
21. **Amendments to CLAUDE.md / README.md** per C1/C2.

---

## 19. Standing prohibition (restated, binding)

**Real payment submission remains prohibited** until *all* of the following exist: counsel-sourced legal acknowledgments implemented per docs/22 §7.8 · server-side validation and revalidation per §6/§12 · certified gateway integration per §13 · and the operational controls of G4/G8 (reconciliation, dual-control refunds, on-call). Until then, every payment surface in any workstream is a truthful contract: production-styled, duplicate-press-protected, inert, and incapable of claiming success. This restates and extends docs/09 §22.7/§22.11 platform-wide.

---

*Approval of this document rebaselines the roadmap per §16. It does not start Commit 17, does not modify CLAUDE.md or README.md (C1/C2 await explicit owner approval), and does not lift §19.*
