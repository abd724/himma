# 22 — Checkout Plan (Milestone 5)

Status: **product-owner approved, 2026-08-04, with corrections.** The owner's corrections are reconciled into this document and recorded in `docs/09_OPEN_DECISIONS.md` §22, which governs where wording differs. Headline corrections: **no `Total` wording anywhere this milestone** (the `Booking price` label continues end-to-end); **no legal-acceptance checkboxes** (policy display only — authoritative legal text and ownership do not exist yet); **no fictional saved card** (one generic `Card payment` contract method; Apple/Google Pay contract-only and never rendered as usable); paid CTA `Continue to payment`, free CTA `Confirm booking`, both inert contracts. Governing docs: 02 (accounts/participants, checkout participant rule §8), 04 (HMA-021 inventory, §2 dock rules, §7 connection map), 05 (pricing models §6), 06 (UX/friction/copy, visible totals), 08 (engineering contract, §14 frontend-vs-backend authority), 09 (open decisions incl. §17.2 inert rule, §21 booking decisions), 12 (native rules incl. §9 Apple/Google Pay readiness), 15 §4 (no-trap rules), 16 (states/interactions), 17–21 (established service/builder/provider patterns), HANDOFF.md (frozen catalogue, live architecture, booking-flow behavior).

## 1. Milestone objective and product purpose

Implement the frontend checkout from the existing Booking Summary **Continue to checkout** CTA through order review, the payable amount, policy display, and the payment-method contract, ending at a truthful payment-submit contract. Checkout answers, in order:

1. **What exactly is being purchased?** — a condensed, re-validated order recap.
2. **Who is attending?** — the confirmed booking participant (with guardian context for child bookings).
3. **What is the payable amount?** — a price breakdown where every visible line reconciles, labelled `Booking price` (owner decision: no `Total` this milestone).
4. **What policies apply?** — the cancellation-policy summary, displayed only; no acceptance is claimed (owner decision: legal acknowledgments arrive with authoritative legal text, and are required before real payment submission is ever enabled).
5. **Which payment method will be used?** — one generic `Card payment` contract method for paid bookings.
6. **What happens on confirm?** — nothing is pretended: the final CTA is a production-styled, duplicate-press-protected, inert contract until real payment exists.

**Truthfulness boundary (absolute):** nothing in this milestone may imply that inventory is reserved, payment was processed, a booking was confirmed, a provider accepted anything, or money was charged. There is no success screen, no confirmation route, no receipt, no "we're holding your place", and no submitting spinner that resolves into pretend success (docs/08 §14).

**Not built in this milestone:** real payment gateway · Apple Pay / Google Pay execution · card entry or tokenization · backend booking creation · inventory reservation · payment capture · provider payout · booking confirmation · cancellation management · refunds · invoices · receipts · loyalty redemption · gift cards · promo-code backend validation · authentication.

## 2. Checkout input model — recommendation

Three candidate models for what Checkout consumes:

| Model | Assessment |
|---|---|
| **A. BookingSummary directly (re-derived per mount)** ★ | The summary is already the single re-validated truth of the order (docs/21 §11): program, provider, branch, participant with re-asserted eligibility, option, session, selection lines, price lines, `bookingPriceLabel`, offer line, policy. Re-deriving it from the live draft at checkout mount gives revalidation for free and adds zero duplicate state. |
| B. New CheckoutDraft copied from BookingSummary | Duplicates booking-state ownership — the copy can go stale the moment the draft is edited (Change participant/session round-trips). Rejected. |
| C. Typed CheckoutIntent created at the boundary | A frozen snapshot has the same staleness problem as B, plus it implies a handoff object the backend doesn't exist to receive. The docs/21 §20.8 decision already rejected CheckoutIntent in favor of the inert contract. Rejected for this milestone; a real intent object belongs to the payment milestone's API design. |

**Recommendation: A.** `CheckoutService.getCheckoutPage(input)` calls the same pure summary derivation the Booking Summary uses (via `MockBookingService.getBookingSummary`) and composes checkout-only presentation on top (price summary, guardian context, payment-method contract). The checkout-local choice (selected method) never duplicates a booking slice. Editing the booking invalidates nothing silently — returning to checkout re-derives everything.

## 3. Routes, step model, and navigation

### 3.1 Route — recommendation

| Surface | Route | File | Dock |
|---|---|---|---|
| Checkout | `/booking/[programId]/checkout` | `src/app/booking/[programId]/checkout.tsx` | Hidden structurally (existing root-level booking stack) |

**Why not a separate `/checkout/[programId]` root stack:** the booking draft lives in `BookingSessionProvider`, mounted in `src/app/booking/[programId]/_layout.tsx` with the flow's lifetime (docs/09 §21.13). A sibling root stack could not read that context; it would need the draft copied out — exactly the duplicate ownership §2 rejects. Adding `checkout` as a fourth screen of the existing booking stack satisfies every stated requirement structurally: root-level focused flow and dock hidden (the booking stack already is), Booking Summary preserved beneath (same-stack push), exact-origin back (stack pop), draft preserved while Checkout is mounted (provider subtree), fresh-draft reset on leaving (provider unmount), no cross-program leakage (`key={programId}`). docs/08 §4's long-term route tree reserves `booking/`, and checkout is the continuation of the same focused transactional flow (docs/04 §2).

There is **no** `/checkout/[programId]/payment` and **no** `/checkout/[programId]/status`: payment is a contract this milestone, and a status route without a real submission would be a fake state (§1). When real payment arrives, `payment`/`status` siblings can join the same stack without moving anything.

### 3.2 Step model — recommendation: one screen

Checkout is **one screen**, not two or three steps. Justification: the flow has already answered what/when/who across three booking steps; checkout adds only price finality, acknowledgments, and method selection — splitting those across routes would produce steps with near-empty content (docs/06 §4 friction rule) and multiply back/edge cases while payment is still a contract. The screen is a single vertical scroll with the sticky CTA; section order (§8) keeps legal and payment information scannable. Revisit the step count in the payment milestone if a platform payment sheet forces a modal step.

The checkout header shows the heading `Checkout` with **no step counter**: the booking flow's `Step N of N` progression is complete at the summary (docs/21 §14); checkout is its own focused surface, and a `Step 4 of 3` retrofit would be nonsense. (Contradiction handling: §17.)

### 3.3 Entry, back, and guards

- **Single entry:** the Booking Summary's Continue to checkout CTA becomes active — `router.push('/booking/[programId]/checkout')` behind the established 700 ms double-tap guard (one press, one route). This is the activation of the docs/09 §21.8 contract, which existed precisely for this milestone.
- **Back:** pops to the exact Booking Summary instance (draft intact). iOS swipe-back enabled; Android back pops one step. Editing the booking = back + the summary's existing Change actions; returning to checkout re-derives the page (§2) and checkout-local state starts clean — every derived value reflects the possibly-edited order, never a stale copy.
- **Access policy:** new pure `checkoutStepAccess(page, draft)` in `booking-navigation.ts` — exactly `summaryStepAccess` plus nothing (checkout requires the same fully-valid draft). Missing option/session or full session → flow start · missing/ineligible participant or guest (empty household) → participant step · unknown program → established recovery state · cold deep link with an empty draft → flow start. No silent draft repair.
- **Guests never reach checkout** structurally: guests cannot pass the participant step (docs/09 §21.9), and `checkoutStepAccess` redirects an empty-household draft there — where the existing inert Sign in to book contract stands. See §7.7.

## 4. Screen hierarchy (docs/04 HMA-021 refined)

Vertical scroll at ~390 × 844:

1. **Header** — back control + heading `Checkout` (header role). No step counter (§3.2).
2. **Order recap** — condensed single card, not a second Booking Summary: thumbnail, program title, provider + verification, area · branch, participant line (`Adam · Age 8`; child bookings add the guardian context line `Booked by you` — §7.9), selection line (dated session / camp week / enrolment schedule / package contents). One `Edit booking` action → back to the summary (the summary owns Change participant/session). No duplicate edit affordances.
3. **Price breakdown** — §6: base line(s), informational offer line where present, and the **`Booking price` line unchanged from the summary** (owner decision: no `Total` this milestone — §7.3). No VAT line, no fee lines (§7.1–7.2).
4. **Cancellation policy** — the program's existing preset, displayed only (same display component family as the summary) with an inert `Full policy` contract row (details-page precedent, future HMS-008). **No acknowledgment checkbox of any kind** (§7.8).
5. **Payment method** *(paid bookings only, Commit 17)* — one generic selectable `Card payment` contract method per §7.5; section absent for `Free` bookings.
6. **Sticky CTA bar** — `Booking price` line (polite live region) + primary button: `Continue to payment` (paid) / `Confirm booking` (free); readiness per §9; final press is the §7.11 inert contract.
7. **Support row** — `Something wrong with your booking?` inert contract (HMA-032 pattern, details-page precedent). No provider phone numbers (docs/09 §11).

Per-type composition:

| Booking | Recap selection line | Price block | Payment section | CTA (inert contract) |
|---|---|---|---|---|
| One-off paid session | `Tue 4 Aug · 7:30 PM` (+ branch) | `1 session · AED 85` → `Booking price · AED 85 per session` | Yes | `Continue to payment` |
| Monthly enrolment | schedule + start lines | `Monthly enrolment` → `Booking price · AED 450 per month` (cadence, §7.3) | Yes | `Continue to payment` |
| Term | term schedule | `Term enrolment` → `Booking price · AED 1,800 per term` | Yes | `Continue to payment` |
| Camp | `Week of 17–21 Aug · 9 AM–12 PM` | `1 week · Week of 17–21 Aug` → `Booking price · AED 850 per week` | Yes | `Continue to payment` |
| Package | `Package of 6 sessions` + orientation | `Booking price · AED 480` | Yes | `Continue to payment` |
| Free / free trial | dated session where applicable | `Booking price · Free` (never `AED 0`) | Absent | `Confirm booking` |
| Paid trial | `Trial session · Tue, 5:30 PM` | `Booking price · AED 35` (structured `trialAmount`) | Yes | `Continue to payment` |
| Child booking | any of the above | unchanged | unchanged | unchanged; recap shows child + `Booked by you` (§7.9), **no consent checkbox** |

## 5. State ownership

Audit — all existing providers reused, none polluted:

| Provider / service | Checkout use |
|---|---|
| `BookingSessionProvider` | **The** order source: checkout reads the live draft (same subtree, §3.1). Never written by checkout. |
| `AccountProvider` | Guest detection; the deterministic demo payment-method fixture (§10) resolves through the account like credit does. |
| `ParticipantProvider` | Untouched (the booking draft already owns the participant). |
| `AreaProvider` | Area labels only. |
| `DetailsService` / `BookingService` | Reused through `CheckoutService` composition — branch, policy, summary derivation. No parallel joins. |
| `FavouritesProvider` / `ResultsSessionProvider` | Untouched; preserved beneath by construction. |

**No `CheckoutSessionProvider`.** Checkout is one screen; its only local state is the selected payment method and the CTA guard — owned by a pure, unit-tested `checkoutReducer` (`selectMethod`, `reset`) in component state (no acceptance state exists — §7.8). A provider would outlive its only consumer for no benefit.

Reset behavior:

| Event | Effect |
|---|---|
| Leaving Checkout (back, exit) | Screen unmount discards the method selection; draft untouched |
| Returning to Booking Summary and editing | Re-entering checkout re-derives the page; checkout-local state starts clean |
| Switching program | Different `[programId]` stack → fresh provider and fresh checkout |
| Cold deep link | Empty draft → `checkoutStepAccess` redirect to flow start |
| Failed payment contract | N/A this milestone (no submission exists); the declared `PaymentSubmitResult` failure shape belongs to the payment milestone |
| App reload / termination | In-memory only — flow and checkout state discarded (docs/09 §21.13 unchanged) |

## 6. Pricing integrity

1. **Reconciliation invariant:** every numeric line visible in the price breakdown participates in the `Booking price` amount, and a unit test recomputes that amount from structured price data (never parsed from copy) for every bookable program × option. With no VAT and no fees (§7.1–7.2) the invariant is currently `bookingPrice = base`; the test structure is what matters — any future line (fee, tax, discount, credit) must reconcile or fail CI.
2. **No `Total` anywhere this milestone** (owner decision, §7.3): the `Booking price · …` label continues end-to-end from the summary. `Total` may be introduced only when an authoritative backend price breakdown includes all applicable taxes, fees, discounts, and credits and reconciles exactly. Recurring and term amounts keep cadence labels and are never presented as a one-time charge — first-collection semantics remain undecided (docs/09 §6).
3. **Free is the word** — `Free`, never `AED 0`, on every line, label, and spoken form (docs/06 §14, established booking rule).
4. **No hidden amounts:** no fee, VAT, or discount arithmetic exists anywhere in the code path (§7.1–7.4); percentage offers stay informational lines.
5. **Spoken pricing:** `spokenPriceLabel` / `spokenBookingPriceLabel` reuse — `Total, 85 dirhams`, `450 dirhams per month`, `Free`. Never bare "AED" for screen readers.
6. **Currency formatting** stays centralized in `src/utils/price.ts` (single Arabic-ready seam for future `ar-AE` locale formatting; no new formatting sites).

## 7. Open product decisions — analysis and recommendations

Each item is an owner decision; ★ marks the plan's recommended default. The flow is built to the starred defaults unless the owner chooses otherwise.

### 7.1 VAT

UAE VAT applies to most commercial activity services, but Himma has no tax configuration, no provider tax profiles, and no backend. Presenting any VAT line would assert a legal/accounting rule the product has not made (docs/09 §1 discipline). Options: (a) prices VAT-inclusive; (b) VAT added at checkout; (c) provider-specific; (d) ★ **no VAT line until backend tax configuration exists**. The `TaxTreatment` contract (§11) ships as `'notConfigured'`, the UI renders no tax line and makes no inclusive/exclusive claim, and the three real options remain open. **Needs an owner/legal decision before the payment milestone.**

### 7.2 Platform, booking, and payment fees

★ **No Himma fee of any kind this milestone** — no fixed booking fee, no percentage platform fee, no provider-specific fees, no payment-method fees. Inventing a fee fabricates a business model decision. The `FeeLine` contract is declared (typed, unused) so a future fee reconciles through §6.1 instead of being bolted on. **Fee policy is an owner decision for the payment/business milestone.**

### 7.3 Final payable amount — **owner-decided: no `Total` this milestone**

The plan's original recommendation (graduating one-off amounts to `Total` on checkout) was **rejected by the owner**. Decided behavior: checkout continues the exact `Booking price · …` labels from the summary — `Booking price · AED 85 per session`, `Booking price · AED 480`, `Booking price · AED 850 per week`, `Booking price · AED 450 per month`, `Booking price · Free`. **`Total` may be introduced only when an authoritative backend price breakdown includes all applicable taxes, fees, discounts, and credits and reconciles exactly.** Recurring/term amounts keep cadence labels with no "first payment" or "charged today" claim (docs/09 §6 stays open). Free stays `Free`. Contracts and tests enforce the absence of `Total` (§11, §14).

### 7.4 Discounts and offers

- Fixed provider-listed prices (incl. structured paid-trial `trialAmount`): already authoritative — display as-is. ★
- Percentage/first-month offers (`20% off first month`): ★ **remain informational lines with no arithmetic** until a backend returns an authoritative discounted amount — a frontend-computed discount would fake pricing authority (docs/08 §14).
- Free/paid trials: already first-class booking options; no change.
- Promo codes: ★ **deferred entirely** — no input field this milestone. An inert promo field would fake function (worse than absence, docs/09 §17.2 spirit); real validation needs the backend. Owner may pull a contract-only field forward.

### 7.5 Payment methods — **owner-decided: one generic contract method**

The plan's original demo-saved-card recommendation was **rejected by the owner** — no fictional saved card, no last-four digits, no cardholder name, no expiry, no saved-card management, no fictional payment tokens. Decided behavior:

| Method | Decision |
|---|---|
| **`Card payment`** (generic) | The single selectable contract method for paid bookings. A plain labelled row — no card details of any kind exist or are implied. |
| Apple Pay / Google Pay | **Contract-only/deferred** until real platform and gateway support exist; **never rendered as usable customer methods**. The typed kinds remain declared (docs/12 §9 readiness). |
| New-card entry, cash at provider, pay later, method fees | **Deferred**; no UI trace. |
| Free booking | No payment-method section at all (§4). |

### 7.6 Free bookings — **owner-approved**

CTA reads **`Confirm booking`** (never `Pay`), the price line reads `Booking price · Free`, no payment-method section renders, and confirming remains the §7.11 inert contract: **no success state exists for free bookings either**, because no backend confirms them. Free-trial bookings behave identically with the trial wording.

### 7.7 Guest behavior

★ **Checkout requires an account by rule, enforced structurally now:** guests cannot pass the participant step (existing sign-in contract, docs/09 §21.9), and `checkoutStepAccess` sends any empty-household draft back there. Checkout itself renders no auth UI, fabricates no account, and shows no saved anything for guests. When real authentication ships, the sign-in gate stays at the participant step (earliest honest gate) unless the owner moves it.

### 7.8 Terms and policy acknowledgment — **owner-decided: display only, no checkboxes**

The plan's original two-checkbox recommendation was **rejected by the owner**: authoritative legal text and its ownership do not yet exist, so **no mandatory acceptance checkboxes are implemented** — not for Himma Terms & Conditions, provider cancellation policy, guardian consent, waivers, health declarations, or privacy consent. Decided milestone behavior:

- the cancellation-policy summary is **displayed** (existing mock preset, wording already flagged placeholder);
- an inert `Full policy` contract row may exist (details-page precedent, future HMS-008);
- **no acceptance is claimed anywhere** — no checkbox, no "by continuing you agree" copy;
- the CTA is **never gated on unavailable legal text**.

**Binding constraint recorded for the future:** all applicable legal acknowledgments (terms, cancellation policy, guardian consent, any required waivers) are **required before real payment submission is ever enabled** — the Payment milestone cannot ship a live submit without them and their counsel-approved sources.

### 7.9 Minor participant consent — **owner-decided: display context only**

The plan's original guardian-consent-checkbox recommendation was **rejected by the owner** — consent mechanics belong to a later legal/profile decision. Decided milestone behavior: child bookings **clearly display the child participant** (name, age) and **the guardian context where available** (`Booked by you` — the primary account holder), with **no consent checkbox and no invented emergency-contact, health, waiver, or consent fields** (docs/02 §5's field set is explicitly not final). Guardian consent joins the §7.8 binding constraint for the Payment milestone.

### 7.10 Capacity and price revalidation

The frontend never claims a draft is still valid without revalidation. Two layers:

1. **Now (deterministic):** checkout re-derives the summary at mount (§2) — a draft whose session filled, program closed, or participant became ineligible in mock data fails `checkoutStepAccess` and redirects to the owning step. Because mock availability never changes mid-session (docs/21 §7 decision stands), the *mid-checkout change* states are reachable **only via QA params** (`?qa-revalidate=sessionFull|priceChanged|offerExpired`, established `?qa-*` pattern) for review, rendering honest recovery states: `This session filled up while you were checking out.` + return-to-selection action; price-changed shows old → new with an explicit `Review updated price` action that re-derives.
2. **Future backend contract:** `CheckoutValidation` (§11) with issue codes `sessionFull` · `registrationClosed` · `priceChanged` · `offerExpired` · `participantIneligible` · `branchUnavailable` · `invalidDraft`, returned by `getCheckoutPage` and (later) by the real submit. The screen maps every code to a recovery action; the payment milestone's backend swaps the deterministic source for real revalidation without touching the screen.

### 7.11 Payment-submit behavior — **owner-approved: inert contract; no mock state machine**

The owner approved option A and explicitly rejected a mock payment state machine. Decided behavior — both CTAs (`Continue to payment` for paid, `Confirm booking` for free) are: production-styled · protected against duplicate presses · **inert with press feedback** · no navigation · no dialog · no success state · no failure state · no reservation · no booking creation · no payment request. Readiness gating (§9) is limited to what is real: a valid re-derived summary, and for paid bookings a selected `Card payment` method (Commit 17). `PaymentSubmitRequest`/`PaymentSubmitResult` remain **declared in the contract file** for the Payment milestone but are **never invoked, constructed, or logged as though a submission occurred**.

### 7.12 Confirmation boundary

Checkout ends at the submit contract. The **future Payment & Confirmation milestone (HMA-022 + HMA-023)** exclusively owns: payment processing/success/failure/pending states, capacity-lost handling, booking-confirmed and booking-pending states, provider-approval-required flows, receipts, booking reference, calendar entry, and the Bookings-tab handoff. Checkout must never absorb any of it; this plan creates no route, state, or copy in that territory. (docs/04 §7's `Checkout → Payment Status → Confirmation` chain is honored by stopping exactly at the arrow.)

Also surfaced from docs/04 HMA-021: the **Marketplace Credit checkbox** ("Use AED 65 credit"). **Owner-decided: deferred to the Credits milestone (docs/09 §22.12)** — no credit checkbox, no subtraction of the demo balance, no ledger or redemption behavior; the `CheckoutPriceLine` kind `'credit'` is declared so future credit lines reconcile.

## 8. Required states

Classification: **in scope** (deterministically demonstrable) · **contract-only** (typed/declared, review-reachable via QA param where noted) · **deferred** (another milestone).

| State | Class | Trigger / notes |
|---|---|---|
| Paid one-off checkout | in scope | `beginner-calisthenics` |
| Monthly enrolment | in scope | `junior-swim-squad` (cadence final line) |
| Term | in scope | `junior-karate` |
| Camp | in scope | `holiday-swim-camp` |
| Package | in scope | `adult-swim-technique` |
| Free | in scope | `community-park-football` (`Confirm booking`) |
| Free trial | in scope | `ladies-strength` |
| Paid trial | in scope | `junior-football-u10` (AED 35) |
| Offer informational-only | in scope | `reformer-pilates` (no arithmetic) |
| Child booking (child + guardian context shown) | in scope | Adam → `junior-swim-squad`; no consent checkbox (§7.9) |
| Policy summary displayed, nothing accepted | in scope | every checkout; `Full policy` row inert |
| Generic `Card payment` selected | in scope (Commit 17) | the single contract method (§7.5) |
| Card payment not yet selected (paid) | in scope (Commit 17) | CTA readiness status names the gap |
| Apple/Google Pay | deferred | never rendered as usable methods (§7.5); kinds declared only |
| Saved card / new-card entry / no-method states | deferred | no fictional cards or tokens exist (§7.5) |
| Session became full (mid-checkout) | contract-only | `?qa-revalidate=sessionFull` recovery state |
| Registration closed | in scope | entry-time redirect via access policy (`teen-arabic-summer`) |
| Price changed | contract-only | `?qa-revalidate=priceChanged` review state |
| Offer expired | contract-only | `?qa-revalidate=offerExpired` review state |
| Participant ineligible | in scope | access-policy redirect to participant step |
| Booking draft missing | in scope | cold link → flow start |
| Unknown program | in scope | established recovery state |
| Error / retry | in scope | `?qa-fail=1` on the checkout route |
| Offline | in scope | same error card family (deterministic flag; no real network states) |
| Cold deep link | in scope | `/booking/x/checkout` with empty draft |
| Abandoned checkout | in scope | exit → re-enter → clean checkout state, fresh derivation |
| Duplicate-submit protection | in scope | double-tap guard on the CTA (mechanics real even while inert) |
| Submitting state | deferred | payment milestone (no submission exists) |
| Payment failure | contract-only | `PaymentSubmitResult` failure shape declared; no UI |
| Payment success | deferred | Payment & Confirmation milestone (§7.12) |

## 9. Validation model

`checkoutReadiness(page, state)` — pure, unit-tested; the single readiness rule for the CTA (no legal gating exists — §7.8):

- draft-derived summary present (else the access policy already redirected);
- for paid bookings, the generic `Card payment` method selected (Commit 17);
- output: `{ ready: boolean; blocker?: string }` where the blocker maps to the status line (`Choose a payment method to continue`) — the CTA is never unready without a visible reason (docs/04 HMA-019 principle applied to forms). When ready, the press remains the §7.11 inert contract.

## 10. Data audit

**Sufficient already:** every `BookingSummary` field (§2); `bookingExtras` (`trialAmount`, `registrationClosed`, `sessionSpots`, `campWeeks`); cancellation presets; provider/branch extras; participant records (name, kind, dateOfBirth → consent wording); pricing helpers (`formatPrice`/`priceLabel`/`spokenPriceLabel`); booking navigation policies (extended, not duplicated).

**Missing — add as deterministic frontend review data:**

| Data | Home | Notes |
|---|---|---|
| Generic `Card payment` method row | `CheckoutService` composition (static; no fixture file, no card data) | The single contract method (§7.5); no `payment-methods.ts` module is created — there is nothing to store |
| Checkout copy (guardian-context line, blocker line, revalidation copy) | feature presentation / service composition | Copy-only; no legal claims anywhere |

**Missing — needs authoritative backend ownership (declared, not populated):** tax configuration (`TaxTreatment` ≠ `notConfigured`), fee schedule, authoritative discounted amounts, real payment methods/tokens, submit results, revalidation truth.

**Legal-copy gaps (owner + counsel):** Himma T&C document, final cancellation-policy wording, guardian-consent wording review.

**Catalogue frozen: 36 programs, 11 providers, zero edits.** No new booking extras are needed — every §8 in-scope state is reachable with existing data plus the payment-method fixture and QA params.

## 11. Typed contracts (exact)

New `src/services/contracts/checkout.ts` + `src/services/mock/mock-checkout-service.ts` (pure sync core `buildCheckoutPage` exported for unit tests; `delayMs = 300`; `simulateFailure` — all established patterns). Screens never import raw mock arrays (docs/08 §8).

```ts
/** Display-only vs authoritative is explicit throughout: everything here is
 * frontend display composition until a backend owns it (docs/08 §14). */

export type TaxTreatment = 'notConfigured' | 'includedInPrice' | 'addedAtCheckout' | 'providerSpecific';

export interface CheckoutPriceLine {
  id: string;
  kind: 'base' | 'discount' | 'fee' | 'tax' | 'credit';   // only 'base' emitted this milestone
  label: string;            // '1 session' | 'Monthly enrolment' | …
  value: string;            // 'AED 85' | 'AED 450 per month' | 'Free'
  /** Numeric participation in reconciliation — from structured price data,
   * never parsed from copy; undefined for cadence/free display lines. */
  amount?: number;
}

export interface CheckoutPriceSummary {
  lines: CheckoutPriceLine[];
  /** Informational only — never arithmetic (docs/09 §21.10, §22.5). */
  offerLine?: string;
  /** One-off amounts reconcile numerically; no 'total' concept exists this
   * milestone (docs/09 §22.4). */
  priceKind: 'oneOff' | 'cadence' | 'free';
  /** The structured one-off amount the lines must sum to; undefined for cadence/free. */
  amount?: number;
  /** 'Booking price · AED 85 per session' — continued unchanged from the
   * summary; never 'Total' (docs/09 §22.4). */
  bookingPriceLabel: string;
  spokenBookingPriceLabel: string;
  taxTreatment: TaxTreatment;                              // 'notConfigured' this milestone (docs/09 §22.2)
}

export interface FeeLine extends CheckoutPriceLine { kind: 'fee' }        // declared, never emitted (§7.2)
export interface DiscountLine extends CheckoutPriceLine { kind: 'discount' } // declared, never emitted (§7.4)

export type PaymentMethodKind = 'card' | 'applePay' | 'googlePay';        // applePay/googlePay declared only (§7.5)
export type PaymentMethodAvailability =
  | { status: 'contractOnly' }                              // selectable; submit stays the §7.11 contract
  | { status: 'unavailable'; reason: string };              // reserved for future honest disablement

export interface PaymentMethod {
  id: string;
  kind: PaymentMethodKind;
  /** 'Card payment' — generic. Never card details, last-four digits, expiry,
   * tokens, or fictional saved cards (docs/09 §22.6). */
  label: string;
  availability: PaymentMethodAvailability;
}

export type CheckoutIssueCode =
  | 'sessionFull' | 'registrationClosed' | 'priceChanged' | 'offerExpired'
  | 'participantIneligible' | 'branchUnavailable' | 'invalidDraft';

export type CheckoutValidation =
  | { ok: true }
  | { ok: false; issues: { code: CheckoutIssueCode; message: string }[] };

export interface CheckoutPage {
  summary: BookingSummary;                                  // §2: re-derived, single source (policy displayed from summary.policy)
  price: CheckoutPriceSummary;
  /** 'Booked by you' for child bookings (§7.9); no consent model exists (§7.8). */
  guardianContextLine?: string;
  /** [generic Card payment] for paid bookings (populated in Commit 17); [] for free. */
  paymentMethods: PaymentMethod[];
  paymentRequired: boolean;
  validation: CheckoutValidation;                           // §7.10 layer-2 shape (deterministic now)
  ctaLabel: 'Continue to payment' | 'Confirm booking';      // docs/09 §22.11
  spokenCtaLabel: string;
}

/**
 * Declared for the payment milestone — never invoked, constructed, or logged
 * this milestone (docs/09 §22.11). A real submission additionally requires
 * the counsel-sourced legal acknowledgments recorded in §7.8.
 */
export interface PaymentSubmitRequest {
  draft: BookingDraft;
  paymentMethodId: string;
}
export type PaymentSubmitResult =
  | { status: 'notAvailable' }
  | { status: 'failed'; code: CheckoutIssueCode | 'paymentDeclined'; message: string }
  | { status: 'succeeded'; confirmationHandoff: unknown };  // owned by the confirmation milestone

export interface CheckoutService {
  /** Undefined for unknown programs; CheckoutValidation carries draft issues. */
  getCheckoutPage(input: {
    draft: BookingDraft;
    participants: Participant[];
    areaId: AreaId;
    simulateFailure?: boolean;
    qaRevalidate?: CheckoutIssueCode;                        // QA-only review states (§7.10; wired in Commit 18)
  }): Promise<CheckoutPage | undefined>;
}
```

Checkout-local UI state: `checkoutReducer(state, action)` — `{ paymentMethodId?: string }` with `selectMethod` / `reset` (pure, tested; §5). No acceptance state exists (§7.8).

## 12. Accessibility plan

- **Heading:** `Checkout` as `accessibilityRole="header"`; section titles are headers; reading order = §4 order (recap → price → policy → payment → CTA → support), asserted structurally in QA like the booking summary.
- **Order recap:** one accessible group labelled with program, participant, and selection (`Junior Swim Squad for Adam, Sat 8 Aug 10:00 AM, Blue Wave Swimming`); `Edit booking` a button adjacent to the group.
- **Policy display:** the cancellation summary is plain readable text (no tiny type, no scroll-trapped fine print, no acceptance claim); the inert `Full policy` row is a button with an honest label.
- **Payment method (Commit 17):** radiogroup/radio semantics with explicit `aria-checked` (booking-flow precedent); the generic `Card payment` row's label is exactly that — no card details spoken or shown.
- **Price lines:** row labels pair label+value (`1 session, 85 dirhams`); the amount line uses `spokenBookingPriceLabel` (`Booking price, 85 dirhams per session`); `Free` spoken as "Free".
- **Sticky CTA:** label = action + booking price (`Continue to payment, Booking price, 85 dirhams per session` / `Confirm booking, free`); the status line is a polite live region announcing readiness blockers and their resolution; scroll padding clears bar + insets.
- **Guardian context:** the child booking's recap group speaks child and guardian context naturally (`Adam, age 8, booked by you`); no consent wording exists (§7.9).
- **Universal:** ≥ 44 pt targets, Dynamic Type tolerance (rows grow; `maxFontSizeMultiplier` only where docs/12 §4 permits), reduced-motion parity, no color-only state (selected method = radio mark + border; readiness blockers named in text).
- Error/revalidation states: message then recovery action in reading order; announced politely.

## 13. Native safety plan (docs/12 in full)

- Safe areas top and bottom; sticky CTA bar padded by `insets.bottom`; dock hidden structurally (existing booking stack).
- Android back pops to the summary; iOS swipe-back enabled; no sheets planned (if a future method list needs one, the hand-built Modal pattern applies).
- **No text inputs this milestone** (no card fields, no promo field — §7.4/§7.5), so no keyboard plan is needed yet. The payment milestone owns secure card entry: fields via the gateway's native SDK components, `secureTextEntry` boundaries, **no card data in ordinary React state ever** — recorded now as a binding constraint on that milestone.
- No DOM APIs, hover, or browser storage; checkout state is React state only; app interruption discards it (§5).
- Double-submit prevention on the CTA (700 ms guard) even while the press is a contract — the mechanics ship real.
- Platform payment-sheet contracts: Apple/Google Pay rows render per platform via `Platform.select`-safe logic with web preview parity; no sheet API is invoked.
- Orientation tolerance via flex layouts; single vertical ScrollView, no nested-scroll traps.
- **Native validation will not be claimed** — the screen ships native-safe and web-reviewed at approval levels 1–2; device items join the HANDOFF backlog.

## 14. Tests

Unit (jest, service-first, pure cores):
`buildCheckoutPage` derivation from every valid draft shape per type (price lines, `priceKind`, `bookingPriceLabel` continuity with the summary, CTA label per §4, payment-section presence, guardian context only for child drafts — synthetic participants, never demo-name-dependent) · **reconciliation invariant across every bookable program × option** (numeric line amounts sum to `price.amount` for `priceKind: 'oneOff'`, from structured data only; cadence/free carry no numeric amount) · **no `Total` wording anywhere** (label sweep) · no VAT/tax line and `taxTreatment: 'notConfigured'` · no fee lines · no discount arithmetic (reformer: no `520` anywhere; offer line informational) · free bookings never contain `AED 0` · `checkoutReadiness` matrix (paid without method → named blocker; free → ready; Commit 17) · `checkoutReducer` transitions + reset · `checkoutStepAccess` matrix (valid render; missing option/session/full → selection; missing/ineligible participant/guest → participant; unknown → recovery; empty draft → flow start) · invalid summary → `undefined` passthrough · QA revalidation states render the declared codes (Commit 18) · submit contract guard: nothing constructs or invokes `PaymentSubmitRequest`.

QA (Playwright, 390 × 844 + 360 × 780, `scripts/qa/checkout-review.mjs` under all HANDOFF locator/scroll rules):
summary → Continue to checkout activates (route, double-tap guard → one route) · per-type checkout journeys (§4 table incl. free `Confirm booking` and paid-trial amount) · policy summary displayed with no checkbox and no acceptance claim · child booking shows child + `Booked by you`; adult booking shows neither consent nor guardian line · payment-method radio semantics incl. explicit aria state (Commit 17) · final press: no route change, no dialog (inert contract) · edit-booking round-trip (checkout → summary → change participant → checkout re-derived) · summary preserved beneath checkout (back shows the intact draft) · exact-origin back chain Checkout → Summary → Participant → Selection → Details → origin · cold links and missing-draft redirects · unknown program recovery · registration-closed/ineligible entry redirects · `?qa-revalidate` recovery states (Commit 18) · error/retry via `?qa-fail=1` · abandoned checkout reset · copy assertions: no reservation/hold/charged-today/confirmed/receipt language, **no `Total`**, no VAT/fee lines, no `AED 0`, no card details · reading order · zero console errors · no horizontal overflow.

## 15. Screenshot matrix

`artifacts/checkout-review/`, every row at **390 × 844 and 360 × 780**:

| # | Capture | Class / commit |
|---|---|---|
| 01 | Paid single-session checkout (top/bottom incl. sticky CTA) | in scope · 16 |
| 02 | Monthly enrolment (cadence `Booking price`, `Continue to payment`) | in scope · 16 |
| 03 | Camp checkout | in scope · 16 |
| 04 | Package checkout | in scope · 16 |
| 05 | Free booking (`Booking price · Free`, `Confirm booking`, no payment section) | in scope · 16 |
| 06 | Free trial | in scope · 16 |
| 07 | Paid trial (AED 35) | in scope · 16 |
| 08 | Child booking (child + `Booked by you` context, no consent row) | in scope · 16 |
| 09 | Price breakdown detail (offer line, `Booking price` label) | in scope · 16 |
| 10 | Payment-method contract row (`Card payment` selected) | in scope · 17 |
| 11 | Paid CTA readiness (blocker named vs ready) | in scope · 17 |
| 12 | Session-full revalidation recovery | contract-only (QA param) · 18 |
| 13 | Price-changed revalidation recovery | contract-only (QA param) · 18 |
| 14 | Error + retry | in scope · 16 |
| 15 | Cold deep-link recovery (checkout link → flow start) | in scope · 16 |
| 16 | Sticky CTA over scrolled content | in scope · 16 |
| — | Submitting / payment-failure / saved cards | **not captured** — deferred states must not be faked for screenshots; declared shapes only |

## 16. Commit sequence

### Commit 16 — `feat(checkout): add checkout foundation and price review`

- **Scope:** `checkout.tsx` route in the booking stack, `checkout.ts` contract file **declared in full** (incl. submit types — no later churn), `MockCheckoutService` + pure `buildCheckoutPage` (re-derived BookingSummary input, price-line builder with structured amounts, `Booking price` continuity, per-type CTA labels, guardian context line), reconciliation validation, `checkoutStepAccess`, **Continue-to-checkout activation** on the Booking Summary (double-tap guard), one-screen structure: order recap (program, provider, participant, selection, branch) + price breakdown + cancellation-policy summary (display only, inert `Full policy` row) + support row + inert CTA, skeleton, error/unknown/invalid-draft/cold-link recovery. **No payment-method implementation, no legal checkboxes, no submit behavior beyond the inert contract boundary.**
- **Files:** create `src/app/booking/[programId]/checkout.tsx`, `src/features/booking/checkout-screen.tsx`, `src/services/contracts/checkout.ts`, `src/services/mock/mock-checkout-service.ts`; modify `booking-navigation.ts` (`checkoutStepAccess`, checkout href), `booking-summary-screen.tsx` (CTA activation only).
- **Tests:** derivation per type, invalid-summary rejection, reconciliation invariant, no-Total/no-VAT/no-fee/no-discount sweeps, access matrix, activation guard; all suites green. **Screenshots:** rows 01–09, 14–16 provisional. **Stop line:** tsc/eslint/jest/expo-doctor green, checkout QA green, booking/details/regression QA green — stop for owner review.

### Commit 17 — `feat(checkout): payment-method contract and checkout readiness`

- **Scope (reconciled — no saved card, no legal checkboxes):** the generic `Card payment` contract method row (radio semantics, no card details), `checkoutReducer` (`selectMethod`/`reset`), `checkoutReadiness` gating with named blockers, free-versus-paid CTA behavior finalized (`Confirm booking` / `Continue to payment`, both inert), policy summary remains display-only, live-region announcements.
- **Files:** create the method-row component; modify `checkout-screen.tsx`, mock service (method composition).
- **Tests:** readiness matrix, reducer, method aria-state QA checks, free/paid CTA matrix. **Screenshots:** rows 10–11 provisional. **Stop line:** checks + QA green — stop for owner review.

### Commit 18 — `feat(checkout): revalidation states and flow hardening`

- **Scope:** `?qa-revalidate` review states (sessionFull/priceChanged/offerExpired) with recovery actions — QA-only demonstrations, no implied live polling, no simulated contention, no silent repair — edit-booking round-trip polish, abandoned-checkout verification, cold-link/duplicate-route hardening, copy assertions wired into QA, submit-contract guard test.
- **Files:** polish edits in `src/features/booking/checkout-*`, mock service, `scripts/qa/checkout-review.mjs` growth.
- **Tests:** revalidation rendering, round-trip draft integrity, no-fake-success guards. **Screenshots:** rows 16–18 + refreshed journeys. **Stop line:** checks + QA green — stop for owner review.

### Commit 19 — `chore(checkout-review): checkout review and milestone closeout`

- **Scope:** full §8 state sweep, §12 accessibility pass, complete §15 matrix both widths, copy audit (no reservation/confirmation/receipt implication anywhere), navigation/draft-lifetime audit, full regression (all nine QA suites), HANDOFF.md update, docs/22 status header update, milestone report with docs/12 three-level status.
- **Stop line:** everything green; report delivered; **stop for owner approval before any payment-milestone work.**

## 17. Contradiction review

Reviewed against docs/02, 04, 05, 06, 08, 09, 12, 15, 16, 17, 18, 19, 20, 21, HANDOFF.md:

| Document | Point | Resolution |
|---|---|---|
| docs/09 §21.11 | `Booking price`, never `Total`, "before VAT and fee decisions exist" | **Owner re-affirmed and extended (docs/09 §22.4):** no `Total` anywhere in this milestone either — checkout continues the `Booking price` labels. `Total` waits for an authoritative backend breakdown that reconciles taxes, fees, discounts, and credits exactly. |
| docs/09 §21.8 / §20.1 | Continue-to-checkout inert "until the Checkout milestone" | That milestone is this one — activation is the plan's purpose; the inert pattern moves one boundary outward to the payment-submit CTA (§7.11), same precedent. |
| docs/04 HMA-021 | Lists price breakdown, **Marketplace Credit checkbox**, payment method, **gift or promotional code**, final action | Breakdown/method/final action: implemented. Credit checkbox: deferred to the Credits milestone (no ledger — §7.12, owner decision §18). Promo/gift codes: deferred (§7.4; gifts are their own milestone). `credit`/`discount` line kinds are declared so both reconcile later. |
| docs/04 §7 | `Summary → Checkout → Payment Status → Confirmation` | Order honored; this milestone stops at the Checkout→Payment arrow (§7.12). No payment-status or confirmation route exists. |
| docs/04 HMA-020 | "Terms acceptance" listed on the summary | docs/09 §21.12 moved acceptance to checkout; **docs/09 §22.7 now defers the acceptance mechanics entirely** until authoritative legal text exists — both the summary and checkout stay acknowledgment-free, and all legal acknowledgments are required before real payment submission is enabled. |
| docs/09 §6 | Recurring payment model open (auto-renewal undecided) | §6.2/§7.3: cadence labels only, no first-payment or renewal claims anywhere. |
| docs/02 §8 | Checkout may select multiple participants | Single-participant scope carried over from docs/09 §21.2 unchanged; checkout displays the draft's one participant. Widening stays a contract-level path. |
| docs/02 §2 / docs/09 §21.9 | Booking/paying requires an account; no auth exists | §7.7: structural guest gate at the participant step stands; checkout adds no auth UI and fabricates nothing. |
| docs/02 §5 | Child-profile legal field set not final | §7.9 shows display context only from existing fields (child name/age, `Booked by you`); consent mechanics and waiver/health/emergency data explicitly deferred to legal review (docs/09 §22.8). |
| docs/08 §14 | Frontend previews; backend authoritative for totals/charges | The §11 contracts mark authority explicitly; no arithmetic beyond the catalogue price; submit is declared, not wired. |
| docs/12 §9 | Checkout UI "must not assume card-only flows" | The generic `Card payment` row is a contract, not an architecture: `PaymentMethodKind` declares `applePay`/`googlePay`, and the method list renders from data — platform pay slots in without redesign. Owner decided the rows are not rendered as usable methods until real support exists (docs/09 §22.6). |
| docs/06 §4 | "Visible payment totals", minimal friction | One-screen model (§3.2) with the §6 reconciliation invariant. |
| docs/16 §6 / docs/04 §2 | Dock hidden on transactional flows | Inherited structurally — checkout lives in the existing root booking stack. |
| docs/18 §6 | No add-child prompting | The consent row names an existing child only; no participant-creation affordance anywhere (incl. the no-method and recovery states). |
| docs/20 §13 / docs/21 §18 | Prior stop lines: "no checkout work without owner approval" | Honored — this document is the approval instrument; implementation waits for sign-off. |
| docs/21 §8 / HANDOFF | Summary CTA behavior and booking-flow architecture | Activation touches only the CTA's press handler; every other booking behavior (skip rule, access policies, draft lifetime) is consumed, not modified. |
| docs/05 §6 | Price-model list wider than the seven implemented kinds | Unchanged seven-kind subset; membership stays the `monthly` mapping (docs/09 §21.14). |

No unresolvable contradictions found.

## 18. Product-owner decisions (resolved 2026-08-04; recorded in docs/09 §22)

All twelve §18 items were decided when this plan was approved with corrections. The decided state, which this document now reflects throughout:

1. **Route/state model** — approved as planned: in-stack single checkout screen, re-derived BookingSummary, no CheckoutDraft copy, no CheckoutSessionProvider, small pure reducer only.
2. **VAT** — no VAT line, no included/excluded claim, no tax arithmetic, no assumption; `TaxTreatment` stays typed (`notConfigured`).
3. **Fees** — none of any kind; `FeeLine` declared but never emitted.
4. **Price label** — **no `Total` this milestone (correction to the plan's recommendation)**: `Booking price · …` continues end-to-end; `Total` only when an authoritative backend breakdown reconciles all taxes, fees, discounts, and credits exactly.
5. **Discounts** — offers informational, no discount arithmetic, no parsing amounts from copy, promo codes deferred, authoritative sale prices belong to backend pricing.
6. **Payment methods** — **no fictional saved card (correction)**: one generic selectable `Card payment` contract method; no card details/tokens/management ever; Apple/Google Pay contract-only and never rendered as usable; cash/pay-later/method-fees deferred.
7. **Legal acknowledgment** — **no acceptance checkboxes of any kind (correction)**: policy summary display only, optional inert `Full policy` contract, no acceptance claim, CTA never gated on unavailable legal text. **All legal acknowledgments are required before real payment submission is ever enabled.**
8. **Child bookings** — display the child and guardian context (`Booked by you`); no consent checkbox, no invented emergency/health/waiver fields (later legal/profile decision).
9. **Guests** — cannot reach functional checkout; honest sign-in-required recovery at the participant step; sign-in inert until auth; nothing fabricated.
10. **Revalidation** — typed `CheckoutValidation` contract approved (sessionFull · registrationClosed · priceChanged · offerExpired · participantIneligible · branchUnavailable · invalidDraft); deterministic frontend revalidates at entry; QA-only params demonstrate recovery; no implied polling, no simulated contention, no silent repair.
11. **Submit boundary** — no mock payment state machine; paid CTA `Continue to payment`, free CTA `Confirm booking`, both production-styled, duplicate-press-protected, inert (no navigation/dialog/success/failure/reservation/booking/payment); submit types declared but never invoked or logged.
12. **Confirmation boundary & credits** — the Payment & Confirmation milestone owns payment outcomes, confirmation, provider approval, capacity-lost-after-submit, receipts, invoices, calendar, notifications; Marketplace Credit application is deferred (no checkbox, no balance subtraction, `credit` line kind kept extensible).

## 19. Exit criteria (milestone)

1. Continue to checkout active; every §4 per-type composition and every §8 in-scope state demonstrable deterministically at 390 and 360 widths; contract-only states reachable via QA params only.
2. §6 pricing integrity holds: reconciliation invariant tested across the catalogue; **no `Total` wording anywhere**; the `Booking price` label continues end-to-end; cadence visible; `Free` never `AED 0`; no VAT/fee/discount arithmetic; no hidden amounts.
3. Policy display carries no acceptance claim; paid-CTA readiness enforced by tested logic; the final press produces no route, dialog, or claim; no reservation/confirmation/receipt implication and no card details anywhere (copy-audited).
4. Exact-origin back and edit round-trips preserve the draft; checkout state resets per §5; cold links, unknown ids, and invalid drafts recover; no duplicate routes.
5. Catalogue byte-identical (36 programs, 11 providers); new data limited to the payment-method fixture and copy.
6. §12 accessibility and §13 native safety verified per the review pass; native validation reported as pending.
7. tsc, eslint, jest (grown suite), expo-doctor, all QA suites green; zero console errors; §15 matrix complete.
8. Four commits per §16, each with a stop-and-report; the closeout report states the docs/12 three-level status.
