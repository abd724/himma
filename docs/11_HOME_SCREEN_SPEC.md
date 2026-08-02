# 11 — Home Screen Specification (Approved Milestone 1)

Status: product-owner approved hierarchy and behavior. This spec governs the first implementation milestone together with `FIRST_PROMPT.md` and docs 01–09. Owner decisions in `docs/09_OPEN_DECISIONS.md` §17 apply.

## 1. Home's job

Home is a personalized, timely, scrollable marketplace feed. It shows a signed-in customer useful, bookable activities for themselves and their children near their selected area — without forcing a search. It must help the user act immediately and represent Himma as an app for individuals **and** families.

Home is program-first. Provider-first and category content support it but never displace specific bookable programs from the top of the feed.

## 2. Default mock persona and context

- Signed-in adult: **Sarah**
- Participants: **Me** (Sarah), **Adam** (age 8), **Lina** (age 12)
- Current area: **Khalifa City, Abu Dhabi**
- Season: Abu Dhabi summer (hot outdoors; indoor and evening activity emphasis)
- All data is deterministic fictional mock data from the Home feed service. No randomness on render.

## 3. Above the fold (approx. 390 × 844)

Visible without scrolling:

1. Header
2. Search bar
3. Participant context chips
4. Quick filter row
5. Top portion of the hero card (partially visible to invite scrolling)

Do not compress all thirteen sections above the fold.

## 4. Full scroll order

1. **Header** — safe-area aware. `Himma` text wordmark (replaceable component); location chip `Khalifa City` with chevron (opens location sheet); notification icon button; avatar icon button.
2. **Search bar** — placeholder `Search activities, providers or classes`. Focusable with keyboard opening; submission is inert this milestone.
3. **Participant context chips** — `Everyone` (default) · `Me` · `Adam` · `Lina`. Single-select. Not a Netflix-style profile switch.
4. **Quick filters** — `Today` · `This weekend` · `Near me` · `Ladies only` · `Camps` · `Offers`. Single-select toggle; tapping the active chip clears it.
5. **Hero** — one image-led seasonal feature relevant to adults and families together. Working concept: *"Indoor this August"* — beat-the-heat indoor fitness, swimming, and holiday camps for you and the family. One concise title, one support line, one CTA button (inert). No startup slogans. Must not read as children-only.
6. **Popular categories** — 8 image-backed tiles: Fitness, Boxing, Pilates, Swimming, Padel, Wellness, Learning, Kids & Teens. Short labels, no text inside images. `View all` action (inert). Layout is a design hypothesis: implementation may use a horizontally scrolling two-row grid, a fixed four-column grid, or a single-row carousel with larger tiles — whichever scans best at 390 × 844. The chosen approach and rationale must be documented in the milestone report.
7. **Recommended for you** — horizontal carousel of program cards for Sarah.
8. **Recommended for Adam** — default child section (see §5 for participant behavior). Serious, age-appropriate development content: swimming, football, Quran, robotics, martial arts.
9. **Available today or tonight** — program cards with time emphasis first (e.g., `Today, 7:30 PM`).
10. **Offers and trials** — merged single section; offer-badge-led program cards (free trial, discount, promotional price).
11. **Popular providers near you** — provider-first cards, visually distinct from program cards.
12. **Marketplace Credit and rewards preview** — one compact strip: fictional credit balance (e.g., `AED 65 credit available`) plus a short rewards line. Tap feedback only; no balance logic.
13. **Floating navigation dock** — Home · Discover · Bookings · Saved · Profile, per `docs/04` §2. Content scrolls behind it; scroll content has enough bottom padding that nothing is covered.

## 5. Participant context behavior

Participant context and quick filter are independent and may coexist. Both are inputs to the same deterministic feed query.

| Context | Feed behavior |
|---|---|
| Everyone (default) | Full feed as ordered in §4; child section shows Adam. |
| Me | Adult-focused feed; child-specific section hidden; adult programs emphasized in all sections. |
| Adam | `Recommended for Adam` becomes the first program section; `Recommended for you` hidden; all sections filter to age-8-suitable programs. |
| Lina | Same as Adam, for Lina and age-12-suitable programs. |

## 6. Quick filter behavior

Selecting a quick filter genuinely and deterministically re-filters or reorders the mock feed in place:

| Filter | Behavior |
|---|---|
| Today | Only programs with availability today. |
| This weekend | Only weekend programs. |
| Near me | Khalifa City and nearby areas (Al Raha, MBZ City) ranked first. |
| Ladies only | Only programs with eligible ladies-only sessions. |
| Camps | Only camp-format programs. |
| Offers | Only trials, discounts, or promotional programs. |

Rules:

- Active state is communicated by more than color: filled chip + check/indicator icon + a context line under the filter row (e.g., `Showing ladies-only activities`).
- Sections with no matching content collapse entirely (no empty carousels).
- If the whole feed has no matches for a context + filter combination (e.g., Adam + Ladies only), show one friendly empty state with a clear recovery action (e.g., `No ladies-only activities for Adam. Try Everyone or Me.`) plus a clear-filter action.
- Filtering never navigates away from Home this milestone.

## 7. Card anatomy

### Program card
Image (with fallback) → badge where relevant (`Free trial`, `Ladies only`, `4 places left` — no fake urgency) → **program title** → provider name → area · schedule line → price-model line emphasized per model (`AED 85 drop-in`, `AED 450/month`, `AED 1,250/week camp`) → rating → favourite heart (toggles locally). Not every field on every card; keep scannable.

### Provider card
Distinct layout from program cards: provider identity (fictional monogram/tile, no real logos) → provider name → category line (`Boxing · Kickboxing · Jiu-jitsu`) → area · rating. No price schedule line.

### Category tile
Strong photo, short label below or overlaid on a contrast-safe scrim, consistent treatment, no text baked into images.

### Hero card
Large rounded image card, concise title and support line, single CTA button, contrast-safe text treatment.

### Credit strip
Compact single-row card using `brand.reward` surface with dark text; icon + `AED 65 credit available` + short rewards line.

## 8. Interactions this milestone

| Element | Behavior |
|---|---|
| Location chip | Opens and closes a location bottom sheet (area list, current selection; selection updates the header label and `Near me` reference area). |
| Participant chips | Select/deselect per §5; feed updates. |
| Quick filter chips | Toggle per §6; feed updates. |
| Search bar | Focus + keyboard; submission inert. |
| Favourite heart | Local toggle with accessible state. |
| Carousels | Smooth horizontal scroll, no clipping. |
| Hero CTA, View all, category tiles, program cards, provider cards, credit strip, notification, avatar | Inert with visible press feedback (opacity/scale). |
| Dock: Discover, Bookings, Saved, Profile | Inert with subtle press feedback only. Home remains visibly active at all times; the active pill never moves to another destination. |

Inert actions must not show alerts, Coming Soon messages, disabled styling, phase labels, placeholder screens, or developer text.

## 9. States

- Default content state (per context/filter matrix above).
- Loading skeleton for the feed (header and dock render immediately).
- Missing-image fallback (neutral branded placeholder block, no broken images).
- Empty recommendation fallback (§6 rules).
- Selected/unselected chip states not relying on color alone.
- Reduced motion respected (no animated skeleton shimmer or pressed-scale when reduced motion is on).

## 10. Mock data and service boundary

- Typed contract, e.g. `HomeFeedService.getHomeFeed({ area, participant, quickFilter }): Promise<HomeFeed>` returning ordered, typed sections.
- One deterministic mock implementation; route screen never imports raw mock arrays directly.
- Catalogue sized for one screen: roughly 18–24 programs across the 8 fictional providers from `FIRST_PROMPT.md`, with attributes covering every filter dimension (today/weekend availability, area, ladies-only sessions, camp format, offers/trials, age suitability 6–adult) so every §5/§6 combination is demonstrable.
- Feed length budget (rich but not exhausting): recommended sections ≈ 3–5 cards; available today or tonight ≈ 3–4; offers and trials ≈ 3–4; popular providers ≈ 3–4; popular categories 6–8 visible.
- Realistic AED prices and Abu Dhabi areas; fictional providers only.

## 11. Accessibility checklist

- Safe-area handling top and bottom.
- All icon-only buttons have screen-reader labels; chips expose selected state.
- Touch targets ≥ 44 × 44 logical pixels.
- Contrast-safe token usage; text over images uses scrims.
- Layout tolerates larger text sizes without clipping.
- No horizontal page overflow; no card clipping; dock never covers content.
- Selection states carry a non-color indicator.

## 12. Excluded from this milestone

All items in `FIRST_PROMPT.md` "Do not build," plus explicitly: navigation to any other screen, search results, program/provider detail, booking or checkout of any kind, real credit logic, notifications, maps, authentication, Arabic/RTL, and any Coming Soon or placeholder destination surfaces.

## 13. Acceptance criteria

1. Scroll order matches §4 exactly at 390 × 844 with §3 above the fold.
2. Every §5 participant context and §6 quick filter produces the specified deterministic feed change, including collapsing sections and the empty-state recovery path.
3. Floating dock matches `docs/04` §2 (detached capsule, active pill, icon + label, content visible behind, no edge-to-edge tab bar).
4. All §8 interactions behave as listed; no inert action produces an alert or placeholder.
5. §9 states are all demonstrable; §11 checklist passes.
6. TypeScript strict, lint, and Expo Doctor pass; screenshots captured per `FIRST_PROMPT.md` visual review.
7. No raw brand hex values in screen components; all styling via central tokens.
