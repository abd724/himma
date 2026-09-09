# 40 — Provider Partner View (owner walkthrough of the Provider Portal, 2026-09-09)

**Purpose.** The product owner walked through the Provider Portal as a provider would, on the local demo setup, and raised questions in business terms. This document records what was found, what is real versus placeholder, the decisions that follow, and how Himma moves forward. It ends with the talking points for a senior engineer who will review the work and continue it. Every statement here was checked against the repository; gate ids refer to `docs/36_LAUNCH_READINESS_AND_PRODUCTION_GATES.md`.

---

## 1. How to read the local setup

- The Provider Portal and Admin Portal run locally on their **built-in demo data** (fixture mode). That is a walkthrough convenience, not the state of the software. Both portals are integrated with the real backend (W2-12 and W3 are closed) and run in live mode in staging/production.
- The Customer App runs locally against the **real backend** with a seeded demo catalogue.
- Because the two portals use demo data locally, a listing created in the portal does **not** appear in the app or the admin portal on the laptop. In staging it does.

## 2. What is genuinely built (real backend, real portals)

- Accounts, participants (parent + children), provider organizations, branches, staff and the seven provider roles.
- Listings with lifecycle (draft → submitted → in review → approved → published → paused/archived), admin moderation and revision moderation.
- Sessions and capacity (backend), bookings and holds, packages and memberships, check-in codes and attendance (backend + portal Check-In page).
- Payments core: Stripe TEST-mode driver, immutable commission snapshot per payment (12% launch term, stored per provider in basis points), reconciling ledger, refund/compensation mechanics. `productionChargingPossible` is the literal `false` until the live-activation slice.
- Worker, scheduler, maintenance jobs; production container image certified; AWS infrastructure code (Terraform, CI/CD) written and validated, not yet deployed.

## 3. Walkthrough findings — concern by concern

| # | Owner concern | Status | What the repository says | Disposition |
|---|---|---|---|---|
| 1 | Bookings page: do customer bookings arrive here? | **Placeholder by design** | Bookings are stored in the backend, but the portal has no Bookings screen (planned as W2-15 in docs/29, never authorized). No notifications exist anywhere (MR-14). Check-In IS live: the customer shows an 8-digit single-use code, front desk types it. | Build (launch blocker) |
| 2 | Schedule page: why "later milestone"? | **Placeholder by design — the most important finding** | Sessions/capacity exist in the backend, but providers have no screen to create them (W2-14). Today only a seed script creates sessions. A real provider cannot make anything bookable. **Not a row in docs/36 yet.** | Build (launch blocker); add to docs/36 |
| 3 | Do listings reach the Customer App? | Built (in staging/production) | Published listings on a live organization appear in app search/discovery. Locally the portal is on demo data, so no. | No change |
| 4 | Only four fields when creating; providers should customize types | Built as designed | The create form takes the minimum for a draft; pricing, branches, eligibility are edited on the listing. Activity types are Himma's taxonomy (admin-managed, D-S4-3); providers ask Himma for a missing type. | No change; explain to providers |
| 5 | Setting: need "not applicable" (indoor/outdoor is meaningless for some listings) | Domain change | `Program.setting` is `indoor \| outdoor` in docs/24. Adding "not applicable" is a small amendment to the canonical spec + portal/app. | Fix before providers see it (owner ruling to amend docs/24) |
| 6 | Pricing: memberships with several durations, packages, professional layout | Built, flatter than wanted | Multiple price options per listing already exist (drop-in, monthly, term, camp, package, free, membership), each with price + label; "1 month / 3 months / 12 months" is done as several Membership options. Grouping and a guided layout are presentation work. | V1.1 (UX); reconsider if design partners struggle |
| 7 | Bundles across services (e.g. 5 cupping + 5 massage) | Not in the model | A Package is N sessions of the same listing. Cross-service bundles are a new commercial shape. | V1.1 owner decision |
| 8 | Offers: percentage discount per option, with dates | Owner-ruled informational | docs/09: offers are informational lines and never change the charged amount; discount arithmetic, promo codes deferred. A computed discount changes the commission basis and VAT posture. For launch, a discounted price is its own option ("12 months (20% off)"). | V1.1 owner decision (FI-01/02 first) |
| 9 | Photos: cannot upload; thumbnail/gallery control | **Not built anywhere** | Media upload/serving/moderation is gate **PR-04 (P0)** plus the image pipeline **IN-15**. Applies to listings and the business profile logo. | Build (P0 gate) |
| 10 | Does a submitted listing reach the admin team? | Built (in staging/production) | Catalogue moderation is real (W3-2): approve / request changes with a message. | No change |
| 11 | Conditional acceptance + site visit by Himma staff | Not in the plan | Verification is document-based with approve / request changes / reject (W3-5). No "visit scheduled" state. Manual route now: "request changes" carrying the visit request. | V1.1 owner decision (policy + state) |
| 12 | Check-in should be a QR code, Entertainer-style | Built as a code | 8-digit code, 10-minute validity, single use, typed by front desk. QR = camera scanner in the portal + QR render in the app. | V1.1 convenience |
| 13 | Settings & Support does nothing; profile menu only signs out; support contact "being built"; Finance "Soon" | Placeholders by design | docs/29 placed these in the menu from day one as designed placeholders. Finance waits for the payout model (FI-04) and W2-17. The support channel is an owner decision (PR-05). | Decide support channel; hide unfinished items before providers see the portal |

## 4. Finance model (asked and answered)

The design matches the owner's intent: **Himma collects the full customer payment; the commission is snapshotted per payment (12% launch term per provider, never a hard-coded global); the provider share is recorded on a reconciling ledger; providers are paid out on a cadence fixed in their contract (weekly/monthly) from a PayoutStatement with dual control (drafted by one person, approved by another).** Built: collection, snapshot, ledger, statement design (docs/24 PayoutStatement, docs/23 §6.8). **Not built:** payout execution and the provider Finance page, because they depend on owner decisions:

- **FI-04** payout model — recommendation: manual bank transfers from statements at launch (monthly; weekly by contract for large providers); Stripe Connect later if volume justifies it.
- **FI-01 / FI-02** VAT treatment and principal-vs-agent (who invoices whom) — accountant + counsel.
- **FI-03** who absorbs the card processing fee.
- **FI-05** the admin capability to set each provider's commission term (no admin screen exists yet; checkout fails closed without a term — by design).

Card readers / QR hardware kits are not needed for V1 (check-in is a code on the customer's phone).

## 5. What "production ready" actually requires

Three groups, from the launch matrix (79 open gates: 26 engineering, 13 owner decisions, 19 external accounts/third parties, the rest configuration and smoke tests that need staging first):

1. **Owner prerequisites (an afternoon, blocking everything):** staging AWS account + non-root engineering identity, the domain/hosted zone, the GitHub repository with `staging`/`production` environments — `docs/39_STAGING_BOOTSTRAP_OWNER_RUNBOOK.md`.
2. **Unbuilt scope providers hit immediately:** provider Schedule/Bookings/Attendance screens (W2-14…16); media (PR-04, IN-15); commission-term administration (FI-05); notifications (MR-14); payouts + Finance page (FI-04, W2-17); content safety for uploads (VE-02).
3. **External and legal:** Stripe account + TEST certification, Apple/Google accounts, VAT/principal-agent rulings, provider agreement (LE-03), refund policy (LE-04), store identifiers (MR-01).

## 6. The way forward (agreed sequence)

1. Owner: company setup, legal, and the four staging prerequisites; start Apple, Google and Stripe applications in parallel.
2. Engineering: deploy and certify AWS staging (W6-4B, already prepared).
3. **Slice: provider Schedule + Bookings + Attendance screens** — the first authorization to give; it is the gap that makes real bookings impossible.
4. Slice: media (PR-04 + IN-15).
5. Slice: commission-term administration (FI-05) + Stripe TEST certification.
6. Owner rulings in parallel: FI-01…04, LE-03/04, MR-14 (notification channels), support channel.
7. Slice: payout statements + provider Finance page + notifications (email at minimum).
8. Content safety, design-partner walkthroughs (docs/30) and a small provider cohort on staging, physical devices, TestFlight/Play internal testing, production, final gate review, live-payment activation, public release.

Target discussed by the owner: providers onboarding in Q1 2027. Achievable if step 1 starts now and slices run back to back.

## 7. Three lists from this walkthrough

- **Built today (demo it):** organization, branches, team and roles, listings and lifecycle, pricing options, offers (informational), submit/publish/pause/archive, bulk import validation, check-in by code, business profile.
- **Fix before providers see it:** Schedule/Bookings/Attendance screens; photos; "not applicable" setting; commission-term admin; remove or hide unfinished menu items ("Soon" badges, empty Settings, support contact); decide the support channel.
- **V1.1 ideas (captured, not built):** grouped pricing layout; cross-service bundles; computed per-option discounts with date windows; conditional approval with site visit; QR scanning at check-in; provider Finance page beyond statements.

---

## 8. Talking points for the senior engineer (Provider Portal)

Give the engineer this section with the repository. The authoritative documents are `README.md`, `docs/23` (master plan), `docs/24` (domain spec), `docs/29`/`docs/30` (portal plan and walkthrough package), `docs/36` (launch gates), `docs/37`–`docs/39` (runtime and infrastructure), and `HANDOFF.md` (status; the top table is current, older sections are history).

**Ask for a review of:**
1. The overall architecture and code quality: `backend/` (Node 24, Fastify 5, PostgreSQL, Kysely; migrations `0001`–`0023`; Jest 1425 tests on real PostgreSQL), `portal/` and `admin/` (Vite/React, contract tests against the backend), the Expo customer app, the container image and Terraform under `infra/`.
2. Whether the delivery process (owner-authorized slices, stop-and-report, certification evidence per slice) is fit for the remaining work, and what they would change.
3. The launch matrix `docs/36`: do they agree with the classifications and priorities, and is anything missing besides the two items below?

**Work to plan on the Provider Portal (in this order):**
1. **Schedule, Bookings, Attendance screens (W2-14, W2-15, W2-16 in docs/29).** Backend support exists (sessions/capacity from backend Slice 5, entitlements/attendance from Slice 6, check-in credentials). Needed: recurring schedule authoring, session and camp-week publishing, capacity management, a bookings view per session/day, attendance marking for front desk, all under the seven-role scope rules. Record these as a P0 row in docs/36 (currently missing).
2. **Media (PR-04 + IN-15).** Upload, private storage (S3), resizing/serving via CDN, thumbnail and gallery ordering, moderation; the same for the business-profile logo. Content safety on uploads (VE-02) precedes real provider documents.
3. **Commission-term administration (FI-05).** An admin capability (dual-control classified per D-W3-5) to set/supersede a provider's commission term; today only fixtures create terms and checkout fails closed without one.
4. **Finance page (W2-17)** after the payout model (FI-04) and VAT/principal-agent rulings (FI-01/02): statements, payout history, bank details with the required dual control.
5. **Notifications (MR-14):** provider and customer email at minimum (booking received, session reminders, moderation outcomes); the outbox events already exist, no sender does.
6. **Small product changes needing an owner ruling:** `Program.setting` gains "not applicable" (docs/24 amendment); hide unfinished menu items; support contact channel; grouped pricing presentation.
7. **Later (V1.1, do not build without authorization):** cross-service bundles, computed discounts, conditional approval with site visit, QR check-in.

**Ground rules the engineer must keep:** no live payments (`productionChargingPossible` stays literal `false` until the PA-06 slice); commission is per provider, never a global constant; offers stay informational until ruled otherwise; production and staging are separate AWS accounts; no product behavior changes outside an authorized slice; every slice ends with tests green, `db:verify` clean, docs/36 recounted, and a clean tree.
