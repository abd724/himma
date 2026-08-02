# 16 — Discover State and Interaction Matrix

Status: draft for product-owner review. Companion to docs/14 (product spec) and docs/15 (information architecture). All copy examples follow docs/06 §14 (direct, friendly, specific); no developer terminology ever reaches the customer.

## 1. Purpose

Defines every required state per surface and the exact interaction rules — filters, participant context, keyboard, gestures, and native back behavior — so implementation and review have one authoritative matrix.

## 2. State matrix

Surfaces: **D** Discover feed · **S** Search · **R** Results (incl. category/activity-type lists) · **F** Filter sheet · **M** Map mode.

| State | Applies to | Behavior and copy example |
|---|---|---|
| Default | all | Per docs/14 §2–4. |
| Loading | D, S, R, M | Static skeletons in section shapes (Home skeleton pattern; reduced-motion safe). Header, chips, and dock render immediately. Previous content stays visible during in-place refilters (Home rule). |
| Empty section | D | Section collapses entirely; no empty carousels (Home rule). |
| Search: no results | S, R | `No results for "pilaties"` + tappable popular searches + `Browse categories` + `Clear filters` when filters active. Typo map may add `Did you mean Pilates?` as the first suggestion. |
| Filter combination: no results | R, D | Empty-state card (Home pattern): `No matches right now` + specific reason when knowable (`No ladies-only activities for Adam. Try Everyone or Me.`) + `Clear filters` recovery. Never a blank screen. |
| Weak category supply | D, R | Discover hides sections below the supply threshold (docs/14 §13). Category/activity pages always open and state it honestly: `Only 2 padel activities near Khalifa City right now. Try nearby areas.` + area action. No "coming soon" language. |
| Missing image | all | `AppImage` branded fallback (approved component). |
| Location unavailable | D, R, M | No geolocation exists in the mock (docs/09 §12): "Near me" always uses the selected area. If no area context exists (future real app), prompt the area sheet: `Choose your area to see nearby activities.` Contract-level; mock always has a default area. |
| Offline / network error | D, S, R | Full-section error card: `Can't load activities right now. Check your connection and try again.` + `Retry`. Mock services expose a deterministic failure flag for QA/Playwright only — no customer-reachable trigger, no dev wording in UI. |
| Provider unavailable | R, D | Unavailable providers and their programs are excluded from all mock lists. If a stale entry is ever opened (deep link, future), the detail surface owns the state — contract: `This provider is no longer on Himma.` + back to Results. |
| Program no longer available | R, D | Same exclusion rule; detail-surface contract: `This program is no longer offered.` + provider's other programs. List surfaces never render dead cards. |
| Selected filters | D, R, F, M | Chips filled + check icon + context line (Home rule); count badge on `Filters`; removable active-filter chips above Results; `Clear all` in sheet. Never color-only. |
| Participant-specific results | D, S, R | Selected context filters suitability exactly as Home §5: child context excludes adult-audience programs and re-ranks; suggestions in Search respect context (no adult-only suggestions under a child context). |
| Ladies-only results | D, S, R, M | Ladies-only filter shows only `women-only` programs; context line `Showing ladies-only activities`; badges on cards where the program is ladies-only; collection entry behaves identically to the filter. |

Every state must be demonstrable in the milestone with deterministic data (docs/14 §8) or explicitly marked contract-level in the milestone report.

## 3. Filter interaction rules

1. **One source of truth.** A single typed `FilterSelection` drives quick chips, sheet, Results, and map; identical state everywhere, counts never disagree (docs/15 §5).
2. **Quick chips on Discover** mirror Home exactly: single-select toggle, in-place feed refiltering, tap active chip to clear (docs/09 §17.4).
3. **Quick chips on Results** set the equivalent sheet field and may combine (e.g. Today + Ladies only). The chip row and sheet stay in sync both directions.
4. **Mutually exclusive groups** (session eligibility: Ladies only / Girls only / Men only / Boys only / Mixed) are radio-style — selecting one replaces the other, announced via the chip state change.
5. **Cross-field conflicts are allowed, explained, and recoverable** — zero-result state names the conflict when knowable; nothing is silently disabled or hidden (docs/04 HMA-019 principle).
6. **Counts:** sheet footer shows `Show N results` live; N is deterministic; N = 0 keeps the button enabled and lands on recovery.
7. **Clearing:** sheet `Clear all`; per-group clears; removable chips above Results; empty-state `Clear filters`.
8. **Persistence:** filter state survives list ↔ map toggling and tab switches within Results; it resets when a new search query is submitted; Discover quick-chip state is independent of Results state (matching Home's independence).
9. **Ladies only** is never more than one tap away on D and R (chip), pinned first in the sheet's Who group.

## 4. Participant context rules

- One app-level browsing context shared by Home and Discover (docs/02 §7); changing it anywhere changes it everywhere.
- Context ∧ quick filter compose (Home §5/§6 semantics); contract table:

| Context | Discover feed | Search suggestions | Results |
|---|---|---|---|
| Everyone | Full breadth | All | All, eligibility-ranked |
| Me | Adult-suitable emphasis; kids-only sections collapse | Adult-relevant | Adult-suitable first, child-only excluded from top ranks |
| Adam (8) | Kid-suitable (age 8) only; adult-only sections collapse | Age-8-suitable | Hard-ineligible excluded |
| Lina (12) | Kid/teen-suitable (age 12) only | Age-12-suitable | Hard-ineligible excluded |

- Checkout-time participant selection remains a separate future concern (docs/02 §8) — browsing context never books.

## 5. Keyboard and input rules (Search)

- `/search` opens with the input focused and keyboard visible; `returnKeyType="search"`.
- Suggestion list scrolls under the keyboard correctly (`keyboardShouldPersistTaps="handled"`, keyboard avoidance per docs/12 §5); tapping a suggestion never requires dismissing the keyboard first.
- `Cancel` (and Android back / iOS swipe-back) dismisses keyboard and returns; clearing the field with the inline ✕ keeps focus.
- Submitting an empty query does nothing (no error modal).
- Dynamic Type: input and suggestion rows scale; rows grow in height rather than truncating labels.

## 6. Native gesture and navigation rules

- **Android back priority:** open sheet → close sheet; else map mode → return to list; else keyboard open on Search → dismiss and return; else pop the route stack.
- **iOS swipe-back** enabled on every pushed route (`/search`, results, categories, category, activity, map); no gesture traps from horizontal carousels (verify in native validation).
- **Sheets:** bottom sheet with top radius `radii.sheet`, drag handle, backdrop tap and swipe-down to dismiss (reduced-motion: fade, no slide); content padded by bottom inset.
- **Dock visibility:** the dock stays visible on browsing surfaces (Discover root, All Categories, category, activity type, Results list) with the Discover pill active, because browsing is not a focused flow (docs/04 §2). It hides while any sheet is open, on `/search` (keyboard-focused flow), in map mode (full-bleed), and on future transactional/detail flows per docs/04 §2.
- **Carousels inside the vertical feed:** horizontal `ScrollView`/`FlatList` with no `pagingEnabled` traps; vertical scroll must win diagonal gestures (native validation checklist item).
- **Touch targets:** every chip, tab, suggestion row, pin, and toolbar control ≥ 44 × 44 pt (docs/12 §7).
- **Map mode:** toggle preserves scroll-independent state; `List` control always visible; pins have list equivalents (docs/14 §9).

## 7. Mock-data requirements

Docs/14 §8 and docs/15 §6 apply. Additionally, the deterministic failure flag (§2 Offline) and a thin collection (docs/15 §6) must exist so every matrix row above is reachable in review without code edits.

## 8. Accessibility requirements

Docs/14 §9 applies to every state here. State changes (filter applied, results count, empty, error) announce politely; recovery actions are buttons, reachable in reading order directly after the message they resolve.

## 9. Native compatibility requirements

Docs/12 in full; §§5–6 above are the Discover-specific applications. Native validation for this milestone must walk the §6 checklist on the iOS Simulator (or device) before "native validated" is claimed — web review cannot cover keyboard, back gestures, or carousel gesture arbitration.

## 10. Acceptance criteria

1. Every §2 row is demonstrated (or explicitly reported contract-level) in review.
2. Filter state round-trips chips ↔ sheet ↔ Results ↔ map with zero disagreement, including counts.
3. The Android back priority order and iOS swipe-back behave exactly per §6 (native pass), with dock visibility following the §6 rule (visible while browsing; hidden under sheets, on Search, and in map mode).
4. Search keyboard behavior matches §5 on native.
5. No state renders developer wording, blank screens, or dead-end errors without a recovery action.

## 11. Explicit exclusions

Real network conditions (only the deterministic failure flag), push-notification states, auth-gated states (favourites prompt-to-sign-in arrives with auth milestone), booking/capacity states (docs/04 HMA-017+), review/rating submission states.

## 12. Open decisions

- Sheet library vs hand-rolled bottom sheet (hand-rolled Modal matched Home's location sheet; revisit if filter sheet complexity demands gestures beyond swipe-down).
- Whether Discover quick-chip state and Results filter state should ever sync (currently independent by design, matching Home).
- Haptic feedback policy for chip toggles and sheet apply (nice-to-have; decide at implementation with reduced-motion parity).
