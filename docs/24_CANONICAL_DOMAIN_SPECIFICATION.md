# 24 — Canonical Production Domain Specification

Status: **conditionally approved by the product owner at `8553557`; Amendment A1 applied; awaiting final owner approval.** Prepared 2026-08-06 as the docs/23 §16 P0 deliverable "§5–§7 canonical-model specification".

**Amendment A1 (2026-08-06, owner rulings on the two flagged confirmation points — documentation-only, applied in place):**

1. **Enrolment inventory.** The first draft's `enrolment_pool` (seat capacity carried on RecurringSchedule) is **rejected**: a recurring schedule remains a purely temporal scheduling rule and never owns inventory. The canonical bookable inventory unit for monthly/term enrolments is the new **EnrolmentCohort** entity (§2.3) — a term, month, intake, or cohort with its own capacity, counts, cutoff, lifecycle, and price/policy references. `CapacityHold` targets exactly one inventory unit: Session, CampWeek, or EnrolmentCohort, all three under the identical database capacity and capacity-floor invariants. Superseded first-draft wording is corrected in §§2.3–2.4, 3.4, 5.4, 7, 11, 12, 13, 14.A2, 15.
2. **System-initiated refunds.** System initiation of a Refund is approved **only** where an authoritative event and a deterministic policy calculation establish the refund obligation (e.g. a policy-evaluated `refund_due` cancellation, a session disruption); the system creates the refund request with the calculated amount, and normal approval remains a separate Finance action — `initiated_by ≠ approved_by` always holds. Gateway **voids and automatic same-amount reversals** compensating a failed checkout saga or lapsed hold are explicitly distinguished: they are append-only `PaymentTransaction` reversal postings, **not** discretionary Refund records, and may execute automatically with audit and reconciliation. Automatic **approval** of ordinary customer/provider refunds is **not** authorized. Corrected in §§4.1, 5.7, 7.5, 8.6, 14.B6. This is the implementation-ready expansion of docs/23 §5 (canonical domain model), §6 (lifecycle state machines), and §7 (server-side authorization), plus the transaction, saga, event, API, migration, and sequencing detail the production database, APIs, customer app, provider portal, and admin portal all follow. It is a documentation and architecture deliverable: **no backend code, schema, or migration accompanies it**, and its approval starts nothing by itself (docs/23 §4 hard sequencing).

**Amendment A2 (2026-08-07, owner ruling D-S4-1 applied via docs/28 Amendment A1 — documentation-only, applied in place):** one canonical Program (listing) may carry MULTIPLE commercial price options through the **ProgramPriceOption** child entity (§2.2): Program = the discoverable activity/service concept; ProgramPriceOption = a commercial way to purchase/access that same concept (e.g. `Gym Access` with monthly/3-month/annual membership options; `Swedish Massage` with 60-minute/90-minute/5-session-package options). The first draft's single `price_model` field on Program is superseded — no authoritative single Program price exists; catalogue reads derive `from`-price displays from active options (docs/28 §14 boundary). Binding modelling rule: options never collapse materially different customer experiences into one listing (adult vs children, private vs group, different activities/content/search-intent = separate Programs). Options are catalogue/commercial metadata ONLY — capacity stays with Session/CampWeek/EnrolmentCohort (§2.3–2.4), entitlement/redemption with Enrolment/PackageEntitlement (§3.4), and money truth with PriceQuote (§3.2/§4.2). Search/discovery remain LISTING-level: one result per Program across providers, never one per option. Superseded wording is corrected in §2.2, §2.6, and §12.1.

Governing documents: docs/23 (master plan — where this document elaborates, docs/23 §§5–7 remain the authority of record and this document must be corrected if they ever disagree), docs/01–22 (approved product record), docs/09 §§17–22 (owner decisions), HANDOFF.md (live frontend state). The docs/23 §19 payment prohibition is restated here and remains fully active.

Discipline rules for every consumer of this document:

- **One vocabulary.** New contracts in any workstream use the nouns defined here. Existing customer mock contracts are conforming subsets (docs/23 §1.4); §12 maps every one of them. No workstream invents parallel nouns.
- **No silent business decisions.** Everything this document could not decide is recorded in §14 with its blocking effect. In particular, this document does **not** decide VAT, provider commission, recurring billing semantics, cancellation-policy templates, waitlists, multi-participant launch scope, production bundle identifiers, or the payment gateway.
- **Server authority.** Pricing, eligibility, availability, and status are computed server-side. Client state is display convenience (docs/08 §14, docs/23 §7).
- **Append-only money and audit.** Financial, credit, and audit history is never edited; corrections are compensating records (docs/23 §5, §6.6).

---

## 1. Accounts and identities

### 1.1 Identity spine

One logical identity model serves all three frontends. Physical separation of customer and staff/admin identity stores is a W4 implementation choice; the logical model is binding.

| Entity | Fields (key fields bold) | Rules |
|---|---|---|
| **User** | **id**, status (`active` \| `locked` \| `deleted`), mfa_enrolled, created_at, last_login_at, version | The authentication principal. A User may hold at most one CustomerAccount, any number of StaffMemberships, and any number of AdminRoleAssignments — but the server evaluates each request in exactly one principal context (§10.1). |
| **AuthIdentity** | **id**, **user_id**, provider (`apple` \| `google` \| `email`), **subject** (provider-issued stable identifier; for `email`: normalized address), email?, email_verified, created_at | Unique `(provider, subject)`. Multiple identities may attach to one User (e.g. Apple + email). Email/password credentials store only a salted hash; Apple/Google store no tokens beyond the subject and refresh material required by the provider contract. Identity linking/unlinking is audit-evented. |
| **Session/Token** (concept) | short-lived access token + rotating refresh; provider-staff tokens are **org-bound** and carry role + branch scope; admin tokens carry role; customer tokens carry account id | MFA is mandatory for all provider-portal and admin-portal principals (docs/23 §7); customer MFA is optional. Token format/lifetimes are W4 configuration (§14.C). |

### 1.2 Customer accounts and participants

| Entity | Fields | Rules |
|---|---|---|
| **CustomerAccount** | **id**, **user_id** (unique), display_name, contact_email, contact_phone?, notification_prefs, consent_records (append-only child table), status (`active` \| `suspended` \| `deletion_requested` \| `anonymized`), created_at, version | One adult customer owns one account (docs/02 §1). Account deletion is a data-subject workflow (§6.14 retention): PII is erased/pseudonymized while financial and audit records survive in anonymized form. |
| **Participant** | **id**, **account_id**, kind (`self` \| `child`), first_name, date_of_birth (required for `child`; optional for `self`), interests (activity-type ids), accessibility_prefs?, status (`active` \| `archived`), created_at, version | Exactly **one `self` participant per account**, created with the account, displayed as "Me"/"You" (docs/02 §4) — enforced by a partial unique index. Child profiles are parent-managed, are **not** logins, and carry only delivery-necessary fields. The extended child field set (medical/safety notes, emergency contact, consent artifacts) is **pending counsel** (docs/02 §5, docs/23 §13) and is modeled as a separate, later `ParticipantLegalProfile` table so its arrival is additive (§14.B1). Age is always computed **server-side against the session/enrolment start date**, never "today" and never client-side (docs/23 §5). |

The frontend's `ParticipantId = 'everyone'` is a **client-only browsing pseudo-context**. It is not an entity, never appears in any API payload that mutates state, and no server table references it (§12.1).

### 1.3 Provider organizations, branches, and staff

| Entity | Fields | Rules |
|---|---|---|
| **Organization** | **id**, legal_name, trade_name (customer-facing "provider" name), description (en, ar?), verification_state (§5.1), commercial_terms_ref (§14.B4), default_policy_refs, media_refs, suspended_at?, offboarded_at?, created_at, version | The commercial counterparty. Customers see the word "provider"; the canonical entity is Organization. Only `live` organizations appear in the customer catalogue. |
| **Branch** | **id**, **organization_id**, label, area_id, geo_point?, address, opening_hours, facilities, active, created_at, version | Every organization has ≥ 1 branch. Programs reference branches of the **same** organization (§6.9 ownership). |
| **StaffMembership** | **id**, **user_id**, **organization_id**, role (§10 provider roles), branch_scope (`all` \| explicit branch-id set), state (`active` \| `revoked`), invited_by, created_at, version | Unique `(user_id, organization_id)` active membership. Role/branch-scope changes are audit-evented. Only the Owner role manages memberships (docs/23 §7). |
| **StaffInvitation** | **id**, **organization_id**, email, role, branch_scope, token_digest, invited_by, expires_at, state (§5.2), created_at | The invitation carries the intended role and scope; acceptance creates (or links) the User and the StaffMembership atomically (§7.10). Tokens are single-use, stored as digests. |

### 1.4 Admin and platform identities

| Entity | Fields | Rules |
|---|---|---|
| **AdminRoleAssignment** | **id**, **user_id**, role (`operations` \| `support` \| `finance` \| `access_admin` \| `auditor`), granted_by, second_approver? (required for finance-capable roles), expires_at?, state (`active` \| `revoked`), created_at | Grants are made only by Access administrators; **finance-capable grants require a second access-admin approval** recorded on the row (`granted_by ≠ second_approver`, docs/23 §7). |
| **AuditorGrant** | **id**, **user_id**, data_domain (financial \| verification \| access \| support \| …), purpose (recorded reason), expires_at, granted_by, state | Auditor access is domain-scoped, purpose-bound, expiring, PII-masked by default; unmasking is a separate per-record/per-case grant, individually logged; exports are logged and watermarked (docs/23 §7). |
| **Platform engineer** | no business-data role rows — infrastructure IAM only | No standing business-data access. **Break-glass** access is a time-boxed, ticket-referenced, dual-acknowledged grant that emits audit events at grant, at every access, and at expiry, and is post-reviewed (docs/23 §7). |

**There is no universal super-admin** (docs/23 §7). No principal combines business-data mutation, financial execution, role granting, and infrastructure power.

---

## 2. Catalogue and supply

### 2.1 Taxonomy and collections (admin-owned)

| Entity | Fields | Rules |
|---|---|---|
| **Category** | **id**, label (en, ar?), image_ref, sort_hint, version | The approved 12-entry taxonomy (docs/15 §3) is the launch content. Admin-owned and versioned; customer-facing ordering may additionally be supply-aware (existing behavior). |
| **ActivityType** | **id**, **category_id**, label (en, ar?), synonyms (en[], ar[]), version | One canonical activity per type; adult and junior variants are different **Programs**, never duplicated types (docs/15 §2). The synonym arrays feed search (docs/14 §3.4). |
| **Collection** | **id**, title (en, ar?), subtitle?, image_ref, filter_preset (typed, server-resolved), audience (`all` \| `adults` \| `children`), child_focused (boolean), featured, seasonal_label?, state (`draft` \| `published` \| `archived`), version | Collections are admin-curated data resolving to filtered results — deletable without schema change (docs/15 §2). `child_focused` drives the docs/18 §6 visibility gate; no logic ever branches on titles. |

### 2.2 Programs (listings)

| Entity | Fields | Rules |
|---|---|---|
| **Program** | **id**, **organization_id**, branch_ids (≥ 1, same org), **activity_type_id** (→ category derived), title (en, ar?), description (en, ar?), media_refs, setting (`indoor` \| `outdoor`), eligibility (embedded, §2.5), price_options (≥ 1 **ProgramPriceOption** — Amendment A2; §2.6), policy_ref (cancellation policy version, §2.7), listing_state (§5.3), sensitive_fields_version, created_at, version | The discoverable offering — the ONE search/discovery unit (results are per Program, never per option). Only `published` listings are searchable/bookable. Edits to admin-designated **sensitive fields** (price options, eligibility, safety copy) re-enter review; other edits hot-publish (docs/23 §6.2). Bilingual columns exist from day one (docs/23 §3.1.1) and stay nullable until the W7 content workflow is decided (§14.B12). |
| **ProgramPriceOption** | **id** (stable opaque — the future booking draft selects options by id, never label/position), **program_id** (same-org composite ref), kind (§2.6 launch subset), amount_fils?, sessions_count? (package), label (en, ar?), sort_hint, state (`active` \| `archived`), version | **Amendment A2:** a commercial way to purchase/access the SAME listed concept — one Program, many options (trial arrives via Offer). Catalogue/commercial metadata ONLY: never the capacity, booking, entitlement, payment, attendance, or redemption record (capacity: §2.3–2.4 units; entitlements: §3.4; money truth: PriceQuote §3.2/§4.2). Options must not collapse materially different customer experiences into one listing — adult vs children, private vs group, different activities/content/search-intent are separate Programs. ≥ 1 active option required for publication; archive-only retirement. |
| **Offer** | **id**, **program_id**, kind (`freeTrial` \| `paidTrial` \| `discount` \| `promo`), label (en, ar?), trial_amount_fils? (structured, for paid trials), effective range, state | Offers are structured records. Until the owner's pricing decisions exist, `discount`/`promo` offers remain **informational** in every customer surface (docs/09 §22.5); when quote-applied discounts arrive they flow through PriceQuote lines (§4.2), never label parsing. |
| **Instructor** | **id**, **organization_id**, display_name, title_line, media_ref?, state (`active` \| `archived`), version | Optional. Sessions and programs may reference instructors for display and for the Coach/Instructor authorization scope (§10). Instructor *profiles* beyond name/title/photo are future scope (docs/20 §8.5). |

### 2.3 Schedules, sessions, camp weeks, enrolment cohorts

| Entity | Fields | Rules |
|---|---|---|
| **RecurringSchedule** | **id**, **program_id**, weekday/time pattern, timezone (`Asia/Dubai`), effective_start, effective_end?, exceptions (dates), registration_cutoff_rule, instructor_id?, state (`active` \| `ended`), version | **A purely temporal scheduling rule — it never owns inventory** (Amendment A1.1). The authority that replaces the mock `scheduleLabel` derivation (docs/23 §5). Session generation from schedules is an idempotent job (§7 note); generated sessions may then be individually managed. |
| **EnrolmentCohort** | **id**, **program_id**, **branch_id**, effective_start, effective_end, schedule_ids (≥ 1 RecurringSchedule refs — the cohort's meeting pattern), **capacity**, **booked_count** (confirmed enrolments), **held_count**, enrolment_cutoff_at, state (§5.4), price_ref (defaults to the booked ProgramPriceOption — Amendment A2; cohort-level override), policy_ref (defaults to the program's cancellation-policy version; cohort-level override), version | **The canonical bookable inventory unit for monthly/term enrolments** (Amendment A1.1): one term, month, intake, or cohort. Capacity truth lives here under the §6.2 invariants, exactly as on Session/CampWeek. An enrolment booking claims a cohort seat through the standard hold machinery (§3.3); the referenced schedules define when the cohort meets, never how many may join. |
| **Session** | **id**, **program_id**, schedule_id?, **branch_id**, start_at, end_at (UTC; presented Asia/Dubai), **capacity**, **booked_count**, **held_count**, session_state (§5.4), registration_cutoff_at, per-session eligibility override?, instructor_id?, version | **Capacity truth lives here**, guarded at the database layer (§6.2). Per-session eligibility overrides support "eligibility can vary by session" (docs/06 §9); absent override, the program's eligibility applies. |
| **CampWeek** | **id**, **program_id**, **branch_id**, date_range, daily time, **capacity**, **booked_count**, **held_count**, state (mirrors §5.4), registration_cutoff_at, version | The week-granularity bookable unit (docs/09 §21.7). Identical capacity machinery to Session. |

### 2.4 Capacity units (uniform interface)

Holds, bookings, and the capacity invariants operate on a **capacity unit**: `(unit_kind, unit_id)` where `unit_kind ∈ {session, camp_week, enrolment_cohort}`. A CapacityHold targets **exactly one** inventory unit.

- `session` — one dated occurrence (drop-in, free session, trial session).
- `camp_week` — one camp week.
- `enrolment_cohort` — one EnrolmentCohort (§2.3) for monthly/term enrolments. **Owner-ruled (Amendment A1.1):** docs/23 §5 defined holds against session/camp-week refs only; the owner directed this extension as a first-class inventory entity — never as capacity carried on a recurring schedule.

Every capacity unit obeys the same two database-enforced invariants (§6.2): no overselling, and no capacity reduction below commitments outside the disruption workflow.

### 2.5 Eligibility (owner-final model)

Unchanged from the approved model (docs/05 §7, `Eligibility` in `src/types/domain.ts`): `minimum_age?`, `maximum_age?` (null = open-ended), `all_ages`, `gender_eligibility` (`men` \| `ladies` \| `mixed`), `skill_level?`, `notes?`. Attached to Program; overridable per Session. Server rules, binding everywhere:

1. Child suitability is **purely age-based**, computed against the unit's start date.
2. Adults are **never** gender-filtered automatically; "Ladies only" is an explicit customer filter/badge over `gender_eligibility = 'ladies'`.
3. Eligibility is **revalidated server-side** at hold creation and at booking confirmation (§7); client eligibility display is convenience.

### 2.6 Pricing model and quotes

- **Catalogue price (Amendment A2):** price kinds live on **ProgramPriceOption** rows (§2.2) — one row per commercial shape, ≥ 1 per Program; the launch kind subset is `dropIn`, `monthly`, `term`, `camp`, `package`, `free`, with amounts in **integer fils**. `membership` and `weekly` are model-ready extensions pending the owner (docs/09 §21.14, §14.B7). The mock's unused `freeTrial` price kind is dropped — trials derive from Offers (HANDOFF; §12.2). No single authoritative `Program.price` exists; customer-facing `from`-price displays are derived at read time from active options (docs/28 §14 boundary).
- **PriceQuote** is the server-computed money truth — see §4.2. **The frontend never computes money** (docs/23 §5): checkout displays the quote, payment references the quote.

### 2.7 Cancellation-policy references

| Entity | Fields | Rules |
|---|---|---|
| **CancellationPolicyTemplate** | **id**, **template_version**, title (en, ar?), summary_lines, rule structure (windows → refund destinations/proportions), state (`draft` \| `active` \| `retired`) | Templates are platform-versioned records. The **content** of launch templates (windows, proportions, credit incentives) is an open owner decision (docs/09 §7, §14.B6); the three mock presets are placeholders, not templates. |
| Policy snapshot | booking.policy_snapshot_ref → (template id, version) | Every confirmed booking freezes the policy version it was sold under (docs/23 §6.7); later template edits never change existing bookings' terms. |

### 2.8 Listing review and publication

Listing lifecycle is §5.3. Operational rules: admin review queues group bulk-imported batches with batch-level actions (docs/23 §8.5); import-created listings are always `draft` — the review loop is not bypassable by import; publishing emits a `listing.published` event that invalidates catalogue caches and feeds the search index (§9.6).

---

## 3. Booking and inventory

### 3.1 Booking drafts (client-only)

`BookingDraft` remains **client-only and never persisted** (docs/23 §6.5, docs/09 §21.13). The server's first sight of a booking attempt is the quote request; its first durable record is the CapacityHold + Booking row pair written at checkout confirmation (§7.4). Draft-persistence/restoration remains deferred (§14.B).

### 3.2 Server-generated price quotes

See §4.2 for the entity. Flow rules:

1. The client requests a quote for `(program, option kind, unit, participant)`; the server validates eligibility and availability and returns the full line breakdown with **quote_id, version, and expires_at**.
2. Quotes are short-TTL (configurable, §14.C). An expired quote forces a visible re-quote — never a silent refresh (docs/23 §12.6).
3. The quote is referenced by the hold, the booking, and the payment intent; **payment may only be taken for the exact quoted amount of an unexpired quote**.

### 3.3 Capacity holds

Per docs/23 §6.4, restated as binding rules:

- **Creation is one atomic DB transaction**: claim the capacity (subject to §6.2 invariants) and insert the hold already `active` with its TTL started — or do neither. There is no committed intermediate.
- Holds are created when the customer commits to pay (checkout confirmation begins), **before** any charge. `sessionFull` is returned fast when no capacity remains.
- **Capture is only permitted against an `active` hold.** A lapsed hold aborts pre-charge, or triggers an automatic same-amount reversal in the §8.6 race window.
- Expiry and release restore capacity atomically. TTL is minutes-scale, tuned per gateway flow (§14.C); customers are never told anything is "reserved" beyond the truthful in-checkout window.
- quantity = 1 at launch (one participant per booking, docs/09 §21.2); the column exists for the future booking-group widening.

### 3.4 Bookings and enrolments

| Entity | Fields | Rules |
|---|---|---|
| **Booking** | **id**, **account_id**, **participant_id**, **program_id**, organization_id, branch_id, option_kind (docs/21 §11 vocabulary), unit ref (`unit_kind`, `unit_id`), **quote_ref**, **hold_ref**, state (§5.6), reference_code (customer-facing, non-enumerable), policy_snapshot_ref, confirmed_at?, cancelled_at?, cancellation_ref?, created_at, version | One participant per booking at launch; the schema permits a future booking group (docs/23 §5) without migration of existing rows. `confirmed` is the only state any frontend may call "booked". |
| **Enrolment** | **booking_id** (subtype), **cohort_id** (→ EnrolmentCohort, matching the booking's unit ref), billing_anchor_date, cadence (`monthly` \| `term`), renewal_policy (**owner-open**, docs/09 §6 — column exists, no value semantics until §14.B5) | Subtype rows for monthly/term bookings; the booking's capacity unit is the EnrolmentCohort (Amendment A1.1). No auto-renewal behavior may be implemented before the owner decision. |
| **PackageEntitlement** | **booking_id** (subtype), sessions_total, sessions_used, expiry_policy (**owner-open**, docs/09 §21.7) | Package redemption/expiry rules are undecided; the entitlement records only what the catalogue sold. |

### 3.5 Attendance

| Entity | Fields | Rules |
|---|---|---|
| **AttendanceRecord** | **id**, **booking_id**, **session_id**, status (`expected` \| `attended` \| `no_show` \| `excused`), marked_by (staff user), marked_at, version | Written by Coach/Instructor (own sessions) or Front-desk (assigned branches) — §10. Attendance on a completed session feeds payout accrual (completed bookings, §6.8 of docs/23) and the future verified-review gate (docs/09 §15). Corrections are audit-evented updates within a short window, then locked (window configurable, §14.C). |

### 3.6 Cancellations and session disruptions

- **CancellationCase** (customer- or provider-initiated): **id**, booking_id, initiator (customer \| provider \| admin), requested_at, policy evaluation result (`refund_due(amount_fils)` \| `no_refund`), state (§5.7), linked Refund ref?. Policy evaluation always runs against the booking's **policy snapshot** (§2.7).
- **SessionDisruption** (controlled disruption workflow, docs/23 §6.3): **id**, unit ref, initiator, reason, affected_booking_ids (selection policy default latest-confirmed-first, owner-adjustable), state (`draft` \| `executed`), created_at. Executing a disruption transitions affected bookings to `cancelled_by_provider` with §5.7 refund handling, notifies customers (§9.6 events), releases capacity, and records the full action. **This workflow is the only path that may reduce effective capacity below existing commitments.**

### 3.7 Capacity invariants (restated)

For every capacity unit, at all times, enforced at the database layer (§6.2):

1. `booked_count + held_count ≤ capacity` — overselling is impossible regardless of application bugs.
2. `capacity` may never be updated below `booked_count + held_count` — the capacity floor; provider/admin edits below the floor are rejected; only the §3.6 disruption workflow reduces commitments first.
3. `booked_count` and `held_count` change **only** inside the §7 transaction boundaries, atomically with the hold/booking state transition that justifies the change.

---

## 4. Payments and finance

All financial history is **append-only**; corrections are compensating records, never edits (docs/23 §5). All amounts are integer fils; currency is AED at launch (§6.1).

### 4.1 Entities

| Entity | Fields | Rules |
|---|---|---|
| **PriceQuote** | **id**, program_id, option_kind, unit ref, participant_id, lines (kind `base` \| `discount` \| `fee` \| `tax` \| `credit`; label; amount_fils), total_fils (must equal the line sum — §6.3), currency, price_kind (`oneOff` \| `cadence` \| `free`), tax_treatment, **expires_at**, created_at | The server money truth (§3.2). Until the owner's VAT/fee decisions exist, quotes emit `base` lines only and `tax_treatment = 'notConfigured'` — the structure is complete, the config is empty (docs/09 §22.2–5). |
| **PaymentIntent** | **id**, **booking_id**, quote_ref, hold_ref, amount_fils, currency (`AED`), state (§5.8), **idempotency_key** (unique), expires_at, created_at, version | One per checkout confirmation attempt-series; a retried confirmation request rejoins the same intent via its idempotency key. |
| **PaymentAttempt** | **id**, **intent_id**, sequence_no, method (`card` \| `applePay` \| `googlePay`), gateway_ref, state (§5.8), failure_code?, threeds_ref?, created_at | **Append-only**: every retry is a new attempt; attempts are never mutated after a terminal state. |
| **PaymentTransaction** | **id**, **attempt_id**, kind (`authorization` \| `capture` \| `refund` \| `reversal` \| `adjustment`), amount_fils, currency, **gateway_transaction_id** (unique), posted_at | **The append-only financial ledger.** No state machine, no edits; the sum of postings is the financial truth. |
| **GatewayEvent** | **id**, **gateway_event_id** (unique — replay-safe), payload digest, signature_verified, received_at, processing_state (`received` \| `verified` \| `processed` \| `quarantined`), linked attempt/transaction refs | Append-only webhook inbox; processing is idempotent by gateway event id; signature/replay failures quarantine with alerting (docs/23 §6.6). Webhooks are authoritative — intent/attempt states converge **to** them, never the reverse. |
| **Refund** | **id**, originating transaction ref, booking_id, amount_fils, destination (`original_method` \| `marketplace_credit`), reason, state (§5.9), **initiated_by** (support/ops principal, or a **system principal** only where an authoritative event and a deterministic policy calculation establish the obligation — Amendment A1.2), **approved_by** (must differ — §6.5; normal approval is always a separate Finance action), resulting refund-transaction ref, created_at | Dual control is a database invariant, not a UI convention. A Refund is a **discretion-bearing money-out decision record**; it is not the vehicle for saga compensation (see the reversal rule below). |

**Voids and reversals are not Refunds (Amendment A1.2).** Gateway voids and automatic same-amount reversals that compensate a failed checkout saga or a lapsed hold (§8.6) are **append-only `PaymentTransaction` postings of kind `reversal`** — they carry no discretion, require no Refund record and no Finance approval, and may execute automatically, fully audit-evented and covered by daily reconciliation (§8.9).
| **ReconciliationEvent** | **id**, run_id, scope (day/gateway), expected vs observed diffs, resolution_state, actor, created_at | Daily reconciliation output; unresolved diffs alert finance (docs/23 §13). Append-only. |
| **CreditLedgerEntry** | **id**, **account_id**, class (`refund` \| `promo` \| `referral` \| `gift`), amount_fils, direction (`credit` \| `debit`), expiry_policy_ref?, booking_ref?, actor, created_at | **Append-only ledger; balance is a projection** (docs/09 §8). Class-specific expiry/transfer rules are owner-open (§14.B8); the structure carries a policy ref so rules arrive as configuration. |
| **PayoutStatement** | **id**, **organization_id**, period, line entries (append-only: per completed booking gross, commission, adjustments incl. refund clawbacks), gross_fils, commission_fils, net_fils, **drafted_by**, **approved_by** (must differ), state (§5.10), created_at | Commission structure and payout cadence are owner-open (§14.B4); the statement math is structural and reconciles by construction. Adjustments post to the **next** statement as append-only entries — statements are never edited after approval. |
| **Payout** | **id**, **statement_id**, transfer amount, destination ref (Owner-maintained bank details), state (within §5.10), gateway/bank ref, created_at | The execution record of an approved statement. |
| **AuditEvent** | **id**, actor (user/system + principal context), action, entity ref, before/after digest, request_id, occurred_at | Append-only; **every §5 state transition emits one**, as do PII views, auth grants, break-glass usage, exports, and configuration changes. |

### 4.2 Money rules (binding)

1. Integer fils everywhere; no floating-point money anywhere in the platform.
2. AED is the only launch currency; every money-bearing row carries a currency column constrained to `AED` (widening later is a migration, not a rewrite).
3. Every customer-visible amount traces to a PriceQuote line or a PaymentTransaction posting. Labels are formatting; amounts are structured (docs/09 §22.5).
4. `Total` wording appears in a customer frontend **only** when the displayed breakdown is an authoritative server quote reconciling all applicable taxes, fees, discounts, and credits exactly (docs/09 §22.4).

---

## 5. State machines

Authoritative states and the **only** valid transitions. Anything not listed is invalid; the server rejects it with a typed error (§11.6) and no state change. Every transition is audit-evented and (where noted) outbox-evented (§9). Client UIs may never fake a state.

### 5.1 Provider organization (docs/23 §6.1)

| From | To | Actor | Notes |
|---|---|---|---|
| `draft` | `submitted` | provider owner | Submission completeness validated |
| `submitted` | `in_review` | admin operations | Case assignment (VerificationCase) |
| `in_review` | `verified` | admin operations | Checklist complete |
| `in_review` | `rejected` | admin operations | Decision notes required |
| `rejected` | `submitted` | provider owner | Resubmission |
| `verified` | `live` | admin operations | Go-live; org enters customer catalogue |
| `live` | `suspended` | admin operations | With customer-impact handling (docs/23 §12.8) |
| `suspended` | `live` | admin operations | |
| `live`, `suspended` | `offboarded` | admin operations (owner-requested or platform-initiated) | Terminal; future bookings mass-handled first |

### 5.2 Staff invitation

| From | To | Actor | Notes |
|---|---|---|---|
| `sent` | `accepted` | invited user | Atomic with User/StaffMembership creation (§7.10); token single-use |
| `sent` | `revoked` | provider owner | |
| `sent` | `expired` | system (TTL job) | Resend = a new invitation row |

### 5.3 Listing (program) (docs/23 §6.2)

| From | To | Actor | Notes |
|---|---|---|---|
| `draft` | `submitted` | listings editor / org manager | Bulk import creates `draft` only |
| `submitted` | `in_review` | admin operations | |
| `in_review` | `approved` | admin operations | |
| `in_review` | `changes_requested` | admin operations | → `submitted` on provider resubmit |
| `approved` | `published` | provider (or auto on approval — configurable, §14.C) | Emits `listing.published` |
| `published` | `paused` | provider | Hidden from search; existing bookings unaffected |
| `paused` | `published` | provider | |
| `published`, `paused` | `archived` | provider or admin | Terminal; sessions handled via §3.6 if commitments exist |

Sensitive-field edits (price, eligibility, safety copy — admin-designated list) move a `published` listing's pending revision through `submitted → in_review` while the current version stays live; other edits hot-publish.

### 5.4 Session (docs/23 §6.3) — CampWeek and EnrolmentCohort mirror this machine

For an EnrolmentCohort (Amendment A1.1): `closed` triggers at its `enrolment_cutoff_at`; `completed` triggers after `effective_end`; `cancelled_by_provider` runs only through the §3.6 disruption workflow, exactly as for sessions.

| From | To | Trigger | Notes |
|---|---|---|---|
| `scheduled` | `open` | registration opens (time or provider action) | |
| `open` | `full` | automatic — capacity exhausted | Atomic with the count change |
| `full` | `open` | automatic — capacity released (cancellation, hold expiry) | Atomic with the count change |
| `open`, `full` | `closed` | registration cutoff (server-computed, Asia/Dubai — docs/23 §12.12) | |
| `scheduled`, `open`, `full` | `cancelled_by_provider` | §3.6 disruption workflow only | Affected bookings handled in the same workflow |
| `closed` | `completed` | system, after end time (idempotent job) | Feeds attendance close-out and payout accrual |

### 5.5 Capacity hold (docs/23 §6.4)

| From | To | Trigger | Notes |
|---|---|---|---|
| *(nonexistent)* | `active` | hold transaction (§7.1) | Creation claims capacity atomically; no pre-state |
| `active` | `consumed` | booking confirmation transaction (§7.4) | Same transaction writes booking `confirmed` and finalizes counts |
| `active` | `expired` | TTL lapse (system job) | Capacity released atomically (§7.2) |
| `active` | `released` | customer abandons / payment terminally fails | Capacity released atomically (§7.2) |

### 5.6 Booking (docs/23 §6.5)

| From | To | Trigger | Notes |
|---|---|---|---|
| *(client draft — never persisted)* | `pending_payment` | checkout confirmation begins (§7.4a) | Hold `active`, intent open |
| `pending_payment` | `confirmed` | capture confirmed (§7.4b) — or immediately for free bookings (§7.3) | Hold consumed in the same transaction |
| `pending_payment` | `expired` | hold/quote TTL lapse | |
| `pending_payment` | `payment_failed` | terminal attempt failure | → `pending_payment` on retry with a fresh or still-active hold |
| `confirmed` | `cancelled_by_customer` | §5.7 case | |
| `confirmed` | `cancelled_by_provider` | §3.6 disruption / suspension handling | |
| `confirmed` | `completed` | unit completed + attendance close | |
| `confirmed` | `no_show` | attendance marking | |

`confirmed` is the only state any frontend may present as "booked".

### 5.7 Cancellation and refund (docs/23 §6.7)

Cancellation case: `requested → policy_evaluated → refund_due(amount) | no_refund` (evaluation against the policy snapshot; server-computed windows in Asia/Dubai).

**Initiation (Amendment A1.2):** a Refund in `initiated` is created by admin support/ops, **or by the system** where an authoritative event (a policy-evaluated `refund_due` cancellation §7.5, a session disruption §7.6, a provider suspension mass-handling) and a deterministic policy calculation establish the obligation and its amount. System initiation creates the request only; **normal approval remains a separate Finance action** (`initiated_by ≠ approved_by` holds — a system initiator never approves), and automatic approval of ordinary customer/provider refunds is **not** authorized. Saga-compensating voids/reversals bypass this machine entirely — they are `PaymentTransaction` reversal postings, not Refunds (§4.1).

Refund: 

| From | To | Actor | Notes |
|---|---|---|---|
| `initiated` | `approved` | admin finance — **must differ from initiator** (§6.5) | Support/ops initiate; finance approves; never self-approval |
| `approved` | `processing` | system (gateway call) | |
| `processing` | `completed` | gateway confirmation (webhook) | Posts a `refund` PaymentTransaction |
| `processing` | `failed` | gateway failure | → `approved` for retry, with alerting |

Destination is `original_method` or `marketplace_credit` per policy/owner rules (templates owner-open, §14.B6).

### 5.8 Payment intent and attempt (docs/23 §6.6)

**PaymentIntent:** `created → in_progress → succeeded | failed | expired | cancelled`. One intent per checkout confirmation; idempotency-keyed so retried requests rejoin it.

**PaymentAttempt:**

| From | To | Trigger |
|---|---|---|
| `started` | `requires_action` | gateway requests 3-D Secure |
| `requires_action` | `started` | challenge completed, processing resumes |
| `started` | `authorized` | gateway authorization |
| `authorized` | `captured` | capture (only against an `active` hold — §3.3) |
| `started`, `authorized` | `declined` | gateway decline (terminal per attempt) |
| `started`, `authorized` | `errored` | gateway/system error (terminal per attempt) |

A retry is a **new** attempt under the same intent. Authorized-not-captured attempts are voided by a `reversal` transaction. **PaymentTransaction has no state machine** — append-only postings only. **GatewayEvent:** `received → verified → processed | quarantined`.

### 5.9 Refund — see §5.7. 

### 5.10 Payout (docs/23 §6.8)

| From | To | Actor | Notes |
|---|---|---|---|
| *(accrual)* | `statement_drafted` | system at period close (+ finance review) | Per completed booking accrual lines |
| `statement_drafted` | `approved` | admin finance — **must differ from drafter** (§6.5) | |
| `approved` | `processing` | system (transfer execution) | |
| `processing` | `paid` | transfer confirmation | |
| `processing` | `failed` | transfer failure | → `approved` for retry, with alerting |

Adjustments (refund clawbacks) post to the next statement as append-only entries.

### 5.11 Support case

| From | To | Actor |
|---|---|---|
| `open` | `assigned` | admin support (assignment) |
| `assigned` | `waiting_customer` / `waiting_provider` | admin support |
| `waiting_*` | `assigned` | reply received |
| `assigned` | `resolved` | admin support |
| `resolved` | `closed` | system after a reopen window (configurable, §14.C) |
| `resolved` | `assigned` | reporter reopens within the window |

### 5.12 Verification case

`open → in_progress → decision_ready → decided(approved | rejected)` — the working record behind §5.1's `in_review`; decision notes required on rejection; append-only document/checklist history.

---

## 6. Database invariants

Enforceable rules the schema itself guarantees (docs/23 §10.1). Application code may add checks; the database is the last line and must hold under application bugs.

1. **Money:** all amounts are integer fils (`BIGINT`); CHECK constraints forbid negative amounts except on explicitly signed ledger columns; every money row carries `currency CHAR(3) CHECK (currency = 'AED')` at launch.
2. **Capacity (both directions):** for every capacity unit, `booked_count + held_count ≤ capacity` and any capacity `UPDATE` below `booked_count + held_count` is rejected — enforced by CHECK constraints plus row-level locking (`SELECT … FOR UPDATE` on the unit row inside every counting transaction, §7). Proven under contention by the docs/23 §11.1 final-seat gate before launch.
3. **Quote integrity:** `total_fils` equals the sum of line `amount_fils` — CHECK/trigger-enforced at write time; quotes are immutable after creation (re-pricing is a new quote).
4. **Organization/branch isolation:** every provider-owned row carries `organization_id`; branch-scoped rows carry `branch_id` with a composite FK ensuring the branch belongs to the same organization; **every provider-portal query is scoped by the token's organization (and branch scope) server-side**. PostgreSQL row-level security is the recommended enforcement backstop (W4 proposal); the scoping requirement itself is binding.
5. **Dual control:** `CHECK (initiated_by <> approved_by)` on Refund; `CHECK (drafted_by <> approved_by)` on PayoutStatement; `CHECK (granted_by <> second_approver)` on finance-capable AdminRoleAssignment; goodwill credits above the configured cap require a distinct approver recorded on the ledger entry (docs/23 §7).
6. **Idempotency keys:** unique constraint on `(account_or_principal, endpoint_scope, idempotency_key)`; replays return the stored outcome (§11.3), never re-execute.
7. **Gateway events:** unique constraint on `gateway_event_id`; duplicate deliveries insert-conflict into a no-op (§8.8).
8. **Append-only enforcement:** PaymentAttempt (post-terminal), PaymentTransaction, GatewayEvent, CreditLedgerEntry, ReconciliationEvent, AuditEvent, consent records, and statement lines accept `INSERT` only — no `UPDATE`/`DELETE` grants to application roles, plus `BEFORE UPDATE/DELETE` trigger guards. Corrections are compensating inserts.
9. **Ownership relationships:** composite/foreign keys guarantee: a Booking's participant belongs to the Booking's account; a Booking's unit belongs to its program; a Program's branches belong to its organization; a StaffMembership's branch scope ⊆ the organization's branches; an EnrolmentCohort's branch and referenced schedules belong to its program's organization and program respectively (Amendment A1.1); a Hold's unit matches its eventual Booking's unit; a Refund's booking matches its originating transaction's booking.
10. **State-machine enforcement:** state columns are constrained enums; transitions execute through single-statement compare-and-set (`UPDATE … WHERE id = $1 AND state = $expected AND version = $v`) so invalid transitions and lost updates fail closed (0 rows → typed rejection, §11.5).
11. **Optimistic concurrency:** every mutable aggregate carries an integer `version`, incremented on every write; mutating APIs require the expected version and return a stale-data conflict on mismatch (§11.5).
12. **Non-enumerable ids:** all ids are opaque (UUID-class; concrete generator is a W4 proposal); customer-facing reference codes are random, not sequential.
13. **Timestamps and actors:** every table carries `created_at`, `updated_at`, and the acting principal for mutations; all timestamps UTC, presented Asia/Dubai.
14. **Archival, deletion, retention:** soft-delete (`archived`/status columns) only, except where the data-subject erasure workflow applies; erasure **pseudonymizes** PII in place while preserving financial/audit rows (the ledger keeps amounts and opaque ids, loses the person); retention periods per record class are counsel-decided configuration (§14.B10) — the schema carries `retention_class` tagging so the policy is enforceable when set. No production data in lower environments (docs/23 §10.8).

---

## 7. Transaction boundaries

The exact atomic boundary for each critical operation. Each is **one** PostgreSQL transaction; each writes its outbox events **inside** that transaction (§9.1). **No boundary ever spans a network call: gateway (and any external) calls happen strictly between transactions, never inside one.** PostgreSQL and the payment gateway can never participate in one distributed transaction — orchestration across them is the §8 saga.

| # | Operation | Inside the single transaction | Never inside it |
|---|---|---|---|
| 7.1 | **Create capacity hold** | Lock the capacity unit row → check invariants (§6.2) + eligibility + registration cutoff → increment `held_count` → insert Hold `active` with TTL → insert Booking `pending_payment` (paid path; §7.3 for free) referencing quote + hold → outbox `hold.created` | The quote request (earlier), any gateway call (later). Failure inside → full rollback, capacity untouched, typed `sessionFull`/`registrationClosed`/`participantIneligible` result |
| 7.2 | **Expire or release a hold** | Lock unit row → CAS hold `active → expired\|released` → decrement `held_count` → if a `pending_payment` booking references it and no capture is in flight per stored state, CAS booking → `expired`/`payment_failed` → outbox `hold.expired`/`hold.released` | The expiry scanner's scheduling; any customer notification delivery (consumes the event) |
| 7.3 | **Confirm a free booking** | Lock unit row → validate hold `active` (created in §7.1 with a `free` quote) → CAS hold → `consumed` → increment `booked_count`, decrement `held_count` → CAS booking → `confirmed` + reference code + policy snapshot → outbox `booking.confirmed` | Nothing external exists on this path — free bookings are still **server**-confirmed, never client-claimed |
| 7.4a | **Begin paid confirmation** | (= §7.1 boundary) plus insert PaymentIntent `created` with idempotency key, amount = quote total | The gateway attempt |
| 7.4b | **Confirm a paid booking** (on verified capture evidence — webhook or synchronous gateway confirmation) | Lock unit row → validate hold `active` → CAS attempt → `captured` + insert `capture` PaymentTransaction → CAS intent → `succeeded` → CAS hold → `consumed` → adjust counts → CAS booking → `confirmed` + reference code + policy snapshot → outbox `booking.confirmed`, `payment.captured` | The capture call itself; 3-DS round-trips; webhook receipt (§7.8 stores it first). If the hold lapsed before this transaction, it aborts → §8.6 reversal path |
| 7.5 | **Cancel a booking (customer)** | Evaluate policy snapshot (pure) → insert CancellationCase with the evaluated outcome → CAS booking `confirmed → cancelled_by_customer` → lock unit row, decrement `booked_count` (future units only) → if `refund_due`: insert Refund `initiated` (**system-initiated — owner-approved, Amendment A1.2**: the authoritative cancellation event plus the deterministic policy calculation establish the obligation and amount; Finance approval remains a separate action) → outbox `booking.cancelled`, `refund.initiated?` | The refund gateway execution (own saga step after Finance approval) |
| 7.6 | **Cancel a session (provider/admin disruption)** | CAS session → `cancelled_by_provider` → for each affected confirmed booking (selection recorded): CAS → `cancelled_by_provider`, decrement `booked_count`, insert CancellationCase + Refund `initiated` per policy (system-initiated per the §5.7 Amendment-A1.2 rule; Finance approval separate) → release affected active holds → insert SessionDisruption `executed` with the full action record → outbox `session.cancelled` + per-booking `booking.cancelled` | Notification sends (consume events); refund execution |
| 7.7 | **Create and approve a refund** | Creation: insert Refund `initiated` (actor recorded). Approval (separate transaction, different principal): CAS `initiated → approved` with `approved_by` (≠ initiator, §6.5) → outbox `refund.approved` | The gateway refund call (after approval, own saga step); completion lands via §7.8 + a completion transaction posting the `refund` PaymentTransaction |
| 7.8 | **Ingest a gateway webhook** | Insert GatewayEvent (unique `gateway_event_id`; duplicate → no-op conflict) with verified-signature flag → outbox `gateway.event.received` | **All processing.** The §8 saga consumes the event asynchronously (its own transactions, e.g. §7.4b), converging state to the gateway's truth |
| 7.9 | **Produce a payout statement** | Period close: insert PayoutStatement `statement_drafted` + all accrual/adjustment lines (from completed bookings and refund clawbacks) in one transaction → outbox `payout.statement_drafted`. Approval: CAS → `approved` (`approved_by` ≠ `drafted_by`) → outbox `payout.approved` | The bank/gateway transfer (own saga step); `paid` lands on transfer confirmation in its own transaction |
| 7.10 | **Accept a staff invitation** | Validate token digest + expiry → CAS invitation `sent → accepted` → create/link User + insert StaffMembership `active` → outbox `staff.joined` | Email delivery of anything |

Cross-cutting: every transaction above operates identically on all three capacity-unit kinds — Session, CampWeek, EnrolmentCohort (Amendment A1.1) — and (a) takes the capacity-unit row lock **first** when counts change, in a globally consistent lock order (unit → hold → booking) to prevent deadlock cycles; (b) writes its outbox rows last, inside the transaction (§9.1); (c) is idempotent at the API layer via §6.6 keys, so a client retry of a committed operation returns the stored outcome without re-executing.

---

## 8. Checkout and payment saga

The paid-booking orchestration across PostgreSQL and the gateway is a **recoverable saga** (docs/23 §10.13): each step commits locally with outbox events, each has a compensating action and a recovery point, and no design pretends cross-system atomicity. A crash at any step converges by resumption or compensation plus reconciliation — never manual data surgery, and **never a customer left charged without capacity**.

| Step | Action | Compensation / recovery |
|---|---|---|
| 8.1 **Quote** | Server computes PriceQuote (eligibility + availability validated); client displays it | Quote expiry (§3.2) → visible re-quote. No state to compensate |
| 8.2 **Hold + booking + intent** | §7.4a transaction: capacity claimed, Hold `active`, Booking `pending_payment`, PaymentIntent `created` | Hold TTL is the universal backstop: §7.2 releases everything if the saga stalls. `sessionFull` fails fast pre-charge (docs/23 §12.3) |
| 8.3 **Payment attempt** | Insert PaymentAttempt `started` (own transaction); call the gateway **between** transactions; intent → `in_progress` | Gateway timeout/unknown outcome → attempt stays `started`; resolution comes from webhook or reconciliation, never a guess |
| 8.4 **3-D Secure** | Attempt `started → requires_action`; client completes the challenge; attempt resumes `started` | Abandoned challenge → attempt times out to `errored`; hold TTL releases capacity; intent expires |
| 8.5 **Capture on active hold** | On authorization/capture evidence: §7.4b single transaction — capture posted, intent `succeeded`, hold `consumed`, booking `confirmed` | Decline/error → attempt terminal, booking `payment_failed`, retry = **new attempt** while the hold lives; terminal failure → §7.2 release |
| 8.6 **Hold-lapse race** | If capture evidence arrives after the hold expired (§7.4b aborts): post an automatic **same-amount `reversal` PaymentTransaction** (or a gateway void where the attempt is only authorized), intent → `failed`, booking → `expired`; customer told honestly | This is the mechanism guaranteeing "never charged without capacity" (docs/23 §6.4, §12.4). **Amendment A1.2:** this compensation is an append-only ledger posting executed automatically with audit + reconciliation — it is never a Refund record and needs no Finance approval |
| 8.7 **Lost response** | Payment succeeded but the client never saw it: the client's retried confirmation rejoins the intent via its idempotency key and reads the converged state; the UI shows "payment received, confirming…" pending truth, **never fake success** (docs/23 §12.4) | Webhook (§7.8) + §8.5 converge the booking; reconciliation (§8.9) catches webhook loss |
| 8.8 **Duplicates** | Duplicate confirmation requests → same idempotency key → same intent, stored outcome returned. Duplicate webhooks → unique `gateway_event_id` no-op. Replayed queue events → consumer inbox no-op (§9.3) | Proven by the docs/23 §11.1 retry-storm gate: zero duplicate captures or refunds in the ledger |
| 8.9 **Reconciliation** | Daily job compares gateway records against the PaymentTransaction ledger and open intents/attempts; diffs become ReconciliationEvents; stuck `processing`/`in_progress` states alert operations within minutes (docs/23 §12.10) | States converge **to** the gateway's truth via the §7 transactions; unresolved diffs are worked by finance (AD-09) |

Free bookings short-circuit the saga: §8.1 (free quote) → §7.1 hold → §7.3 confirmation. Refund execution and payout transfer are smaller sagas of the same shape: approve (DB) → external call (between transactions) → completion transaction on confirmation, with failure → retry from `approved` and reconciliation as backstop.

---

## 9. Outbox and inbox

Binding event-integrity requirements (docs/23 §10.13).

1. **Transactional outbox:** every domain event is written to the outbox table **in the same transaction as the state change that caused it** (§7). A committed change with no event, or an event with no change, is structurally impossible.
2. **At-least-once publishing:** a relay publishes outbox rows to the durable queue, marks them published, and retries on failure; ordering is guaranteed per aggregate (per-aggregate sequence numbers), not globally.
3. **Consumer inbox:** every consumer records processed event ids inside its own processing transaction; at-least-once delivery therefore yields exactly-once effects. Consumers are safely re-runnable.
4. **Retries and dead letters:** failed processing retries with exponential backoff; exhausted retries dead-letter with alerting; DLQ replay is a routine, tested operation (docs/23 §11.1 requires DLQ empty at load-test end).
5. **Event versioning:** every event carries `event_id`, `type`, `schema_version`, `occurred_at`, aggregate ref, and actor. Schema changes are additive within a version; breaking changes mint a new version published alongside the old during a deprecation window. Consumers ignore unknown fields.
6. **Required domain events (launch set):**

| Event | Emitted by |
|---|---|
| `organization.verified`, `organization.suspended`, `organization.offboarded` | §5.1 transitions |
| `staff.invited`, `staff.joined`, `staff.revoked` | §5.2 / membership changes |
| `listing.published`, `listing.paused`, `listing.archived` | §5.3 (drives cache invalidation + search indexing, docs/23 §10.5) |
| `session.scheduled`, `session.closed`, `session.cancelled`, `session.completed` | §5.4 |
| `hold.created`, `hold.expired`, `hold.released` | §7.1–7.2 |
| `booking.confirmed`, `booking.cancelled`, `booking.completed`, `booking.no_show` | §5.6 |
| `payment.captured`, `payment.failed`, `payment.reversed` | §5.8 postings |
| `gateway.event.received` | §7.8 |
| `refund.initiated`, `refund.approved`, `refund.completed`, `refund.failed` | §5.7 |
| `credit.posted` | ledger inserts |
| `payout.statement_drafted`, `payout.approved`, `payout.paid`, `payout.failed` | §5.10 |
| `reconciliation.diff_found`, `reconciliation.resolved` | §8.9 |
| `support.case_opened`, `support.case_resolved` | §5.11 |
| `notification.requested` | any consumer needing a send (notifications are themselves event consumers) |

Consumers at launch: notification dispatch (push/email/SMS templates), search indexer, catalogue cache invalidation, payout accrual, analytics-safe projections (no child PII — docs/23 §13), and the admin operations queues.

---

## 10. Server authorization

All authorization is **enforced server-side per request**; client UI state is convenience only. Deny-by-default, role-based with organization/branch scoping (docs/23 §7 — restated here operationally; the docs/23 §7 table is the authority).

### 10.1 Principal contexts and scope resolution

A request executes as exactly one principal context: `guest`, `customer(account_id)`, `provider_staff(user, organization_id, role, branch_scope)`, `admin(user, role)`, `auditor(user, grants)`, or `system(job)`. Provider-staff tokens are org-bound; a user with multiple memberships selects one context per session. Scope resolution order: authenticate → resolve context → resolve resource ownership (org/branch/account) → role permission check → row-level constraints (§6.4) → PII tier (§10.3).

### 10.2 Permission matrix

| Principal | Scope | Can | Cannot |
|---|---|---|---|
| **Guest** | none | read the public catalogue (published listings of live orgs, taxonomy, collections, public availability) | any account-scoped read or write |
| **Customer** | own account | manage own profile/participants; browse; request quotes; create holds/bookings/payments **for own participants**; view/cancel own bookings; own credits, gifts, support cases; own data export/deletion | other customers' data; any provider internals; any admin surface; any price/eligibility override |
| **Provider: Owner** | their org (all branches) | everything Org manager can, **plus** staff role management (§5.2), commercial/payout bank details, offboarding request | other orgs; admin functions; platform taxonomy |
| **Provider: Org manager** | their org (all branches) | listings, schedules, sessions, capacity (≥ floor), offers, bookings view, attendance oversight, provider-initiated cancellations (§3.6), org reports, bulk import | staff role grants; payout bank details |
| **Provider: Branch manager** | assigned branch(es) | the Org-manager set scoped to their branches | org-wide settings; other branches; bank details |
| **Provider: Listings editor / Scheduler** | org or assigned branches | create/edit listings and schedules, submit for review, media, import previews | publishing overrides; bookings PII; reports; finance |
| **Provider: Coach / Instructor** | own assigned sessions | roster view (minimal PII: first name + age band), attendance marking for own sessions | other sessions; pricing; listings; reports; exports |
| **Provider: Front-desk** | assigned branch(es) | today's sessions, attendance marking, booking lookup (minimal PII: name + age band + booking ref) | pricing; listings; reports; exports; payout data |
| **Provider: Finance** | their org | statements, payout history, refund-impact reports | listing/schedule mutation |
| **Admin: Operations** | platform, business ops | verification cases, listing review, moderation, taxonomy, collections, provider suspension, session-disruption oversight | payment/refund execution; payouts; role grants; platform configuration |
| **Admin: Support** | platform, read-heavy | customer/booking lookup (PII-logged), support cases, goodwill credit within the configured cap, **initiating** refunds | **approving/executing** refunds; verification decisions; payouts; role grants |
| **Admin: Finance** | platform, financial | **approving/executing** refunds (never self-initiated), payout approval (never self-drafted), reconciliation resolution, fee/VAT configuration once decided | content/verification actions; role grants; initiating what they approve |
| **Admin: Access administrator** | platform, identity only | admin/support role grants and revocations (finance-capable grants need a second access-admin) | business data mutation; customer PII beyond identity records; payments; content |
| **Platform engineer** | infrastructure | deployments, infra/config, feature flags; break-glass (time-boxed, ticketed, dual-acknowledged, fully audited, post-reviewed) | routine business-data access; standing PII/payment/refund/payout/verification/role powers |
| **Auditor** | granted domains only | masked, purpose-bound, expiring, logged review; per-record unmasking by separate grant; watermarked exports | mutation; unscoped browsing; default unmasked PII; unlogged exports |

### 10.3 PII tiers and child-data minimization

- **Tier 0 (public):** published catalogue content only.
- **Tier 1 (delivery-minimal):** what a provider needs to deliver a **confirmed** booking — participant first name + age band + booking reference; accessibility needs where the customer supplied them for delivery. Coach/Front-desk see only this tier. Providers never see contact details, dates of birth, addresses, other bookings, or any data for non-confirmed customers (docs/02 §11).
- **Tier 2 (account):** the customer's own full data; support/ops access is per-view logged.
- **Tier 3 (child-sensitive/legal):** the pending-counsel legal profile (§1.2); access rules arrive with counsel; **no child data in analytics** (docs/23 §13).

### 10.4 Dual control and required audit events

Dual-control invariants are §6.5 (database-enforced). Required audit events beyond state transitions: every PII view by support/admin (record + viewer + purpose), every auth-role grant/revoke, every break-glass grant and access, every auditor unmasking and export, every capacity/price/eligibility change on published listings, every policy-template change, every platform-configuration change. Audit events are append-only (§6.8) and explorable in AD-18.

---

## 11. API contract principles

Binding on every production API in every workstream; the customer app's existing contract style (typed results, honest states, `?qa-*` discipline) is the pattern, now formalized (docs/23 §12 preamble).

1. **Server authority:** pricing (quotes), eligibility, availability, and every §5 status are computed server-side; availability and booking options are expressed over the three inventory-unit kinds — Session, CampWeek, EnrolmentCohort (§2.4) — and a hold/booking request names exactly one unit. Responses may include display-ready labels, but structured data is the truth and clients never do money arithmetic or permission logic (docs/08 §14).
2. **Typed results:** every endpoint returns a typed success shape or a typed error `{ code, message, details?, retryable? }` from a published error vocabulary. The docs/09 §22.10 `CheckoutIssueCode` set (`sessionFull` · `registrationClosed` · `priceChanged` · `offerExpired` · `participantIneligible` · `branchUnavailable` · `invalidDraft`) is the platform revalidation vocabulary, extended (never forked) as new domains need codes.
3. **Idempotency:** every mutating endpoint accepts an idempotency key (§6.6); replays return the stored outcome with an idempotent-replay marker. Payment and webhook handlers are idempotent and safely re-runnable (docs/23 §10.2).
4. **Pagination and filtering:** list endpoints use opaque cursor pagination with a bounded page size; filters are typed query objects (the existing `FilterSelection` is the customer-search subset); totals are provided where cheap, honest `hasMore` otherwise.
5. **Resource versions and stale-data conflicts:** mutable resources expose `version`; mutations carry the expected version; mismatch returns a `staleVersion` conflict with the current resource so clients re-derive and re-present — never silently overwrite (the checkout re-derive pattern, generalized).
6. **Validation errors:** malformed or rule-violating input returns field-level typed validation errors; invalid state transitions return the §5 rejection with the current state; nothing is silently repaired (docs/23 §12.2).
7. **Authentication and authorization failures:** unauthenticated → 401-equivalent `authenticationRequired`; authenticated-but-forbidden → 403-equivalent `forbidden` **without resource existence leakage** (unknown-or-forbidden reads return the same not-found shape where enumeration is a risk).
8. **Failure semantics:** clients can distinguish "not sent" from "unknown outcome" and retry safely with the same key (docs/23 §12.1); long operations expose pending states that converge (§8.7) — no fake terminal states, ever.
9. **No client-trusted decisions:** any client-supplied amount, eligibility claim, discount, role, or scope in a request body is ignored or rejected; the server recomputes from its own state.

---

## 12. Existing-frontend migration map

Every current mock type and service mapped to its production entity/API. **Target achieved: no approved screen requires redesign** — every gap is contract substitution behind existing service boundaries (docs/23 §1.5). Legend: **unchanged** = contract survives as-is; **extended** = same shape, new fields/authority; **mock-only** = dies with the mocks; **conflict** = canonical vocabulary differs (noted).

### 12.1 Domain types (`src/types/domain.ts`)

| Mock type / field | Production mapping | Class |
|---|---|---|
| `Participant` | Participant entity (§1.2); `label` becomes display composition; `interests` unchanged | extended |
| `ParticipantId = 'everyone'` | **Client-only browsing pseudo-context** — never sent to mutating APIs; server ids are opaque | mock-only (as a server concept) |
| `Area` / `AreaId` enum | Admin-owned Area reference data with geo; the closed enum opens up | extended |
| `Category`, `ActivityType`, `CategoryId` | Taxonomy entities (§2.1), admin-versioned; synonym arrays move server-side | unchanged (shape) |
| `Provider` | **Conflict (vocabulary):** canonical entity is **Organization** (§1.3); customer APIs keep serving a `provider`-shaped public projection (trade name, rating, verified), so customer contracts don't churn. `Provider.categories: string[]` (free-text display strings) is **mock-only** — production derives categories from programs via taxonomy join (the storefront already does, docs/20 §7.3) | conflict + mock-only field |
| `Program` core (`id`, `title`, `providerId`, `categoryId`, `activityTypeId`, `areaId`, `setting`, `price`, `eligibility`, `rating`, `offer`) | Program entity + published projection; `rating` becomes a review-aggregate projection | unchanged |
| `Program` schedule flags (`scheduleLabel`, `todayTime`, `availableToday`, `runsOnWeekend`, `runsAfterSchool`, `isCamp`) | **Mock-only as stored fields** — become server-computed projections from RecurringSchedule/Session data (the display labels survive as API-composed strings) | mock-only (derivation changes) |
| `Program.imageKey` | Media refs into object storage/CDN (docs/23 §10.6) | extended |
| `PriceModel` (7 kinds, AED numbers, one per program) | ProgramPriceOption rows in fils (§2.2/§2.6 — Amendment A2): each mock program graduates as ONE Program with ONE option carrying its mock kind/amount; multi-option listings are a production capability the mocks never exercised (the shipped `BookingOption[]` contract already supports them); `freeTrial` kind dropped (trials are Offers); `membership`/`weekly` pending owner | extended + conflict (fils; option child; `monthly`-as-membership mapping pending §14.B7) |
| `Eligibility` | Unchanged — owner-final (§2.5) | unchanged |
| `Offer` (label-only) | Structured Offer entity (§2.2) with `trial_amount_fils`; `bookingExtras.trialAmount` folds in | extended |
| `Collection` + `preset` | Admin-curated Collection (§2.1); preset resolved server-side; `childFocused`/`audience` unchanged | extended |
| `BrowseEntry` | API-composed browse tiles (taxonomy + collections) | unchanged |
| `CreditSummary` | Projection over CreditLedgerEntry (§4.1) | extended |
| `ProviderBranch` | Branch entity (§1.3); fictional `addressLine` becomes real address data | extended |
| `SessionOccurrence` (`dayOffset`, `dayLabel`, `spotsLeft`) | Session entity (§2.3). **Mock-only:** `dayOffset`/`MOCK_TODAY` relative dating — production uses real datetimes with server/client Asia/Dubai formatting. `spotsLeft` becomes derived remaining capacity with a display threshold (few-left threshold configurable, §14.C) | extended + mock-only fields |
| `CancellationPolicy` (3 preset ids) | CancellationPolicyTemplate + versioned refs (§2.7); the three mock presets are placeholders and do **not** graduate | conflict (templates owner-open) |

### 12.2 Service contracts

| Mock contract | Production API | Notes |
|---|---|---|
| `HomeFeedService.getHomeFeed(HomeFeedBuildInput)` | Home feed endpoint returning the same typed section list; `ScheduleEntry`/`ActivePlan` inputs become Booking/Enrolment projections resolved server-side | **Unchanged shape.** `AccountScenarioId` and the `?qa-scenario` fixture layer are mock-only and die (already `__DEV__`-gated) |
| `ScheduleService` (scenario-keyed) | Bookings/schedule endpoints keyed by the authenticated account | Extended: scenario params → auth context |
| `DiscoverFeedService` (`childParticipants` gate input) | Discover feed endpoint; the server resolves account composition itself — the client stops passing `childParticipants` | Extended (input shrinks; gate rule §2.1/docs/18 §6 moves server-side) |
| `CatalogueService` (categories/pages/counts) | Catalogue read APIs over published projections with cached supply counts | Unchanged |
| `SearchService` (+ synonym/typo maps, deterministic ranking) | Search API over the indexed engine (docs/23 §10.5); synonyms/typos/ranking move server-side; `FilterSelection` becomes the typed query object | Unchanged shape; mock ranking dies |
| `MapService` | Map/geo search API sharing the search engine; schematic mock canvas is replaced only when the real map milestone ships (own screen decision — not forced by this model) | Extended |
| `DetailsService` (program page / storefront page) | Program detail + storefront read APIs; `extras` modules (`programDetailExtras`, `providerDetailExtras`) dissolve into Program/Organization/Branch/Instructor fields | Unchanged shape; extras modules are mock-only |
| `BookingService.getBookingOptions` | Booking-options endpoint (server-computed options, availability, skip rule, household eligibility, preselection). Recurring/term options resolve server-side to **EnrolmentCohort** units (Amendment A1.1): a single open cohort maps to today's dateless single option (skip rule unchanged); multiple open intakes arrive as multiple options — already supported by `BookingOption[]`, exactly as camp weeks are | Unchanged shape; availability derives from §5.4 states |
| `BookingService.getBookingSummary` | **Replaced by quote + summary composition:** the summary's price lines and `bookingPriceLabel` become PriceQuote-derived (§3.2). The screen contract (blocks, edit round-trips, labels) is unchanged; `Total` may appear only per §4.2.4 | Extended (money authority moves) |
| `BookingDraft` | Stays client-only (§3.1) | unchanged |
| `CheckoutService.getCheckoutPage` | Checkout endpoint: re-derived summary + quote + payment methods + real `CheckoutValidation` | Unchanged shape; `qaRevalidate`/`simulateFailure` are mock-only QA affordances |
| `CheckoutValidation` / `CheckoutIssueCode` | The platform revalidation vocabulary (§11.2) — adopted verbatim | unchanged |
| `PaymentMethod` (`contractOnly`) | Real methods per the selected gateway (§14.B3); `applePay`/`googlePay` kinds already declared | extended |
| `PaymentSubmitRequest/Result` (declared, never invoked) | Real intent/attempt endpoints implementing §5.8/§8 — **only after docs/23 §19 is lifted**; `confirmationHandoff: unknown` gets typed by the Payment & Confirmation milestone | extended |
| `TaxTreatment = 'notConfigured'` | Resolved by the owner VAT decision (§14.B2); other enum values already declared | extended |
| `FilterSelection`, `QuickFilterId`, `SortId` | Typed search-query objects (§11.4) | unchanged |
| `simulateFailure`, `?qa-fail`, `?qa-nocount`, `?qa-revalidate`, `?qa-scenario` | QA-only, `__DEV__`-gated affordances — never production API surface | mock-only |

### 12.3 Redesign check

Screens audited against this model: Home, Discover, Search, Results, catalogue pages, Map, Program Details, Provider Storefront, booking steps, Checkout. **None requires redesign.** Watch-items (contract-level, not visual): (a) `Booking price` → quote-line display is additive (`CheckoutPriceLine` kinds already declared); (b) informational session lists gain real dates — same rows; (c) `monthly`-as-membership stays until §14.B7 decides; (d) camp multi-week options are already contract-supported (`campWeeks`), and multiple EnrolmentCohort intakes reuse the same multi-option pattern (Amendment A1.1) — no screen change; (e) the `everyone` pseudo-participant never leaves the client. A genuine business contradiction requiring redesign was **not** found.

---

## 13. First backend slices

Implementation sequence for W4 after this document is owner-approved (docs/23 §4: slices start on model approval + already-approved customer workflows; provider-API contracts freeze only after docs/23 §8.6). Every slice follows the docs/20–22 pattern: plan → owner approval → staged commits → stop-and-report. Every slice ships with: migrations (two-phase, reversible), typed API contracts, contract tests against the corresponding mock contracts, **negative authorization tests** (every §10 "Cannot" relevant to the slice proven denied), and CI green per docs/23 §10.9.

| # | Slice | Scope | Acceptance criteria (in addition to the cross-cutting set) | Required negative-auth tests | Required transaction/concurrency tests |
|---|---|---|---|---|---|
| 1 | **Database & migration foundation** | PostgreSQL baseline: id/timestamp/actor/version conventions, enum domains, money-in-fils domain, outbox + inbox tables and relay skeleton, audit-event table, migration tooling, seeded deterministic staging data (mock catalogue graduates to a seed) | Migrations apply + roll back cleanly in staging; append-only guards (§6.8) proven by failing UPDATE/DELETE attempts; outbox relay delivers at-least-once with per-aggregate order; CHECK/constraint suite (§6.1–6.3, 6.5–6.7) covered by tests | n/a (no API yet) — DB-role tests: app role cannot UPDATE/DELETE append-only tables | Concurrent outbox relay instances deliver without loss or reorder per aggregate; idempotency-key unique constraint under concurrent identical inserts |
| 2 | **Identity & authorization** | User, AuthIdentity (Apple/Google/email), CustomerAccount, sessions/tokens, MFA enrolment for staff/admin, AdminRoleAssignment + AccessAdmin dual-approval, principal-context middleware, audit events for auth | Sign-in with all three identity types; identity linking; token org-binding; per-request context resolution; every auth mutation audit-evented | Guest hits every account-scoped endpoint → `authenticationRequired`; customer A reads customer B → not-found-shaped denial; finance-capable grant without second approver → rejected (DB + API); revoked membership token → denied | Concurrent duplicate sign-ups on one email/subject → single User (unique constraint proven); concurrent role grant/revoke → consistent final state via version CAS |
| 3 | **Provider organizations & branches** | Organization, Branch, VerificationCase, §5.1 machine, StaffInvitation + StaffMembership + §5.2, admin verification workflow (AD-03/04 API), suspension with future-booking guard stub | Full onboard loop draft→live drivable via API; only `live` orgs appear in public reads; §5.1/§5.2 invalid transitions rejected with typed errors; invitation acceptance atomic (§7.10) | Org A staff reads/mutates org B anything → denied; branch-scoped manager mutates an unassigned branch → denied; listings editor grants roles → denied; operations admin executes a refund → denied | Double acceptance of one invitation (concurrent) → one membership; concurrent verification decisions → single winner via state CAS |
| 4 | **Catalogue & search** | Category/ActivityType/Collection admin APIs, Program CRUD + §5.3 review machine, sensitive-field revision flow, media refs, published projections, search indexing pipeline (outbox-fed), customer catalogue/search/discover read APIs behind the existing mock contract shapes | Customer app's catalogue/search/discover screens run against the real API behind unchanged service contracts (contract tests vs mocks pass); publish → searchable within the docs/23 §11.1 index-delay target in staging; import-created listings are always `draft` | Unverified/suspended org's staff publishes → denied; provider publishes without review on a sensitive-field change → rejected; guest/customer hits admin taxonomy APIs → denied; provider mutates another org's listing → denied | Concurrent sensitive-edit + review decision → consistent revision state; index consumer replay (inbox) produces no duplicate documents |
| 5 | **Participants** | Participant CRUD under CustomerAccount, one-`self` invariant, child profiles (core fields only — legal profile pends counsel), server-side age computation service, interests | Participant create/edit/archive; the `self` uniqueness invariant proven; age computed against unit start dates (fixed-date tests, no "today"); Home/Discover account-composition inputs served server-side (§12.2) | Customer mutates another account's participant → denied; provider reads any participant beyond Tier-1 delivery data → denied (pre-booking: no access at all); support view of a participant emits a PII audit event (asserted) | Concurrent second-`self` insert → constraint rejection; concurrent participant edit with stale version → `staleVersion` conflict |
| 6 | **Sessions & availability** | RecurringSchedule (temporal rule only), Session/CampWeek generation (idempotent job), **EnrolmentCohort** CRUD (§2.3 — provider-defined intakes referencing schedules), §5.4 machine across all three unit kinds, registration/enrolment cutoffs (server, Asia/Dubai), capacity fields + §6.2 constraints on all three unit kinds, availability read APIs feeding details/booking-options contracts, capacity-floor edits, §3.6 disruption workflow skeleton | Schedule → session generation idempotent (re-runs create nothing new); details/booking screens read real availability behind unchanged contracts (recurring/term availability served from cohorts); cutoff transitions server-computed; capacity edit below floor rejected at API **and** DB layers **for sessions, camp weeks, and cohorts alike** | Scheduler edits another org's schedule/cohort → denied; front-desk edits capacity → denied; coach reads another instructor's roster → denied | Property test: random interleaved capacity edits + bookings never violate §6.2 on any unit kind (DB-verified after run); concurrent generation jobs → no duplicate sessions (natural-key constraint); concurrent cohort capacity edit vs floor → CAS/CHECK rejection |
| 7 | **Capacity holds & bookings** | CapacityHold + §5.5, PriceQuote (base-lines-only config), Booking + §5.6, free-booking confirmation (§7.3), hold expiry job (§7.2), cancellation case skeleton (§7.5, refund execution stubbed pending W5), outbox events, customer Bookings read APIs | End-to-end **free** booking confirmable against real capacity (paid confirmation waits for W5 + §19 lift); hold TTL expiry releases capacity; every §7.1–7.5 boundary implemented as specified single transactions with outbox rows; booking reference codes non-enumerable | Customer books another account's participant → denied; customer books an unpublished program → denied; provider staff creates customer bookings → denied; customer cancels another's booking → denied | **Final-seat gate (early run), executed per unit kind** — session, camp week, **and enrolment cohort** (Amendment A1.1): N ≥ 50 concurrent holds on 1 seat → exactly 1 active hold, N−1 typed `sessionFull`, zero constraint violations (docs/23 §11.1 rehearsal); expiry job racing confirmation → exactly one of consumed/expired wins via CAS; idempotent confirmation replay returns the stored outcome without double-increment |

Payments (W5 gateway integration, §8 saga end-to-end), refund execution, payouts, portal write-surfaces, and notifications follow as their workstreams and owner decisions activate (docs/23 §16 P2+); their model is fully specified above so no contract churn is expected.

---

## 14. Owner decisions

This specification decides technical structure only. The items below are recorded, not decided. Per the task rule, **VAT, provider commission, recurring billing, cancellation templates, waitlists, multi-participant launch scope, production bundle identifiers, and the payment gateway are explicitly not decided here.**

### 14.A Decisions that block schema implementation (block slice 1+ where noted)

| # | Decision | Blocks | Reference |
|---|---|---|---|
| A1 | **Approve this specification** as the binding §5–§7 expansion | All W4 slices (docs/23 §4: no backend code before approval) | docs/23 §16 P0/P1 |
| A2 | **Enrolment capacity model — RESOLVED (owner ruling, 2026-08-06, Amendment A1.1):** the first-draft `enrolment_pool` (capacity on RecurringSchedule) is rejected; **EnrolmentCohort** (§2.3) is the canonical bookable inventory unit for monthly/term enrolments, with schedules remaining purely temporal rules. No longer blocks slices 6–7 | — (resolved) | §2.3–2.4 |
| A3 | **Hosting region / data residency** | Slice 1 (where the database physically lives); already docs/23 §18.3 | docs/23 §18.3 |
| A4 | **Scale-tier ratification** (Tier 1 as launch target) — sizing assumptions for slice 1 infrastructure | Slice 1 capacity planning; already docs/23 §18.2 | docs/23 §18.2 |

### 14.B Decisions that block only later payment or commercial work (schema is ready for any outcome)

| # | Decision | Blocks | Reference |
|---|---|---|---|
| B1 | Child legal field set, guardian consent, waivers, health/emergency data (counsel) | `ParticipantLegalProfile`, consent UX, §19 lift | docs/02 §5, docs/23 §13 |
| B2 | **VAT treatment** | Quote tax lines; `TaxTreatment` resolution | docs/09 §22.2, docs/23 §18.11 |
| B3 | **Payment gateway selection** | W5, §8 execution, method list | docs/23 §18.4 |
| B4 | **Provider commercial model** (commission, fees, payout cadence) | Payout statement math config, fee quote lines | docs/23 §18.7 |
| B5 | **Recurring billing semantics** (auto-renew vs manual, first collection) | Enrolment renewal behavior, store-policy review | docs/09 §6, docs/23 §18.12 |
| B6 | **Cancellation/refund policy templates** (windows, proportions, credit incentives). **Partially resolved (owner ruling, 2026-08-06, Amendment A1.2):** system **initiation** is approved where an authoritative event + deterministic policy calculation establish the obligation; normal **approval** remains a separate Finance action, and automatic approval of ordinary customer/provider refunds is **not** authorized — any future auto-approval would be a new owner decision. Template content stays open | Template content, provider agreement | docs/09 §7, docs/23 §18.14 |
| B7 | `membership`/`weekly` price kinds vs the `monthly` mapping | Price-model widening | docs/09 §21.14 |
| B8 | **Marketplace Credit classes and expiry** | Ledger expiry-policy config, AD-11 | docs/09 §8, docs/23 §18.13 |
| B9 | **Multi-participant booking at launch** | Booking-group activation (schema-ready) | docs/09 §21.2, docs/23 §18.18 |
| B10 | Retention schedules and data-subject workflows detail (counsel) | §6.14 policy values | docs/23 §13 |
| B11 | **Waitlists** | Entirely deferred until decided; no schema reserved | docs/09 §21.4, docs/23 §18.19 |
| B12 | Arabic provider-content workflow | Bilingual field population, import template columns | docs/23 §3.1.4, §18.17 |
| B13 | **Production bundle identifiers** (`com.himma.dev` is a dev-only placeholder) | Store release, deep-link/universal-link domains | HANDOFF, docs/23 §18 |
| B14 | Search engine tier; notification channel providers | §10.5 engine choice; notification dispatch | docs/23 §18.20 |

### 14.C Values that must remain configurable (never hard-coded; defaults proposed by W4, tuned in operation)

Hold TTL (per gateway flow) · quote TTL · registration-cutoff defaults · few-places-left display threshold · goodwill-credit cap and above-cap approval threshold · support-case reopen window · attendance-correction window · session-generation horizon · disruption selection policy (default latest-confirmed-first) · reconciliation run schedule · retry/backoff and DLQ policies · rate limits (per docs/23 §10.7) · auto-publish-on-approval for listings · commission/VAT/fee values once B2/B4 decide them · retention periods once B10 decides them.

---

## 15. Consistency review

Checked against the approved record; no unresolvable contradiction found.

| Source | Point | Disposition |
|---|---|---|
| docs/23 §5–§7 | Entity list, state machines, authorization | Expanded 1:1; the additions beyond docs/23 are: **EnrolmentCohort** as the third capacity unit (**owner-ruled**, Amendment A1.1 — extends docs/23 §5's session/camp-week hold refs), the system-initiation rule for policy-established refunds (**owner-ruled**, Amendment A1.2 — refines docs/23 §6.7's support/ops initiator wording; dual control unchanged), StaffInvitation/SupportCase/VerificationCase machines (§5.2, §5.11, §5.12 — entities named in docs/23 §5 without transition tables), PayoutStatement/Payout split (§4.1, implementing §6.8's states), and the identity spine (§1.1, implementing docs/23 §7's principals) |
| docs/23 §6.4 / A2 | Atomic hold creation, no pre-state, capacity floor | Restated verbatim in §3.3, §5.5, §6.2, §7.1 |
| docs/23 §10.13 | Outbox/inbox, saga not distributed transaction | §7 (boundaries never span network calls), §8, §9 |
| docs/09 §22.4–5, §21.10–11 | No `Total`, no arithmetic, structured amounts | §4.2.3–4, §12.2 quote mapping |
| docs/09 §17.2, §21, §22; docs/23 §19 | Inert contracts; payment prohibition | §12.2 (`PaymentSubmitRequest` stays declaration-only until §19 lifts); prohibition restated in the header |
| docs/02 §1, §5, §11 | One account, child fields pending counsel, PII minimization | §1.2, §10.3, §14.B1 |
| docs/05 §7, docs/16 §4 | Eligibility model owner-final; no automatic gender filtering | §2.5 unchanged and binding server-side |
| docs/18 §6 | Child-dependent visibility gate | §2.1 Collection.child_focused; gate moves server-side (§12.2) |
| docs/15 §2 | One catalogue; collections are data | §2.1 |
| docs/21/22 + HANDOFF | Booking/checkout contracts and behavior | §12.2 maps each; no screen redesign required (§12.3) |
| CLAUDE.md scope protection | No schools/companies/quotation workflows | No such entity exists in this model; Himma for Business remains future scope |

---

*Prepared as the docs/23 §16 P0 canonical-model deliverable; conditionally approved at `8553557` and amended in place per the owner's Amendment A1 rulings. Final approval of this document is the §14.A1 decision and enables W4 slice planning per §13; it starts no implementation, lifts no prohibition, and changes no approved screen.*
