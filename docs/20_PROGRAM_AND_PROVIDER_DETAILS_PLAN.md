# 20 — Program Details + Provider Storefront Plan (Milestone 3)

Status: for product-owner approval. No implementation has started. Governing docs: 04 (HMA-014/015 inventories), 05 (catalogue and eligibility), 06 (UX), 08 (engineering), 09 (open decisions), 12 (native), 14–16 (Discover specs), 15 §4.1 (route contracts), 18 (Home/Discover roles), 19 (established service/builder patterns), HANDOFF.md (frozen catalogue, inert-card inventory).

## 1. Milestone objective and product purpose

Implement the two evaluation surfaces that complete the pre-booking journey and activate every inert program and provider card:

- **Program Details (HMA-015)** answers: *"Is this activity suitable for me or the selected participant, and do I want to book it?"*
- **Provider Storefront (HMA-014)** answers: *"Can I trust this provider, and what suitable activities do they offer?"*

Both pages finish the evaluation stage. Booking, checkout, payment, gifts, and reviews-as-content remain future milestones. The Book action is present and prominent but opens nothing transactional — no fake checkout, no fake payment, no fake capacity holds (docs/08 §14).

## 2. Routes, navigation model, and back behavior

### 2.1 Routes

| Surface | Route (concrete = logical contract, docs/15 §4.1) | Dock |
|---|---|---|
| Program Details | `/program/[programId]` — `src/app/program/[programId].tsx` (root-level push) | Hidden structurally |
| Provider Storefront | `/provider/[providerId]` — `src/app/provider/[providerId].tsx` (root-level push) | Hidden structurally |

Rationale: docs/16 §6 keeps the dock on *browsing* surfaces and hides it on detail/transactional flows; docs/08 §4's long-term route tree already places `provider/` and `program/` at the app root. Root-level pushes reuse the exact `/search` and `/map` mechanism (dock hidden because the tab navigator is not mounted — no per-screen hacks), and the concrete paths match the docs/15 §4.1 logical contracts with no `/discover/` prefix. The sticky Book CTA occupies the bottom region the dock would otherwise use.

### 2.2 Back behavior

- Standard pattern (existing convention): `if (router.canGoBack()) router.back(); else router.replace('/discover')`. Exact-origin back everywhere: Home → Program Details → back lands on Home; Results → Program Details → back lands on Results with the results session untouched (Results stays mounted beneath the root push, so query, tab, filters, sort, and page are preserved by construction — no session serialization needed).
- iOS swipe-back enabled; Android back pops (sheet first when the branch selector is open, per docs/16 §6 priority).
- **Cold deep link** (opening `/program/junior-swim-squad` with an empty stack): the back control falls back to `router.replace('/discover')`; app-level providers give default participant (`everyone`) and area (`khalifa-city`), so the page renders fully.
- **Unknown id**: the details service returns `undefined` (the established category/activity-type recovery precedent); the screen renders the docs/16 §2 contract state — program: `This program is no longer offered.`; provider: `This provider is no longer on Himma.` — each with a `Browse activities` recovery action to `/discover`.

### 2.3 Duplicate-route prevention and cross-links

New pure, unit-tested policy module `src/features/details/detail-navigation.ts` (same pattern as `search-navigation.ts` / `map-navigation.ts`):

```ts
export type DetailHref = `/program/${string}` | `/provider/${string}`;
export function programHref(programId: string): DetailHref;
export function providerHref(providerId: string): DetailHref;
/**
 * 'back' when the target is the route directly beneath the current one
 * (Program ↔ Provider round-trips reuse the existing screen instead of
 * growing the stack); otherwise 'push'.
 */
export function crossLinkAction(previousHref: string | undefined, target: DetailHref): 'back' | 'push';
```

- Card taps use `router.push` guarded by a per-press in-flight ref so one navigation action never pushes two copies of the same detail route (double-tap safety).
- Program Details → provider link and Provider Storefront → program card use `crossLinkAction`: `provider A → program X → provider A` goes back instead of pushing a third route; `provider A → program X → program Y`'s provider link (also A) likewise resolves via the policy. Distinct targets push normally — a genuine chain (program X → provider A → program Y) is legitimate stack growth.

### 2.4 Activation matrix (all currently inert cards)

Program cards → `/program/[programId]`:

| Origin | Component and call sites |
|---|---|
| Home | `ProgramCard` in `src/features/home/home-screen.tsx` rails |
| Discover | `ProgramCard` carousels in `discover-screen.tsx` |
| Results | `CompactProgramRow` in `results-screen.tsx` (All + Programs tabs) |
| Category page | `CompactProgramRow` (popular + offers) in `category-screen.tsx` |
| Activity-type page | `CompactProgramRow` in `activity-type-screen.tsx` |
| Search | No program cards exist on the Search screen (suggestions are activity/provider/category/area by design); program taps happen on Results. Documented, not a gap. |
| Map | No program cards exist on the map (pins are provider markers; areas open Results). Documented, not a gap. |

Provider cards → `/provider/[providerId]`:

| Origin | Component and call sites |
|---|---|
| Discover | `ProviderCard` carousel |
| Results | `CompactProviderRow` (All + Providers tabs) |
| Category page | `CompactProviderRow` |
| Activity-type page | `CompactProviderRow` |
| Search | Provider suggestion rows route directly via the already-populated `SearchSuggestion.targetId` (its doc comment names this exact activation) instead of submitting a search |
| Program Details | Provider link row (§3) |
| Home | No provider cards exist on Home after docs/18 (providers appear only inside program/booking cards). Documented, not a gap. |

Provider Storefront → Program Details via its program list (§4). `ProgramCard`, `CompactProgramRow`, `ProviderCard`, `CompactProviderRow` each gain an optional `onPress` prop; the body `PressableFeedback` already exists, so activation is prop-threading, not redesign. The four "inert until details ship" code comments are removed.

**Provider name inside program cards stays non-interactive.** docs/04 §5 says the provider name on a program card should open the storefront, but nested interactive controls are invalid on native (documented constraint at `program-card.tsx:68`). Resolution: the card body opens Program Details, whose provider row is one further tap from the storefront. Recorded in §13 and as an open decision (§14.2).

## 3. Program Details — page hierarchy (HMA-015)

Vertical scroll at ~390 × 844, top to bottom. Sections marked *(conditional)* render only with content and collapse otherwise (established rule).

1. **Primary image treatment** — full-width image (existing `imageKey` via `AppImage`, branded fallback), top scrim for status-bar legibility. Overlaid safe-area controls: back (left), save heart + share (right), all ≥ 44 pt on scrim chips. A multi-image gallery is deferred: the mock image library has one image per program; gallery arrives with provider media onboarding (§8.5).
2. **Offer badge** *(conditional)* — existing `Badge` (`Free trial`, `20% off first month`, …).
3. **Program title** — screen-title type, up to 2 lines.
4. **Provider row** — monogram + provider name + verification mark where `verified` — the Program → Provider cross-link (whole row pressable, chevron affordance).
5. **Rating and review count** — `★ 4.8 (124 reviews)` (deterministic mock count, §8).
6. **Key facts strip** — concise metadata chips in one wrapping row: age label (`Ages 6–12` · `Ages 16+` · `All ages`), gender eligibility only when restrictive (`Ladies only`), skill level (`All levels`), format (`Drop-in` / `Monthly` / `Term` / `Camp` / `Package` / `Free` / `Trial`), setting (`Indoor`/`Outdoor`).
7. **Participant suitability** *(signed-in only)* — one line for the currently selected participant: eligible → `Suitable for Adam (age 8)`; ineligible → recovery banner (§6.1). Selected participant comes from the shared `ParticipantProvider`; `everyone` shows the age label only, no per-person line.
8. **Price block** — exact pricing model emphasized per docs/05 §6 (`AED 85 per session`, `AED 450/month`, `AED 1,250/week camp`, `AED 400 for five sessions`, `Free`); offer/trial line beneath where present.
9. **Schedule summary** — `scheduleLabel` (+ `Today, 7:30 PM` emphasis when `availableToday`).
10. **Available sessions** — next-two-weeks deterministic session list (§8.3): day label · time · branch where relevant · `4 places left` where weak. **Informational display only** (owner decision, docs/09 §20.9): no selection state, no persisted choice, no implied transaction while Book is inert — session selection becomes functional in the Booking milestone. Empty → `No upcoming sessions listed. Contact support for the next start date.` (no fake urgency).
11. **Area and branch** — area label + branch label where the provider is multi-branch; pressable row opens the provider's branch information (storefront section).
12. **Description** — 2–4 sentence mock description per program (§8.2), no truncation games (short enough to show fully).
13. **What's included** *(conditional)* — short bullet list.
14. **What to bring** *(conditional)* — short bullet list.
15. **Instructor** *(conditional)* — name + one-line title (`Head Coach · 10 yrs`), monogram avatar. Omitted entirely when absent (missing-instructor state).
16. **Facilities** *(conditional)* — chips (`Showers`, `Parking`, `Ladies-only area`, …), relevant subset from the provider record.
17. **Cancellation and refund summary** — 2–3 line preset policy summary (§8.4) + `Full policy` inert contract row (future HMS-008).
18. **Safety and eligibility notes** *(conditional)* — `eligibilityNotes` and any safety line, plain text.
19. **More from {provider}** *(conditional)* — up to 4 compact rows of the provider's other programs (cross-links).
20. **Support row** — `Something wrong with this listing?` inert contract (future HMA-032 help entry). No provider phone numbers (docs/09 §11).
21. **Sticky Book CTA** — pinned bottom bar above the home indicator: primary button `Book` + price reminder (`AED 85 · drop-in`; `Book free trial` for trials). **Inert with press feedback** per docs/09 §17.2 — it opens no sheet, alert, or placeholder (owner may choose a richer contract, §14.1). Ineligible selected child ⇒ CTA stays enabled and honest (booking-time participant selection is the real gate, docs/02 §8) while the §6.1 banner explains suitability.

Save = heart toggle (shared favourites, §5). Share (owner decision, docs/09 §20.5) = native share sheet with the program title + placeholder canonical web URL `https://himma.app/program/[programId]`; on Expo web, Web Share when available with a safe copy-link fallback. No `himma://` links in shared content.

## 4. Provider Storefront — page hierarchy (HMA-014)

1. **Identity header** — cover image where available, else a brand-tokened monogram banner (fictional monogram derived from the provider name — no real logos, docs/08 §11). Overlaid back / save / share controls as §3.1.
2. **Provider name + verification** — name, `Verified` mark with label (never color-only).
3. **Rating and review count** — `★ 4.7 (312 reviews)`.
4. **Description** — 2–3 sentence mock description.
5. **Category and activity-type chips** — derived from the provider's actual programs (`Program.categoryId`/`activityTypeId` joined to the taxonomy — never the free-text `Provider.categories` strings, §7). Chips deep-link to category/activity-type pages.
6. **Branches** — single-branch providers: one row (area + fictional address line + opening hours). Multi-branch: branch selector (segmented control for 2, sheet for more) that filters the program list; branch rows show area, address line, hours.
7. **Programs** — the storefront's core, immediately visible without extra navigation layers: vertical `CompactProgramRow` list of every program, eligibility-aware for the selected participant (child context: age-ineligible programs shown in a collapsed `Not for {name}'s age` group rather than hidden — honesty over silent filtering, with counts). Grouped under small category headers when the provider spans multiple categories.
8. **Offers and trials** *(conditional)* — badge-led subset rail; collapses when the provider has none.
9. **Facilities and amenities** *(conditional)* — chips.
10. **Instructors / team** *(conditional)* — 1–3 name + title rows where the mock data provides them.
11. **Policies** — same preset policy summary component as §3.17.
12. **Map-area entry** *(conditional)* — `See {area} on the map` row opening `/map?origin=provider` with the shared session (new `provider` value appended to `mapOrigins`; list-return behavior identical to other origins).
13. **Support row** — same contract row as §3.20.

No sticky CTA on the storefront (nothing to book at provider level); the dock stays hidden (root detail route) and content gets standard bottom safe-area padding. Save = provider favourite (§5). Share = as §3.

**Filters**: at the current supply scale (2–7 programs per provider) additional filter controls are not genuinely useful and are deliberately omitted; the branch selector (§4.6) and the participant-eligibility grouping (§4.7) are the storefront's only narrowing mechanisms. Revisit when a provider exceeds ~10 programs.

## 5. Shared state model

Reuse only — **no second favourites system, no second participant state, no new global stores**:

| Provider | Use on detail pages |
|---|---|
| `AccountProvider` | Resolves participants for the suitability banner and household recovery list; guest (`account === null`) hides per-person suitability, shows age labels only (docs/02 §2 guest browsing holds) |
| `ParticipantProvider` | The selected browsing participant drives suitability and storefront eligibility grouping. Detail pages **read** it; the only write is the explicit recovery action (§6.1) — never a silent switch |
| `AreaProvider` | Area labels; `Near you` phrasing when program area ∈ selected area's `nearby` |
| `FavouritesProvider` | Extended to typed keys (below); one provider, one set, both entity kinds |
| `ResultsSessionProvider` | Untouched by detail pages; preserved beneath root pushes by construction (§2.2) |

Favourites API change (Commit 10, all call sites updated in the same commit):

```ts
// src/state/favourites-context.tsx
export type FavouriteKind = 'program' | 'provider';
export type FavouriteKey = `${FavouriteKind}:${string}`;
interface FavouritesContextValue {
  favourites: ReadonlySet<FavouriteKey>;
  isFavourite: (kind: FavouriteKind, id: string) => boolean;
  toggleFavourite: (kind: FavouriteKind, id: string) => void;
}
```

Session-local as today; persistence still arrives with the account milestone. Existing call sites (home, discover, results, category, activity-type screens) migrate to `isFavourite('program', id)` — behavior identical.

## 6. Eligibility and participant suitability

### 6.1 Presentation helper (new, pure, unit-tested)

`src/utils/eligibility.ts` gains a presentation layer over the existing predicates (`suitsChild`, `suitsAdult`, `ageRangeLabel`, `spokenAgeLabel` are reused, not duplicated):

```ts
export interface ParticipantSuitability {
  participantId: ParticipantId;
  label: string;            // 'Me' | 'Adam' | …
  suitable: boolean;
  /** Customer wording, e.g. 'Ages 6–12 — Adam is 8' or 'Ages 16+ — Adam is 8'. */
  reason: string;
}
export function participantSuitability(eligibility: Eligibility, participant: Participant): ParticipantSuitability;
export function householdSuitability(eligibility: Eligibility, participants: Participant[]): ParticipantSuitability[];
```

Rules (unchanged semantics): children hard-check the provider-defined age range — authoritative (docs/05 §7); adults check `suitsAdult` (never gender-based; Ladies-only remains a badge and filter, never an automatic exclusion).

### 6.2 Child-ineligible recovery (no silent switching)

When the selected participant is a child outside the provider-defined range, Program Details shows a banner directly under the key facts strip:

> `Not suitable for Adam (Ages 16+ — Adam is 8).`
> `Suitable for: Me` — one chip per eligible household participant.

Tapping a chip explicitly sets the shared participant context to that person (visible everywhere, reversible, announced politely). No automatic reassignment ever happens; the page never blocks viewing (evaluation stays open, booking-time eligibility is the future hard gate, docs/02 §8). The storefront equivalent: `No programs for Lina's age at this provider yet` + eligible-participant chips + `Browse activities for Lina` → `/discover`.

## 7. Data audit

### 7.1 Fields already available (reused as-is)

| Entity | Fields |
|---|---|
| `Program` | `id`, `title`, `providerId`, `categoryId`, `activityTypeId`, `areaId`, `imageKey`, `scheduleLabel`, `todayTime`, `availableToday`, `runsOnWeekend`, `runsAfterSchool`, `isCamp`, `setting`, `price` (all 7 `PriceModel` kinds incl. `free`), `eligibility` (full structured model incl. `eligibilityNotes`), `rating`, `offer` |
| `Provider` | `id`, `name`, `categories` (display strings — card use only), `areaId`, `rating`, `verified` |
| Helpers | `ageRangeLabel`, `spokenAgeLabel`, `suitsChild`, `suitsAdult`, `isLadiesOnly`, `MOCK_TODAY`, `providerProgramCount` |

### 7.2 Fields missing for Program Details

`description` · review count · sessions/availability · included · what-to-bring · instructor · facilities · cancellation/refund summary · branch reference.

### 7.3 Fields missing for Provider Storefront

`description` · review count · cover image key · branches (address, hours) · facilities · instructors/team · policies · taxonomy-joined categories (`Provider.categories` is free text and does not join to `CategoryId` — the storefront derives categories from the provider's programs instead; the display strings stay untouched for existing cards).

### 7.4 Optionality

Optional (section collapses): instructor, included, bring, facilities, team, offers, cover image, opening hours, safety notes, `todayTime`. Required for every program/provider: description, review count, policy preset, sessions plan (may be explicitly empty for the no-sessions state).

### 7.5 Deterministic mock additions vs backend-wait

| Add now (deterministic mock) | Wait for backend / provider onboarding |
|---|---|
| Descriptions, review counts, instructor names/titles, facilities, branch labels + fictional address lines + opening hours, policy presets (mock-only wording), session occurrences derived from existing schedule fields | Real review content and verified-review pipeline, real capacity, multi-image galleries and provider media, real policies per provider contract, instructor profiles/photos, live availability, support/report backend, share web URLs |

**Catalogue freeze holds: 36 programs, 11 providers, zero reordering.** No appended programs or providers are needed — every required state is reachable with the existing catalogue (§9 maps states to concrete ids). All additions live in *new keyed extras modules* so `catalogue.ts` is untouched:

## 8. Domain types, mock data, and services (exact contracts)

### 8.1 Domain additions — `src/types/domain.ts` (append-only)

```ts
export interface ProviderBranch {
  id: string;
  label: string;            // 'Al Raha Beach'
  areaId: AreaId;
  /** Fictional street line for realism — never a real address. */
  addressLine: string;
  openingHours?: string;    // 'Daily 6:00 AM – 10:00 PM'
}

export interface SessionOccurrence {
  id: string;
  /** 0–13 relative to MOCK_TODAY (two-week window). */
  dayOffset: number;
  dayLabel: string;         // 'Today' | 'Mon 3 Aug' | …
  timeLabel: string;        // '7:30 PM'
  /** Present only when places are genuinely limited; drives '4 places left'. */
  spotsLeft?: number;
}

export interface CancellationPolicy {
  id: 'flex-24' | 'flex-48' | 'non-refundable';
  title: string;            // 'Flexible cancellation'
  summaryLines: string[];   // 2–3 concise customer lines
}
```

### 8.2 Extras modules (new files; every id covered, enforced by data-invariant tests)

```ts
// src/data/mock/program-details.ts
export interface ProgramDetailExtras {
  description: string;
  reviewCount: number;
  policyId: CancellationPolicy['id'];
  included?: string[];
  bring?: string[];
  instructorName?: string;
  instructorTitle?: string;
  safetyNote?: string;
  branchId?: string;                 // multi-branch providers only
  /** 'derived' (default) builds sessions from schedule fields; 'none' = no upcoming sessions; explicit array overrides. */
  sessions?: 'none' | SessionOccurrence[];
}
export const programDetailExtras: Record<string, ProgramDetailExtras>;

// src/data/mock/provider-details.ts
export interface ProviderDetailExtras {
  description: string;
  reviewCount: number;
  coverImageKey?: string;            // reuses existing demo image keys
  branches?: ProviderBranch[];       // absent = one implicit branch at provider.areaId
  openingHours?: string;
  facilities?: string[];
  team?: { name: string; title: string }[];
  policyId: CancellationPolicy['id'];
}
export const providerDetailExtras: Record<string, ProviderDetailExtras>;

// src/data/mock/policies.ts — the three approved presets (docs/09 §20.4): free
// cancellation up to 24 h, free cancellation up to 48 h, non-refundable after
// confirmation. Wording is MOCK-ONLY placeholder copy; final policy wording comes
// from provider onboarding and backend configuration. No partial-refund maths,
// wallet-credit rules, provider penalties, or exception policies.
export const cancellationPolicies: Record<CancellationPolicy['id'], CancellationPolicy>;
```

Multi-branch demo without touching the catalogue: **Blue Wave Swimming** gets two branches *within Al Raha* (`Al Raha Beach`, `Al Raha Gardens`); its programs map to branches via `branchId` in the extras record. Program `areaId` values, catalogue order, and all area-based counts stay byte-identical. Every other provider keeps one implicit branch. (Alternative — a second-area branch with appended programs — rejected: it would break the 36-program freeze for no additional state coverage.)

### 8.3 Deterministic session derivation (pure, unit-tested)

`buildUpcomingSessions(program, extras): SessionOccurrence[]` in the mock service: derives a two-week window from `MOCK_TODAY` using `scheduleLabel` day patterns, `todayTime`/`availableToday`, and `runsOnWeekend` — no randomness, no device clock. Per-program overrides via `extras.sessions`: one program is set to `'none'` (no-sessions state) and two carry small `spotsLeft` values (weak availability). Camps render start-week sessions (`Week of 10 Aug`).

### 8.4 Service contract — `src/services/contracts/details.ts` + `src/services/mock/mock-details-service.ts`

```ts
export interface ProgramDetailInput {
  programId: string;
  participantId: ParticipantId;
  areaId: AreaId;
  simulateFailure?: boolean;   // QA/Playwright-only, established pattern
}

export interface ProgramDetailPage {
  program: Program;
  provider: Provider;
  extras: ProgramDetailExtras;
  ageLabel: string;                       // from ageRangeLabel
  formatLabel: string;                    // 'Drop-in' | 'Monthly program' | …
  priceLabel: string;                     // 'AED 85 per session'
  sessions: SessionOccurrence[];
  branch?: ProviderBranch;
  policy: CancellationPolicy;
  suitability?: ParticipantSuitability;   // selected participant; undefined for 'everyone'/guest
  householdSuitability: ParticipantSuitability[];
  areaLabel: string;
  moreFromProvider: Program[];            // ≤ 4, excludes self, deterministic order
}

export interface ProviderStorefrontInput {
  providerId: string;
  participantId: ParticipantId;
  areaId: AreaId;
  branchId?: string;
  simulateFailure?: boolean;
}

export interface StorefrontProgramGroup {
  category: Category;
  programs: Program[];
}

export interface ProviderStorefrontPage {
  provider: Provider;
  extras: ProviderDetailExtras;
  monogram: string;                       // 'FC' — derived from name
  categories: Category[];                 // taxonomy-joined via programs (§7.3)
  activityTypes: ActivityType[];
  branches: ProviderBranch[];             // ≥ 1 (implicit primary included)
  policy: CancellationPolicy;
  programGroups: StorefrontProgramGroup[];      // eligible-first for child context
  ineligiblePrograms: Program[];                // child context only; shown collapsed, never hidden
  offerPrograms: Program[];
  programCount: number;
  eligibleProgramCount: number;
  areaLabel: string;
}

export interface DetailsService {
  getProgramDetailPage(input: ProgramDetailInput): Promise<ProgramDetailPage | undefined>;
  getProviderStorefrontPage(input: ProviderStorefrontInput): Promise<ProviderStorefrontPage | undefined>;
}
```

Mock implementation: `MockDetailsService` (constructor `delayMs = 300`, same inline delay pattern), pure sync cores `buildProgramDetailPage` / `buildProviderStorefrontPage` exported for direct unit testing (established pattern), `undefined` for unknown ids, joins done entirely in the service — screens never import raw arrays (docs/08 §8).

### 8.5 Explicitly deferred data

Review entries (summary rating + count only this milestone), multi-image galleries, real policy text, provider contact channels, live capacity, instructor bios/photos. Each waits on backend/provider onboarding; none blocks the evaluation-stage purpose.

## 9. Required states

### 9.1 Program Details

| State | Trigger / demo data |
|---|---|
| Default | `beginner-calisthenics` |
| Loading | 300 ms service delay; skeleton mirrors §3 shapes; back control renders immediately |
| Saved / unsaved | Heart toggle, `program:` favourite key |
| Selected child eligible | `?qa-scenario=household`, Adam + `junior-swim-squad` |
| Selected child ineligible | Adam + any `minimumAge: 16` program → §6.2 banner + recovery chips |
| Adult participant | `Me` + adult program → `Suitable for you`; `Me` + junior program → honest `Ages 6–12` reason |
| Ladies-only program | `ladies-strength`: badge + key-facts entry + suitability semantics unchanged |
| Offer / trial | Any of the 7 offer programs; badge + offer price line |
| Free program | The `kind: 'free'` community program → `Free` price block, CTA `Book free session` |
| Missing image | `AppImage` branded fallback (forced-decode QA limitation stands, as Home) |
| Missing instructor | Extras without `instructorName` → section absent |
| No available sessions | One program's extras `sessions: 'none'` → honest empty message |
| Weak availability | `spotsLeft` ≤ 4 → `4 places left` (real data, no fake urgency) |
| Offline / error | `?qa-fail=1` → `simulateFailure` → error card + `Retry` |
| Unknown deep link | `/program/does-not-exist` → `This program is no longer offered.` + `Browse activities` |

### 9.2 Provider Storefront

| State | Trigger / demo data |
|---|---|
| Default | `falcon` |
| Loading | Skeleton; back control immediate |
| Saved / unsaved | Heart toggle, `provider:` favourite key |
| Multiple branches | `blue-wave` (two Al Raha branches, §8.2) + branch selector filtering programs |
| One branch | Every other provider — single branch row, no selector |
| No eligible programs for child | Adam or Lina + an adult-only provider (e.g. the wellness provider) → §6.2 storefront recovery |
| Weak supply | A 1–2 program provider (e.g. `coastal-tennis`) — honest short list, no padding |
| No offers | Provider without offer programs → offers section collapses |
| Missing logo / image | No cover key → monogram banner (the design, not an error); `AppImage` fallback for covers |
| Offline / error | `?qa-fail=1` → error card + `Retry` |
| Unknown deep link | `/provider/does-not-exist` → `This provider is no longer on Himma.` + `Browse activities` |

## 10. Accessibility plan

- **Heading hierarchy**: program/provider title `accessibilityRole="header"`; each section title a header; logical reading order top-to-bottom.
- **Images**: primary image labelled with the program/provider name; decorative scrims hidden from screen readers; monogram banner labelled `{Provider name} logo placeholder`.
- **Save**: `accessibilityRole="button"` + `accessibilityState={{ selected }}` + label `Save {name}` / `Saved — double tap to remove`.
- **Suitability**: banner is a polite live region; participant-switch chips announce the resulting context (`Browsing as Me`); age ranges use `spokenAgeLabel` (`Ages six to twelve`, `Ages sixteen and up`).
- **Pricing**: labels expand abbreviations — `85 dirhams per session`, `450 dirhams per month`; never `AED`-only for screen readers.
- **Sessions**: informational list semantics (no selection this milestone, docs/09 §20.9); each occurrence labelled `Tuesday 5 August, 7:30 PM, 4 places left`.
- **Sticky CTA**: labelled `Book {program title}, 85 dirhams per session`; never obscured by or obscuring content (scroll padding accounts for CTA height + insets).
- **Branch selector**: radio semantics; selected branch announced; sheet titled and dismissible per docs/16 §6.
- **Segmented controls / grouped lists**: tab roles with selected state where a segmented control is used.
- **Reviews summary**: single label `Rated 4.8 out of 5 from 124 reviews`.
- **Errors and recovery**: message then action in reading order; recovery actions are buttons.
- **Universal**: ≥ 44 × 44 pt targets (overlay icons get scrim chips + hitSlop), Dynamic Type tolerance (rows grow, `numberOfLines` on titles only, CTA text scales within a capped multiplier per docs/12 §4), reduced-motion parity, no color-only status anywhere (eligible/ineligible pair icon + text).

## 11. Native safety plan (docs/12 in full)

- Safe areas: overlay header controls inset by `insets.top`; sticky CTA bar padded by `insets.bottom` (home indicator); storefront content bottom-padded normally.
- Dock hidden structurally on both routes (root-level pushes, §2.1) — no fixed offsets, no per-screen flags.
- Android back: branch-selector sheet closes first (`onRequestClose`), then route pops; unknown-id and error states also pop normally.
- iOS swipe-back enabled on both routes.
- Nested scrolling: `More from provider` and offer rails are horizontal `ScrollView`s inside the vertical scroll (existing carousel rules); session list is vertical (no nested-vertical-scroll traps).
- Sheets: branch selector reuses the hand-built Modal pattern (backdrop tap, Android back, bottom inset, reduced-motion fade) — no new sheet dependency.
- Keyboard: neither screen has text input; nothing to avoid. (Report/support is an inert contract.)
- No DOM APIs, no hover dependencies, no browser storage; share uses React Native `Share`.
- Orientation tolerance: flex layouts, no fixed image heights beyond aspect ratios, CTA bar width-fluid.
- **Native validation remains pending** (no Xcode on this machine); both screens ship native-safe, web-reviewed, and are reported at approval levels 1–2 only.

## 12. Tests, QA, and screenshots

### 12.1 Unit tests (jest, service-first; `*.test.ts` convention)

`src/services/__tests__/details.test.ts`:
- program lookup returns a complete page for every one of the 36 ids (extras coverage invariant); provider lookup likewise for all 11.
- unknown program/provider id → `undefined` (screen recovery precedent).
- provider-program relationship: every page's `programGroups` exactly partition the provider's catalogue programs; `moreFromProvider` excludes self, caps at 4, deterministic order.
- taxonomy join: storefront `categories` derive from programs, never from the free-text strings.
- age eligibility: child context marks correct programs ineligible (never hidden); adult context never gender-filters; `everyone` yields no per-person suitability.
- multi-branch: `blue-wave` returns 2 branches; `branchId` filters groups; single-branch providers return the implicit branch.
- session derivation: offsets within 0–13, `Today` labelling, `sessions: 'none'` override, `spotsLeft` passthrough, determinism (two calls identical).
- policy resolution: every `policyId` resolves to a preset.
- `simulateFailure` throws the QA-only error.

`src/utils/__tests__/eligibility.test.ts` (extend): `participantSuitability` reasons for child in/out of range, open-ended ranges, `allAges`, adult on junior program; `householdSuitability` ordering.

`src/features/details/__tests__/detail-navigation.test.ts`: `crossLinkAction` back-vs-push matrix (provider→program→same provider ⇒ back; distinct ⇒ push; undefined previous ⇒ push); href builders.

`src/state/__tests__/favourites.test.ts` (new): keyed toggling, kind isolation (`program:x` vs `provider:x`), existing-call-site semantics preserved.

Also in Commit 9: price-label formatting for all seven `PriceModel` kinds, and share-URL generation (`https://himma.app/program/[id]` / `.../provider/[id]` — no `himma://`).

### 12.2 Navigation / QA (Playwright over Expo web, 390 × 844 + 360 × 780)

`scripts/qa/details-review.mjs`:
- Home → program card → Program Details → back lands on Home (exact origin).
- Results (query + filter + page 2) → program → back: results session intact (query, tab, filters, Load-more page preserved).
- Discover → provider → program → provider link resolves via back (no third route); assert no duplicate routes after double-tap.
- Search provider suggestion → storefront directly.
- Category/activity-type card activation both kinds.
- Child ineligible banner + recovery chip switches context explicitly (assert visible context change, no silent switch).
- Storefront branch switch filters programs; child-context ineligible grouping.
- Save state survives navigating away and back (session persistence) for both kinds.
- Deep links: unknown ids show recovery states; cold-start back control lands on `/discover`.
- Error states via `?qa-fail=1`; zero console errors; no horizontal overflow.

### 12.3 Screenshot matrix (saved to `artifacts/details-review/`)

Every row is captured at **both 390 × 844 and 360 × 780** (`-390` / `-360` filename suffixes):

| # | Capture |
|---|---|
| 01 | Program Details — adult program, default (top/mid/bottom) |
| 02 | Program Details — child context, eligible (suitability line + age badge) |
| 03 | Program Details — child-ineligible banner + recovery chips |
| 04 | Program Details — Ladies-only program |
| 05 | Program Details — offer/trial program |
| 06 | Program Details — free program + no-sessions state |
| 07 | Program Details — sticky CTA over scrolled content |
| 08 | Provider Storefront — default (top/mid/bottom) |
| 09 | Provider Storefront — multi-branch + selector |
| 10 | Provider Storefront — child context (eligible grouping + ineligible group) |
| 11 | Provider Storefront — weak supply |
| 12 | Missing-image / monogram fallback (both surfaces) |
| 13 | Error + retry, unknown-id recovery (both surfaces) |
| 14 | Program → Provider flow pair (program provider-row, then storefront) |

## 13. Commit sequence

### Commit 9 — `feat(program-details): implement program evaluation page`

- **Scope**: domain additions (§8.1), `program-details.ts` + `policies.ts` extras (+ the provider-extras subset the program page needs: branches for `blue-wave`), session derivation, `DetailsService` contract declared in full with `getProgramDetailPage` implemented (`getProviderStorefrontPage` is implemented in Commit 10 — the contract exists from day one so Commit 10 adds no contract churn), suitability helpers, `/program/[programId]` route, program-details feature (screen, skeleton, detail header, key-facts strip, suitability banner, session list, policy summary, sticky CTA), `detail-navigation.ts`, program-card activation on Home / Discover / Results / Category / Activity-type.
- **Files**: create `src/app/program/[programId].tsx`, `src/features/details/program-details-screen.tsx` + components + `detail-navigation.ts`, `src/services/contracts/details.ts`, `src/services/mock/mock-details-service.ts`, `src/data/mock/program-details.ts`, `src/data/mock/policies.ts`; modify `src/types/domain.ts`, `src/utils/eligibility.ts`, the five card-hosting screens, `program-card.tsx` / `compact-program-row.tsx` (onPress prop).
- **Tests**: details service (program half), eligibility presentation, detail-navigation, data invariants; all existing suites green.
- **Screenshots**: matrix rows 01–07 provisional.
- **Stop line**: tsc / eslint / jest / expo-doctor green, QA program-path script green, report — then stop for owner review of the Program Details design before Commit 10.

### Commit 10 — `feat(provider-storefront): implement provider evaluation page`

- **Scope**: `provider-details.ts` extras complete, storefront builder + `getProviderStorefrontPage`, `/provider/[providerId]` route, storefront feature (screen, skeleton, identity header, monogram, branch selector sheet, program groups, ineligible grouping), favourites keyed refactor (§5) across all call sites, provider-card activation (Discover / Results / Category / Activity-type / Search suggestion), Program ↔ Provider cross-links live both directions, `mapOrigins` + `provider` origin.
- **Files**: create `src/app/provider/[providerId].tsx`, `src/features/details/provider-storefront-screen.tsx` + components, `src/data/mock/provider-details.ts`; modify `src/state/favourites-context.tsx` + five host screens, `provider-card.tsx` / `compact-provider-row.tsx`, `search-screen.tsx`, `src/features/map/map-navigation.ts`.
- **Tests**: details service (storefront half), favourites keyed suite, updated navigation tests; all suites green.
- **Screenshots**: matrix rows 08–12 provisional.
- **Stop line**: checks green, QA storefront script green, report — stop for owner review.

### Commit 11 — `chore(details-review): connection, states, and review pass`

- **Scope**: full state sweep for §9 (both tables), accessibility pass (§10 verified per screen), duplicate-route/double-tap hardening, deep-link and error polish, complete `details-review.mjs` QA suite, full screenshot matrix (incl. 360-width set and flow pair), HANDOFF.md update, milestone report with docs/12 three-level status per surface (design ✅ via this doc once approved · frontend pending owner review · native pending).
- **Files**: polish-only edits in `src/features/details/*`, `scripts/qa/details-review.mjs`, `artifacts/details-review/*`, `HANDOFF.md`.
- **Tests**: full jest, tsc, eslint, expo-doctor, all QA scripts, zero console errors, no horizontal overflow.
- **Stop line**: milestone report delivered; stop for owner approval before any booking-flow work.

## 14. Product-owner decisions (approved 2026-08-03 — recorded in docs/09 §20)

All §14 items were resolved by the owner when this plan was approved:

1. **Book CTA** — production-ready Book button with press feedback, inert until the Booking milestone. No fake booking-preview, session-selection, checkout, or payment sheet.
2. **Provider name inside program cards** — non-interactive; no nested pressables. Approved path: Program card → Program Details → Provider row → Provider Storefront.
3. **Reviews** — summary only (rating + review count); no written review content, no invented testimonials.
4. **Cancellation policies** — the three mock-only presets in §8.2; no partial-refund maths, wallet-credit rules, provider penalties, or exception policies. Final wording comes from provider onboarding and backend configuration.
5. **Share** — native share where supported with placeholder canonical URLs `https://himma.app/program/<id>` / `https://himma.app/provider/<id>`; Web Share + copy-link fallback on web; no `himma://` links in shared content yet.
6. **Branch model** — Blue Wave multi-branch extras approach approved; no appended catalogue programs; 36 programs / 11 providers stand.
7. **Map pins** — pin → storefront activation deferred; the schematic map stays area-based with no undersized pin actions.
8. **Gift action** — deferred to the Gifts milestone; no active Gift action on Program Details.
9. **Available sessions** — informational only (date, time, branch, availability where supported); no persisted selection or implied transaction while Book is inert.

## 15. Contradiction review

Reviewed against docs/02, 04, 05, 08, 09, 12, 14, 15, 16, 17, 18, 19, HANDOFF.md:

| Document | Point | Resolution |
|---|---|---|
| docs/04 §5 HMA-014 | "The provider name on a program card should open this screen" | Nested interactive controls are invalid on native (constraint recorded at `program-card.tsx:68`). Card body → Program Details; provider row there → storefront. Open decision §14.2. |
| docs/04 §5 HMA-015 | Lists Gift action and Program Details → Gifts connection | Deferred to the Gifts milestone; open decision §14.8. No other HMA-015 content item is dropped (capacity/availability = sessions + places-left). |
| docs/04 §2 / docs/16 §6 | Dock hidden on "focused transactional flows" vs detail routes | docs/16 §6 already extends hiding to detail flows; root-level routes implement it structurally. Consistent — no doc change needed. |
| docs/15 §4.1 concrete-path note | Catalogue surfaces carry `/discover/` prefix to keep the dock | Detail surfaces are not browsing surfaces; they sit at root, matching the logical contracts `/program/[programId]` / `/provider/[providerId]` exactly. The note's scope ("catalogue browsing surfaces") already excludes them. |
| docs/14 §5 / §12, docs/15 §9, docs/17 §1 | "Storefront lists its programs — future milestone", storefront/details excluded | That future milestone is this one; exclusions were milestone-2-scoped, not permanent. Superseded by milestone progression, not contradicted. |
| docs/16 §2 | Provider/program-unavailable states are "contract-level (detail screens don't exist)" | Contracts now implemented as the unknown-id states (§9); wording (`This program is no longer offered.` / `This provider is no longer on Himma.`) reused verbatim. |
| docs/18 §7 | Discover exclusively owns the provider directory; Home has no provider cards | Activation matrix honors it: no provider-card origin on Home; providers reach Home only inside program cards (non-interactive name) and future booking cards. |
| docs/02 §2 | Guests may view providers and programs | Both pages render for guests; suitability lines require participants and simply don't render; save stays session-local (auth gating arrives with the account milestone, consistent with current favourites). |
| docs/05 §7 / docs/16 §4 | Child hard-exclusion by age in child context | Detail surfaces deliberately *show* ineligible programs with honest labelling (storefront collapsed group, details recovery banner) rather than hiding them — evaluation surfaces explain eligibility (docs/04 HMA-019 principle: never hide the reason). List surfaces keep hard exclusion unchanged. Recorded as a refinement, not a conflict. |
| docs/09 §7, §15 | Refund model and reviews are open decisions | Mock-only policy presets and summary-only reviews; §14.3/§14.4 keep them owner-visible. No permanent rule invented. |
| docs/19 §10 | "Program details, provider storefronts … remain out of scope" | Scoped to the `feat(home)` commit's exit criteria; that milestone is closed. No conflict. |
| HANDOFF.md | 8b row "awaiting owner sign-off"; storefront/details listed as do-not-start | Owner closed the milestone at `ec79c7d`; HANDOFF updated alongside this plan to record closure and name this planning document as current. |
| docs/08, docs/12 | Route grouping, engineering and native rules | docs/08 §4 already places `program/` and `provider/` at the app root — supports §2.1. No conflicts found. |

## 16. Exit criteria (milestone)

1. Both routes resolve per docs/15 §4.1 with every §2.4 origin activated and every §9 state demonstrable deterministically.
2. Exact-origin back everywhere; no duplicate detail routes from one navigation action; results session preserved on return; cold deep links recover.
3. One favourites system covering programs and providers; one participant state; no silent participant switching.
4. Catalogue byte-identical: 36 programs, 11 providers, original order; all new data in extras modules.
5. §10 accessibility and §11 native-safety requirements verified per screen; native validation reported as pending.
6. tsc, eslint, jest (grown suite), expo-doctor, all QA scripts green; zero console errors; screenshot matrix complete.
7. Three commits as §13 with a stop-and-report after each; milestone report states the docs/12 three-level status per surface.
