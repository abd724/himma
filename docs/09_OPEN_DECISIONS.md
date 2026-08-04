# 09 — Open Decisions and Temporary Frontend Assumptions

## 1. Purpose

These items are not fully decided.

Claude must not silently convert a temporary UI assumption into a permanent business rule.

The first Home-screen milestone should proceed using the documented assumptions below unless a genuine contradiction blocks implementation.

## 2. Final branding

Open:

- Final logo
- Final brand palette
- Final typography
- Final tagline
- Final image direction
- Final Arabic brand treatment

Temporary assumption:

- Use the provisional Orbit Indigo system.
- Use a simple `Himma` wordmark.
- Keep all brand choices replaceable.

## 3. Exact launch catalogue

Open:

- Initial provider count
- Exact launch categories
- Exact featured category order
- Which categories have sufficient Abu Dhabi supply

Temporary Home assumption:

Feature a balanced mock set covering:

- Fitness
- Boxing
- Pilates
- Swimming
- Padel
- Wellness
- Learning
- Kids & Teens

Use fictional providers and realistic program types.

## 4. Default customer persona for mock Home

Temporary assumption:

Use one signed-in adult named Sarah with:

- `Me`
- Adam, age 8
- Lina, age 12

The Home feed should demonstrate:

- Recommended for you
- Recommended for Adam
- A family or youth-oriented section

This persona is only demo data.

## 5. Independent accounts for ages 16–17

Open:

- Legal eligibility
- Guardian consent
- Payment permissions

Temporary assumption:

Do not build an independent-minor onboarding path in the first frontend milestone.

## 6. Recurring monthly payments

Open:

- Auto-renewal
- Manual renewal
- Provider billing rules
- Store-policy implications

Temporary frontend assumption:

Cards may display monthly pricing and recurring schedules without implementing subscription behavior.

## 7. Refund model

Open:

- Exact cancellation templates
- Refund timing
- Credit incentive
- Provider cancellation consequences

Temporary frontend assumption:

Future cancellation UI may show both original-payment refund and immediate Marketplace Credit where policy permits.

No cancellation flow is built during the first Home milestone.

## 8. Marketplace Credit classes

Open:

- Refund credit
- Promotional credit
- Referral credit
- Birthday credit
- Gift balance
- Expiry and transfer rules

Confirmed direction:

- Credit should be easy to apply at checkout.
- Ordinary customer credit is intended not to expire.
- Internal credit classes may later have different rules.

Temporary Home assumption:

Show one simple available credit balance preview.

## 9. Gifts

Open:

- Specific session gift
- Flexible provider voucher
- Marketplace Credit gift
- Recipient redemption timing
- Gift restrictions

Temporary Home assumption:

A gift-related promotional card may appear, but do not build the gift flow yet.

## 10. Rewards and referrals

Open:

- Final reward amount
- Points conversion
- Attendance rules
- Birthday rules
- Referral qualification

Temporary Home assumption:

Use AED 20 as clearly fictional referral demo data only if needed.

## 11. Provider communication

Open:

- Pre-booking provider chat
- Marketplace support mediation
- Contact visibility after booking

Temporary assumption:

Do not expose provider phone numbers on Home.

## 12. Map

Open:

- Whether Map becomes a permanent tab after testing
- Production map provider
- Geolocation permissions

Temporary assumption:

Map remains inside Discover and results.

Do not implement real maps in the Home milestone.

## 13. Calendar integration

Open:

- Apple Calendar
- Google Calendar
- Calendar file export
- Two-way synchronization

Confirmed direction:

A confirmed booking should later be addable to the user's preferred calendar.

No real calendar integration is required in the Home milestone.

## 14. Arabic

Open:

- Translation workflow
- Arabic typography
- RTL screen review
- Arabic search synonyms

Temporary assumption:

English only. Keep code localization-ready.

## 15. Reviews

Open:

- Review timing
- Rating dimensions
- Moderation rules

Confirmed direction:

Only verified bookings should eventually produce reviews.

Home may display deterministic mock ratings.

## 16. Wellness and medical boundary

Open:

- Regulated health services
- Licensing requirements
- Provider verification requirements

Temporary assumption:

Use non-medical wellness examples such as massage, recovery, stretching, meditation, or sauna.

Do not present medical treatment claims.

## 17. Product-owner decisions — 2026-08-02

These decisions were confirmed by the product owner and override earlier wording where they differ:

1. **Demo child renamed.** The 12-year-old demo child is **Lina**, not "Sara", to avoid confusion with the account holder Sarah. Demo participants: Me (Sarah), Adam (8), Lina (12).
2. **Dead taps during the Home milestone.** Destinations that do not exist yet are inert with visible press feedback: dock items other than Home (Discover, Bookings, Saved, Profile), "View all", search submission, the credit preview, the hero CTA, category tiles, and program and provider cards. No Coming Soon messages, phase labels, disabled styling, developer explanations, alerts, or placeholder destination screens. This is a deliberate review-stage decision, not a defect.
3. **Home section merging permitted.** The Home content list in `FIRST_PROMPT.md` defines required capabilities, not mandatory separate blocks. Sections may be merged or trimmed for scanability. The product owner approves the final hierarchy via `docs/11_HOME_SCREEN_SPEC.md`.
4. **Quick filters on Home re-filter the feed in place.** Selecting a quick filter (including Ladies only) deterministically re-filters the mock Home feed content rather than only changing chip appearance. Sections with no matching content collapse gracefully. Navigation to a dedicated filtered-results screen is deferred until that screen exists.
5. **Repository root.** The app repository root is the folder containing this docs package (`README.md`, `CLAUDE.md`, and `/docs` live at the repo root next to the Expo app).
6. **Floating navigation dock.** Primary navigation is a floating rounded-capsule dock detached from the screen edges, with an active-destination pill, icon-plus-label items, and centralized dock tokens — not a standard edge-to-edge bottom tab bar. Full requirements in `docs/04_APP_NAVIGATION_AND_PAGE_INVENTORY.md` section 2. The dock hides during future checkout and payment flows.

## 18. Product-owner decisions — 2026-08-03

1. **Simple rule-based recommendations are the current scope.** The initial product uses deterministic, rule-based recommendations only: authoritative eligibility first (provider-defined `minimumAge` / `maximumAge` / `allAges` versus participant age, location, availability, explicit program restrictions, and `Ladies only` only when the customer explicitly selects that filter), then declared interests (optional, set during onboarding or participant-profile setup, editable later), then simple ranking factors (interest match, area proximity, relevant schedule, availability, rating or popularity, offers or trials), while preserving discovery diversity (some related and some popular or new activities, never only exact interest matches). Full rules in `docs/05_DISCOVERY_CATALOGUE_AND_FILTERS.md` section 9.
2. **Behavioral and machine-learning recommendations are future scope.** Do not model or implement ranking based on search history, view history, dwell time, clicks, bookings, attendance, reviews, recommendation dismissals, similar-user behavior, or machine learning. Keep the architecture replaceable through a typed `RecommendationService` contract; the initial implementation may use straightforward deterministic rules.
3. **Deterministic mock interests for the current frontend.** Sarah (`Me`): Calisthenics, Pilates, Padel. Adam: Swimming, Football, Robotics. Lina: Coding, Art, Languages.
4. **Open: recommendation weighting.** How the simple ranking factors combine (their relative weights and ordering) is not decided. Until decided, any implementation ordering is a temporary assumption, not a business rule.

These decisions do not alter the approved Home or Discover visual baseline and do not change the approved Commit 6 sequence.

## 19. Product-owner decisions — 2026-08-03 (Home/Discover differentiation)

These decisions were confirmed by the product owner and are specified fully in `docs/18_HOME_DISCOVER_DIFFERENTIATION.md`, which governs where earlier wording differs:

1. **Home and Discover have separated product roles.** Home is the personalized activity hub ("What matters to me right now?") — schedule-aware and action-oriented, incorporating additional participant profiles when they exist. Discover is the broad marketplace catalogue ("What activities and providers exist across Himma?"). A section must not appear on both screens in substantially the same form (docs/18 §2).
2. **Removed from Home:** the dominant participant context chips, the quick filter row, the seasonal hero on signed-in Home (guest/no-history welcome card only), the popular-categories grid, and the popular-providers rail. Discover exclusively owns the participant selector, quick filters incl. Ladies only, categories/All Categories, activity types, collections, trending, popular providers, marketplace-wide Available today and Offers & trials, and map discovery (docs/18 §4, §7). **Section 17.4 of this document is superseded for Home only**; Discover quick-chip semantics are unchanged.
3. **Home is dynamically participant-aware, never household-hard-coded.** Sections generate from the actual participant list (zero, one, or many additional profiles) with generated labels (`For you`, `For {participantName}`); no UI logic branches on demo names or a fixed participant count. Sarah, Adam, and Lina remain deterministic demo profiles only (docs/18 §3, §5, §9).
4. **Home shows real schedule context from deterministic mock bookings** (upcoming activity, weekly preview, active plans) pinned to `MOCK_TODAY`, referencing existing catalogue programs only, behind a typed service contract. Never fabricate bookings, memberships, or schedules in no-history scenarios (docs/18 §10).
5. **Child-dependent collection visibility.** An account with only the primary participant `Me` must not automatically see child- or student-focused collections (camps, after-school, Kids & Teens, child-development rails) on Home or in the default Discover feed — a visibility rule, not a ranking preference. Child-focused collections appear only when the account has at least one child profile **and** the collection has provider-defined age-eligible supply for at least one of those children. Deliberate search and explicit catalogue browsing remain complete. Full rules and required test cases in docs/18 §6 and §15.
6. **No default child-profile prompting.** Me-only and me-active Home feeds never render a permanent `Add a child profile` card. Participant creation belongs to future Profile/onboarding; a one-time setup suggestion may appear only after explicit family/child intent exists. No child-related prompt appears merely because the account has no child profiles (docs/18 §6).

These decisions change Home's content hierarchy but not the approved visual system (tokens, typography, dock, card language, spacing).

## 20. Product-owner decisions — 2026-08-03 (Program Details + Provider Storefront milestone)

`docs/20_PROGRAM_AND_PROVIDER_DETAILS_PLAN.md` is approved. The following decisions resolve its §14 open items and govern the milestone:

1. **Book CTA.** A production-ready Book button with press feedback, inert until the Booking milestone. No fake booking-preview, session-selection, checkout, or payment sheet of any kind.
2. **Provider name on program cards.** Non-interactive inside the card — no nested pressables. Approved navigation: Program card → Program Details → Provider row → Provider Storefront.
3. **Reviews.** Summary only: rating and review count. No written review content this milestone; never invent customer testimonials.
4. **Cancellation policies.** Deterministic mock-only presets only (e.g. free cancellation up to 24 hours before the session; free cancellation up to 48 hours; non-refundable after confirmation). Do not invent partial-refund calculations, wallet-credit rules, provider penalties, or complex exception policies. Final policy wording comes from provider onboarding and backend configuration.
5. **Share.** Native share behavior where supported, sharing a placeholder canonical web URL (`https://himma.app/program/<programId>` / `https://himma.app/provider/<providerId>`). No `himma://` custom deep links in shared content yet. On web: Web Share when available, safe copy-link fallback otherwise.
6. **Branch model.** Blue Wave multi-branch extras approach approved. No duplicate catalogue programs to demonstrate branches; the catalogue stays at 36 programs and 11 providers.
7. **Map pins.** Map-pin → Provider Storefront activation is deferred. The schematic map remains area-based; no undersized provider-pin actions, no implied accurate geography.
8. **Gift action.** Deferred to the future Gifts milestone; no active Gift action on Program Details.
9. **Available sessions.** Sessions display as information only (date, time, branch, availability where supported). No persisted session selection and no implied booking transaction while Book is inert; session selection becomes functional in the Booking milestone.

## 21. Product-owner decisions — 2026-08-04 (Booking flow milestone)

`docs/21_BOOKING_FLOW_PLAN.md` is approved. Every starred default in its §20 is approved as written; where wording below refines docs/21, this section governs:

1. **Booking sequence.** Option A — Session/plan → Participant → Summary — with the exact type-conditional skip rule of docs/21 §2 (skip the selection step only when a program yields exactly one bookable option requiring no date choice).
2. **Participants.** One participant per booking this milestone. Multi-participant booking is deferred.
3. **Full sessions.** Visible, disabled, and explained — never hidden.
4. **Waitlist.** Fully deferred. No waitlist UI or placeholder of any kind.
5. **Program Details availability.** Approved: a zero-spot occurrence shows `Full` on the Program Details informational session list so details and booking share one availability derivation and can never disagree.
6. **Branches.** No branch selector in booking. The program's existing branch from extras is displayed. Revisit only when a program genuinely spans multiple branches.
7. **Program-type semantics.** Recurring enrolment starts from the next derived session with cadence-labelled pricing and no auto-renewal claim (§6 of this document stands). Camps book at week granularity. Packages show only package size, price, and known schedule orientation — no invented expiry or redemption rules.
8. **Continue to checkout.** The summary CTA stays inert with press feedback. No CheckoutIntent object, checkout UI, payment, confirmation, or success state.
9. **Guest booking.** The sign-in-required contract state (docs/21 §6.5); the sign-in action stays inert until authentication exists.
10. **Pricing.** Catalogue price only. Offers remain informational lines. No VAT, no platform/booking/payment fees, no discounted-total arithmetic, and no "charged today" language.
11. **Summary price wording.** The summary uses the label **`Booking price`** rather than `Total` throughout this milestone (e.g. `Booking price · AED 85`, `Booking price · AED 450 per month`, `Booking price · Free`) so no legally final checkout total is implied before VAT and fee decisions exist. The docs/21 §11 `totalLabel` field is implemented as `bookingPriceLabel` accordingly.
12. **Terms and cancellation acknowledgment.** No checkbox this milestone; the cancellation summary is display-only. Acceptance belongs to Checkout.
13. **Draft persistence.** In-memory only. Leaving the flow, reload, restart, or app termination discards the draft.
14. **Membership.** `monthly` remains the membership representation; no new price kind is added.
15. **Eligibility review.** Inline on the participant step (HMA-019's purpose honored there); no separate eligibility screen.
16. **Inputs and participant management.** Promo codes deferred to Checkout; booking notes and special requests deferred; adding a child profile during booking is not offered.

## 22. Product-owner decisions — 2026-08-04 (Checkout milestone)

`docs/22_CHECKOUT_PLAN.md` is approved **with the following corrections**, which govern where the plan's original recommendations differ:

1. **Route and state model.** Checkout is one screen at `/booking/[programId]/checkout` inside the existing booking stack, with the Booking Summary mounted beneath. Checkout re-derives and revalidates the BookingSummary at entry; no second CheckoutDraft, no CheckoutSessionProvider; checkout-local UI state uses a small pure reducer in the screen layer.
2. **VAT.** No VAT line, no "VAT included"/"VAT excluded" claim, no tax arithmetic, no tax assumption. `TaxTreatment` stays typed as `notConfigured` for future backend integration.
3. **Fees.** No platform, booking, payment, provider-specific, or hidden fee. `FeeLine` stays declared for future backend use but is never emitted.
4. **Price label.** **No `Total` in this milestone.** The `Booking price · …` labels continue end-to-end (e.g. `Booking price · AED 85`, `Booking price · AED 450 per month`, `Booking price · Free`). `Total` may be introduced only when an authoritative backend price breakdown includes all applicable taxes, fees, discounts, and credits and reconciles exactly.
5. **Discounts.** Percentage and promotional offers remain informational; no discounted-price calculation; no parsing amounts from copy; promo codes deferred; authoritative sale prices belong to backend pricing.
6. **Payment methods.** No fictional saved card — no last-four digits, cardholder name, expiry, saved-card management, or fictional tokens. One generic selectable contract method: **`Card payment`**. Apple Pay and Google Pay remain contract-only/deferred and are never rendered as usable customer methods until real platform and gateway support exist. Cash, pay later, and payment-method fees remain deferred.
7. **Legal and policy acknowledgment.** No mandatory checkboxes for Himma Terms, cancellation-policy acceptance, guardian consent, waivers, health declarations, or privacy consent — authoritative legal text and ownership do not yet exist. The cancellation-policy summary is displayed; an inert `Full policy` contract may exist; no acceptance is claimed; the CTA is never gated on unavailable legal text. **All applicable legal acknowledgments are required before real payment submission is ever enabled.**
8. **Child bookings.** Clearly display the child participant and the guardian context where available (`Booked by you`). No guardian-consent checkbox yet; no invented emergency-contact, health, waiver, or consent fields — a later legal/profile decision.
9. **Guests.** Guests cannot proceed into functional Checkout; a missing authenticated account produces the honest sign-in-required recovery (participant step), with the sign-in action inert until authentication exists. No fictional account, participant, or payment method.
10. **Revalidation.** The typed `CheckoutValidation` contract is approved (`sessionFull` · `registrationClosed` · `priceChanged` · `offerExpired` · `participantIneligible` · `branchUnavailable` · `invalidDraft`). The deterministic frontend revalidates the BookingSummary at Checkout entry; QA-only parameters may demonstrate recovery states; no implied live polling, no simulated inventory contention, no silent repair of changed data.
11. **Submit boundary.** No mock payment state machine. Paid CTA `Continue to payment`; free CTA `Confirm booking`. Both are production-styled, duplicate-press-protected, and inert with press feedback: no navigation, dialog, success state, failure state, reservation, booking creation, or payment request. `PaymentSubmitRequest`/`PaymentSubmitResult` stay declared for the future Payment milestone but are never invoked or logged as though a submission occurred.
12. **Confirmation boundary and credits.** Checkout does not own payment success/failure, booking confirmed/pending, provider approval, capacity lost after submission, receipts, invoices, calendar entries, or notifications — all belong to the future Payment & Confirmation milestone. Marketplace Credit application is deferred: no credit checkbox, no subtraction of the demo balance, no ledger or redemption behavior; future price-line support stays extensible.
13. **Staged sequence.** Four commits: 16 checkout foundation and price review · 17 payment-method contract and checkout readiness (generic `Card payment`, no saved card, no legal checkboxes, CTA readiness/gating, free-versus-paid behavior, policy summary only) · 18 revalidation states and flow hardening · 19 checkout review and milestone closeout.
