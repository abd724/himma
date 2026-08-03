# 18 — Home / Discover Differentiation

Status: draft for product-owner review. Approved decisions in this document supersede the conflicting parts of docs/04 HMA-004, docs/09 §17.4, and docs/11 listed in §12. Nothing here changes the approved visual system: Orbit Indigo tokens, typography, floating dock, card language, imagery, spacing, and native navigation are untouched (docs/07, docs/11 §7, docs/12).

## 1. The problem this document resolves

Home and Discover currently repeat categories, program carousels, providers, filters, and marketplace rails with only minor differences, which makes Discover feel redundant. This document separates their product roles permanently:

- **Home** answers: *"What matters to me and my family right now?"* — personalized, schedule-aware, action-oriented.
- **Discover** answers: *"What activities and providers exist across Himma?"* — the broad, visual marketplace catalogue.

## 2. Duplication rule (permanent)

A section must not appear on both Home and Discover in substantially the same form unless there is a clear, documented reason. Where both screens serve a similar need, Home's version is personalized and Discover's is marketplace-wide and filterable:

| Need | Home form | Discover form |
|---|---|---|
| Age-appropriate children's content | `For {participantName}` — generated per real child profile, eligibility- and interest-ranked | `After school`, `Kids & Teens` — broad collections over the whole catalogue |
| Today's availability | `Available today for you` — only programs a household participant is eligible for | `Available today` — marketplace-wide, filterable |
| Offers | `Offers for you` — 2–3 personalized offer cards | `Offers & trials` — full marketplace rail |
| Browse entry | Search bar + dock Discover tab | Categories, All Categories, collections, map |

## 3. Dynamic participant model (governs everything below)

Home is **participant-aware, not household-hard-coded** (docs/02 §1):

- Every account has exactly one primary participant, shown as **you** in labels (internally `Me`).
- The account may have zero, one, or multiple additional participant profiles — children today, possibly other approved dependent types later.
- Home renders from the **actual participant list**. No screen, component, or service may assume a fixed number of participants, branch on participant names, or depend on a layout of exactly three people.
- Sarah, Adam, and Lina are deterministic mock profiles of the default demo account only. Components accept dynamic participant arrays; tests must cover zero-children, one-child, and multiple-children accounts (§14).

## 4. Revised Home hierarchy

Scroll order at ~390 × 844. Every section from 3 onward is **conditional**: it renders only when it has meaningful content per the generation rules in §5, and collapses entirely otherwise (approved Home collapse rule, docs/11 §6).

1. **Header** — unchanged: wordmark, location chip (HMS-001), notification icon, avatar.
2. **Search entry** — unchanged visual; navigates to `/search` (already live).
3. **Upcoming activity** — the next scheduled session across all participants: program title, participant, day and time, provider, area. One card. Tap → Booking detail contract (HMA-024; inert until Bookings ships).
4. **Your week** — compact 7-day schedule preview (from `MOCK_TODAY`, never the device clock) listing each booked session: day, time, participant, short program title. Tap → Bookings tab contract (HMA-006; inert until it ships).
5. **Continue your routine** — active memberships, packages, or recurring programs with progress emphasis (e.g., `6 of 10 sessions left`). Max 2–3 cards.
6. **Per-participant sections** — generated from the real profile list, primary participant first, then additional profiles in account order:
   - `Based on your interests` (primary participant; declared-interest rule-based recommendations per docs/05 §9)
   - `For {participantName}` — one rail per additional profile, provider-eligibility-first (age range), then declared interests, then the docs/05 §9 ranking factors.
   - Where supply justifies it, a profile may get one supplemental format rail (`After school for {participantName}`, `Camps for {participantName}`) instead of or in addition to the base rail — never an empty one.
7. **Available today for you** — programs available today that at least one household participant is eligible for, time-led cards.
8. **Offers for you** — small personalized offers section, 2–3 badge-led cards.
9. **Marketplace Credit and rewards preview** — unchanged compact strip.
10. **Floating dock** — unchanged.

### Removed from Home (see §12 for spec supersessions)

| Section (docs/11 §4) | Fate |
|---|---|
| Participant context chips (`Everyone · Me · Adam · Lina`) | **Removed from Home.** Home shows every participant's content simultaneously via labelled sections; no profile switching needed (§7). |
| Quick filter row (Today · This weekend · Near me · Ladies only · Camps · Offers) | **Removed from Home.** Filtering is Discover/Results behavior; Home covers the timely cases with personalized sections. Supersedes docs/09 §17.4 for Home. |
| Seasonal hero (`Indoor this August`) | **Removed from signed-in Home.** Upcoming activity leads instead. Seasonal editorial lives in Discover collections. A seasonal welcome card may appear only on guest/no-history Home (§8), where no upcoming activity exists. |
| Popular categories grid + View all | **Removed from Home.** Discover exclusively owns categories and All Categories. |
| Popular providers near you | **Removed from Home.** Discover owns the provider directory; providers still appear on Home inside program cards and the upcoming-activity card. |

### Retained on Home

Header, search entry, credit strip, dock, program-card anatomy, skeletons, empty/error patterns, `AppImage` fallbacks — all visually unchanged.

### Transformed on Home

| Was (docs/11 §4) | Becomes |
|---|---|
| Recommended for you | `Based on your interests` (primary participant) |
| Recommended for Adam (single default child section) | Dynamic `For {participantName}` rails, one per real profile |
| Available today or tonight (marketplace-wide) | `Available today for you` (household-eligibility scoped) |
| Offers and trials (marketplace rail) | `Offers for you` (small, personalized) |

## 5. Section-generation rules

Home sections derive from: existing participant profiles, participant type and age, provider-defined eligibility (`minimumAge`/`maximumAge`/`allAges` vs age from date of birth — the authoritative first gate, docs/05 §9), declared interests, current bookings, active packages or memberships, current availability, the selected area, and suitable offers.

Rules:

1. A section renders only when it has meaningful content: ≥ 1 item for schedule/routine cards and ≥ 1 card for a recommendation rail (a single strong match still renders; zero never does). Supplemental format rails (`After school for…`, `Camps for…`) require ≥ 2 matches — with fewer, the content stays in the profile's base rail.
2. **Never render:** empty participant rails, fabricated bookings, fabricated memberships, fixed participant names in logic, layouts that require a specific participant count.
3. Labels are generated: `For you` / `Based on your interests` for the primary participant (never expose an internal profile name unnecessarily); `For {participantName}`, `After school for {participantName}`, `Camps for {participantName}` for additional profiles.
4. Recommendations stay simple, deterministic, and rule-based (docs/09 §18); no behavioral signals.
5. Personalization on Home ranks and scopes — it never gender-filters. `Ladies only` remains an explicit Discover/Results filter choice only (docs/05 §7).
6. Feed-length budgets from docs/11 §10 apply per rail (≈ 3–5 cards). With many profiles, Home stays scannable because each profile contributes at most its base rail plus at most one supplemental rail, and rails collapse when supply is thin.

## 6. Discover: exclusive ownership

Discover's approved hierarchy (docs/14 §2) is unchanged. These belong to Discover (and its Search/Results/Category/Map surfaces) **exclusively** — they must not reappear on Home:

- Participant context selector (chips)
- Quick filters and the filter sheet, including **Ladies only**
- Browse categories, All Categories, and the taxonomy pages
- Activity types
- Editorial collections and seasonal editorial content
- Trending content
- Popular providers (the provider directory)
- Marketplace-wide `Available today` and `Offers & trials`
- Map discovery

## 7. Participant handling

- **Home ignores the app-level browsing context.** It is context-complete: all participants' content is visible simultaneously in labelled sections. Changing the browsing context on Discover does not reorder or filter Home.
- The **participant selector remains** on Discover, Search Results, the filter sheet, and future Checkout (docs/16 §4 continues to govern those surfaces).
- The Home header may later gain a compact household/participant action (e.g., avatar → Participants); this is optional and deferred (§17). Home must never require profile switching to see each person's content.
- Checkout-time participant selection remains a separate concern (docs/02 §8); nothing on Home books on anyone's behalf.

## 8. Account scenarios and dynamic behavior

Home renders correctly for any participant list and booking state. Four normative scenarios (each must be demonstrable deterministically, §13):

| # | Scenario | Home content |
|---|---|---|
| A | **New guest, no account/history** | Header (sign-in affordance on avatar), search, seasonal welcome card (the only surface where the hero card language persists on Home), `Popular near {area}`, `Available today` (area-scoped, not personalized), `Offers`, and an invitation card to set up profiles/interests (routes to sign-in when auth ships; inert now). No upcoming, week, routine, credit, or participant rails. Nothing fabricated. |
| B | **Primary participant only, no bookings** (e.g., Sarah, interests declared) | Search, `Based on your interests`, `Popular near {area}`, `Available today for you`, `Offers for you`, credit strip, plus an optional `Add a child profile` action card. No upcoming/week/routine sections — no fake bookings. |
| C | **Account with active bookings** | Scenario B plus: `Upcoming activity`, `Your week`, and `Continue your routine` (when a membership/package exists) at the top, per §4 order. |
| D | **Household: primary + multiple children with bookings** (default demo: Sarah, Adam 8, Lina 12) | Full §4 hierarchy: upcoming + week across all participants, routine, `Based on your interests`, `For Adam`, `For Lina` (generated from the profile list, not hard-coded), `Available today for you`, `Offers for you`, credit. |

One-child accounts are Scenario C/D with a single generated rail (e.g., `For Lena`, `After school for Lena`) — exactly the same code path as D with a shorter list.

## 9. Upcoming bookings and weekly schedule (deterministic mock)

- New mock domain: **bookings** and **active plans** (membership/package/recurring enrolment), attached to the demo account and referencing **existing catalogue programs only** (no new programs; catalogue stays within the owner's 28–36 range and first-21 order stability, HANDOFF).
- All dates derive from `MOCK_TODAY` (2026-08-02, `src/utils/eligibility.ts`) — never the device clock. `Your week` = the 7 days starting at `MOCK_TODAY`.
- Default demo booking set (deterministic, referencing the current catalogue):
  - **Adam** — Junior Swim Squad (Blue Wave Swimming), weekend morning sessions; the next session is the household's `Upcoming activity`.
  - **Lina** — Teen Coding Summer Camp (Future Makers Robotics), weekday mornings this week.
  - **Sarah** — Reformer Pilates Foundations (Core Pilates House) as an active package: `6 of 10 sessions left`, next session mid-week evening → drives `Continue your routine`.
  - Exact session days/times are chosen at implementation to be internally consistent with the catalogue's schedule labels and are then frozen for tests and screenshots.
- Service boundary (docs/08 §8): a typed contract such as `ScheduleService.getUpcomingActivity(...)`, `.getWeekSchedule(...)`, `.getActivePlans(...)` (or equivalent fields on an extended `HomeFeedService` response) with one deterministic mock implementation; screens never import raw booking arrays. The account scenario (§8 A–D) is selected in mock data / QA parameters, following the established `?qa-*` pattern for review states.
- These mock bookings exist only for Home (and future Bookings) demonstration. They introduce no booking, payment, or capacity logic.

## 10. New components (existing tokens and card language only)

| Component | Job |
|---|---|
| Upcoming-activity card | Lead card: program, participant, time, provider, area; prominent but calm |
| Week-schedule strip | Compact 7-day preview with per-day session entries |
| Routine/plan card | Program + progress line (`6 of 10 sessions left`) + next session |
| Participant section header | Existing `SectionHeader` with generated labels — no new visual treatment |
| Welcome/setup cards (scenarios A–B) | Reuse hero/offer card language; no new visual system |

No visual-system changes: colors, type roles, radii, spacing, dock, and approved card anatomies are reused as-is.

## 11. What Discover loses / gains

Nothing. Discover's spec (docs/14–16) already matches its role here and remains as approved and implemented. This document only removes Home's duplication of it. The shared area context (location chip) continues to apply to both screens.

## 12. Contradiction review and supersessions

Reviewed against docs/02, 04, 05, 09, 11, 12, 14, 15, 16, 17:

| Document | Conflict | Resolution |
|---|---|---|
| docs/11 §3–§6 (above-the-fold, scroll order, participant chips, quick-filter behavior) | Prescribes hero, categories grid, providers rail, participant chips, quick filters on Home | **Superseded by §4–§5 here.** docs/11 §7 (card anatomy), §9 (states), §10 (service boundary), §11 (accessibility) remain in force. Home's approved visual baseline (screenshots) will be re-baselined after the rework is approved. |
| docs/09 §17.4 (Home quick filters re-filter in place) | Home no longer has a quick filter row | **Superseded for Home** (owner decision, 2026-08-03, recorded here and to be appended to docs/09). Discover quick-chip semantics are unaffected. |
| docs/04 HMA-004 core content list | Lists popular categories, providers nearby, seasonal feature on Home | **Refined by §4 here**; docs/04's purpose line ("personalized... without forcing a search") already matches the new role. Connection map updates: Home's `Category → Category page` and hero-CTA links are removed; Home keeps Search, program/provider card contracts, and credit-preview links. |
| docs/05 §2 (Home versus Discover) | Home list includes "Relevant providers" and seasonal content broadly | **Consistent in intent** (Home = "personalized and timely; act immediately"). Providers now surface on Home only through program/booking cards, not a rail. No text change required. |
| docs/14 §2 / docs/15 §4.2 (Discover hierarchy, Home connections) | Home entries "category tile → category, View all → categories, hero CTA → preset Results" assume those Home sections exist | Those Home entry points are removed with their sections; the routes and Discover-side entries are unchanged. |
| docs/16 §2, §4 ("Discover feed follows Home §5"; participant context shared by Home and Discover) | Home no longer consumes the browsing context | Context tables in docs/16 §4 now govern **Discover/Search/Results only**; the app-level context remains shared across those surfaces. Home is context-complete per §7 here. |
| docs/17 §18.8 (Commit 8 = polish + screenshots + report, no new screens) | Home rework is new scope | The Home rework becomes its own commit (`feat(home)`, docs/17 step 8a) after owner approval of this document; review polish, the full screenshot matrix, and the milestone report close afterwards as the final commit. Home regression baselines change by design in that commit and are re-baselined once approved. |
| docs/02, docs/12 | — | No conflicts. §3 here restates docs/02 §1; docs/12 applies in full to every new component. |

## 13. States

Existing Home state rules (docs/11 §9) apply unchanged: loading skeletons (header/dock immediate), image fallbacks, reduced motion, non-color selection indicators. Additional required states: each §8 scenario (A–D) demonstrable deterministically; week strip with 0 sessions on some days; routine card at different progress values; collapse of any participant rail with thin supply. No empty-state fabrication: a scenario with no upcoming bookings simply has no upcoming/week sections rather than an empty-schedule placeholder.

## 14. Testing requirements

- Feed-generation unit tests cover: zero additional profiles, one child, multiple children, guest (no account), no-bookings vs active-bookings, thin-supply rail collapse.
- No UI logic branches on the names Sarah, Adam, or Lina; tests assert sections derive from arbitrary participant arrays (e.g., a synthetic account with one child named `Lena` produces `For Lena`).
- Schedule assertions pin to `MOCK_TODAY`.
- Existing Discover/Search/Results/catalogue/map tests and QA scripts must continue to pass unchanged; Home QA script and screenshot baselines are updated to the new hierarchy.

## 15. Accessibility and native compatibility

docs/11 §11 and docs/12 apply in full to every new component: safe areas, ≥ 44 × 44 targets, labelled controls, Dynamic Type tolerance (week strip rows grow rather than truncate), non-color state indicators, carousels inside native vertical scrolling, reduced-motion parity. Native validation remains pending until an iOS Simulator/device pass (docs/12 §1).

## 16. Acceptance criteria (for the Home rework commit)

1. Home renders the §4 hierarchy; every removed section from §4 is absent; no participant chips or quick filter row on Home.
2. All four §8 scenarios demonstrable deterministically; no fabricated data in A/B.
3. Sections generate from the real participant list: adding/removing a mock profile changes Home without code changes; nothing assumes three participants or fixed names.
4. Upcoming activity, Your week, and Continue your routine derive from the deterministic mock bookings pinned to `MOCK_TODAY`.
5. Duplication rule holds: no section appears on Home and Discover in substantially the same form (§2 table is the allowed mapping).
6. Visual system unchanged: tokens, typography, dock, card anatomies, spacing; no new visual language beyond §10's compositions.
7. §14 tests pass; tsc, lint, jest, expo-doctor, QA scripts green; Discover surfaces unaffected (their screenshots byte-identical).

## 17. Open decisions

- Compact household/participant affordance in the Home header (deferred; not required for the rework).
- Supplemental rail policy at scale (many profiles): current rule is base rail + max one supplemental per profile; revisit after usability testing.
- Whether `Your week` becomes the Bookings tab's agenda pattern when HMA-006 ships (likely shared component; decide then).
- Guest-scenario reachability in the demo build (QA parameter now; real guest flow arrives with onboarding/auth milestone).
- Recommendation weighting remains open per docs/09 §18.4.
