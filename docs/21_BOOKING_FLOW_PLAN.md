# 21 — Booking Flow Plan (Milestone 4)

Status: **milestone completed and closed** — Commit 12 (`c1e5191` booking foundation and session selection, owner-approved), Commit 13 (`df06260` participant selection and eligibility, owner-approved 2026-08-04), Commit 14 (`6d952d0` booking summary and flow connections, owner-approved 2026-08-04: design, frontend implementation, flow connections, and accessibility review), Commit 15 (`chore(booking-review)` closing pass). Native validation is pending for all three booking steps (no Xcode on the build machine). Deviations from this plan and current live state are recorded in HANDOFF.md, which supersedes this document for project status.

Plan approved by the product owner 2026-08-04. Every starred default in §20 is approved; the decisions (including the `Booking price` summary-label refinement) are recorded in `docs/09_OPEN_DECISIONS.md` §21, which governs where wording differs. Governing docs: 02 (accounts/participants, checkout participant rule §8), 04 (HMA-017–020 inventories, §2 dock rules, §7 connection map), 05 (pricing models §6, eligibility §7), 06 (UX/friction/copy), 08 (engineering contract, §14 frontend-vs-backend authority), 09 (open decisions incl. §17.2 inert rule, §20 details decisions), 12 (native rules), 15 §4 (route contracts, no-trap rules), 16 (states/interactions), 17–19 (established service/builder/provider patterns), 20 (details milestone, superseded for status by HANDOFF.md), HANDOFF.md (frozen catalogue, live architecture).

## 1. Milestone objective and product purpose

Implement the frontend booking flow from the existing Program Details **Book** CTA through selection, participant confirmation, eligibility validation, and a booking summary that ends at a **Continue to checkout** contract. The flow answers, in order:

1. **Which session or plan is being booked?** — type-appropriate selection (never one forced session-picker UI).
2. **Who is attending?** — explicit participant selection from the real account participant list (docs/02 §8: browsing context never books).
3. **Is that participant eligible?** — authoritative age-based check, explained, never silent.
4. **What does it cost?** — honest price presentation per pricing model, no invented fees.
5. **What will happen when the user continues?** — a truthful summary and a checkout contract that promises nothing the frontend cannot deliver.

This milestone stops before payment, backend reservation, and confirmation. **Nothing in the flow may imply that inventory is reserved** — no capacity holds, no countdowns, no "we're holding your place" copy (docs/08 §14). Not built: payment, card entry, Apple/Google Pay, backend reservation, inventory locking, booking confirmation, refunds, cancellation management, provider approval workflows, waitlists, gifts, authentication.

## 2. Recommended booking sequence — Option A with a type-conditional skip

**Decision: Option A (Session/plan → Participant → Summary), where the selection step is skipped for programs with exactly one bookable option that requires no date choice.** This is one rule, not per-type reordering (Option C's flexibility without its inconsistency).

Justification:

1. **docs/04 §7 already prescribes it.** The approved connection map is `Book → Session/Package Selector → Participant Selection → Eligibility Review → Booking Summary`. Option A is the documented order; Option B would contradict it without cause.
2. **Continuity of intent.** The user arrives from Program Details having just evaluated *what* and *when* (schedule, sessions, price). "Which session?" continues that momentum; switching first to "who?" interrupts it.
3. **Eligibility is program-level in the current model.** `Eligibility` attaches to programs (per-session variation exists in docs/05 but not in mock data), so choosing a session first never invalidates a participant and choosing a participant first never changes the session list. Order therefore costs nothing in correctness — Option B's only theoretical advantage doesn't apply.
4. **The skip rule handles the "no session to select" cases** (recurring enrolment, package) without inventing an empty step: the flow enters directly at the participant step and the summary carries the full plan explanation. docs/06 §4 (minimize friction, no re-asking) governs.

**Skip rule (exact):** the selection step renders when the program yields **more than one booking option** (e.g. trial + full enrolment) **or any option requiring a date choice** (single session, free session, camp week). Otherwise (single recurring/package option) the flow enters at participant selection and the summary shows the plan with no "Change selection" action.

**Participant preselection:** the shared browsing participant is preselected on the participant step **only when it is a real participant (not `everyone`) and eligible for the program**. An ineligible browsing participant is shown with its reason, never preselected, and never silently replaced.

**One participant per booking (recommended initial scope, confirmed here as the milestone rule):** the participant step is single-select. Multi-participant booking (docs/02 §8 "multiple children", "me and one or more children") is deferred — §20 open decision. Copy stays truthful for single selection ("Who is attending?"), and the contracts (§11) keep a `participantId`, not an array, so widening later is a contract change, not a redesign.

## 3. Routes and navigation

### 3.1 Route contracts

| Surface | Route | File | Dock |
|---|---|---|---|
| Selection step | `/booking/[programId]` | `src/app/booking/[programId]/index.tsx` | Hidden structurally |
| Participant step | `/booking/[programId]/participant` | `src/app/booking/[programId]/participant.tsx` | Hidden structurally |
| Summary | `/booking/[programId]/summary` | `src/app/booking/[programId]/summary.tsx` | Hidden structurally |

- `src/app/booking/[programId]/_layout.tsx` hosts a nested Stack **and the `BookingSessionProvider`** (§10), so the draft's lifetime equals the flow's lifetime — leaving the flow unmounts and discards the draft by construction.
- Root-level stack group (sibling of `program/`, `provider/`, `search.tsx`, `map.tsx`): the dock is hidden structurally, matching docs/04 §2 ("dock hidden during focused transactional flows") and the established root-push mechanism — no per-screen flags. docs/08 §4's long-term tree already reserves `booking/`.
- There is **no completion, confirmation, or checkout route**. The flow ends at the summary; the checkout CTA is a contract (§8). No fake completion state of any kind.

### 3.2 Entry, back, and stack behavior

- **Single entry point:** the Program Details Book CTA becomes active and pushes `/booking/[programId]`. A new pure policy module `src/features/booking/booking-navigation.ts` (pattern of `detail-navigation.ts`) owns href building; the push reuses the established double-tap guard so one press never creates two booking routes.
- **Exact-origin back:** Program Details stays mounted beneath the flow (root push). Back from the selection step (or from participant when the skip rule applied) lands on the exact Program Details instance; back from participant → selection; back from summary → participant. iOS swipe-back enabled per step; Android back pops one step (no sheets planned in this flow).
- **Skip-rule mechanics:** `/booking/[programId]/index` evaluates the skip rule; when selection is not needed it renders a `<Redirect>` to `/participant` (replace, not push), so back from participant still returns to Program Details in one step.
- **Cold deep link** to any booking route with an empty stack: providers give defaults (participant `everyone`, area `khalifa-city`); a cold link to `/participant` or `/summary` with an empty draft **redirects to the flow start** (`/booking/[programId]`), which re-runs the skip rule. The back control falls back to `router.replace('/program/[programId]')` when it cannot pop (keeping the user on the evaluation surface), and that screen's own fallback chain to `/discover` stands.
- **Unknown program id** at any step: the service returns `undefined`; the screen renders the established recovery state — `This program is no longer offered.` + `Browse activities` → `/discover` (docs/16 §2 wording reused verbatim).
- **Switching program:** each flow is keyed by `[programId]`; booking a different program is a different stack instance with a fresh provider. Cross-program draft leakage is structurally impossible.
- **Context preservation:** the flow reads (never mutates) `AreaProvider`; the browsing `ParticipantProvider` is read for preselection only — the booking participant choice lives in the draft, so browsing context anywhere else is untouched (docs/16 §4: "browsing context never books").

## 4. Booking entry behavior (Book CTA matrix)

The Book CTA stays enabled and honest in every case (docs/20 §3.21 precedent: booking-time selection is the real gate). What varies is what the flow shows on entry:

| Program situation | Demo id | Entry behavior |
|---|---|---|
| Single-session activity | `beginner-calisthenics` | Selection step: session list |
| Recurring class (monthly) | `junior-swim-squad` | Skip → participant step; summary shows enrolment schedule + start |
| Term program | `junior-karate` | Skip → participant step; summary shows term schedule |
| Camp | `holiday-swim-camp`, `teen-coding-camp` | Selection step: camp week option(s) with date range |
| Package | `adult-swim-technique`, `junior-pottery` | Skip → participant step; summary shows package contents |
| Membership-style plan | `mens-strength-basics` (monthly) | As recurring (§5.5 mapping) |
| Free activity | `community-park-football` | Selection step: session list; `Free` pricing throughout |
| Trial available | `ladies-strength`, `junior-robotics` (free trial), `junior-football-u10` (paid trial) | Selection step: two options — trial session (with session pick) vs full enrolment |
| No available sessions | package `public-speaking` has `sessions: 'none'` but needs none; a session-requiring no-sessions state is added via §12 overrides | Flow renders `No upcoming sessions listed.` + recovery (back to program, browse) — CTA never lies by being disabled without explanation |
| Weak availability | `reformer-pilates` (3 left), `padel-beginners` (2 left) | Session rows show `3 places left` (existing honest data) |
| Full session | §12 override (`morning-yoga` first occurrence) | Row disabled with `Full` + reason; other sessions selectable; waitlist deferred |
| Registration closed | §12 override (`teen-arabic-summer`) | Entry state: `Registration for this camp has closed.` + recovery |
| Child-only program, adult selected | `junior-karate` + Me | Flow opens; participant step explains (`Ages 6–12`) and offers eligible children |
| Adult-only program, child selected | `mens-strength-basics` + Adam | Flow opens; participant step explains + offers eligible adults |
| Ladies-only program | `ladies-strength` | Badge shown; **no gender-based blocking anywhere** (docs/05 §7 — Ladies only is a filter/badge, never an automatic exclusion) |
| All-ages program | `community-park-football` | Every participant eligible; browsing participant preselected |
| Guest (QA scenario only) | `?qa-scenario=guest` | Flow opens to a sign-in-required contract state (§6.5); nothing bookable, nothing faked |

## 5. Program-type behavior

Seven frontend behaviors over the existing seven `PriceModel` kinds. No type is forced into another type's UI.

### 5.1 Single session (`dropIn`, and `free` with dated sessions)

- **Selects:** exactly one dated session (radio list from the shared session derivation, §12).
- **Shows:** day, time, branch (multi-branch providers), availability state per row.
- **Date required:** yes. **Summary line:** `Tue 4 Aug · 7:30 PM` (+ branch). **Price:** `AED 85` total, unit `per session`.

### 5.2 Recurring enrolment (`monthly`)

- **Selects:** nothing at step 1 (skip rule) — the enrolment is the product.
- **Shows (summary):** schedule (`Sat & Sun · 10:00 AM`), start (`Starts with the next session — Sat 8 Aug`), cadence price.
- **Date required:** no. **Summary wording:** `Monthly enrolment`. **Price:** `AED 380/month`. No auto-renewal claims (docs/09 §6 open).

### 5.3 Camp (`camp`)

- **Selects:** the camp week (radio of week options; usually one, still shown — the date range is the decision).
- **Shows:** date range (`Week of 10–14 Aug`), daily time, what's included.
- **Date required:** yes (week granularity). **Summary wording:** `Holiday camp · Week of 10–14 Aug`. **Price:** `AED 850/week`.

### 5.4 Package (`package`)

- **Selects:** nothing (skip rule) — one package option.
- **Shows (summary):** `Package of 6 sessions` + the program's schedule label for orientation. **No redemption, expiry, or scheduling rules are invented** — how package sessions are redeemed is a §20 open decision; the summary states only what the catalogue knows.
- **Date required:** no. **Price:** `AED 500 for 6 sessions` (total).

### 5.5 Membership

- No `membership` price kind exists in the catalogue; membership-style products are represented by `monthly` (and `ActivePlan.kind: 'membership'` exists only in Home's schedule mock). **Mapping for this milestone:** membership behaves as §5.2 recurring enrolment. Introducing a distinct membership price kind is a §20 open decision; the catalogue stays frozen either way.

### 5.6 Trial (`offer.kind: 'freeTrial' | 'paidTrial'`)

- **Selects:** step 1 offers **two options**: `Free trial session` (or `Trial session · AED 35`) and the full plan (`Monthly enrolment · AED 450/month`). Choosing the trial reveals the session list (a trial is one dated session); choosing the full plan shows the enrolment summary inline.
- **Date required:** trial yes; full plan per its own type. **Summary wording:** `Free trial session · Tue 4 Aug, 6:30 PM`. **Price:** trial `Free` / `AED 35`; the full-plan price is never shown as the trial total.
- The unused `freeTrial` *price kind* stays unused (§12 gap note); trials derive from offers.

### 5.7 Free booking (`free`)

- As §5.1 with `Free` in place of every amount; total `Free` (rendered as `AED 0` nowhere — `Free` is the customer word, docs/06 §14). CTA labels: `Book free session` / `Continue`.

Discounted offers (`discount`/`promo`, e.g. `20% off first month`) are **not** a distinct flow type: the offer label displays as an informational line; no discounted arithmetic is performed (§9).

## 6. Participant selection

Data source: `AccountProvider`'s resolved participant list (dynamic — zero, one, or many children; docs/18 §3: no fixed names, no fixed counts anywhere in logic or tests).

1. **List:** every real participant (`kind !== 'everyone'`), primary first, as a single-select radio group. Each row: name, `You` for the primary participant where natural, age for children, and an eligibility line.
2. **Eligibility first:** rows are computed via the existing `householdSuitability` helper (reused, not duplicated). Eligible rows are selectable; ineligible rows are **visible, disabled, and explained** (`Ages 6–12 — Adam is 8` pattern; docs/04 HMA-019: never hide the reason). Eligible rows rank first; order within groups follows account order.
3. **Preselection:** per §2 — browsing participant only, only when real and eligible. `everyone` browsing context preselects nothing.
4. **Ineligible-selected recovery:** when the browsing participant is ineligible, the step opens with no selection, the ineligible row explains why, and the eligible rows are one tap away. **No silent switching, ever** — selection is always an explicit user tap, announced politely.
5. **No eligible participants** (e.g. child-only program on a `me-only` account, or adult-only program browsing as a child with no other profiles): the step renders a recovery state — `None of your profiles can join this program.` + the age line + actions `Back to program` and `Browse activities` (→ `/discover`). No add-child prompt (participant creation belongs to future Profile/onboarding — docs/18 §6 spirit; adding profiles mid-booking is a §20 open decision).
6. **Guest** (QA-reachable only): booking requires an account (docs/02 §2). Temporary assumption (§20): the flow renders a sign-in-required state — `Sign in to book` card reusing existing card language, inert with press feedback (docs/09 §17.2) until the auth milestone. No fake sign-in form.
7. **One participant per booking** (§2). The UI never suggests multi-select (no checkboxes, no "add another").

## 7. Capacity and availability (deterministic frontend states)

All availability is **deterministic frontend mock data, labeled as such only in service-layer doc comments — never in customer-facing copy**. The frontend never claims real-time availability (docs/08 §14) and never simulates contention.

| State | Source | Presentation |
|---|---|---|
| Available | default | Plain selectable row |
| Few places left | `spotsLeft` 1–4 (existing extras + §12 additions) | `3 places left` on the row — real data, no fake urgency (docs/06 §10) |
| Full | `spotsLeft: 0` (§12 override) | Row disabled, marked `Full` in text + disabled semantics; explanation `This session is full.`; other sessions remain selectable |
| No upcoming sessions | empty derived list / `sessions: 'none'` | Full-step state: `No upcoming sessions listed.` + recovery actions |
| Registration closed | §12 program-level override | Entry state: `Registration for this camp has closed.` + recovery |
| Unavailable / unknown program | unknown id | `This program is no longer offered.` + `Browse activities` |

Decisions (recommended, owner-visible in §20 where marked):

- **Full sessions are disabled with explanation, not hidden** — consistent with the storefront's never-hide rule.
- **Waitlist is deferred** (§20).
- **Selecting a session updates the draft and therefore the summary** — the summary always renders the current draft; stale summaries cannot exist.
- **Availability never changes during a flow.** The mock is static per session; simulating "someone took the last place" would fake backend behavior (the future `Payment status — capacity lost` state, HMA-022, owns that story).

## 8. Booking summary

One screen (`/booking/[programId]/summary`) rendering the resolved draft:

1. **Heading** — `Review your booking` (step heading + progress, §14).
2. **Program block** — image thumbnail, program title, provider name + verification, area · branch (branch from the program's extras `branchId`; §20 notes branch choice).
3. **Participant block** — name + age line + eligibility confirmation (`Suitable for Adam (age 8)` — the §6 check re-asserted at summary build) + `Change participant` edit action → participant step.
4. **Selection block** — per-type wording (§5): session date/time, camp week range, enrolment schedule + start, or package contents. `Change session` edit action → selection step (rendered only when the selection step exists per the skip rule).
5. **Price block** — §9 lines and total.
6. **Cancellation summary** — the program's existing mock policy preset (2–3 lines, same component family as details); full policy stays a future HMS-008 contract.
7. **Continue to checkout CTA** — sticky bottom bar above the home indicator, price-reminder line + primary button `Continue to checkout`. **Recommended behavior: inert with press feedback** (the exact owner-approved Book precedent, docs/09 §20.1) until the Checkout milestone — it must not pretend payment is functional and must not open any fake sheet. Owner may instead choose a typed `CheckoutIntent` handoff contract (§20.8).

No terms checkbox this milestone (belongs with real checkout; §20). No capacity-hold line ever (contradiction with docs/04 HMA-020 resolved in §19). No promo-code input (§20; keeps the flow input-free, §15).

## 9. Pricing presentation

Formatting reuses `formatPrice` / `priceLabel` / `spokenPriceLabel` (extended where needed, never duplicated):

| Model | Summary lines | Total line |
|---|---|---|
| Per session (`dropIn`) | `1 session · AED 85` | `Total AED 85` |
| Package | `Package of 6 sessions` | `Total AED 500` |
| Membership/monthly | `Monthly enrolment` | `AED 450 per month` (cadence, not a one-off total) |
| Term | `Term enrolment` | `AED 1,800 per term` |
| Camp | `1 week · Week of 10–14 Aug` | `Total AED 850` |
| Free | `Free activity` | `Free` |
| Free trial | `Free trial session` | `Free` |
| Paid trial | `Trial session` | `Total AED 35` |
| Discounted offer | Offer label as an informational line (`20% off first month`) | Catalogue price unchanged |

Rules:

- **Subtotal = the catalogue price. No discount arithmetic, no fees, no VAT lines.** Computing discounted totals, platform fees, payment fees, or VAT would invent business rules (docs/09 §1 discipline). **VAT display and any fee treatment are §20 open decisions**; until decided the summary shows only the price the catalogue states.
- Recurring cadences are always labeled as cadences (`per month`, `per term`) — never presented as a charged-today total.
- Paid-trial amounts become structured data (§12) — no parsing prices out of offer labels.
- Screen readers get expanded forms (`85 dirhams per session`), reusing `spokenPriceLabel`.

## 10. State ownership

Audit of existing providers — all reused, none polluted:

| Provider | Booking-flow use |
|---|---|
| `AccountProvider` | Read: real participant list for §6; guest detection (`account === null`) |
| `ParticipantProvider` | Read once at flow entry for preselection. **Never written** by the flow (no silent context changes; the details-page recovery chips remain the only writer) |
| `AreaProvider` | Read: area labels |
| `FavouritesProvider` | Untouched |
| `ResultsSessionProvider` | Untouched; preserved beneath the flow by construction |
| `DetailsService` | Reused for program/provider/branch/policy joins and the shared session derivation (§12) |

**New: `BookingSessionProvider`** (`src/state/booking-session-context.tsx`), mounted inside `src/app/booking/[programId]/_layout.tsx` — justified because no existing provider may own transient booking state (task rule) and the draft must outlive individual step screens but not the flow. It owns the `BookingDraft` (§11) plus a pure reducer (`draftReducer` — the unit-test surface, per the established pure-core pattern): `selectOption`, `selectSession`, `selectParticipant`, `reset`.

Reset behavior (mostly structural, therefore untestable-to-break):

| Event | Effect |
|---|---|
| New Book action | Fresh provider mount → empty draft |
| Cancel / back out of the flow | Stack unmount discards the draft |
| Switching program | Different `[programId]` stack instance → separate fresh draft |
| Cold deep link | Fresh mount; empty draft forces redirect to flow start (§3.2) |
| Completed mock flow | No completion exists; leaving the summary via back or exit discards the draft like any other exit |
| App interruption / backgrounding | Draft is in-memory only; OS-killed apps lose it. **No draft persistence this milestone** (no storage dependency); restoration expectations are a §20 open decision |

Current step is not stored in the draft — the route *is* the step (single source of truth; no route/state divergence possible).

## 11. Service contracts (typed, deterministic, backend-replaceable)

New `src/services/contracts/booking.ts` + `src/services/mock/mock-booking-service.ts` (pure sync cores `buildBookingOptions` / `buildBookingSummary` exported for unit tests; constructor `delayMs = 300`; `simulateFailure` QA flag — all established patterns). Screens never import raw mock arrays (docs/08 §8).

```ts
export type SessionAvailability = 'available' | 'fewLeft' | 'full';

/** One selectable dated occurrence; extends the shared SessionOccurrence data. */
export interface SessionOption {
  id: string;
  dayOffset: number;
  dayLabel: string;          // 'Today' | 'Tue 4 Aug' | 'Week of 10–14 Aug'
  timeLabel: string;
  branchLabel?: string;
  availability: SessionAvailability;
  spotsLeft?: number;        // present for fewLeft only
}

export type BookingOptionKind =
  | 'single-session' | 'free-session' | 'trial'
  | 'recurring' | 'term' | 'camp-week' | 'package';

/** One bookable shape of a program (a program may offer several, e.g. trial + enrolment). */
export interface BookingOption {
  id: string;
  kind: BookingOptionKind;
  title: string;             // 'Single session' | 'Free trial session' | 'Monthly enrolment' | …
  priceLabel: string;        // 'AED 85 per session' | 'Free' | 'AED 35' | …
  /** True when choosing this option requires picking a dated session/week. */
  requiresSession: boolean;
  sessions: SessionOption[]; // empty when requiresSession is false
  /** Plan orientation lines for dateless options ('Sat & Sun · 10:00 AM', 'Starts with the next session — Sat 8 Aug'). */
  detailLines: string[];
}

export type BookingAvailability =
  | { status: 'bookable' }
  | { status: 'noSessions' }
  | { status: 'registrationClosed'; reason: string };

/** Reuses the existing suitability presentation — no parallel eligibility type. */
export type ParticipantEligibility = ParticipantSuitability;

export interface BookingOptionsPage {
  program: Program;
  provider: Provider;
  branch?: ProviderBranch;
  availability: BookingAvailability;
  options: BookingOption[];        // ≥ 1 when bookable
  /** §2 skip rule, computed once in the service: options.length === 1 && !options[0].requiresSession. */
  skipSelectionStep: boolean;
  householdEligibility: ParticipantEligibility[];
  /** §2 preselection rule result; undefined when none applies. */
  preselectedParticipantId?: ParticipantId;
}

export interface BookingDraft {
  programId: string;
  optionId?: string;
  sessionId?: string;              // required iff the chosen option requiresSession
  participantId?: ParticipantId;
}

export interface BookingSummary {
  program: Program;
  provider: Provider;
  branch?: ProviderBranch;
  participant: ParticipantEligibility;   // suitable === true re-asserted at build time
  option: BookingOption;
  session?: SessionOption;
  selectionLines: string[];              // §5 per-type wording
  priceLines: { label: string; value: string }[];
  totalLabel: string;                    // 'Total AED 85' | 'AED 450 per month' | 'Free'
  offerLine?: string;                    // informational only, no arithmetic (§9)
  policy: CancellationPolicy;
}

export interface BookingService {
  /** Undefined for unknown program ids — the screen owns the recovery state. */
  getBookingOptions(input: {
    programId: string;
    participantId: ParticipantId;        // browsing context, for preselection only
    participants: Participant[];
    areaId: AreaId;
    simulateFailure?: boolean;
  }): Promise<BookingOptionsPage | undefined>;
  /** Undefined when the draft is incomplete or invalid — screens redirect, never render a broken summary. */
  getBookingSummary(input: {
    draft: BookingDraft;
    participants: Participant[];
    areaId: AreaId;
    simulateFailure?: boolean;
  }): Promise<BookingSummary | undefined>;
}
```

Validation lives in the service/reducer, not screens: a step's Continue is enabled only when its draft slice is valid; `getBookingSummary` re-validates everything (option exists, session exists and not full, participant eligible) so no UI path can compose an invalid summary.

## 12. Mock data audit

**Catalogue freeze holds: 36 programs, 11 providers, zero reordering, zero edits to `catalogue.ts`.** All additions are keyed extras (docs/20 §8.2 precedent).

Reusable as-is: `Program.price` (all 7 kinds present except `freeTrial`, unused), `scheduleLabel`/`todayTime`/`availableToday`/`runsOnWeekend`/`isCamp`, `eligibility`, `offer`, `programDetailExtras` (descriptions, `branchId`, `policyId`, `sessions` overrides, `spotsLeft`), `buildUpcomingSessions` + `dayLabelForOffset` (shared session derivation — booking consumes the same derivation so details and booking can never disagree about which sessions exist), suitability helpers, `formatPrice` family, `cancellationPolicies`, Blue Wave branches.

Missing booking-specific fields → new keyed module `src/data/mock/booking-extras.ts`:

```ts
export interface BookingExtras {
  /** Structured paid-trial price — no parsing offer labels (§9). */
  trialAmount?: number;                     // junior-football-u10: 35
  /** Program-level closed state (§7). */
  registrationClosed?: boolean;             // teen-arabic-summer: true
  /** Per-occurrence spots by derived-session index; 0 = full. Supersedes the single first-occurrence spotsLeft where present. */
  sessionSpots?: Record<number, number>;    // morning-yoga: { 0: 0 } (full first session)
  /** Camp week options where a camp offers more than one start (default: derived single week). */
  campWeeks?: { startOffset: number; label: string }[];
}
export const bookingExtras: Record<string, BookingExtras>; // sparse — only overrides
```

Session-availability consistency: `buildUpcomingSessions` gains `sessionSpots` awareness so **one derivation feeds both surfaces**. Consequence: the details session list will render `Full` for a zero-spot occurrence — a minor, honest extension of the approved informational list, flagged for owner awareness in §19.

Program-type demonstration coverage (all existing programs):

| Type | Programs |
|---|---|
| Single session | `beginner-calisthenics`, `boxing-fundamentals`, `morning-yoga` (full-session demo), `karate-foundations` |
| Recurring | `junior-swim-squad`, `ladies-boxing`, `arabic-adults-evenings` |
| Term | `junior-karate`, `junior-tennis-stars` |
| Camp | `holiday-swim-camp` (discount), `teen-coding-camp`, `active-summer-camp`, `teen-arabic-summer` (registration closed) |
| Package | `adult-swim-technique`, `junior-pottery`, `public-speaking` (`sessions: 'none'` — proves packages need no sessions) |
| Free | `community-park-football` |
| Trial | `ladies-strength`, `junior-robotics` (free), `junior-football-u10` (paid, 35) |

Gaps recorded (no fix this milestone): the `freeTrial` **price kind** remains unused (trials are offers); no `membership` price kind (§5.5 mapping); no multi-week camp options in default data (`campWeeks` supports it; one camp *may* get two weeks if review needs it — decided at implementation, extras-only either way).

## 13. Required states

Every state is deterministic and reachable in review (QA params follow the established `?qa-*` pattern):

Default booking · preselected eligible participant (browsing as Adam → `junior-swim-squad`) · selected participant ineligible (Adam → `mens-strength-basics`) · no eligible participants (`me-only` scenario → `junior-karate`) · one available session · multiple sessions · few places left (`reformer-pilates`) · full session (`morning-yoga`) · no sessions (session-requiring override) · recurring (`junior-swim-squad`) · camp (`holiday-swim-camp`) · package (`adult-swim-technique`) · membership-style (`mens-strength-basics`) · free (`community-park-football`) · trial free/paid (`ladies-strength` / `junior-football-u10`) · discounted offer (`reformer-pilates` 20% label line) · changed participant · changed session · loading skeletons per step (300 ms) · error/retry (`?qa-fail=1`) · unknown program (`/booking/does-not-exist`) · registration closed (`teen-arabic-summer`) · abandoned flow (exit → re-enter → fresh draft) · cold deep link (each of the three routes) · guest sign-in contract (`?qa-scenario=guest`).

## 14. Accessibility

- **Step heading and progress:** each step has an `accessibilityRole="header"` title (`Choose a session` / `Who is attending?` / `Review your booking`) plus a progress line (`Step 1 of 3`; counts adjust when the skip rule applies) — visible text, not color or position alone.
- **Session and option controls:** radio semantics (`accessibilityRole="radio"` within a labeled radiogroup); selected state exposed; RN-web `aria-checked` set explicitly (HANDOFF rule).
- **Participant controls:** same radio semantics; each row's label includes name, age, and eligibility (`Adam, age 8, suitable` / `Adam, age 8, not suitable — ages sixteen and up` via `spokenAgeLabel`).
- **Disabled/full sessions:** `accessibilityState={{ disabled: true }}` + the reason in the label (`Tuesday 4 August, 7:30 AM, full`); never color-only.
- **Eligibility announcements & draft changes:** polite live region announces selection changes and eligibility results (`Booking for Adam`); summary edits re-announce the updated selection.
- **Price and total pronunciation:** `spokenPriceLabel` everywhere (`450 dirhams per month`); totals labeled (`Total, 85 dirhams`).
- **Summary reading order:** program → participant → selection → price → policy → CTA, matching visual order; edit actions are buttons adjacent to the block they edit.
- **Sticky CTA:** labeled with action + price (`Continue to checkout, total 85 dirhams`); scroll padding accounts for bar height + insets so content is never trapped.
- **Universal:** ≥ 44 × 44 pt targets, Dynamic Type tolerance (rows grow; `maxFontSizeMultiplier` caps only where docs/12 §4 permits), reduced-motion parity, no color-only states.

## 15. Native safety (docs/12 in full)

- Safe areas top and bottom on every step; sticky CTA bars padded by `insets.bottom`; dock hidden structurally (root stack — no offsets, no flags).
- **No text inputs in this flow** (promo codes deferred, §20) — no keyboard avoidance needed; if the owner adds promo entry later it lands with the checkout milestone's keyboard plan.
- Android back pops exactly one step; iOS swipe-back enabled per step; no sheets or modals planned (selection is inline; if a future option list needs a sheet it reuses the hand-built Modal pattern).
- Nested scrolling: each step is a single vertical ScrollView; no horizontal carousels inside the flow; no nested-vertical traps.
- No DOM APIs, hover, or browser storage; the draft is React state only.
- Orientation tolerance via flex layouts; app interruption loses the in-memory draft (documented, §10).
- **Native validation will not be claimed.** All three flow screens ship native-safe and web-reviewed; the milestone report lists them at approval levels 1–2 with native validation pending (no Xcode on this machine), added to the existing device backlog.

## 16. Tests

Unit (jest, service-first, pure cores): `buildBookingOptions` per price kind (option shapes, `requiresSession`, `skipSelectionStep`, trial dual options, camp weeks, free labels) · availability derivation (`fewLeft` thresholds, `sessionSpots` full override, `noSessions`, `registrationClosed`) · preselection rule (browsing real+eligible → preselected; `everyone` → none; ineligible → none) · `householdEligibility` ordering and reasons (arbitrary synthetic participants — never demo-name-dependent) · no-eligible-participant detection · `draftReducer` transitions incl. option switch clearing a stale `sessionId`, and reset · one-participant invariant (draft holds a single id by type) · `buildBookingSummary` per type (selection lines, price lines, totals, offer line without arithmetic, policy join) · summary invalid-draft rejection (missing/full session, ineligible participant → `undefined`) · trial pricing from structured `trialAmount` · unknown id → `undefined` · `booking-navigation` href/guard policy · data invariants (booking extras keys ⊆ catalogue ids, `sessionSpots` indexes within derived windows, every price kind demonstrably covered).

QA (Playwright, 390 × 844 + 360 × 780, `scripts/qa/booking-review.mjs` under all HANDOFF locator/scroll rules): Book CTA → flow entry per type (session, skip-to-participant, trial choice) · full/disabled session not selectable, explanation visible · no-session and registration-closed recovery · participant preselection, ineligible explanation, recovery to eligible, no-eligible state · summary reflects draft; `Change session`/`Change participant` round-trips preserve the rest of the draft · Continue-to-checkout contract (inert; no route change, no dialog) · exact-origin back per step; Program Details preserved beneath (and Results session beneath that) · double-tap → no duplicate booking routes · cold deep links redirect to flow start · unknown id recovery · abandoned-flow reset (exit, re-enter, empty draft) · error/retry via `?qa-fail=1` · no fake reservation copy anywhere (explicit copy assertions) · zero console errors, no horizontal overflow.

## 17. Screenshot matrix

`artifacts/booking-review/`, every row at **390 × 844 and 360 × 780** (`-390`/`-360` suffixes):

| # | Capture |
|---|---|
| 01 | Single-session selection (multiple sessions, availability mix) |
| 02 | Session selection — few places left rows |
| 03 | Session selection — full session disabled + explanation |
| 04 | No-sessions state |
| 05 | Registration-closed state |
| 06 | Trial option step (free trial + paid trial variants) |
| 07 | Camp week selection |
| 08 | Participant step — preselected eligible (child booking) |
| 09 | Participant step — ineligible explained + eligible alternatives |
| 10 | Participant step — no eligible participants recovery |
| 11 | Participant change (after-switch state) |
| 12 | Summary — single session (top/bottom incl. sticky CTA) |
| 13 | Summary — recurring/membership |
| 14 | Summary — camp · package · free · trial (one frame each) |
| 15 | Summary after edit (changed session) |
| 16 | Sticky CTA over scrolled content |
| 17 | Error + retry |
| 18 | Unknown program recovery |
| 19 | Cold deep-link recovery (summary link → flow start) |
| 20 | Guest sign-in contract state |

## 18. Commit sequence

### Commit 12 — `feat(booking): booking foundation and session selection`

- **Scope:** `booking/[programId]` stack (+ `_layout` with `BookingSessionProvider`), `booking.ts` contract in full (summary types declared; `getBookingSummary` implemented in Commit 14 — no later contract churn), `MockBookingService` with `buildBookingOptions` + availability derivation, `booking-extras.ts`, `buildUpcomingSessions` `sessionSpots` extension, `draftReducer`, selection step screen (sessions, trial options, camp weeks, availability states, no-session/closed/unknown/error states, skeleton), `booking-navigation.ts`, **Book CTA activation** on Program Details, participant/summary route stubs that redirect to the flow start (no dead routes).
- **Files:** create `src/app/booking/[programId]/{_layout,index,participant,summary}.tsx`, `src/features/booking/{booking-selection-screen.tsx,booking-navigation.ts,…}`, `src/services/contracts/booking.ts`, `src/services/mock/mock-booking-service.ts`, `src/data/mock/booking-extras.ts`, `src/state/booking-session-context.tsx`; modify `src/services/mock/mock-details-service.ts` (shared derivation), `src/features/details/program-details-screen.tsx` (CTA activation + `Full` session row text).
- **Tests:** options builder, availability, reducer, navigation policy, data invariants; all existing suites green. **Screenshots:** rows 01–07, 18 provisional. **Stop line:** tsc/eslint/jest/expo-doctor green, QA selection-path checks green — stop for owner review.

### Commit 13 — `feat(booking): participant selection and eligibility`

- **Scope:** participant step screen (dynamic list, radio semantics, preselection, ineligible explanations, no-eligible recovery, guest contract state), eligibility wiring through the draft, live-region announcements, skip-rule redirect live (`skipSelectionStep`).
- **Files:** create `src/features/booking/booking-participant-screen.tsx` (+ row components); modify booking service (preselection/eligibility outputs), participant route.
- **Tests:** preselection matrix, ineligible recovery, no-eligible, one-participant rule, synthetic-participant label tests. **Screenshots:** rows 08–11, 20. **Stop line:** checks + QA participant-path green — stop for owner review.

### Commit 14 — `feat(booking): booking summary and flow connections`

- **Scope:** `buildBookingSummary` + summary screen (blocks per §8, edit actions, sticky Continue-to-checkout contract), draft validation end-to-end, cold-deep-link redirects finalized, abandoned-flow behavior verified, per-type summary wording.
- **Files:** create `src/features/booking/booking-summary-screen.tsx` (+ blocks); modify booking service/mock, summary route.
- **Tests:** summary builder per type, invalid-draft rejection, edit round-trips, checkout-contract inertness. **Screenshots:** rows 12–16, 19. **Stop line:** checks + QA summary-path green — stop for owner review.

### Commit 15 — `chore(booking-review): booking flow review and milestone closeout`

- **Scope:** full §13 state sweep, §14 accessibility pass per step, complete `booking-review.mjs`, full screenshot matrix (both widths), copy audit (no reservation implications), HANDOFF.md update, milestone report with the docs/12 three-level status per screen (design ✅ via this doc once approved · frontend pending owner review · native pending).
- **Files:** polish-only edits in `src/features/booking/*`, `scripts/qa/booking-review.mjs`, `artifacts/booking-review/*`, `HANDOFF.md`.
- **Stop line:** full jest/tsc/eslint/expo-doctor/all QA scripts green, zero console errors — milestone report delivered; stop for owner approval before any checkout work.

## 19. Contradiction review

Reviewed against docs/02, 04, 05, 08, 09, 12, 15, 16, 17, 18, 19, 20, HANDOFF.md:

| Document | Point | Resolution |
|---|---|---|
| docs/04 §5 HMA-017/018/019/020 | Four separate booking screens incl. a dedicated Eligibility review screen | Three steps: eligibility presentation is **inline** on the participant step (per-participant states: eligible, ineligible + reason) and re-asserted on the summary — HMA-019's purpose ("explain eligibility results per participant, never hide the reason") is fully honored without an extra low-content screen (docs/06 §4 friction rule). Refinement, recorded here; §20.14 lets the owner require a separate screen. HMA-019's "additional information required" state has no data model yet — deferred to provider onboarding. |
| docs/04 HMA-020 | Summary lists "Add-ons", "Capacity hold", "Terms acceptance" | Add-ons: no add-on model exists — future scope. **Capacity hold: deliberately omitted** — a frontend-only hold would fake reservation (docs/08 §14; this prompt's rule). Terms acceptance: deferred to checkout (§20.11). |
| docs/04 §7 connection map | `Book → Selector → Participant → Eligibility → Summary → Checkout → Payment → Confirmation` | Order followed (basis of §2). Checkout and beyond are the next milestone; the flow ends at the checkout contract. |
| docs/02 §8 | Checkout may select "multiple children" / "me and children" | Scoped to one participant this milestone (prompt's recommended initial scope); contracts keep the widening path open. §20.2 owner decision. |
| docs/02 §2 / docs/09 §17.2 | Booking requires authentication; no auth exists; inert-tap rules | Guest flow entry renders the sign-in-required contract state, inert per §17.2 — no fake auth, no placeholder screens. §20.9. |
| docs/05 §6 | Pricing list includes weekly price, private lesson, workshop, "membership" as distinct | Catalogue's seven `PriceModel` kinds are the implemented subset (established since milestone 2); membership maps to `monthly` (§5.5). No new kinds without owner approval — §20.6/§20.13. |
| docs/05 §7 / docs/16 §4 | Child hard-exclusion in lists; Ladies-only never auto-excludes | Participant step shows ineligible participants disabled-with-reason (evaluation-surface precedent, docs/20 §15) — booking is where hiding would be most harmful. No gender-based blocking anywhere. |
| docs/15 §4.3 | Back always returns to exact origin; no forced resets | Root push + per-step stack: exact-origin back throughout; recovery `replace` targets mirror the details-screen precedent. |
| docs/16 §6 / docs/04 §2 | Dock hidden on focused transactional flows | Booking stack is root-level — hidden structurally, same mechanism as `/program`. |
| docs/20 §3.10 / docs/09 §20.9 | Sessions on details are informational only, no persisted selection | Unchanged on details. The booking flow owns selection; the shared derivation keeps both surfaces consistent. The `sessionSpots` extension makes a full occurrence show `Full` on the details list too — minor honest extension of the approved surface, flagged for owner sign-off (§20.5). |
| docs/20 §3.21 / docs/09 §20.1 | Book CTA "inert until the Booking milestone" | That milestone is this one — activation is the plan's purpose. CTA-enabled-when-ineligible behavior (booking-time gate) carries over unchanged. |
| docs/18 §6 / §8 | No add-child prompting; browsing context never books | No add-child prompt in the no-eligible recovery (§6.5); flow never writes `ParticipantProvider` (§10). |
| docs/19 §3 / HANDOFF | Scenario ids never reach domain logic; `?qa-scenario` is web-guarded | Booking consumes resolved account data only; guest state derives from `account === null`, never from the scenario id. The existing native `qa-scenario` limitation stands unchanged. |
| docs/08 §4 / HANDOFF route inventory | `booking/` reserved at app root; no duplicate routes | §3 places it exactly there; double-tap guard + single entry point prevent duplicates. |
| docs/17 §18 / docs/19 §10 | "Booking/checkout out of scope" | Scoped to those milestones, both closed. Superseded by milestone progression. |

No unresolvable contradictions found.

## 20. Open product decisions (owner input needed before or during implementation)

Recommendations marked ★ are the plan's defaults; the flow is built to them unless the owner chooses otherwise.

1. **Booking sequence** — ★ Option A with the type-conditional skip (§2). Confirm.
2. **Participants per booking** — ★ one this milestone; multi-participant (docs/02 §8) deferred to a later booking iteration. Confirm.
3. **Full sessions** — ★ disabled with explanation, not hidden. Confirm.
4. **Waitlist** — ★ deferred entirely (no UI trace). Confirm.
5. **Full-session visibility on Program Details** — the shared derivation makes a zero-spot occurrence show `Full` on the (approved) details session list. ★ Accept as an honest minor extension; alternative is divergent availability between surfaces.
6. **Branch selection in booking** — ★ none: a program's branch comes from its extras `branchId` and is displayed, not chosen (no program spans branches in the data). Revisit if multi-branch programs ever exist.
7. **Recurring and camp enrolment semantics** — ★ recurring: enrol from the next derived session, cadence-labeled pricing, no auto-renewal claims (docs/09 §6 stands). Camp: week-granularity selection. Package redemption/expiry wording: undecided — summary states only package size and price (§5.4).
8. **Continue-to-checkout CTA behavior** — ★ inert with press feedback (Book-CTA precedent) until the Checkout milestone. Alternative: emit a typed `CheckoutIntent` contract object (logged/no-op) — slightly more forward-wired, same UX.
9. **Guest booking** — ★ sign-in-required contract state at flow entry (§6.5), inert until auth. Alternatives: hide Book for guests (rejected — guests may evaluate; docs/02 §2) or block at Program Details.
10. **Pricing: VAT, fees, discounted totals** — undecided by design. ★ Until decided: catalogue price only, offers as informational lines, no VAT/fee/discount arithmetic (§9). **Needs an owner decision before the checkout milestone.**
11. **Terms/cancellation acknowledgment checkbox** — ★ none this milestone (policy summary is displayed; acceptance belongs to checkout, HMA-020/021).
12. **Booking-draft persistence/restoration** — ★ in-memory only; interruption loses the draft. Persistence needs a native-storage decision (docs/14 §13 precedent) — deferred.
13. **Membership price kind** — ★ keep `monthly` as the membership representation; introducing a distinct `membership` kind (and the unused `freeTrial` kind's fate) is deferred to backend contract work.
14. **Eligibility review as its own screen (HMA-019)** — ★ inline on the participant step (§19 row 1). Confirm.
15. **Promo codes / booking notes / special requests** — ★ all deferred (promo codes to checkout; notes/requests need a provider-side model). No inputs exist in this flow.
16. **Adding a child profile mid-booking** — ★ not offered (no participant-management UI exists); the no-eligible recovery routes to browsing instead. Revisit with the Profile milestone.

## 21. Exit criteria (milestone)

1. Book CTA active on Program Details; every §4 entry behavior and every §13 state demonstrable deterministically at 390 and 360 widths.
2. §2 sequence and skip rule hold; participant preselection and no-silent-switch rules verified; one participant per booking enforced by contract and test.
3. Exact-origin back per step; Program Details (and any Results session beneath) preserved; no duplicate booking routes; cold deep links and unknown ids recover; abandoned flows reset.
4. No reservation implication anywhere (copy-audited); Continue to checkout is a contract, not a pretense; no completion route exists.
5. Catalogue byte-identical (36 programs, 11 providers); all new data in keyed extras; shared session derivation keeps details and booking consistent.
6. §14 accessibility and §15 native-safety verified per step; native validation reported as pending.
7. tsc, eslint, jest (grown suite), expo-doctor, all QA scripts green; zero console errors; screenshot matrix complete.
8. Four commits per §18, each with a stop-and-report; milestone report states the docs/12 three-level status per screen.
