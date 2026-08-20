# 32 — W4 Slice 5: Booking & Capacity Domain — Workstream Plan (S5-0)

**Status: PLANNING ONLY — awaiting owner review. No migrations, services, routes, frontend code, or tests exist for this slice yet. This document contains no application code and creates no schema.**

Authority: docs/23 (§4–§7, §10–§12, §16, §18), docs/24 (the owner-approved canonical domain specification incl. Amendments A1.1/A1.2/A2/A3 — the BINDING domain source for everything below), docs/25 (backend engineering contract), docs/21 + docs/09 §21 (the approved W1 booking workflow), docs/22 + docs/09 §22 (the approved W1 checkout workflow), docs/18 §10 (deterministic schedule mock foundations), and the repository itself (Slices 1–4 shipped schema/services, the W2-12 live portal integration, the W3 admin platform). W3 is CLOSED at `92ac88d`; this is the first W4 Slice-5 artifact, produced on the docs/20–22 / docs/24–28 pattern: specification → owner decisions → bounded staged sub-slices with owner STOPs.

---

## 1. Repository reconciliation

### 1.1 What already exists (verified in the repository)

| Source | Finding |
|---|---|
| docs/24 §2.3–§2.4, §3, §5.4–5.6, §6, §7.1–7.6, §8 | The booking/capacity domain is ALREADY fully specified and owner-approved: capacity units (Session · CampWeek · EnrolmentCohort — A1.1), the uniform `(unit_kind, unit_id)` hold interface, hold/booking machines, both capacity invariants, exact single-transaction boundaries (§7.1 hold, §7.2 expiry/release, §7.3 free confirm, §7.4 paid), and the checkout saga. **Slice 5 implements docs/24; it does not re-design it.** Everything below cites that spec and reconciles it against the shipped code and approved frontends. |
| `backend/migrations/0001_foundation.sql` | `audit_event`, `outbox_event`, `inbox_event`, and **`idempotency_key`** (the docs/24 §6.6 store — unique key shape ready) already exist. **No backend service uses `idempotency_key` yet** — Slice 5 is its first consumer and must build the first (bounded) service primitive over the existing table. `forbid_mutation`, `set_updated_at`, `bump_row_version` trigger functions exist and are the repo conventions. |
| Slices 2–4 shipped schema | `organization`/`branch` (S3-1, composite-FK spine), `staff_membership` (branch scopes; instructor/coach identities exist as staff), `program` + `program_branch` + `program_price_option` (kinds `dropIn·monthly·term·camp·package·free`, integer fils — A2) + `offer` (incl. `freeTrial` kind with `trial_amount_fils`) + `program_media` (S4-1), full listing lifecycle + moderation + taxonomy + search. **No `session`, `camp_week`, `enrolment_cohort`, `recurring_schedule`, `capacity_hold`, `booking`, `price_quote`, or payment table exists** — pinned by the structural-boundary test (`program-schema.test.ts` forbids them until their owning slice). |
| Transaction/CAS conventions | `withTransaction` + single-statement compare-and-set (`UPDATE … WHERE id AND state/version = expected` → 0 rows = typed refusal) is the certified pattern everywhere (docs/24 §6.10–6.11); `SELECT … FOR UPDATE` row-locking is already used (e.g. taxonomy/program CAS reads). Slice 5 reuses these exactly. |
| Audit/outbox conventions | `appendAuditEvent`/`appendOutboxEvent` in the same transaction as the state change (§10.13 outbox), ids/machine-facts-only payloads, `admin-event-integrity` locks the pattern. Reused as-is. |
| W3 admin infrastructure | Admin LoginSession + PostgreSQL roles + capability projection + baseline/`adminStepUp` split (D-W3-5 RESOLVED, exhaustive mutation-policy lock in `admin-routes.test.ts`) + AD-18 audit read. Slice 5's admin surface REUSES all of it; any new admin mutation must be explicitly classified into the D-W3-5 lock or certification fails. |
| W1 approved booking workflow (docs/21 + docs/09 §21) | Sequence Option A (session/plan → participant → summary); **one participant per booking** (§21.2, explicit); full sessions visible-disabled-explained; **waitlist fully deferred** (§21.4); camps book at week granularity (§21.7); recurring enrolment starts from the next session, **no auto-renewal claim** (docs/09 §6 stands); packages sell size+price only (redemption rules owner-open); no branch selector; drafts client-only and never persisted. Mock contracts: `BookingOptionKind = 'single-session'|'free-session'|'trial'|'recurring'|'term'|'camp-week'|'package'`, `SessionOption {id, dayOffset, dayLabel, timeLabel, availability, spotsLeft?}`, `BookingDraft {programId, optionId?, sessionId?, participantId?}` (`src/services/contracts/booking.ts`; `SessionOccurrence`/`scheduleLabel` in `src/types/domain.ts` are display-mock shapes docs/24 §2.3 explicitly replaces with RecurringSchedule/Session authority). |
| W1 approved checkout workflow (docs/22 + docs/09 §22) | One checkout screen; re-derived summary; `Booking price` labels — **no `Total` until an authoritative reconciling quote exists** (§22.4); **no VAT claim** — `TaxTreatment 'notConfigured'` typed for future backend (§22.2); no fees/discount arithmetic; generic `Card payment` contract method only; **no legal acknowledgments yet and all applicable acknowledgments required before real payment submission** (§22.7); typed revalidation vocabulary `sessionFull · registrationClosed · priceChanged · offerExpired · participantIneligible · branchUnavailable · invalidDraft` — Slice 5's typed outcomes must map onto exactly this vocabulary; `PaymentSubmitRequest/Result` declared but never invoked (§22.11); confirmation/payment states belong to the future Payment & Confirmation milestone (§22.12). |
| docs/23 §19 | Real payment submission remains PROHIBITED until every §19 condition exists. Slice 5 must be implementable and certifiable without violating this — which it is, because payments are outside its boundary (§2 below). |

### 1.2 Conflicts, underspecified areas, terminology drift (surfaced, not silently reconciled)

1. **Mock option-kind vocabulary ≠ catalogue price kinds.** The approved frontend sells `'single-session'|'free-session'|'trial'|'recurring'|'term'|'camp-week'|'package'`; the shipped catalogue has `ProgramPriceOption.kind ∈ dropIn·monthly·term·camp·package·free`. The mapping is mostly mechanical (`single-session→dropIn`, `free-session→free`, `recurring→monthly`, `camp-week→camp`, `term→term`, `package→package`) **except `trial`**: docs/24 §2.6 deliberately DROPPED the mock's `freeTrial` price kind — *"trials derive from Offers"* — and Slice 4 shipped `offer.kind='freeTrial'` with `trial_amount_fils`. **How a trial books is therefore quote-engine behavior, not a price kind**: a session booking whose PriceQuote applies the active freeTrial Offer (base line at `trial_amount_fils`, possibly 0). The quote-side Offer-application rule is specified nowhere beyond this sentence → §20 decision D-7 confirms the proposed rule before S5-3. |
2. **Booking confirmation requires a policy snapshot, but cancellation-policy TEMPLATES are owner-open.** docs/24 §7.3/§7.4b write `policy_snapshot_ref` at confirmation; docs/24 §2.7 says launch template CONTENT is an open owner decision (docs/09 §7; §18 #14). Unresolved as written, confirmation cannot honestly execute in production. Proposed resolution (the certified D-W3-3/D-S3-3 pattern): an injected `CancellationPolicyProvider` seam — dev/test uses fictional templates; **production confirmation FAILS CLOSED with a typed condition until a real owner-approved template exists**. → §20 decision D-8 (approach confirmation; the template content itself stays §18 #14). |
3. **`scheduled → open` trigger is underspecified** (docs/24 §5.4: "registration opens (time or provider action)"). Proposal: sessions generated from a schedule default to `open` at creation unless the schedule carries a future `registration_opens_at` rule; `scheduled` remains representable for provider-created future-gated sessions. Low-risk; folded into §20 D-9 for confirmation. |
4. **`registration_cutoff_rule` (schedule) → `registration_cutoff_at` (session) derivation is unspecified.** Proposal: the generation job materializes `registration_cutoff_at` per session from the schedule's rule (launch rule set: `at_start` default, or `minutes_before(n)`); cutoff enforcement is server-side per docs/23 §12.12. Config, not schema. Folded into §20 D-9. |
5. **Counter/row duplication needs a stated consistency obligation.** `booked_count`/`held_count` (unit columns) duplicate aggregations over hold/booking rows — deliberately (O(1) invariant checks + CHECK enforcement). Obligation added by this plan: counters mutate ONLY inside the §7 transactions holding the unit row lock, and the certification suite must include a DB-verifiable reconciliation assertion (counter = row aggregate) after every concurrency run. Not a schema conflict; a stated proof obligation. |
6. **§11.1 gates vs CI proofs.** The §11.1 table is a STAGING load gate (G5, Tier-1 volume, production topology — W6-dependent). Slice 5 cannot run G5; it must ship the CI-scale concurrency RED suite (§15 below) whose properties are the same invariants at smaller N, plus a design that provably scales to the gate. The plan keeps these two proof tiers explicitly distinct. |
7. **Terminology drift, minor:** docs/23 §5 `CapacityHold` lists no `held_count`; docs/24 A1.1 added `held_count` to every unit and added EnrolmentCohort as the third unit kind — docs/24 governs. The mock's `spotsLeft`/`fewLeft` is a derived display of `capacity − booked_count − held_count`; the backend never stores it. `SessionOccurrence.dayOffset`/`scheduleLabel` are mock-era derivations that Session/RecurringSchedule replace as authority (docs/23 §5, docs/24 §2.3). |
8. **Attendance, reviews, notifications delivery** are adjacent in docs/24 (§3.5, §9) but are NOT booking-core; §2 excludes them from Slice 5 with their future owners named.

---

## 2. Slice 5 authority boundary

| Truth | Owner | Slice 5? |
|---|---|---|
| Scheduled occurrence + capacity configuration/status (Session · CampWeek · EnrolmentCohort), RecurringSchedule pattern, session generation | **Slice 5** (docs/24 §2.3) | YES |
| Temporary inventory reservation during checkout (CapacityHold) | **Slice 5** (docs/24 §3.3, §5.5) | YES |
| Durable customer reservation after hold consumption (Booking + Enrolment/PackageEntitlement subtype rows) | **Slice 5** (docs/24 §3.4, §5.6) | YES |
| Server money truth at checkout (PriceQuote, base-lines-only until VAT/fees decided) | **Slice 5** (docs/24 §4.1 quote entity; §10 below) | YES — quote seam only |
| Payment intent/attempt/transaction/gateway events; capture; 3-DS; reversals | **W4 payments slice with W5** (docs/24 §4, §5.8, §8) | **NO.** Slice 5 leaves paid bookings resting at `pending_payment` on an active hold — the §7.4a seam WITHOUT the PaymentIntent insert (that insert is the payment slice's first move). Hold TTL is the universal backstop that unwinds unpaid rests. No gateway logic of any kind is invented here. |
| Refunds, payout accrual, credit ledger | Future refunds/payout slices (docs/24 §4, §5.7, §5.9–5.10) | NO — see §6 for the cancellation consequence |
| Attendance | Future provider-operations slice (docs/24 §3.5) | NO |
| Catalogue truth (programs, price options, offers, branches, taxonomy) | Slices 3–4 (closed) | Consumed, never mutated |
| Notification delivery | W6/§10.4 consumers of outbox events | NO — Slice 5 only emits events |
| Admin booking/session oversight | Slice 5 reads-only (§13); AD-08 mutations are future work | READS ONLY |

---

## 3. Session state machine (proposed = docs/24 §5.4, reconciled)

Vocabulary: `scheduled → open → full ⇄ open → closed → completed`, plus `scheduled|open|full → cancelled_by_provider` (disruption only). CampWeek and EnrolmentCohort mirror it (cohort: `closed` at `enrolment_cutoff_at`, `completed` after `effective_end`).

| From → To | Actor/authority | Prerequisites | Capacity effect | Booking effect | Audit/outbox | Stale/CAS | Confirmed bookings affected? |
|---|---|---|---|---|---|---|---|
| *(none)* → `scheduled`/`open` (creation/generation) | Provider (schedule/capacity capability) or the idempotent generation job (system) | Program+branch belong to the org; capacity ≥ 0 | Sets `capacity`, counts 0 | none | `session.created` (job runs audit as `system`) | Insert; generation idempotent by `(schedule_id, occurrence_date)` unique | No |
| `scheduled` → `open` | Time rule or provider action | — | none | none | `session.opened` | CAS on state+version | No |
| `open` → `full` / `full` → `open` | **Automatic, atomic with the count change** — never a direct API action | count transaction | none (statement of counts) | none | none (derived; the hold/booking event is the record) | Same transaction as §7.1/§7.2/§7.3 count change | No |
| `open`,`full` → `closed` | System (server-computed cutoff, Asia/Dubai — docs/23 §12.12) | `registration_cutoff_at` passed | New holds refused (`registrationClosed`) | Existing bookings untouched | `session.closed` (idempotent job) | CAS | No |
| `closed` → `completed` | System job after `end_at` | — | none | Feeds future attendance/payout slices | `session.completed` | CAS, idempotent | No (state only) |
| `scheduled`,`open`,`full` → `cancelled_by_provider` | Provider/admin **through the §3.6 disruption workflow ONLY** | Disruption record drafted; affected bookings selected | Releases affected holds; decrements `booked_count` for cancelled bookings | Affected CONFIRMED bookings transition `cancelled_by_provider` **in the same workflow — never silently deleted** | `session.cancelled` + per-booking `booking.cancelled` + the disruption record | One §7.6 transaction | **Yes — explicitly, selected, recorded** |
| Capacity/config edit (not a state) | Provider/admin | **Capacity floor: `capacity ≥ booked_count + held_count`** — DB-rejected below the floor | Direct | none | `session.updated` | CAS `expectedVersion` | Never via direct edit |

**Capacity-floor invariant (restated as binding):** no provider/admin action may reduce usable capacity below legitimate committed occupancy (`booked_count + held_count`). The ONLY path below existing commitments is the controlled disruption workflow, which first transitions the affected bookings with full records. Slice 5 defines the disruption **seam** (SessionDisruption entity, selection recorded, §7.6 transaction shape); the refund leg of disruption is deferred with the refunds slice (§6), and the **selection policy default (latest-confirmed-first) is owner-decidable** — §20 D-5. Nothing in Slice 5 deletes or silently cancels a booking.

## 4. Capacity authority and the overselling invariant

**The single authoritative equation, per capacity unit, enforced at the database layer (docs/24 §6.2):**

```
booked_count + held_count ≤ capacity          (overselling impossible)
capacity may not be UPDATEd below booked_count + held_count   (floor)
```

**What counts against availability:** confirmed/committed bookings (`booked_count`) + ACTIVE unexpired holds (`held_count`). **What does not:** consumed holds (already converted into `booked_count` in the same transaction — never double-counted), expired holds, released holds (both decremented `held_count` in their §7.2 transaction). Effective availability shown to customers = `capacity − booked_count − held_count`, derived at read time, never stored.

**Enforcement design (application "check then insert" is explicitly insufficient — three independent layers):**

1. **Row-level locking:** every counting transaction begins `SELECT … FOR UPDATE` on the capacity-unit row, in the globally consistent lock order **unit → hold → booking** (docs/24 §7 cross-cutting). *Race prevented:* two concurrent §7.1 transactions both reading "1 seat free" — the second waits on the row lock, re-reads the incremented `held_count`, and takes the typed `sessionFull` exit. Also prevents deadlock cycles between hold-creation, expiry, and disruption transactions.
2. **Database CHECK constraints as the final authority:** `CHECK (booked_count + held_count <= capacity)` and `CHECK (capacity >= 0 AND booked_count >= 0 AND held_count >= 0)` on every unit table. *Race prevented:* an application bug that skips the lock or mis-computes — the incrementing `UPDATE` itself violates the CHECK and the whole transaction rolls back; overselling is impossible **regardless of application bugs** (docs/23 §10.1). The same CHECK symmetrically rejects a capacity `UPDATE` below the floor.
3. **Single-statement CAS on every state transition:** `UPDATE … SET state='consumed' WHERE id=$1 AND state='active' AND expires_at > now()` (0 rows → typed refusal). *Races prevented:* the same hold consumed twice concurrently (at most one row update wins); consumption racing expiry at the TTL boundary (the `expires_at` predicate makes consumed XOR expired — both CAS on `state='active'`, serialized by the row lock, and the loser matches 0 rows); a stale session `version` during capacity/status edits (optimistic CAS refusal, no partial write).

Isolation level: the repo's standard READ COMMITTED with explicit row locks + constraints — no serializable isolation, no advisory locks, no external lock service. PostgreSQL is the sole capacity authority (§16: no premature distributed infrastructure).

## 5. Capacity hold (InventoryReservation) machine

States exactly per docs/24 §5.5: *(nonexistent)* `→ active → consumed | expired | released`. No pre-state, no committed intermediate.

- **Creation prerequisites (§7.1, one transaction):** unit lock → unit is `open`/`full`-recoverable and before cutoff → eligibility revalidated server-side for the participant against the unit date (docs/24 §2.5.3) → invariant headroom → increment `held_count` → insert hold `active` with TTL started → insert Booking `pending_payment` (paid path) or the free-path booking (§6) referencing quote + hold → outbox `hold.created`. Failure anywhere → full rollback, capacity untouched, typed `sessionFull | registrationClosed | participantIneligible | quoteExpired` (mapping onto the approved docs/22 §11 vocabulary).
- **Ownership:** `account_id` + the created booking (`consumed_by_booking_id` set at consumption); one hold targets exactly one `(unit_kind, unit_id)`.
- **Quantity:** column exists, `= 1` at launch (docs/24 §3.3; §7/D-2).
- **TTL/expiry representation:** `expires_at` timestamptz; **expiry is authoritative only via the §7.2 transaction** (CAS `active→expired` + decrement, outbox `hold.expired`). Trigger model: BOTH (a) a scheduled idempotent sweep over the partial index `(expires_at) WHERE state='active'`, AND (b) opportunistic synchronous reclamation — a §7.1 transaction that finds the unit full first expires that unit's lapsed holds (bounded, same transaction, same lock) before answering `sessionFull`, so the final seat is reclaimable without waiting for the sweep. Both paths are the same CAS; running twice is a no-op.
- **Idempotency:** hold creation (= checkout confirmation begin) requires a client idempotency key (§14); a retry of a committed creation returns the stored outcome — never a second hold. A **duplicate checkout attempt** for the same `(account, unit, participant)` while a live hold exists is additionally refused by a partial-unique constraint (§18) with a typed `holdAlreadyActive` outcome — one intended operation, one hold.
- **Consumption:** only the §7.3 (free) / §7.4b (paid, future slice) confirmation transactions may consume, and **only while `active` and unexpired** — capture/confirmation can never consume an expired, released, or already-consumed hold (the CAS predicate is the guarantee, §4.3).
- **Release:** customer abandonment (explicit cancel-checkout API) or terminal payment failure (future slice) → §7.2 `released`. **Abandoned checkout without any signal:** the TTL is the universal backstop — the sweep expires it; the associated `pending_payment` booking is CAS-transitioned to `expired` in the same §7.2 transaction.
- **Stale retries:** a retry against a hold that meanwhile expired gets the typed refusal + the stored idempotent outcome where applicable; nothing double-decrements (counters only move with the single winning CAS).

## 6. Booking machine

States per docs/24 §5.6. Slice 5 implements: *(client draft, never persisted)* → `pending_payment` → `confirmed` | `expired`, plus the free path, plus the structural cancellation edges. Deliberately deferred WITH their owners: `payment_failed` ⇄ retry (payments slice — the state is representable in the enum from day one, unreachable until then), refund evaluation/execution (refunds slice), `completed`/`no_show` close-out (attendance slice).

- **Free path (§7.3) — full Slice-5 scope:** the SAME §7.1 hold transaction (free quote) followed by the §7.3 confirmation transaction: unit lock → hold `active` CAS → `consumed` → `booked_count`+1, `held_count`−1 → booking CAS → `confirmed` + reference code + policy snapshot → outbox `booking.confirmed`. **No special non-atomic shortcut exists: free bookings ride the identical capacity authority and hold-consumption transaction as paid bookings**, and remain server-confirmed, never client-claimed.
- **Paid path — the seam only:** §7.1 leaves the booking at `pending_payment` on an active hold. Slice 5 defines the atomic boundaries `active hold → booking pending_payment` (creation) and `active hold → consumed + booking confirmed` (the confirmation transaction shape the payments slice will invoke with capture evidence). Nothing in Slice 5 pretends payment occurred; with no payments slice, every `pending_payment` booking rests until its hold TTL unwinds it (`expired`).
- **Cancellation in Slice 5:** the `confirmed → cancelled_by_customer | cancelled_by_provider` edges and the CancellationCase/SessionDisruption records are structural Slice-5 scope **restricted to the no-money reality this slice creates**: only free bookings can be `confirmed` here, so policy evaluation deterministically yields `no_refund`-class outcomes and NO Refund row is written (the Refund leg of §7.5/§7.6 lands with the refunds slice — dual control and destinations untouched here). Capacity release, records, events, and the never-silently-cancel rule apply in full.
- **Reference code:** customer-facing, random and non-enumerable (docs/24 §6.12), unique, generated server-side at confirmation.
- **Policy snapshot:** required at confirmation; supplied by the injected `CancellationPolicyProvider` (fail-closed in production until §18 #14 — §1.2.2, §20 D-8).

## 7. Multi-participant semantics — §18 #18 (OWNER DECISION REQUIRED)

**What the approved W1 flow actually says (not invented):** docs/09 §21.2 — *"One participant per booking this milestone. Multi-participant booking is deferred."* The approved UI is a single-select radio group (no multi-select anywhere); participant selection happens BEFORE checkout (booking step 2), i.e. **before hold creation**, and the checkout summary re-derives it. docs/24 fixes `quantity = 1` at launch with the columns shaped for a future booking group (docs/09 §21.2, docs/23 §5 Booking note).

**Why it must be decided now:** quantity affects the hold's capacity claim and the invariant arithmetic; the participant model affects booking uniqueness (`one live hold per (account, unit, participant)`), pricing (per-participant quotes), checkout composition, and future cancellation granularity. Changing from 1→N after S5-1 reworks the hold/booking spine.

**Recommendation (mark: OWNER DECISION REQUIRED — D-2):** launch stays **one participant per booking**, exactly as already approved for W1; the schema carries `capacity_hold.quantity` (CHECK `= 1` at launch, widened by a future migration relaxing the CHECK) and one `participant_id` per booking, with the booking-group widening documented as additive. Booking several children = several bookings (each its own hold/quote), which the invariants already handle. Any other option (named multi-participant groups; unnamed quantity) reopens the approved W1 flow and blocks S5-1.

## 8. Waitlists — §18 #19 (OWNER DECISION REQUIRED)

The approved workflow does NOT require waitlists — docs/09 §21.4: *"Waitlist. Fully deferred. No waitlist UI or placeholder of any kind."* **Recommendation (D-3): keep waitlists OUT of Slice 5 entirely.** No waitlist states, tables, or reservations of the core path. Compatibility is preserved by design rather than speculation: a future waitlist is a separate entity that OFFERS a claim which then travels the standard §7.1 hold transaction — it never touches the capacity equation directly, so adding it later cannot corrupt capacity authority. The final inclusion call is the owner's.

## 9. Recurring billing / enrolment — §18 #12 (OWNER DECISION REQUIRED)

The two problems are deliberately separated (they are NOT the same domain):

- **Enrolment as INVENTORY** (a cohort seat for monthly/term programs) is already owner-ruled into the domain: Amendment A1.1 made **EnrolmentCohort** a first-class capacity unit, and docs/24 §3.4 defines the **Enrolment** booking subtype (`billing_anchor_date`, `cadence`, `renewal_policy` — *column exists, no value semantics until the owner decision*). The approved W1 flow sells `recurring`/`term` options today.
- **Recurring BILLING** (auto-renewal, collection rules, store-policy implications) is docs/09 §6 — OPEN — and is W5 authority in any case. No auto-renewal behavior may be implemented before that decision (docs/24 §3.4, binding).

The sources are consistent (no entanglement conflict found): the specification already splits them. **Recommendation (D-4):** Slice 5 ships the EnrolmentCohort capacity unit (S5-1) and the Enrolment subtype row on cohort bookings (S5-3) with `renewal_policy` valueless and ZERO billing recurrence — one cohort seat is claimed and (free-path) confirmed exactly like a session seat; what "the next billing cycle" means stays fully deferred to §18 #12 + W5. The smallest owner decision: confirm this inventory-now/billing-later split (or defer cohort bookings entirely from Slice 5, shrinking scope but leaving the approved `recurring`/`term` options backend-less).

## 10. Pricing / VAT boundary — §18 #11

**VAT does NOT block the Slice 5 schema.** docs/24 §4.1 already defines PriceQuote with a complete structure and an explicitly empty config: lines of kind `base|discount|fee|tax|credit`, `total_fils` CHECK-equal to the line sum, `tax_treatment` — and *"until the owner's VAT/fee decisions exist, quotes emit `base` lines only and `tax_treatment = 'notConfigured'"* (mirroring the approved checkout contract, docs/09 §22.2–22.5).

Slice 5 therefore ships: the **PriceQuote entity + quote service seam** — server-computed from the ACTIVE ProgramPriceOption (and the freeTrial Offer where applicable — §1.2.1/D-7), immutable after creation, short-TTL (`expires_at`; re-price = new quote, docs/24 §3.2), snapshotting `quote_id → booking` so every booking knows exactly what was offered, base lines only, `notConfigured` tax treatment. **Owned by catalogue/pricing:** the option/offer rows themselves. **Owned by W5-era decisions:** tax/fee/discount/credit lines, `Total` wording, and any charge. Nothing in Slice 5 pre-decides the payment/tax architecture; if the eventual VAT ruling adds lines, it is config + new quote lines — no booking-schema change. The only genuinely blocking scenario (VAT requiring a different snapshot GRANULARITY) does not exist under the approved quote model; VAT therefore appears in §20 only as a non-blocking recorded dependency.

## 11. Provider-facing contracts Slice 5 must support (backend; Provider Portal UI is later W2 work)

Scoped by the existing provider policy pipeline (org/branch scoping server-side, capabilities per docs/27; suspended-org mutation refusals apply). Proposed capability mapping follows the certified pattern (`schedule.manage`, `capacity.manage` — or reuse of `listings.manage` — finalized in the S5-4 spec against the shipped capability registry; no new authorization MODEL, only entries).

- **Schedule management:** create/edit/end RecurringSchedule per program (pattern, timezone `Asia/Dubai`, effective range, exceptions, cutoff rule); CAS versions; schedules never own inventory (A1.1).
- **Session/CampWeek/EnrolmentCohort management:** create one-off units; edit time/capacity/cutoff under the **capacity floor** (typed `capacityBelowCommitments` refusal); open/close where the machine allows; the generation job materializes sessions from schedules idempotently.
- **Disruption:** draft a SessionDisruption (unit, reason, selection per policy default), review affected bookings, execute — §7.6 shape, refund leg deferred (§6). This is deliberately a two-step workflow, not a delete button.
- **Roster/read:** per-unit booking roster (participant display name + booking state + reference; NO customer contact/PII beyond what provider operations legitimately needs — exact projection specified in S5-4 with the same PII-lean discipline as W3-2), unit occupancy (capacity/booked/held), schedule listings.
- **Coach/resource association:** `instructor_id?` (staff ref) exists in the spec (docs/24 §2.3) — carried as an optional column in S5-1, surfaced read/write in S5-4; no resource model beyond it is invented.
- Mocks never become authority: the W2 portal's future schedule UI consumes these contracts; contracts track docs/24 + this plan.

## 12. Customer-facing contracts Slice 5 must support (backend; W1 app integration is its own task)

Mapping onto the approved W1 contracts (docs/21 §11, docs/22 §11 — typed refusals reuse the approved vocabulary):

- **Availability read:** bookable options + dated units for a program (unit id, start/end, effective availability `available|fewLeft(spotsLeft)|full`, cutoff state) — derived, never stored; no internal counters/lock bookkeeping exposed (no `held_count` on the wire).
- **Quote:** request a PriceQuote for `(program, option, unit, participant)` → id, lines, total, `expires_at` (§10).
- **Begin checkout / create hold (idempotency-key required):** the §7.1 transaction → `{holdId, bookingId, expiresAt}` or typed `sessionFull | registrationClosed | participantIneligible | quoteExpired | holdAlreadyActive`.
- **Hold status:** state + `expiresAt` (truthful in-checkout window only — customers are never told "reserved" beyond it).
- **Free-booking completion (idempotency-key required):** §7.3 → `confirmed` + reference code; retry returns the stored outcome.
- **Paid handoff seam:** the `pending_payment` rest state + the documented confirmation-transaction shape — NOTHING more (no intent, no method, no capture; the CTA boundary stays exactly docs/09 §22.11 until the payments slice).
- **Abandon checkout:** explicit release (§7.2) — idempotent.
- **Booking status/list:** the customer's own bookings (state, unit, program display refs, reference code) — account-scoped server-side.
- Idempotency/retry: §14; every mutation is safely retriable; a network retry can never create two holds or two bookings for one intended operation.

## 13. Admin boundary (reuse W3 wholesale)

**Slice 5 needs Admin oversight READS only initially — stated explicitly.** Proposed: session/booking oversight reads for `operations` on the `admin` BASELINE (the D-W3-5 read rule), following the W3-2 read-model pattern (bounded projections, keyset pagination, no payment/PII beyond need). Every future admin booking MUTATION (e.g. AD-08 admin cancel with policy override) is future work and MUST receive an explicit D-W3-5 classification in the exhaustive mutation-policy lock before it can exist (an unclassified mutation fails certification — the lock is already authoritative); by the ruling's categories, admin cancel/disruption would be consequential (`adminStepUp`) — recorded as guidance, decided when that surface is actually planned. No admin infrastructure is rebuilt; LoginSession, roles/capabilities, audit, and the AD-18 trail are consumed as-is.

## 14. Idempotency and retry model

- **Infrastructure finding:** the `idempotency_key` table (unique `(principal, endpoint_scope, idempotency_key)`, stored outcome — docs/24 §6.6) has existed since 0001 and has NO consumer yet. Slice 5 builds the first bounded primitive over the EXISTING table: `runIdempotent(principal, scope, key, txnFn)` — first run executes the §7 transaction and stores the typed outcome IN the same transaction; replays return the stored outcome without re-execution (docs/24 §11.3 semantics). No new table.
- **Key-required mutations:** create-hold/begin-checkout · free-booking confirmation · customer cancellation · abandon/release. The future payment-confirmation callback seam inherits the same store (PaymentIntent's own idempotency key arrives with the payments slice, per docs/24 §4.1).
- **Provider mutations:** schedule/unit edits are CAS-guarded (`expectedVersion`) — duplicate submission is inherently safe (stale refusal); unit CREATION accepts an optional idempotency key; schedule→session generation is idempotent by the `(schedule_id, occurrence_date)` unique constraint, no key needed.
- **Defense in depth beyond keys:** the `holdAlreadyActive` partial-unique constraint (§5) catches duplicate checkout attempts even when a client mints two different keys for what a human intends as one operation.

## 15. Concurrency proof plan (§11.1-aligned RED tests — designed now, written RED in S5-2 before implementation)

**Harness:** real migrated PostgreSQL (the existing `createMigratedTestDb` per-suite database); true DB-level contention via N independent pool connections driving N concurrent service-layer transactions, released simultaneously by a barrier (all connections established and payloads prepared before a single `Promise.all` release); post-conditions asserted by direct SQL (counters, row aggregates, CHECK-consistency reconciliation per §1.2.5). Plus one **multi-process** variant: M spawned worker processes (distinct PostgreSQL backends and event loops) hammering one unit — proving the database, not JavaScript scheduling, is the serializer. Deterministic-enough for CI via fixed N/M, per-suite databases, retries-free assertions on invariants (not on which contender wins), and a bounded repetition count (§16).

| # | RED test | Proven property |
|---|---|---|
| 1 | Capacity 1, two simultaneous §7.1 holds | Exactly one `active` hold + one typed `sessionFull`; `held_count = 1` |
| 2 | Capacity N, N+K simultaneous claims (N≥5, K≥5) | `booked_count + active holds ≤ N` always; exactly K typed refusals; counter = row aggregate |
| 3 | Simultaneous claim vs expiry/release of the last-seat hold | Either the claim wins the freed seat or refuses — never both holds active; counts consistent |
| 4 | Same hold consumed twice concurrently (two §7.3 confirmations) | At most one `consumed` + one `booking.confirmed`; the loser gets the typed already-consumed refusal |
| 5 | Confirmation racing hold expiry at the TTL boundary | Consumed XOR expired; a booking never confirms on an expired hold; no count drift |
| 6 | Provider capacity reduction while active holds + confirmed bookings exist | Typed `capacityBelowCommitments`; DB CHECK proven independently by a direct SQL `UPDATE` attempt |
| 7 | Stale session `version` during concurrent capacity/status edits | One writer wins; the stale writer gets the CAS refusal; no partial write |
| 8 | Free confirmation and paid-path hold creation compete for the final unit | Exactly one wins; zero oversell; the loser's typed refusal is pre-charge by construction |
| 9 | Duplicate/idempotent client retry (same key, create-hold and free-confirm; storm of R replays) | One hold/booking ever; every replay returns the stored outcome; ledger of outcomes identical |
| 10 | Multi-process final-seat gate (M processes × contenders) | DB-level serialization proven; invariants hold; CHECK-reconciliation clean after the run |

Plus the standing certification obligations: post-run counter reconciliation after EVERY race test; audit/outbox exactly-once per winning transition; zero events from refused attempts.

## 16. Scale-tier recommendation — §18 #2 (OWNER DECISION REQUIRED)

The §11 ladder is documented but NOT yet owner-approved. **Recommendation (D-1): approve Tier 1 as the launch certification target.** Slice-5 consequences: final-seat CI gate at **N = 50** concurrent contenders per session (the §11.1 minimum), unit inventories in CI at hundreds of sessions (the 5,000-sessions/week Tier-1 volume is a G5 staging load-gate concern on production topology, not a CI concern); transaction behavior = lock-wait then typed refusal at READ COMMITTED (no client-visible retry storms; constraint violations surface as `sessionFull`); CI stress = 3 repetitions of the race suite per run (bounded runtime, drift-catching); DB connections = pool sized ≥ N + headroom for the race suite only (test config, not production). PostgreSQL alone provides the launch guarantee — **no queue-based reservation broker, no Redis locks, no distributed anything** (§10/§16 anti-goal). Tier promotion re-runs the §11.1 gates; the design above reaches Tier 2 without redesign (row-locked hot units scale per-unit, not globally).

## 17. Audit/outbox events (minimal canonical set)

`session.created · session.opened · session.closed · session.completed · session.updated · session.cancelled` · `schedule.created · schedule.updated · schedule.ended` · `hold.created · hold.expired · hold.released` · `booking.confirmed · booking.cancelled` · `disruption.executed` (or folded into `session.cancelled` — finalized in S5-1) · `quote.created` (audit-only; not outboxed — quotes are not domain state changes; confirmed in S5-3).

Payload discipline (binding, per the certified conventions): ids + machine facts only (`unitKind`, `unitId`, `bookingId`, `holdId`, state slugs, quantities). **Never:** customer PII, participant names, contact data, payment material, free-form notes, or quote line labels. Actor/source audit required on: every provider/admin mutation (user actor), generation/expiry/completion jobs (`system` actor), and every booking/hold transition. `open⇄full` derived flips emit nothing (the causing hold/booking event is the record). Refused attempts emit nothing.

## 18. Schema / migration proposal (planning only — no migration is written by this task)

Proposed tables (all with `created_at`, `updated_at`, actor columns, integer `version` where mutable, opaque UUID ids; org/branch composite-FK spine continued; kinds/states as CHECK-constrained text per repo convention):

| Table | Key columns (beyond docs/24 field lists) | Invariants/notes |
|---|---|---|
| `recurring_schedule` | program_id FK, pattern fields, timezone, effective range, exceptions, cutoff rule, `registration_opens_at?`, instructor_id?, state | Mutable (CAS). Never carries capacity (A1.1). |
| `session` | program_id, schedule_id?, branch_id (composite FK → same org), start_at/end_at, `capacity`, `booked_count`, `held_count`, state, registration_cutoff_at, eligibility override?, instructor_id? | **CHECK `booked_count + held_count <= capacity`** + non-negative CHECKs; `UNIQUE (schedule_id, occurrence_date)` for idempotent generation; indexes `(program_id, start_at)`, `(branch_id, start_at)`, `(state, registration_cutoff_at)`. Mutable under CAS; counters mutate only in §7 transactions. |
| `camp_week` / `enrolment_cohort` | per docs/24 §2.3 (cohort: schedule refs join table, cutoff, price/policy overrides) | Identical capacity CHECK machinery; cohort children org-bound by composite FKs (docs/24 §6.9). |
| `capacity_hold` | `session_id?`/`camp_week_id?`/`cohort_id?` — **exactly-one CHECK** (three nullable FKs preferred over an unconstrained `(unit_kind, unit_id)` pair so referential integrity is real; final call in S5-1), account_id, booking_id?, quantity CHECK `=1` (launch), quote_id, state, `expires_at`, consumed_by_booking_id? | Immutable except state (CAS-only transitions); **partial index `(expires_at) WHERE state='active'`** (sweep); **partial UNIQUE `(account_id, unit, participant)` WHERE `state='active'`** (`holdAlreadyActive`); no UPDATE of unit/quantity/owner columns (trigger-guarded). |
| `booking` | account_id, participant_id (composite FK → same account, docs/24 §6.9), program_id, organization_id, branch_id, option_kind, unit refs (same exactly-one shape, CHECK-matched to the hold's unit), quote_id, hold_id, state, `reference_code` UNIQUE, policy_snapshot_ref?, confirmed_at?, cancelled_at? | State CAS-only; identity/ownership columns immutable (trigger); `policy_snapshot_ref` NOT NULL from `confirmed` onward (CHECK by state). Indexes `(account_id, created_at)`, unit ref, `(organization_id, created_at)`. |
| `enrolment` / `package_entitlement` | booking_id subtype PKs per docs/24 §3.4 | `renewal_policy` and package expiry columns exist VALUELESS (owner-open); no behavior. |
| `price_quote` (+ `price_quote_line`) | program/option/unit/participant refs, lines (kind/label/amount_fils), total_fils, currency `AED`, price_kind, tax_treatment, `expires_at` | **Immutable after creation** (append-only guards); trigger/CHECK: total = line sum (docs/24 §6.3). |
| `cancellation_policy_template` | template_version, rule structure, state | Platform-versioned; the fail-closed provider seam reads it (D-8); content owner-open (§18 #14). |
| `cancellation_case` / `session_disruption` | per docs/24 §3.6 | Append-plus-state; disruption records the full selection. |

**Immutable vs mutable:** unit identity/ownership, hold identity, booking identity/refs, quotes, and all history are immutable; only states (CAS), counters (§7-transactions-only), capacities/config (CAS + floor CHECK), and schedule patterns (CAS) mutate. **Historical truth vs catalogue edits:** bookings/holds/quotes reference ids + immutable snapshots (quote lines, policy snapshot, reference code) — later program/price/session edits never rewrite what was sold (the W3-8 "history survives" discipline).

**Cannot be finalized until owner decisions:** hold `quantity` CHECK + participant model (D-2); cohort/enrolment inclusion (D-4); policy-template seam shape (D-8); TTL defaults as config (D-6); disruption selection default (D-5). Everything else is decision-independent.

## 19. Slice decomposition (each ends at an owner STOP)

| Sub-slice | Scope | Gate |
|---|---|---|
| **S5-0** | This plan; owner decisions D-1…D-9 closed | Owner approval of this document |
| **S5-1** | Schema + Session/CampWeek/EnrolmentCohort/RecurringSchedule foundation: migration(s), codegen, DB-invariant tests (capacity CHECK both directions, exactly-one unit refs, generation uniqueness, append-only/immutability guards), the policy-template + quote tables, structural-boundary test updates. NO routes. | D-2, D-4 decided |
| **S5-2** | Atomic capacity holds: §7.1/§7.2 services, the idempotency primitive over the existing store, expiry sweep + opportunistic reclamation, and the **§15 concurrency gate written RED first** (tests 1–3, 5–10 subset applicable pre-booking) then GREEN. | D-1 (gate calibration), D-6 |
| **S5-3** | Booking domain: PriceQuote seam (base-only), free confirmation (§7.3), paid `pending_payment` rest + confirmation-shape seam, customer cancellation + disruption workflow (no-money scope), policy fail-closed seam, remaining §15 races (4, 8, 9), event set finalized. | D-5, D-7, D-8 approach |
| **S5-4** | Provider schedule/capacity/roster API (§11) + session generation job + provider contract tests; capability entries finalized against the shipped registry. (Provider Portal UI is W2 work, separately planned.) | — |
| **S5-5** | Customer booking API (§12) + contract tests against the approved W1 vocabulary. (Customer-app live integration is its own W1 task, separately planned — the W2-12 precedent.) | — |
| **S5-6** | Admin oversight reads (§13, baseline/operations, D-W3-5 lock extended), cross-surface security regression (customer/provider/admin disjointness over the new routes), closeout audit (W2-12D/W3-9 pattern). | — |

Every sub-slice: RED→GREEN on real PostgreSQL, contract tests through the real transport where routes exist, `db:verify`, codegen on schema change, full-suite regression, certification per docs/25, commit, STOP.

## 20. Required owner decisions

| ID (source) | Question | Options | Architectural consequence | Recommendation | Blocks |
|---|---|---|---|---|---|
| **D-1** (§18 #2) | Launch scale tier / certification target | Tier 1 · higher | Sets the §11.1 gate numbers Slice 5 certifies against (final-seat N, CI stress reps); higher tiers change load-gate targets, not this design | **Tier 1** (final-seat N=50, 3 CI reps; §16) | S5-2 gate calibration only |
| **D-2** (§18 #18) | Multi-participant model at launch | (a) one participant per booking (as W1-approved) · (b) named multi-participant groups · (c) unnamed quantity | (b)/(c) rework hold quantity, invariant arithmetic, pricing, uniqueness, checkout, and the approved W1 flow | **(a)** — schema carries the documented widening path (§7) | **S5-1** |
| **D-3** (§18 #19) | Waitlists in Slice 5? | out (design-compatible) · in | "In" adds a non-approved workflow and a second claim path into capacity | **Out** (§8) | none if out |
| **D-4** (§18 #12) | Enrolment scope | (a) cohort inventory + Enrolment rows now, zero billing (split per docs/24) · (b) defer cohorts entirely | (b) leaves approved `recurring`/`term` options without backend units; (a) adds one unit kind of identical machinery | **(a)** — billing stays W5/§18 #12 (§9) | **S5-1** (schema), S5-3 (booking path) |
| **D-5** (docs/23 §6.3) | Disruption selection policy default | latest-confirmed-first (documented default) · other | Recorded selection rule in SessionDisruption; owner-adjustable later either way | **latest-confirmed-first** | S5-3 |
| **D-6** (docs/24 §14.C) | Default hold TTL + quote TTL | e.g. hold 10 min / quote 15 min (both config) | Config only; TTL bounds the pending_payment rest window | **10 min hold · 15 min quote**, environment-configurable | S5-2 defaults only |
| **D-7** (§1.2.1) | Trial booking rule | quote applies the active freeTrial Offer (base line = `trial_amount_fils`) · defer trials from S5 | Defer = the approved `trial` option stays backend-less | **Apply-the-Offer in the quote engine** | S5-3 |
| **D-8** (§1.2.2; relates §18 #14) | Policy-snapshot seam while templates are owner-open | fail-closed injected `CancellationPolicyProvider` (D-W3-3 pattern: production confirmation refuses until a real template exists) · placeholder template in production | Placeholder would sell bookings under fake terms — rejected by precedent | **Fail-closed seam**; template CONTENT stays §18 #14 (blocks production enablement, not implementation) | S5-3 approach; production enablement |
| **D-9** (§1.2.3–4) | Registration-open + cutoff derivation defaults | generate-`open`, optional `registration_opens_at`; cutoff rule `at_start` default / `minutes_before(n)` | Config + one nullable column | **As proposed** | S5-1 (column), S5-4 (rules) |
| *(recorded, non-blocking)* (§18 #11) | VAT | — | Does NOT block Slice-5 schema/contracts (§10): quote structure complete, config empty | — | later W5-era work only |

None of these are decided by this document.

## 21. Definition of done — met by this planning task

Repository reconciliation documented with conflicts surfaced (§1) · authority boundaries explicit incl. W1/W2/W3/W5 ownership (§2, §11–§13) · machines/invariants specified from the approved sources (§3–§6) · overselling prevention has a concrete three-layer PostgreSQL design with named races (§4) · concurrency RED tests designed with their harness (§15) · owner decisions isolated in one table (§20) · implementation bounded into sub-slices with owner STOPs (§19) · **no implementation code, schema, route, or test was created or changed**. Next step after owner approval: **S5-1** — and not before.
