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
- **Fix before providers see it:** Schedule/Bookings/Attendance screens; photos; "not applicable" setting; commission-term admin; remove or hide unfinished menu items ("Soon" badges, empty Settings, support contact); decide the support channel; **listing templates + the "Other, write your own" rule (§9 below), right after the Schedule screens and before the design-partner sessions**.
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

---

## 9. Listing form: templates and customization (owner direction, 2026-09-09)

**Principle.** Providers across health and wellness (physical, mental, children, adults) must be able to describe what they offer in their own words. The listing is a form the provider fills top to bottom, not a database screen.

**Two layers in every listing**
1. **A small structured core Himma needs to keep its promises:** activity type (Himma taxonomy, with "request a new type" built in), who it is for (ages, adults/children, gender eligibility, skill level), where (branch), how it is bought (structured price options — only these can be booked, paid, commissioned, refunded), when (schedule, once the Schedule screens exist). Structured because search, child-safety eligibility and payment depend on it.
2. **Everything else belongs to the provider:** free sections they add, rename, reorder or remove (what a session looks like, what to bring, coach qualifications, medical notes, benefits); custom price-option names ("1 month", "10-session pack", "Family bundle"); custom offer wording; tags in their own words.

**The "Other, write your own" rule.** Every dropdown offers a free-text alternative; a provider is never blocked by a missing option. Written values are accepted immediately and shown as typed. For search/safety fields (activity type, setting) the written value is also recorded as a request to the admin team, who can adopt it into the taxonomy, map it, or leave it as text — the listing is not held up.

**Templates.** Starting points a provider picks: After-school activity, Summer camp, Winter camp, Term course, Drop-in class, Membership (more later: Ramadan programme, holiday camp, ladies-only class). A template pre-fills a draft (title pattern, description outline, typical age band, the right price-option kinds — camp weeks priced per week, after-school monthly or per term — eligibility, schedule pattern, sections). Everything is editable and removable; a template never locks or publishes anything; the result is an ordinary draft through the same review. Templates are Himma-managed content, tunable from what design partners actually do. Placement: right after the provider Schedule slice, before the design-partner sessions.

---

## 10. Admin Portal — owner walkthrough findings (2026-09-09)

Sign-in used: `ops@himma.demo` (operations). Same reading rule as §1: the admin runs on demo data locally; verification downloads locally are a fictional text file named `.pdf`.

| # | Owner concern | Status | What the repository says | Disposition |
|---|---|---|---|---|
| 1 | The dashboard is not a dashboard (just links) | Gap vs plan | docs/31 AD-02 specified a work-queue home (verifications awaiting review, listings submitted, open revisions — real counts). The queues exist as separate pages; the home never received the counts. | Build |
| 2 | Providers list: want a directory of who is with us (joined date, live, branches, catalogue, later revenue), not a status list | Gap | The list is an operations queue keyed on verification state; the data for a directory exists. | Build |
| 3 | "In review" page: nothing to review, cannot approve, download "damaged" | Demo artefact + fail-closed + real gap | Download: fixture text file (real S3 file in staging; retrieval blocked in production until VE-02 scanning exists). Approve disabled because a required document is missing — correct fail-closed behaviour, badly explained. **The provider side of verification is not built (VE-03, P0): providers cannot upload documents; the required-document checklist was never ruled (VE-04).** The loop cannot be completed by anyone today. | Rule VE-04; build VE-03 + VE-02; rewrite the decision guidance |
| 4 | `Round 1: in_review` raw value on screen | Defect | Developer-facing label; violates the project's own rule. | Fix |
| 5 | Audit: entities should be clickable | Polish | The trail is real (who/what/when/record); no links. | Fix |
| 6 | Sign-out only; no settings; "SMS"/unfinished wording | Placeholders | Same pattern as the portal. | Remove placeholders; account menu |
| 7 | "Looks generated, not designed" | Fair | docs/31 scoped the admin as the minimum operations console; it never had the design pass the app had. | Design pass in the admin slice |
| 8 | How is a provider onboarded? Why documents on a listing? | Half-built loop | Intended flow (docs/29 §9, docs/31): Himma creates the org + invites the owner → owner completes basics/storefront/branch → submits → reviewer works a checklist of documents → approve → live. Exists: steps 2–3 (portal), reviewer side of 4. Missing: **an admin screen to create a provider/invite the owner** (route + script only), the provider document-upload step (VE-03), the checklist ruling (VE-04). Documents are attached to the organization's verification case, never to a listing. | Build (see §11) |

**On approvals.** Each W3 slice was owner-approved at its closing commit on written evidence and tests. This walkthrough is the first operator-style use of the portal; it caught what reports cannot. Rule going forward: every portal slice includes an owner walk-through before approval.

## 11. Admin operations — the target (owner direction)

**Requests, not statuses.** Home shows queues with counts: partner requests (from the website, §12), verification requests, listing submissions, change requests.

**One request, one page.** Clicking a request opens the whole submission as a readable form: who applied, company details, branches, team, the listing exactly as the provider wrote it (structured core + their own sections, price options, offers, photos once PR-04 exists), every attachment viewable inline. Decision at the bottom: approve, request changes with a reason the applicant reads, reject; per-attachment accept/reject where documents are involved; approval enabled only when everything required is present, stated in plain words. History of rounds and decisions on the page, with links to people and records. No raw values, no placeholders, no "Soon".

**Two-round review — "our trust with the customer is the product."**
1. Provider submits → the request appears in the queue; staff notified (in-portal badge now; email/push when the notification slice MR-14 exists — nothing sends today).
2. **Round 1, desk review:** read the submission and attachments; approve for a visit, request changes, or reject.
3. **Round 2, site visit:** new state "approved pending visit" with date, visitor and a short checklist (place, coach, safety, offering match what was written). Pass → live; fail → written reason back to the provider.
4. Everything on the record, provider-visible in their words, audit-linked.

**Owner decisions this needs before it starts:** VE-04 (the document checklist per business type — trade licence, operating licence, owner ID, insurance where required; counsel to confirm); the site-visit policy (who visits, checklist, per organization or per listing); the support channel.

**Interim process** until VE-03/VE-04 exist: documents by email, decision recorded in the portal. Works for a handful of pilot providers, not for launch.

## 12. Public website and partner acquisition (owner direction)

**Positioning (the brief for the website and for marketing):** our children's and our own health are our responsibility, and Himma makes acting on it easy. Families find and join activities that make them healthier and more connected; providers get exposure, full sessions and a community; free sessions and trials open doors. The commission sustains the company and belongs in the provider agreement, never in the message. Tone: adult, warm, direct; the provisional brand system (docs/07) so site and app feel like one product; real Abu Dhabi activities and places in photography (illustrated placeholders honestly until the first partners).

**Reference:** Beanz (beanz.ae) — inspiration for structure only, never copied: one page speaks to customers, partners and "already a partner → log in"; a short partner application with a promised response time; social proof by real partner logos/gallery; footer with the store-required links (terms, privacy, delete my account, support, head office); Arabic one click away.

**What exists:** `portal.himma.app` (partner login) and `admin.himma.app` are already separate addresses in the infrastructure. `himma.app` is planned only as a technical surface (app links, payment return). **No marketing site and no self-application exist** — onboarding starts with a Himma invitation. This is new scope, recorded here as a launch item.

**Proposed page (himma.app):** 1 Hero — the impact (a family, an activity, a healthier routine), the app as the way to act on it, store badges once live, Partner login. 2 For families — health, confidence, time together; children and adults side by side; one account, one pass. 3 For partners — "be part of it": reach families looking for exactly what you do, fill your sessions, welcome newcomers with a free session, grow your community; the portal and payouts as supporting facts; no percentage anywhere. 4 Free sessions and trials — their own visible place. 5 Partners with us — real logos and gallery only. 6 Become a partner — business name, activity type, contact name, phone, email, city, Instagram (optional); "we reply within two working days"; sales email. 7 FAQ. 8 Footer — support, head office, terms, privacy, delete my account, Arabic switch when the Arabic slice lands.

**Scope to build (small):** static site on the S3/CloudFront web surface already written; one backend route storing the partner request (spam protection, rate limiting); a "Partner requests" queue and request page in the admin portal; an "accept" action that creates the organization and sends the owner invitation, after which the certified onboarding takes over.

**From the owner:** brand direction and copy (marketing person), sales and support addresses, legal pages from counsel.

## 13. Talking points for the senior engineer (Admin Portal and website)

1. Complete the verification loop first: VE-04 ruling → provider document upload (VE-03) → scanning (VE-02) → the two-round review with the site-visit state. Without it no provider can be verified in production.
2. Admin operations slice: work-queue home with real counts, providers directory, "one request, one page" review form with inline attachments, create-provider/invite-owner screen, partner-requests queue, plain-language decision guidance, no raw labels, linked audit entries, account menu, placeholders removed, design pass. Keep dual control (D-W3-5) exactly as certified.
3. Notifications (MR-14): staff (new request), providers (decision, booking received), customers — email first; the outbox events exist, no sender does.
4. Website + partner request intake as above; static hosting exists; one route + one queue.
5. Listing form: structured core + provider-owned sections, "Other, write your own" everywhere with taxonomy requests to admin; templates as Himma-managed content.
6. Everything above is unbuilt scope, not defects in certified behaviour; nothing starts without owner authorization; `productionChargingPossible` stays literal `false`.

---

## 14. Customer App — owner walkthrough findings (2026-09-09, Expo web preview against the real dev backend)

| # | Owner concern | Status | What the repository says | Disposition |
|---|---|---|---|---|
| 1 | Home and Discover both show "New on Himma" and "Offers & free trials" | Confirmed duplication | Both feeds are built by the discovery service with the same two sections. | Redesign: Discover = categories, collections, providers only; Home = new/offers/free trials + feed (§15) |
| 2 | A category shows nothing outside the selected area ("try nearby areas") | Confirmed; area is a gate | The category page filters by the selected area; the search API already accepts "no area"; the map already has "Show all areas". | Fix: show all of Abu Dhabi by default; "Near me" filter (selected area + its neighbours now; device location later — geolocation permission is an open docs/09 item) |
| 3 | Quran under Learning & Languages; category list | Content | The seed has a Tajweed circle, hidden by the area gate. Categories/activity types are Himma's admin-managed taxonomy (D-S4-3). | Owner confirms the launch taxonomy: Fitness & gyms · Martial arts & combat · Swimming & water · Padel & racquet · Pilates & yoga · Team & outdoor sports · Learning & languages (incl. Quran/Tajweed) · … |
| 4 | After-school not visible | By an earlier rule | Child-focused collections (after-school, camps, Kids & Teens) appear only when a child is on the account (docs/09 §21 child-dependent visibility). The owner's account had no child. | Superseded by the Kids tab (§15) |
| 5 | "Monthly" on CrossFit Foundations: asked for a session; not in Passes; wanted 1/3/6/12-month memberships with a start date | Vocabulary, not a defect | The seeded option is kind `monthly` = a recurring programme with a fixed schedule (an enrolment cohort) → the app asks where to start and files it under Bookings. Kind `membership` = an access pass: bought without choosing a session, valid for a period, shown under Passes (the RI-4 acquisition path). The seed used the wrong kind for what a gym calls "monthly", and the two kinds are confusable even for the owner. | Owner ruling: merge the provider-facing vocabulary — "Membership" with durations (1/3/6/12 months, start date) vs "Programme with a fixed timetable"; app copy follows |
| 6 | Calendar empty on the 14th | Seed gap | The booked cohort has zero schedule rows in the dev seed; the calendar derives from schedules and had nothing to expand. Calendar code is correct. | Seed fix only |
| 7 | "Who is attending" shown when only "Me" exists | UX gap | The step preselects but never skips. | Fix: skip when the account has a single participant |
| 8 | Saved tab does nothing | Unbuilt scope | Saved (HMA-007) was scoped and never built; the tab is inert by the "dead taps" rule. | Saving becomes a heart on listings + a "Saved" list under Profile; the dock slot goes to Kids (§15) |
| 9 | Date of birth typed as YYYY-MM-DD | V1 shortcut | The field is text on every platform, marked "native date picker later" in code. | Fix before launch: native iOS/Android date pickers (year first), text fallback on web only |
| 10 | Book for two children in one transaction | Deferred rule, now lifted | One participant per booking at launch (docs/09 §21.2); multi-participant deferred; the schema already reserves a booking group and a quantity column (docs/24 B9, docs/23 §18.18). | Owner ruling: launch scope (§16) |
| 11 | Referral reward | Open decision, now ruled | Referrals screen specified (HMA-029); docs/09 §10 open items; no backend (no referral code, no credit ledger yet — the credits design exists in docs/24). | Owner ruling (§17) |

## 15. Customer App direction (owner, pending formal design approval — amends docs/04)

- **Dock:** Home · Discover · **Kids** · Bookings · Profile (still five). Saved moves under Profile; the heart on a listing saves it.
- **Kids tab:** everything child-focused in one place — after-school, camps, holiday programmes, Kids & Teens — filtered by the children's ages once children exist on the account. Adults never see children's content mixed into Home; Discover keeps a "for children" filter so nothing is unreachable.
- **Home:** a vertical feed of **listing** cards (the activity is what a family decides on; the provider comes after), Instagram-like: one card per listing, at most one card per provider in view, the provider's name opens the provider page with everything under it; chips at the top — New on Himma, Offers, Free trials, Near me, later Trending; "New on Himma" may also be a horizontal row above the feed. Providers as a browsable set stay on Discover.
- **Discover:** categories, collections, providers, filters (area/near me, for children, ladies only, free trials, camps).
- **Ranking** stays the recorded rule-based model (eligibility → interests → proximity/schedule/availability/rating) for launch; revisit when the catalogue grows.
- **Sequencing:** a redesign of an approved surface → owner design approval → customer-app design milestone → implementation; not before the Provider Schedule slice (a feed with nothing bookable helps nobody).

## 16. Multi-participant booking (owner ruling: launch scope)

"Who is attending" becomes checkboxes. Ticking several family members (children and/or "You") produces one checkout, one payment, one confirmation, and underneath **one booking per participant inside one booking group** — each participant keeps their own pass, check-in code, attendance and cancellation, while the payment and receipt are one. Eligibility is checked per participant and stated per participant; if one is refused (age, capacity) the checkout continues with the eligible ones and says who was left out. Partial cancellation follows the ordinary per-booking policy. Placement: after the Provider Schedule slice and the membership vocabulary decision, before the design-partner sessions.

## 17. Referrals and Himma credits (owner ruling)

- A member shares a code or link. When the referred person creates an account with it, **pays for a booking and actually attends** (check-in), the referrer earns a fixed reward in **AED as Himma credit** (amount to be fixed by the owner; working figure ~AED 30). Payment without attendance, or paid-then-refunded, never qualifies — this is the loop defence. Add a cap per referrer per period and a minimum booking value.
- **Credits at checkout:** a line shows "You have AED X of Himma credit", ticked by default so it is deducted from the total; the customer can untick it to keep it for later. Usable on any payment — sessions, memberships, packages.
- **Not cash:** credit stays inside the marketplace; no payout, no bank details. The credits ledger (docs/24) must be built; redemption changes the price breakdown and the commission basis, so it is designed together with the finance rulings (FI-01…03).
- Provider-side referral (a provider bringing existing clients onto Himma) is a separate programme for a separate decision.
- Placement: after Stripe TEST certification and the credits ledger; before public launch.

## 18. Customer App — three lists

- **Fix before launch:** Home/Discover split; area as a filter with Near me; single-participant skip; native date picker; Saved built under Profile or removed from the dock; membership vocabulary applied to the provider form and app copy; seed schedules for every seeded programme.
- **Owner rulings recorded here:** Kids tab + dock change; Home feed direction; launch taxonomy list; multi-participant booking as launch scope; referrals as Himma credit with attendance qualification; location permission still open.
- **Not defects:** Passes/calendar behaviour for a `monthly` programme purchase; demo-seed gaps.

## 19. Talking points for the senior engineer (Customer App)

1. Discovery restructure (Home feed, Discover, Kids tab, Saved under Profile) as one design milestone after owner approval; keep the rule-based ranking.
2. Area → filter + Near me; after-school/camps visibility moves to the Kids tab; taxonomy content per the owner's list.
3. Commercial vocabulary: reconcile `monthly` (fixed-timetable programme) vs `membership` (access pass) in provider UI and app copy; memberships with durations and a start date; seed data corrected.
4. Booking group for multi-participant checkout (schema-ready per docs/24 B9); per-participant eligibility and cancellation.
5. Credits ledger + referral programme (code, attribution, attendance-qualified reward, checkout redemption with the finance rulings).
6. Small fixes: native date picker; single-participant step skip.
7. Everything here is unbuilt scope or owner direction, not defects in certified behaviour; nothing starts without authorization; `productionChargingPossible` stays literal `false`.

