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
