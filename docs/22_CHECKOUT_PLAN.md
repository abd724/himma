# 22 — Checkout Plan (Milestone 5)

Status: **draft for product-owner approval. No implementation has started.** Governing docs: 02 (accounts/participants, checkout participant rule §8), 04 (HMA-021 inventory, §2 dock rules, §7 connection map), 05 (pricing models §6), 06 (UX/friction/copy, visible totals), 08 (engineering contract, §14 frontend-vs-backend authority), 09 (open decisions incl. §17.2 inert rule, §21 booking decisions), 12 (native rules incl. §9 Apple/Google Pay readiness), 15 §4 (no-trap rules), 16 (states/interactions), 17–21 (established service/builder/provider patterns), HANDOFF.md (frozen catalogue, live architecture, booking-flow behavior).

## 1. Milestone objective and product purpose

Implement the frontend checkout from the existing Booking Summary **Continue to checkout** CTA through order review, the final payable amount, policy and terms acknowledgment, and payment-method selection, ending at a truthful payment-submit contract. Checkout answers, in order:

1. **What exactly is being purchased?** — a condensed, re-validated order recap.
2. **Who is attending?** — the confirmed booking participant.
3. **What is the final payable amount?** — a price breakdown where every visible line reconciles.
4. **What must be accepted?** — cancellation policy and terms, plus guardian consent for child bookings.
5. **Which payment method will be used?** — deterministic method selection with honest availability.
6. **What happens on confirm?** — nothing is pretended: the final CTA is a gated, production-ready contract until real payment exists.

**Truthfulness boundary (absolute):** nothing in this milestone may imply that inventory is reserved, payment was processed, a booking was confirmed, a provider accepted anything, or money was charged. There is no success screen, no confirmation route, no receipt, no "we're holding your place", and no submitting spinner that resolves into pretend success (docs/08 §14).

**Not built in this milestone:** real payment gateway · Apple Pay / Google Pay execution · card entry or tokenization · backend booking creation · inventory reservation · payment capture · provider payout · booking confirmation · cancellation management · refunds · invoices · receipts · loyalty redemption · gift cards · promo-code backend validation · authentication.

## 2. Checkout input model — recommendation

Three candidate models for what Checkout consumes:

| Model | Assessment |
|---|---|
| **A. BookingSummary directly (re-derived per mount)** ★ | The summary is already the single re-validated truth of the order (docs/21 §11): program, provider, branch, participant with re-asserted eligibility, option, session, selection lines, price lines, `bookingPriceLabel`, offer line, policy. Re-deriving it from the live draft at checkout mount gives revalidation for free and adds zero duplicate state. |
| B. New CheckoutDraft copied from BookingSummary | Duplicates booking-state ownership — the copy can go stale the moment the draft is edited (Change participant/session round-trips). Rejected. |
| C. Typed CheckoutIntent created at the boundary | A frozen snapshot has the same staleness problem as B, plus it implies a handoff object the backend doesn't exist to receive. The docs/21 §20.8 decision already rejected CheckoutIntent in favor of the inert contract. Rejected for this milestone; a real intent object belongs to the payment milestone's API design. |

**Recommendation: A.** `CheckoutService.getCheckoutPage(input)` calls the same pure summary derivation the Booking Summary uses (via `MockBookingService.getBookingSummary`) and composes checkout-only presentation on top (price summary, acceptances, payment methods). Checkout-local choices (acceptances, selected method) never duplicate a booking slice. Editing the booking invalidates nothing silently — returning to checkout re-derives everything.

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
- **Back:** pops to the exact Booking Summary instance (draft intact). iOS swipe-back enabled; Android back pops one step. Editing the booking = back + the summary's existing Change actions; returning to checkout re-derives the page (§2), and checkout-local acceptances reset because the order they applied to may have changed — acceptance is per-reviewed-order, an honesty rule, not a bug.
- **Access policy:** new pure `checkoutStepAccess(page, draft)` in `booking-navigation.ts` — exactly `summaryStepAccess` plus nothing (checkout requires the same fully-valid draft). Missing option/session or full session → flow start · missing/ineligible participant or guest (empty household) → participant step · unknown program → established recovery state · cold deep link with an empty draft → flow start. No silent draft repair.
- **Guests never reach checkout** structurally: guests cannot pass the participant step (docs/09 §21.9), and `checkoutStepAccess` redirects an empty-household draft there — where the existing inert Sign in to book contract stands. See §7.7.

## 4. Screen hierarchy (docs/04 HMA-021 refined)

Vertical scroll at ~390 × 844:

1. **Header** — back control + heading `Checkout` (header role). No step counter (§3.2).
2. **Order recap** — condensed single card, not a second Booking Summary: thumbnail, program title, provider + verification, area · branch, participant line (`Adam · Age 8`), selection line (dated session / camp week / enrolment schedule / package contents). One `Edit booking` action → back to the summary (the summary owns Change participant/session). No duplicate edit affordances.
3. **Price breakdown** — §6: base line(s), informational offer line where present, final amount line (`Total` for one-off kinds; cadence label for recurring/term; `Free` for free kinds). No VAT line, no fee lines (§7.1–7.2).
4. **Cancellation policy** — the program's existing preset (same display component family as the summary), now paired with its acknowledgment checkbox (§7.8).
5. **Terms** — Himma Terms & Conditions acknowledgment checkbox with an inert `Read terms` link contract (§7.8).
6. **Guardian consent** *(child bookings only)* — one consent checkbox naming the child (§7.9).
7. **Payment method** *(paid bookings only)* — radio list per §7.5; collapsed entirely for `Free` bookings.
8. **Sticky CTA bar** — final amount line (polite live region) + primary button: `Pay AED 85` / cadence and free variants per §6.3; gated by §9 validation; final press is the §7.11 contract.
9. **Support row** — `Something wrong with your booking?` inert contract (HMA-032 pattern, details-page precedent). No provider phone numbers (docs/09 §11).

Per-type composition:

| Booking | Recap selection line | Price block | Payment section | CTA |
|---|---|---|---|---|
| One-off paid session | `Tue 4 Aug · 7:30 PM` (+ branch) | `1 session · AED 85` → `Total · AED 85` | Yes | `Pay AED 85` (contract) |
| Monthly enrolment | schedule + start lines | `Monthly enrolment · AED 450 per month` → final line stays cadence-labelled (§7.3) | Yes | `Confirm enrolment` (contract) |
| Term | term schedule | `Term enrolment · AED 1,800 per term` (cadence) | Yes | `Confirm enrolment` (contract) |
| Camp | `Week of 17–21 Aug · 9 AM–12 PM` | `1 week · AED 850` → `Total · AED 850` | Yes | `Pay AED 850` (contract) |
| Package | `Package of 6 sessions` + orientation | `Total · AED 480` | Yes | `Pay AED 480` (contract) |
| Free / free trial | dated session where applicable | `Free` (never `AED 0`) | Collapsed | `Confirm booking` (contract) |
| Paid trial | `Trial session · Tue, 5:30 PM` | `Total · AED 35` (structured `trialAmount`) | Yes | `Pay AED 35` (contract) |
| Child booking | any of the above | unchanged | unchanged | unchanged + guardian consent required (§7.9) |

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

**No `CheckoutSessionProvider`.** Checkout is one screen; its only local state is the acceptance set, the selected payment method, and the CTA guard — owned by a pure, unit-tested `checkoutReducer` (`toggleAcceptance`, `selectMethod`, `reset`) in component state. A provider would outlive its only consumer for no benefit.

Reset behavior:

| Event | Effect |
|---|---|
| Leaving Checkout (back, exit) | Screen unmount discards acceptances/method; draft untouched |
| Returning to Booking Summary and editing | Re-entering checkout re-derives the page; acceptances start clean (per-order acceptance, §3.3) |
| Switching program | Different `[programId]` stack → fresh provider and fresh checkout |
| Cold deep link | Empty draft → `checkoutStepAccess` redirect to flow start |
| Failed payment contract | N/A this milestone (no submission exists); the declared `PaymentSubmitResult` failure shape belongs to the payment milestone |
| App reload / termination | In-memory only — flow and checkout state discarded (docs/09 §21.13 unchanged) |

## 6. Pricing integrity

1. **Reconciliation invariant:** every numeric line visible in the price breakdown participates in the final amount, and a unit test recomputes the final amount from the lines for every bookable program × option. With no VAT and no fees (§7.1–7.2) the invariant is currently `final = base`; the test structure is what matters — any future line (fee, tax, discount, credit) must reconcile or fail CI.
2. **`Total` is reserved for genuine one-off charges** (single session, package, camp week, paid trial). Recurring and term amounts keep cadence labels end-to-end and are never presented as a one-time charge — what is actually collected first for an enrolment is undecided (docs/09 §6) and stays undecided here (§7.3).
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

### 7.3 Final payable amount

With §7.1–7.2, the payable amount equals the catalogue price, so checkout may honestly graduate the label: ★ **`Total` appears on checkout only, and only for one-off charges** (single session, package, camp week, paid trial), reconciling by construction. Recurring/term amounts keep their cadence label (`AED 450 per month`, `AED 1,800 per term`) with **no "first payment" or "charged today" claim** — first-collection semantics belong with the §7.1/§7.2 decisions and docs/09 §6 auto-renewal. Free stays `Free`. Formats per type are tabled in §4. The Booking Summary's `Booking price` wording (docs/09 §21.11) is **unchanged** — the summary still precedes the legally-final amount; checkout is where finality begins (§17 records this refinement).

### 7.4 Discounts and offers

- Fixed provider-listed prices (incl. structured paid-trial `trialAmount`): already authoritative — display as-is. ★
- Percentage/first-month offers (`20% off first month`): ★ **remain informational lines with no arithmetic** until a backend returns an authoritative discounted amount — a frontend-computed discount would fake pricing authority (docs/08 §14).
- Free/paid trials: already first-class booking options; no change.
- Promo codes: ★ **deferred entirely** — no input field this milestone. An inert promo field would fake function (worse than absence, docs/09 §17.2 spirit); real validation needs the backend. Owner may pull a contract-only field forward.

### 7.5 Payment methods

| Method | Recommendation |
|---|---|
| Demo saved card | ★ **Fully designed now** — one deterministic, clearly-fictional saved card on the demo account fixture (`Visa ending 4242`), the same class of demo data as the AED 65 credit. Selected by default when present. Never a real card, never entry of one. |
| Apple Pay / Google Pay | ★ **Contract-only rows** — represented per platform (docs/12 §9 readiness) with honest availability `contractOnly`; selecting them is allowed, the submit stays the §7.11 contract. No platform sheet is invoked. |
| New card | ★ **Contract-only** — an `Add card` row that is inert with press feedback. No card fields, no tokenization, no card data in state (§13). |
| Cash at provider / pay later | ★ **Deferred** — business decisions with provider-settlement implications; no UI trace. |
| Free booking | No method section at all (§4). |

`PaymentMethodAvailability` (§11) carries an explicit reason for anything not selectable, so nothing is silently hidden.

### 7.6 Free bookings

★ CTA reads **`Confirm booking`** (never `Pay`), the price block reads `Free`, the payment section collapses, and — critically — confirming remains the §7.11 contract: **no success state exists for free bookings either**, because no backend confirms them. Free-trial bookings behave identically with the trial wording.

### 7.7 Guest behavior

★ **Checkout requires an account by rule, enforced structurally now:** guests cannot pass the participant step (existing sign-in contract, docs/09 §21.9), and `checkoutStepAccess` sends any empty-household draft back there. Checkout itself renders no auth UI, fabricates no account, and shows no saved anything for guests. When real authentication ships, the sign-in gate stays at the participant step (earliest honest gate) unless the owner moves it.

### 7.8 Terms and policy acknowledgment

Acceptance mechanics belong to checkout (docs/09 §21.12). Minimum honest scope — ★ exactly two checkboxes for adult bookings:

1. **Provider cancellation policy** — "I understand the cancellation policy above." Source: the existing mock presets (docs/09 §20.4), whose wording is already flagged placeholder; final text arrives with provider onboarding. Owner: provider + Himma ops.
2. **Himma Terms & Conditions** — "I agree to the Himma Terms & Conditions." The linked document **does not exist**; the `Read terms` link is an inert contract, and the **legal copy source (Himma legal counsel) is an explicitly open item** — recorded, not invented.

Not included (each needs a legal/data-model source that doesn't exist): provider waivers, health/safety declarations, privacy-notice acceptance (browsing doesn't newly require it; the account milestone owns privacy consent), marketing consent. All deferred with owners named in §18.

### 7.9 Minor participant consent

★ For child bookings, **one additional required checkbox**: "I confirm I am {child}'s parent or guardian and consent to their participation." — data-model-light, honest, and derived from the existing participant record (name/age already in the draft). **Not included now:** emergency-contact confirmation, health-condition declarations, provider waivers, identity/age verification — each requires a data model (docs/02 §5's field set is explicitly not final) and legal review. These are marked open (§18); the consent checkbox's own legal wording also needs counsel review before production.

### 7.10 Capacity and price revalidation

The frontend never claims a draft is still valid without revalidation. Two layers:

1. **Now (deterministic):** checkout re-derives the summary at mount (§2) — a draft whose session filled, program closed, or participant became ineligible in mock data fails `checkoutStepAccess` and redirects to the owning step. Because mock availability never changes mid-session (docs/21 §7 decision stands), the *mid-checkout change* states are reachable **only via QA params** (`?qa-revalidate=sessionFull|priceChanged|offerExpired`, established `?qa-*` pattern) for review, rendering honest recovery states: `This session filled up while you were checking out.` + return-to-selection action; price-changed shows old → new with an explicit `Review updated price` action that re-derives.
2. **Future backend contract:** `CheckoutValidation` (§11) with issue codes `sessionFull` · `registrationClosed` · `priceChanged` · `offerExpired` · `participantIneligible` · `branchUnavailable` · `draftInvalid`, returned by `getCheckoutPage` and (later) by the real submit. The screen maps every code to a recovery action; the payment milestone's backend swaps the deterministic source for real revalidation without touching the screen.

### 7.11 Payment-submit behavior

Options: A inert production CTA · B typed no-op PaymentIntent · C mock payment state machine · D defer the step. ★ **A, with B's types declared but not wired.** The CTA is gated by *real, testable* validation (§9) — acceptances complete, method selected where required — and once valid, the final press is inert with press feedback: the exact owner-approved precedent of the Book CTA (docs/09 §20.1) and Continue to checkout (docs/09 §21.8), and the owner already rejected a logged no-op intent once (docs/21 §20.8). C is rejected outright: a deterministic "processing → success/failure" machine is a fake payment. D is rejected: the gating, acceptance, and method mechanics are real deliverables. `PaymentSubmitRequest`/`PaymentSubmitResult` are **declared in the contract file with doc comments** so the payment milestone wires them with zero churn — nothing constructs them this milestone.

### 7.12 Confirmation boundary

Checkout ends at the submit contract. The **future Payment & Confirmation milestone (HMA-022 + HMA-023)** exclusively owns: payment processing/success/failure/pending states, capacity-lost handling, booking-confirmed and booking-pending states, provider-approval-required flows, receipts, booking reference, calendar entry, and the Bookings-tab handoff. Checkout must never absorb any of it; this plan creates no route, state, or copy in that territory. (docs/04 §7's `Checkout → Payment Status → Confirmation` chain is honored by stopping exactly at the arrow.)

Also surfaced from docs/04 HMA-021: the **Marketplace Credit checkbox** ("Use AED 65 credit"). ★ **Deferred to the Credits milestone** — no credit ledger exists (the balance is a display-only Home preview), and applying credit is discount arithmetic without authority (§7.4). Owner decision recorded (§18); the `CheckoutPriceLine` kind `'credit'` is declared so it reconciles later.

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
| Child booking + guardian consent | in scope | Adam → `junior-swim-squad` |
| Missing required acceptance | in scope | CTA gated + status line names the gap |
| Saved card selected | in scope | demo fixture (§7.5) |
| New-card contract | in scope (inert) | `Add card` row |
| Apple/Google Pay rows | contract-only | platform-appropriate row, `contractOnly` availability |
| Payment-method unavailable | in scope | reasoned row (e.g. Google Pay row on iOS web preview) |
| No payment method | in scope | QA fixture without the demo card → honest empty state + `Add card` contract; CTA gated |
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
| Abandoned checkout | in scope | exit → re-enter → clean acceptances, fresh derivation |
| Duplicate-submit protection | in scope | double-tap guard on the CTA (mechanics real even while inert) |
| Submitting state | deferred | payment milestone (no submission exists) |
| Payment failure | contract-only | `PaymentSubmitResult` failure shape declared; no UI |
| Payment success | deferred | Payment & Confirmation milestone (§7.12) |

## 9. Validation model

`checkoutValidation(page, state)` — pure, unit-tested; the single gate for the CTA:

- draft-derived summary present (else the access policy already redirected);
- every `required` acceptance accepted (cancellation, terms, + guardian consent for child bookings);
- a selectable payment method chosen when the booking is paid;
- output: `{ complete: boolean; blockers: CheckoutBlocker[] }` where each blocker maps to the status line (`Accept the cancellation policy to continue`, `Choose a payment method`) — the CTA is never disabled without a visible reason (docs/04 HMA-019 principle applied to forms).

## 10. Data audit

**Sufficient already:** every `BookingSummary` field (§2); `bookingExtras` (`trialAmount`, `registrationClosed`, `sessionSpots`, `campWeeks`); cancellation presets; provider/branch extras; participant records (name, kind, dateOfBirth → consent wording); pricing helpers (`formatPrice`/`priceLabel`/`spokenPriceLabel`); booking navigation policies (extended, not duplicated).

**Missing — add as deterministic frontend review data:**

| Data | Home | Notes |
|---|---|---|
| Demo saved card | new `src/data/mock/payment-methods.ts` keyed by account fixture, resolved through `AccountProvider` (credit precedent) | Clearly fictional (`Visa ending 4242`); absent for the no-method QA fixture |
| Acceptance definitions | `CheckoutService` composition (from policy preset + static terms item + child detection) | No new catalogue data |
| Checkout copy (consent lines, blocker lines, revalidation copy) | feature presentation module | Copy-only; legal review flagged |

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
  /** Numeric participation in reconciliation; undefined for cadence/free display lines. */
  amount?: number;
}

export interface CheckoutPriceSummary {
  lines: CheckoutPriceLine[];
  /** Informational only — never arithmetic (docs/09 §21.10). */
  offerLine?: string;
  finalKind: 'total' | 'cadence' | 'free';                 // §6.2 label rule
  finalLabel: string;       // 'Total · AED 85' | 'AED 450 per month' | 'Free'
  spokenFinalLabel: string; // 'Total, 85 dirhams' | '450 dirhams per month' | 'Free'
  taxTreatment: TaxTreatment;                              // 'notConfigured' this milestone
}

export interface FeeLine extends CheckoutPriceLine { kind: 'fee' }        // declared, never emitted (§7.2)
export interface DiscountLine extends CheckoutPriceLine { kind: 'discount' } // declared, never emitted (§7.4)

export type PaymentMethodKind = 'savedCard' | 'newCard' | 'applePay' | 'googlePay';
export type PaymentMethodAvailability =
  | { status: 'available' }
  | { status: 'contractOnly' }                              // selectable; submit stays the §7.11 contract
  | { status: 'unavailable'; reason: string };              // visible, disabled, explained

export interface PaymentMethod {
  id: string;
  kind: PaymentMethodKind;
  label: string;            // 'Visa ending 4242 (demo)' | 'Apple Pay' | 'Add card'
  availability: PaymentMethodAvailability;
}

export interface PolicyAcceptance {
  id: 'cancellation' | 'terms' | 'guardianConsent';
  required: boolean;
  label: string;            // customer copy (§7.8–7.9)
  /** Where the legal text comes from — 'mock-policy-preset' | 'himma-terms-pending' | 'consent-copy-pending'. Honest provenance, never rendered. */
  source: string;
}

export type CheckoutIssueCode =
  | 'sessionFull' | 'registrationClosed' | 'priceChanged' | 'offerExpired'
  | 'participantIneligible' | 'branchUnavailable' | 'draftInvalid';

export type CheckoutValidation =
  | { ok: true }
  | { ok: false; issues: { code: CheckoutIssueCode; message: string }[] };

export interface CheckoutPage {
  summary: BookingSummary;                                  // §2: re-derived, single source
  price: CheckoutPriceSummary;
  acceptances: PolicyAcceptance[];                          // ordered; child consent present iff child booking
  paymentMethods: PaymentMethod[];                          // empty for free bookings
  paymentRequired: boolean;
  validation: CheckoutValidation;                           // §7.10 layer-2 shape (deterministic now)
  ctaLabel: string;                                         // 'Pay AED 85' | 'Confirm enrolment' | 'Confirm booking'
  spokenCtaLabel: string;
}

/** Declared for the payment milestone — nothing constructs these now (§7.11). */
export interface PaymentSubmitRequest {
  draft: BookingDraft;
  paymentMethodId: string;
  acceptedPolicyIds: PolicyAcceptance['id'][];
}
export type PaymentSubmitResult =
  | { status: 'notAvailable' }                              // the only value the mock could ever return
  | { status: 'failed'; code: CheckoutIssueCode | 'paymentDeclined'; message: string }
  | { status: 'succeeded'; confirmationHandoff: unknown };  // owned by the confirmation milestone

export interface CheckoutService {
  /** Undefined for unknown programs; CheckoutValidation carries draft issues. */
  getCheckoutPage(input: {
    draft: BookingDraft;
    participants: Participant[];
    areaId: AreaId;
    platform: 'ios' | 'android' | 'web';                    // method-row appropriateness
    simulateFailure?: boolean;
    qaRevalidate?: CheckoutIssueCode;                        // QA-only review states (§7.10)
  }): Promise<CheckoutPage | undefined>;
}
```

Checkout-local UI state: `checkoutReducer(state, action)` — `{ accepted: Set<PolicyAcceptance['id']>; paymentMethodId?: string }` with `toggleAcceptance` / `selectMethod` / `reset` (pure, tested; §5).

## 12. Accessibility plan

- **Heading:** `Checkout` as `accessibilityRole="header"`; section titles are headers; reading order = §4 order (recap → price → policy → terms → consent → payment → CTA), asserted structurally in QA like the booking summary.
- **Order recap:** one accessible group labelled with program, participant, and selection (`Junior Swim Squad for Adam, Sat 8 Aug 10:00 AM, Blue Wave Swimming`); `Edit booking` a button adjacent to the group.
- **Acceptances:** `accessibilityRole="checkbox"` with `accessibilityState={{ checked }}` **and explicit `aria-checked`** (RN-web rule, HANDOFF); labels are the full consent sentence, never "checkbox 1"; required-but-unchecked state named in the CTA status line, not color.
- **Payment methods:** radiogroup/radio semantics with explicit `aria-checked`/`aria-disabled` (booking-flow precedent); unavailable rows carry the reason in the accessible label.
- **Price lines:** row labels pair label+value (`1 session, 85 dirhams`); final amount uses `spokenFinalLabel`; `Free` spoken as "Free".
- **Sticky CTA:** label = action + amount (`Pay, total 85 dirhams` / `Confirm booking, free`); the status line is a polite live region announcing blockers and their resolution; scroll padding clears bar + insets.
- **Legal text:** rendered as plain readable text (no tiny type, no scroll-trapped fine print); the inert `Read terms` link is a button with an honest label.
- **Guardian consent:** wording names the child; spoken form uses the name (`I confirm I am Adam's parent or guardian…`).
- **Universal:** ≥ 44 pt targets, Dynamic Type tolerance (checkbox rows grow; `maxFontSizeMultiplier` only where docs/12 §4 permits), reduced-motion parity, no color-only state (checked = mark + border; disabled = pill + reason).
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
`buildCheckoutPage` per type (price lines, finalKind/label per §6.2, CTA label per §4, payment section presence, acceptance set incl. child-conditional consent) · **reconciliation invariant across every bookable program × option** (numeric lines sum to the final for `finalKind: 'total'`; cadence/free carry no numeric total) · free bookings never contain `AED 0` · offer line without arithmetic (reformer: no `520` anywhere) · tax treatment `notConfigured` with no tax line · no fee lines emitted · saved-card default selection; no-method fixture yields gated state · platform method-row matrix · `checkoutValidation` blocker matrix (each missing acceptance, missing method, child consent only for child drafts — synthetic participants, never demo-name-dependent) · `checkoutReducer` transitions + reset · `checkoutStepAccess` matrix (valid render; missing option/session/full → selection; missing/ineligible participant/guest → participant; unknown → recovery; empty draft → flow start) · QA revalidation states render the declared codes · invalid summary → `undefined` passthrough · submit contract: nothing constructs `PaymentSubmitRequest` (a grep-style guard test on the mock service's exports) · data invariants (payment-method fixture ids, acceptance sources).

QA (Playwright, 390 × 844 + 360 × 780, `scripts/qa/checkout-review.mjs` under all HANDOFF locator/scroll rules):
summary → Continue to checkout activates (route, double-tap guard → one route) · per-type checkout journeys (§4 table incl. free `Confirm booking` and paid-trial amount) · acceptance gating round-trip (CTA blocked with named reason → accept → method → CTA enabled) · child booking requires guardian consent; adult booking never shows it · payment-method radio semantics incl. explicit aria state; unavailable row disabled with reason · final press: no route change, no dialog (inert contract) · edit-booking round-trip (checkout → summary → change participant → checkout re-derived, acceptances reset) · exact-origin back chain Checkout → Summary → Participant → Selection → Details → origin · cold links and missing-draft redirects · unknown program recovery · registration-closed/ineligible entry redirects · `?qa-revalidate` recovery states · error/retry via `?qa-fail=1` · abandoned checkout reset · copy assertions: no reservation/hold/charged-today/confirmed/receipt language, no VAT/fee lines, no `AED 0`, `Total` only on one-off types · reading order · zero console errors · no horizontal overflow.

## 15. Screenshot matrix

`artifacts/checkout-review/`, every row at **390 × 844 and 360 × 780**:

| # | Capture | Class |
|---|---|---|
| 01 | Paid single-session checkout (top/bottom incl. sticky CTA) | in scope |
| 02 | Monthly enrolment (cadence final line, `Confirm enrolment`) | in scope |
| 03 | Camp checkout | in scope |
| 04 | Package checkout | in scope |
| 05 | Free booking (`Free`, `Confirm booking`, no payment section) | in scope |
| 06 | Free trial | in scope |
| 07 | Paid trial (AED 35) | in scope |
| 08 | Child booking with guardian consent row | in scope |
| 09 | Acceptances unchecked → CTA gated with named blocker | in scope |
| 10 | Acceptances checked (checked-state visuals) | in scope |
| 11 | Payment-method selection (saved demo card selected) | in scope |
| 12 | New-card `Add card` contract row | in scope |
| 13 | Unavailable method with reason | in scope |
| 14 | No payment method (gated + empty-state) | in scope |
| 15 | Final price breakdown detail (offer line, reconciled total) | in scope |
| 16 | Session-full revalidation recovery | contract-only (QA param) |
| 17 | Price-changed revalidation recovery | contract-only (QA param) |
| 18 | Error + retry | in scope |
| 19 | Cold deep-link recovery (checkout link → flow start) | in scope |
| 20 | Submitting / payment-failure | **not captured** — deferred states must not be faked for screenshots; declared shapes only |

## 16. Commit sequence

### Commit 16 — `feat(checkout): checkout foundation and price review`

- **Scope:** `checkout.tsx` route in the booking stack, `checkout.ts` contract file **declared in full** (incl. submit types — no later churn), `MockCheckoutService` + pure `buildCheckoutPage` (price summary, per-type final labels, CTA labels, acceptance composition, platform method rows), `checkoutStepAccess`, **Continue-to-checkout activation** on the Booking Summary (double-tap guard), order recap + price breakdown + policy display sections, skeleton, error/unknown/redirect states; CTA present but gated with honest status (acceptance/method sections land in 17).
- **Files:** create `src/app/booking/[programId]/checkout.tsx`, `src/features/booking/checkout-screen.tsx` (+ recap/price components + presentation module), `src/services/contracts/checkout.ts`, `src/services/mock/mock-checkout-service.ts`, `src/data/mock/payment-methods.ts`; modify `booking-navigation.ts`, `booking-summary-screen.tsx` (CTA activation only).
- **Tests:** builder per type, reconciliation invariant, access matrix, activation guard; all suites green. **Screenshots:** rows 01–07, 15, 19 provisional. **Stop line:** tsc/eslint/jest/expo-doctor green, checkout QA entry+price checks green — stop for owner review.

### Commit 17 — `feat(checkout): policy acceptance and payment methods`

- **Scope:** acceptance checkboxes (cancellation, terms + inert Read-terms contract), child guardian consent, payment-method radio list with availability semantics and demo saved card, `checkoutReducer`, full §9 gating with named blockers, inert final press (§7.11), live-region announcements.
- **Files:** create acceptance/method row components; modify `checkout-screen.tsx`, mock service (method fixture join).
- **Tests:** validation/blocker matrix, child-conditional consent, reducer, method availability matrix, aria-state QA checks. **Screenshots:** rows 08–14 provisional. **Stop line:** checks + QA green — stop for owner review.

### Commit 18 — `feat(checkout): revalidation states and flow hardening`

- **Scope:** `?qa-revalidate` review states (sessionFull/priceChanged/offerExpired) with recovery actions, edit-booking round-trip polish, abandoned-checkout verification, cold-link/duplicate-route hardening, copy assertions wired into QA, submit-contract guard test.
- **Files:** polish edits in `src/features/booking/checkout-*`, mock service, `scripts/qa/checkout-review.mjs` growth.
- **Tests:** revalidation rendering, round-trip draft integrity, no-fake-success guards. **Screenshots:** rows 16–18 + refreshed journeys. **Stop line:** checks + QA green — stop for owner review.

### Commit 19 — `chore(checkout-review): checkout review and milestone closeout`

- **Scope:** full §8 state sweep, §12 accessibility pass, complete §15 matrix both widths, copy audit (no reservation/confirmation/receipt implication anywhere), navigation/draft-lifetime audit, full regression (all nine QA suites), HANDOFF.md update, docs/22 status header update, milestone report with docs/12 three-level status.
- **Stop line:** everything green; report delivered; **stop for owner approval before any payment-milestone work.**

## 17. Contradiction review

Reviewed against docs/02, 04, 05, 06, 08, 09, 12, 15, 16, 17, 18, 19, 20, 21, HANDOFF.md:

| Document | Point | Resolution |
|---|---|---|
| docs/09 §21.11 | `Booking price`, never `Total`, "before VAT and fee decisions exist" | This plan is where those decisions are put to the owner. §7.3 refines: summary keeps `Booking price`; checkout may show `Total` **only** for one-off amounts under the no-VAT/no-fee defaults, reconciling by construction. Owner approves via this document. |
| docs/09 §21.8 / §20.1 | Continue-to-checkout inert "until the Checkout milestone" | That milestone is this one — activation is the plan's purpose; the inert pattern moves one boundary outward to the payment-submit CTA (§7.11), same precedent. |
| docs/04 HMA-021 | Lists price breakdown, **Marketplace Credit checkbox**, payment method, **gift or promotional code**, final action | Breakdown/method/final action: implemented. Credit checkbox: deferred to the Credits milestone (no ledger — §7.12, owner decision §18). Promo/gift codes: deferred (§7.4; gifts are their own milestone). `credit`/`discount` line kinds are declared so both reconcile later. |
| docs/04 §7 | `Summary → Checkout → Payment Status → Confirmation` | Order honored; this milestone stops at the Checkout→Payment arrow (§7.12). No payment-status or confirmation route exists. |
| docs/04 HMA-020 | "Terms acceptance" listed on the summary | Deliberately moved to checkout (docs/09 §21.12 already decided this); the summary stays acknowledgment-free. |
| docs/09 §6 | Recurring payment model open (auto-renewal undecided) | §6.2/§7.3: cadence labels only, no first-payment or renewal claims anywhere. |
| docs/02 §8 | Checkout may select multiple participants | Single-participant scope carried over from docs/09 §21.2 unchanged; checkout displays the draft's one participant. Widening stays a contract-level path. |
| docs/02 §2 / docs/09 §21.9 | Booking/paying requires an account; no auth exists | §7.7: structural guest gate at the participant step stands; checkout adds no auth UI and fabricates nothing. |
| docs/02 §5 | Child-profile legal field set not final | §7.9 consent stays data-model-light (one checkbox, existing fields); waivers/health/emergency data explicitly deferred to legal review. |
| docs/08 §14 | Frontend previews; backend authoritative for totals/charges | The §11 contracts mark authority explicitly; no arithmetic beyond the catalogue price; submit is declared, not wired. |
| docs/12 §9 | Checkout UI "must not assume card-only flows" | §7.5 designs the method list with Apple/Google Pay rows as first-class (contract-only) entries. |
| docs/06 §4 | "Visible payment totals", minimal friction | One-screen model (§3.2) with the §6 reconciliation invariant. |
| docs/16 §6 / docs/04 §2 | Dock hidden on transactional flows | Inherited structurally — checkout lives in the existing root booking stack. |
| docs/18 §6 | No add-child prompting | The consent row names an existing child only; no participant-creation affordance anywhere (incl. the no-method and recovery states). |
| docs/20 §13 / docs/21 §18 | Prior stop lines: "no checkout work without owner approval" | Honored — this document is the approval instrument; implementation waits for sign-off. |
| docs/21 §8 / HANDOFF | Summary CTA behavior and booking-flow architecture | Activation touches only the CTA's press handler; every other booking behavior (skip rule, access policies, draft lifetime) is consumed, not modified. |
| docs/05 §6 | Price-model list wider than the seven implemented kinds | Unchanged seven-kind subset; membership stays the `monthly` mapping (docs/09 §21.14). |

No unresolvable contradictions found.

## 18. Open product decisions (owner input needed)

Recommendations marked ★ are the plan's defaults (full analysis in §7); the milestone is built to them unless the owner chooses otherwise:

1. **VAT presentation** — ★ no VAT line until backend tax configuration exists (`TaxTreatment: 'notConfigured'`). Legal/accounting decision required before the payment milestone.
2. **Fees** — ★ none of any kind; `FeeLine` declared for future reconciliation. Business decision.
3. **`Total` labeling** — ★ checkout-only, one-off amounts only; cadence products keep cadence labels with no first-payment claim.
4. **Discounts** — ★ percentage offers informational until authoritative backend pricing; promo codes deferred entirely (no inert field).
5. **Payment methods** — ★ demo saved card designed now; Apple/Google Pay + Add-card contract-only; cash-at-provider/pay-later deferred.
6. **Free bookings** — ★ `Confirm booking` CTA, contract behavior, no success state.
7. **Guest gate** — ★ authentication required for checkout, enforced at the participant step until auth exists.
8. **Acceptance scope** — ★ cancellation-policy + Himma-terms checkboxes (+ guardian consent for minors); waivers/health/privacy deferred. **Himma T&C legal copy has no source yet — Himma legal counsel owns it.**
9. **Minor consent depth** — ★ single guardian-consent checkbox; emergency contact, health declarations, waivers, and age verification deferred pending legal/data-model decisions (docs/02 §5).
10. **Marketplace Credit at checkout** (docs/04 HMA-021) — ★ deferred to the Credits milestone; `credit` line kind declared.
11. **Payment-submit behavior** — ★ option A (gated production CTA, inert final press) with submit types declared; the payment milestone wires them.
12. **Confirmation boundary** — ★ Payment & Confirmation milestone owns success/pending/receipt/calendar (§7.12); checkout never absorbs it.

## 19. Exit criteria (milestone)

1. Continue to checkout active; every §4 per-type composition and every §8 in-scope state demonstrable deterministically at 390 and 360 widths; contract-only states reachable via QA params only.
2. §6 pricing integrity holds: reconciliation invariant tested across the catalogue; `Total` only on one-off kinds; cadence visible end-to-end; `Free` never `AED 0`; no VAT/fee/discount arithmetic; no hidden amounts.
3. Acceptance gating and guardian consent enforced by tested validation; the final press produces no route, dialog, or claim; no reservation/confirmation/receipt implication anywhere (copy-audited).
4. Exact-origin back and edit round-trips preserve the draft; checkout state resets per §5; cold links, unknown ids, and invalid drafts recover; no duplicate routes.
5. Catalogue byte-identical (36 programs, 11 providers); new data limited to the payment-method fixture and copy.
6. §12 accessibility and §13 native safety verified per the review pass; native validation reported as pending.
7. tsc, eslint, jest (grown suite), expo-doctor, all QA suites green; zero console errors; §15 matrix complete.
8. Four commits per §16, each with a stop-and-report; the closeout report states the docs/12 three-level status.
