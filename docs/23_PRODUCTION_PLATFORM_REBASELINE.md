# 23 — Production Platform Rebaseline (Master Plan)

Status: **draft for product-owner approval — binding on the whole platform once approved.** Prepared 2026-08-05 after full re-analysis of the repository, docs/01–22, HANDOFF.md, the git history, and the implemented customer application (through Commit 16, `31f11b9`).

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
        │                └──────┬─────────┘                   │
        │                       ▼                             ▼
        │             Approved three-frontend surface   W6 environments/CI/CD
        │                       │                       (parallel, early)
        │                       ▼                             │
        │             W4 backend vertical slices  ◄───────────┘
        │             (identity → catalogue → booking/capacity
        │              → payments W5 → payouts/refunds)
        │                       │
        └───────────┬───────────┘
                    ▼
        Frontend API integration (all three apps, slice by slice)
                    ▼
        Native validation (§14) + load/security/reliability gates (§15)
                    ▼
        LAUNCH (gated, §15)
```

**Can run in parallel now:** W1 checkout completion (§16) · W2 provider-portal specification · §5–§7 modeling · W6 environment/CI groundwork · legal engagement · brand engagement.
**Must be decided first (blocking):** the §18 owner decisions — every one of them blocks a workstream noted there.
**Hard sequencing:** no backend code before the §5–§7 model is owner-approved; no payment integration before legal text and gateway selection; no launch before every §15 gate.

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
| **Booking** | id, account id, participant id, program id, option kind, session/campweek/enrolment ref, quote ref, state (§6.4), reference code, timestamps, audit trail | One participant per booking now; schema allows a booking group later (docs/09 §21.2). |
| **Enrolment** | booking subtype for monthly/term: billing anchor, cadence, renewal policy (owner-open, docs/09 §6) | |
| **Payment** | booking id, gateway intent id, amount, currency (AED), method, state (§6.5), idempotency key | |
| **Refund** | payment id, amount, destination (original method / marketplace credit), reason, state (§6.6), actor | |
| **CreditLedgerEntry** | account id, class (refund/promo/referral/gift), amount, direction, expiry policy ref, booking ref? | Append-only ledger; balance is a projection (docs/09 §8). |
| **Payout** | org id, period, gross, commission, adjustments, net, state (§6.7), statement ref | Provider settlement. |
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

**6.4 Booking**
`draft (client-only, never persisted) → pending_payment → confirmed` · `pending_payment → expired (quote/hold TTL) | payment_failed (→ pending_payment on retry)` · `confirmed → cancelled_by_customer | cancelled_by_provider | completed | no_show` · free bookings: `draft → confirmed` directly (server-confirmed, still never client-claimed). `confirmed` is the only state the customer app may ever call "booked".

**6.5 Payment**
`created → processing → succeeded` · `processing → failed (→ created on retry) | requires_action (3-D Secure) → processing` · `succeeded → partially_refunded ↔ refunded`. Gateway webhooks are the source of truth; the API reconciles, never assumes.

**6.6 Cancellation & refund**
Cancellation request evaluates the booking's policy snapshot (frozen at confirmation): `requested → policy_evaluated → {refund_due(amount) | no_refund}` · refund: `initiated → processing → completed | failed (→ initiated, alerting)`; destination original-method or marketplace credit per policy/owner rules (docs/09 §7 remains owner-open on templates).

**6.7 Payout**
`accrued (per completed booking) → statement_drafted (period close) → approved (finance role) → processing → paid` · `processing → failed (→ approved, alerting)` · adjustments (refund clawbacks) post to the next statement. Dual-control: drafting and approving must be different actors (§7).

---

## 7. Server-side authorization model

All authorization is enforced server-side per request; client UI state is convenience only. Model: role-based with organization/branch scoping, deny-by-default.

| Principal | Scope | Can | Cannot |
|---|---|---|---|
| **Customer** | own account | manage own profile/participants, browse public catalogue, book/pay for own participants, view/cancel own bookings, own credits/gifts, own support cases | see other customers, any provider internals, any admin surface |
| **Guest** | none | browse public catalogue only (docs/02 §2) | any account-scoped action |
| **Provider: Owner** | their org (all branches) | everything Manager can, plus staff management, commercial/payout settings, offboarding request | other orgs; admin functions; editing platform taxonomy |
| **Provider: Manager** | org or assigned branches | listings, schedules, sessions, capacity, offers, bookings view, attendance, provider-initiated cancellations, reports | staff role grants, payout bank details |
| **Provider: Front-desk** | assigned branch(es) | today's sessions, attendance marking, booking lookup (minimal PII: name + age band + booking ref) | pricing, listings, reports, exports, payout data |
| **Provider: Finance** | their org | statements, payout history, refund impact reports | listing/schedule mutation |
| **Admin: Operations** | platform | verification cases, listing review, content moderation, taxonomy, provider suspension | payment capture/refund execution, role grants |
| **Admin: Support** | platform, read-heavy | customer/booking lookup, support cases, goodwill credit within a capped budget, initiating (not approving) refunds | verification decisions, payouts, role grants |
| **Admin: Finance** | platform | refund approval/execution, payout approval, reconciliation, fee configuration | content/verification actions (separation of duties) |
| **Admin: Super-admin** | platform | role grants, configuration, everything above — every action audit-logged, MFA-required | bypassing audit |
| **Auditor** | platform, read-only | all records + full audit trail, exports | any mutation |

Cross-cutting rules: child-participant PII is visible to providers only for confirmed bookings and only the minimum delivery fields (docs/02 §11); support/admin access to PII is logged per-view; payout and refund execution require dual control; all admin surfaces require MFA; provider staff sessions are org-bound tokens.

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

### 8.2 End-to-end workflows (each must be specced, mocked, approved)

1. **Onboard:** expression of interest → invitation → PP-02 submission → §6.1 review loop → verified → build storefront → first listing → §6.2 review → published → appears in customer app.
2. **Operate weekly:** maintain schedules/capacity → watch bookings arrive → run sessions with PP-11 attendance → handle provider-initiated changes (cancel session → §12.7 customer notification/refund path).
3. **Get paid:** completed bookings accrue → period statement → finance approval (W3) → payout → PP-14 reconciliation.
4. **Handle problems:** full session inquiries, customer no-shows, refund disputes → PP-15 → W3 support.

### 8.3 Build approach
Same discipline as the customer app: spec doc → owner approval → deterministic mock services over the §5 model → staged commits with QA → approval per surface. Stack decision (§18): recommended Expo web/React reusing the design system versus a separate web stack.

### 8.4 Web-quality contract
Responsive (desktop-first, tablet-usable), keyboard-navigable, WCAG 2.1 AA targets, same zero-console-error/QA gates as the customer app.

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
Provider verification end-to-end (AD-03→04) · listing review loop (AD-05) · refund with dual control (AD-10, §6.6) · payout period close (AD-12, §6.7) · support resolution with entity links (AD-13) · incident-driven suspension (AD-04) with customer-impact handling (§12).

---

## 10. Production architecture requirements (W4/W6)

Binding requirements, not implementation choices; stack details are proposed for owner sign-off in the W4 plan.

1. **Database:** PostgreSQL as the system of record. All multi-entity mutations in ACID transactions. Integrity in the schema: FKs, check constraints, unique constraints on natural keys and idempotency keys, and **capacity enforced at the database layer** (e.g. `booked_count <= capacity` guarded by row-level locking or equivalent) so overselling is impossible regardless of application bugs.
2. **Idempotency:** every mutating API accepts an idempotency key; payment/webhook handlers are idempotent and safely re-runnable; retries never double-book or double-charge.
3. **Application tier:** stateless, horizontally scalable API services; no session affinity; config via environment; secrets from a managed secret store, never in code or images.
4. **Async processing:** durable queue for notifications, webhook processing, statement generation, media processing; dead-letter queues with alerting; scheduled jobs (session completion, quote expiry, payout accrual) as idempotent workers.
5. **Caching & search:** read-side caching for catalogue/discovery with explicit invalidation on publish events; search served by an indexed engine (PostgreSQL FTS acceptable at Tier 1, dedicated engine by Tier 2 — §11) fed from the system of record.
6. **Object storage & CDN:** provider media in object storage, served via CDN with image resizing; upload scanning; no user media on app servers.
7. **Rate limiting & abuse controls:** per-IP and per-account limits on auth, search, and booking endpoints; bot controls on account creation.
8. **Environments:** local → staging → production, config-identical topology; production data never in lower environments; seeded deterministic staging data (the mock catalogue graduates to a seed).
9. **CI/CD:** every merge runs typecheck, lint, unit, contract, and E2E suites for all three frontends and the API; migrations applied automatically with backward-compatible, two-phase patterns; deploys are one-command with **tested rollback** (deploy + rollback rehearsed in staging); database migration rollback plans documented per release.
10. **Observability:** structured logs with request ids end-to-end, metrics (RED per endpoint + business metrics: bookings, payment success rate, webhook lag), distributed traces, error tracking in all three frontends and API, uptime checks, alerting with an on-call rotation before launch.
11. **Backups & DR:** automated PITR-capable database backups; restore rehearsed quarterly; **RPO ≤ 15 minutes, RTO ≤ 4 hours proposed** (owner approval, §18); object storage versioning; documented region-failure runbook.
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

---

## 12. Failure and recovery scenarios (binding on all frontend service contracts)

Every frontend contract — customer, provider, admin — must support these outcomes explicitly. The customer app's deterministic `?qa-fail`/`CheckoutValidation` patterns become the standard: every scenario has a typed result, honest customer copy, and a recovery action. None may be silently repaired.

1. **Network loss / timeout mid-request:** idempotent retry with the same key; UI distinguishes "not sent" from "unknown outcome" and offers safe retry.
2. **Stale read (price/availability changed since render):** server rejects with a typed issue (`priceChanged`, `sessionFull`, `offerExpired` — the docs/09 §22.10 codes are the platform vocabulary); UI re-derives and explains; never books at a stale price.
3. **Capacity lost at confirmation:** booking fails atomically (`sessionFull`), nothing charged or half-written; UI offers alternatives (other sessions).
4. **Payment succeeded but response lost:** webhook + reconciliation converge the booking to `confirmed`; UI shows "payment received, confirming…" pending state — never a fake success, never a duplicate charge on retry (idempotency).
5. **Payment failed / requires action:** typed failure with retry path; 3-D Secure round-trips modeled in the contract.
6. **Quote expiry:** checkout quotes carry TTLs; expiry forces visible re-quote, not silent refresh.
7. **Provider cancels a session/enrolment:** affected bookings transition with notification + refund path (§6.6); customer app surfaces it in Bookings, not just email.
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

1. Acquire a validation environment (Mac with Xcode + simulators, plus at least one physical iPhone and one Android device — HANDOFF backlog items 1–11 stand).
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
- **G5 Load & reliability:** Tier 1 load targets (§11) met in staging with production topology; §12 failure drills executed (including webhook outage and DB failover); backup restore rehearsed; RPO/RTO demonstrated.
- **G6 Native quality:** §14 pass complete on every shipped screen; crash-free sessions ≥ 99.5 % in pre-launch tracks; store review passed on both stores.
- **G7 Legal & policy:** all §13 legal documents executed and rendered in-product; acceptance UX implemented per counsel; provider agreements signed for launch providers.
- **G8 Operations:** on-call staffed; runbooks tested; support tooling live; status page live; analytics/crash reporting verified end-to-end.

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
| **P0 — now** | Owner decisions §18 batch 1 (scale tier, hosting region, gateway shortlist, counsel engagement, brand engagement) · W1 Commits 17–19 (finish checkout) · start §5–§7 canonical-model specification document |
| **P1** | Owner approves §5–§7 · W2 provider-portal spec (docs/14-pattern document set) · W1 Bookings/Saved/Profile mock milestone · W6 environment + CI/CD groundwork · legal drafting begins |
| **P2** | W2 provider-portal mock build (staged commits) · W3 admin-portal spec, then mock build · W4 schema + API contract design from the approved model · W1 onboarding/auth screens (mock) · native validation environment acquired, first §14 pass on existing surfaces |
| **P3** | W4 backend vertical slices: identity/auth → catalogue/search → booking/capacity · three frontends integrate slice-by-slice behind their existing contracts · W5 gateway integration in sandbox |
| **P4** | W1 Payment & Confirmation milestone (now honestly plannable) · payments end-to-end in staging · W3 finance/refund/payout workflows live against real ledger · §15 gate work (load, security, DR drills) |
| **P5** | Launch-provider onboarding via W2 (real catalogue) · store submission tracks · gate reviews G1–G8 · **launch** |

Every phase ends with a stop-and-report; no phase starts implementation without its planning document approved (the docs/20–22 pattern, now platform-wide).

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

`CLAUDE.md` and `README.md` amendments (C1, C2) are owner-approval items — this rebaseline does not edit permanent instructions on its own authority.

---

## 18. Owner decisions required before implementation can proceed safely

**Batch 1 — blocks P0/P1 (decide first):**
1. **Approve this rebaseline** (§1 redefined frontend-first, §3 workstreams, §16 sequence) as binding.
2. **Scale tier ladder** (§11) and Tier 1 as the launch target.
3. **Hosting region / data residency** (UAE-region requirement or not) — blocks W6 and privacy counsel.
4. **Payment gateway selection** (UAE cards + Apple Pay/Google Pay + payout capability) — blocks W5 and the Payment & Confirmation milestone.
5. **Legal counsel engagement** — blocks T&C, provider agreement, child-data model, consent UX, refund templates (docs/09 §7), and ultimately G4/G7.
6. **Brand engagement timing** — provisional brand cannot reach launch (C7); rebrand lands best before store assets and portal theming.
7. **Provider commercial model** — commission/fee structure and payout cadence (blocks §6.7, §9 finance surfaces, docs/09 §22.3's "no fees" placeholder).

**Batch 2 — blocks specific workstreams (decide during P1/P2):**
8. **VAT treatment** (docs/09 §22.2 stands until this) — with counsel/accounting; blocks real PriceQuote design.
9. **Recurring billing semantics** (docs/09 §6): auto-renew vs manual, first-collection rules — blocks Enrolment model and store-policy review.
10. **Marketplace Credit classes and expiry** (docs/09 §8) — blocks ledger design and AD-11.
11. **Cancellation/refund policy templates** (docs/09 §7) — blocks §6.6 and provider agreement.
12. **Provider portal stack** (§8.3) and admin portal stack.
13. **Multi-participant booking** timing (docs/09 §21.2) — schema supports it; decide whether launch includes it.
14. **Waitlists** (docs/09 §21.4) — remain deferred or enter the backlog with the capacity model.
15. **Search engine tier** (§10.5) and notification channels (push/email/SMS providers).
16. **Native validation environment** procurement (Mac/Xcode + devices) — blocks §14 and G6.
17. **Amendments to CLAUDE.md / README.md** per C1/C2.

---

## 19. Standing prohibition (restated, binding)

**Real payment submission remains prohibited** until *all* of the following exist: counsel-sourced legal acknowledgments implemented per docs/22 §7.8 · server-side validation and revalidation per §6/§12 · certified gateway integration per §13 · and the operational controls of G4/G8 (reconciliation, dual-control refunds, on-call). Until then, every payment surface in any workstream is a truthful contract: production-styled, duplicate-press-protected, inert, and incapable of claiming success. This restates and extends docs/09 §22.7/§22.11 platform-wide.

---

*Approval of this document rebaselines the roadmap per §16. It does not start Commit 17, does not modify CLAUDE.md or README.md (C1/C2 await explicit owner approval), and does not lift §19.*
