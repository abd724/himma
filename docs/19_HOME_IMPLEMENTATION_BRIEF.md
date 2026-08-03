# 19 — Home Rework Implementation Brief (`feat(home)`)

Status: prepared for product-owner approval. No Home code changes until the owner approves this brief. Governing specs: docs/18 (differentiation + §6 child-dependent visibility), docs/09 §19, docs/11 §7/§9/§10/§11 (still in force), docs/12 (native), docs/05 §9 + docs/09 §18 (rule-based recommendations).

**Goal:** rebuild Home as the personalized, schedule-aware activity hub defined in docs/18 §4, add the child-dependent collection visibility gate to Home and the default Discover feed, and keep every approved visual token, card, and Discover surface otherwise unchanged.

**Architecture:** a new `AccountProvider` resolves the review scenario (docs/18 §9 A–D, `?qa-scenario`) into plain account data — participants, schedule entries, plans, credit; a rewritten `HomeFeedService` assembles a typed, ordered section list via a pure, unit-tested `buildHomeFeed(HomeFeedBuildInput)` that consumes only that resolved data (scenario ids never reach the domain layer); the Discover feed service gains one account-composition input for the §6 gate. Screens keep consuming services only — no raw arrays.

**One commit:** `feat(home): rebuild Home as personalized activity hub` (docs/17 step 8a). Checks green before commit; stop-and-report after. The final `chore(review)` commit follows separately.

## 1. Global constraints (apply to every step)

- Visual system untouched: Orbit Indigo tokens, typography roles, dock, card anatomies, spacing, imagery (docs/07, docs/11 §7). No raw hex in screens.
- Dynamic participant model: no logic branches on `Sarah`/`Adam`/`Lina` or collection titles; no layout assumes a participant count (docs/18 §3, §15).
- All dates from `MOCK_TODAY` (2026-08-02, a Sunday) in `src/utils/eligibility.ts` — never the device clock.
- Catalogue frozen: 36 programs / 11 providers, first-21 order stability, bookings reference existing programs only (HANDOFF).
- No customer-facing developer wording, phase labels, or Coming Soon surfaces; inert taps keep press feedback only (docs/09 §17.2).
- Native-safe per docs/12: safe areas, ≥ 44 × 44 targets, Dynamic Type tolerance, reduced-motion parity, carousels inside native vertical scroll. Native validation stays “pending” (no Xcode on this machine).
- Deterministic services behind typed contracts (docs/08 §8); sync build cores are the unit-test surface (established pattern).

## 2. File map

**Create**

| File | Responsibility |
|---|---|
| `src/services/contracts/schedule.ts` | Schedule/plan types + `ScheduleService` contract |
| `src/data/mock/schedule.ts` | Deterministic demo bookings, active plans, scenario definitions |
| `src/services/mock/mock-schedule-service.ts` | `ScheduleService` implementation + pure `buildWeek` core |
| `src/state/account-context.tsx` | `AccountProvider`: resolves the `?qa-scenario` fixture once and exposes the resolved account data (participants, childParticipants, schedule entries, plans, credit) |
| `src/features/home/upcoming-activity-card.tsx` | Lead card: program, participant, day/time, provider, area |
| `src/features/home/week-strip.tsx` | Compact 7-day schedule preview |
| `src/features/home/plan-card.tsx` | Routine card with progress line + next session |
| `src/features/home/home-action-card.tsx` | Guest welcome/setup action card (no add-child variant — docs/18 §6, docs/09 §19.6) |

**Modify**

| File | Change |
|---|---|
| `src/types/domain.ts` | Add `interests` to `Participant` (if absent), `childFocused: boolean` to the collection type |
| `src/data/mock/catalogue.ts` | Mark `kids-teens`, `after-school`, `camps` collections `childFocused: true`; others `false`. Append-only; program order untouched |
| `src/services/contracts/home-feed.ts` | Replace feed shape with the §3 section-list contract |
| `src/services/mock/mock-home-feed-service.ts` | Rewrite around pure `buildHomeFeed(input)` |
| `src/services/contracts/discover-feed.ts` + `src/services/mock/mock-discover-feed-service.ts` | Add `childParticipants` input; apply the §6 visibility gate to child-focused collections |
| `src/state/participant-context.tsx` | Derive participants from `AccountProvider` instead of importing the catalogue array |
| `src/app/_layout.tsx` | Mount `AccountProvider` above `ParticipantProvider` |
| `src/features/home/home-screen.tsx`, `home-skeleton.tsx` | Rewrite to the docs/18 §4 hierarchy |
| `scripts/qa/home-review.mjs` (or create if the Home script has another name — reuse the existing Home QA entry point) | Scenario-matrix checks via `?qa-scenario` |
| Existing home-feed and discover-feed test suites | Rewrite/extend per §7 |

**Do not touch:** search, results, catalogue pages, map, filter/sort sheets, dock component, all approved card components.

## 3. Contracts (exact)

```ts
// src/services/contracts/schedule.ts
export type AccountScenarioId = 'guest' | 'me-only' | 'me-active' | 'household';

/** Display-ready schedule entry; joins are done in the service, never in screens. */
export interface ScheduleEntry {
  id: string;
  programId: string;
  /** 0–6 relative to MOCK_TODAY; the week window is exactly these 7 days. */
  dayOffset: number;
  dayLabel: string;        // 'Today' | 'Mon 3' | …
  timeLabel: string;       // '10:00 AM'
  participantId: string;
  participantLabel: string; // 'You' for the primary participant, else profile name
  programTitle: string;
  providerName: string;
  areaLabel: string;
}

export interface ActivePlan {
  id: string;
  programId: string;
  participantId: string;
  participantLabel: string;
  kind: 'package' | 'membership' | 'recurring';
  programTitle: string;
  providerName: string;
  progressLabel: string;   // '6 of 10 sessions left'
  nextSessionLabel: string; // 'Wed, 6:30 PM'
}

export interface ScheduleService {
  getUpcomingActivity(scenario: AccountScenarioId): Promise<ScheduleEntry | null>;
  getWeekSchedule(scenario: AccountScenarioId): Promise<ScheduleEntry[]>;
  getActivePlans(scenario: AccountScenarioId): Promise<ActivePlan[]>;
}
```

```ts
// src/services/contracts/home-feed.ts (replaces the current HomeFeed shape)
export type HomeSection =
  | { kind: 'welcome'; content: HeroContent }                  // guest only
  | { kind: 'upcoming'; entry: ScheduleEntry }
  | { kind: 'week'; days: WeekDay[] }                          // WeekDay = { dayOffset; dayLabel; entries: ScheduleEntry[] }
  | { kind: 'plans'; plans: ActivePlan[] }
  | { kind: 'programs'; id: string; title: string; programs: Program[] }
  | { kind: 'action'; id: 'setup'; title: string; body: string }   // union stays extensible; only 'setup' (guest) is emitted this commit
  | { kind: 'credit'; credit: CreditSummary };

export interface AccountSnapshot {
  primaryParticipantId: ParticipantId;
}

/** The real feed domain input: resolved account data only — never scenario ids. */
export interface HomeFeedBuildInput {
  areaId: AreaId;
  /** null = guest (no account). */
  account: AccountSnapshot | null;
  /** Primary participant first, then additional profiles in account order. Empty for guest. */
  participants: Participant[];
  scheduleEntries: ScheduleEntry[];
  activePlans: ActivePlan[];
  credit?: CreditSummary;
}

export interface HomeFeed { sections: HomeSection[]; }

export interface HomeFeedService {
  getHomeFeed(input: HomeFeedBuildInput): Promise<HomeFeed>;
  getAreas(): Area[];
}
```

**Data flow (fixture vs domain):** `?qa-scenario` → deterministic mock account fixture (`AccountProvider`) → `HomeFeedBuildInput` → pure `buildHomeFeed()`. `AccountScenarioId` exists only in the fixture layer and the `ScheduleService` mock API; the screen, `HomeFeedService`, and `buildHomeFeed` never see or branch on scenario names — every behavioral difference derives from the resolved data (null account, empty participants, empty schedule, missing credit).

`getParticipants()` and `getQuickFilters()` leave the Home contract (participants move to `AccountProvider`; Home has no quick filters). Discover keeps its own quick-filter source unchanged.

```ts
// src/services/contracts/discover-feed.ts — input gains account composition
export interface DiscoverFeedInput {
  areaId: AreaId;
  participantId: ParticipantId;
  quickFilterId?: QuickFilterId;
  /** Account composition for the docs/18 §6 visibility gate. Empty for guest/me-only. */
  childParticipants: Participant[];
}
```

## 4. Deterministic mock data

`MOCK_TODAY` = Sunday 2026-08-02. Week window = day offsets 0–6 (Sun 2 → Sat 8 Aug).

**Demo household bookings** (`household` / trimmed for other scenarios), referencing existing programs; time labels must match each program's catalogue `scheduleLabel` (verify at implementation, then freeze):

| Participant | Program (provider) | Sessions (dayOffset · time) |
|---|---|---|
| Adam | Junior Swim Squad (Blue Wave Swimming) | 0 · 10:00 AM ← **Upcoming activity** (“Today, 10:00 AM”); 6 · 10:00 AM |
| Lina | Teen Coding Summer Camp (Future Makers Robotics) | 1–4 · mornings, per the program's schedule label |
| Sarah | Reformer Pilates Foundations (Core Pilates House) | 1 · 6:30 PM; 3 · 6:30 PM |

**Active plan:** Sarah — Reformer Pilates Foundations package, `6 of 10 sessions left`, next `Mon, 6:30 PM`.

**Scenarios** (docs/18 §9; selected via `?qa-scenario=`, default `household`):

| Id | Participants | Bookings/plans | Credit |
|---|---|---|---|
| `guest` | none | none | none |
| `me-only` | Sarah | none | yes |
| `me-active` | Sarah | Sarah's sessions + plan | yes |
| `household` | Sarah, Adam (8), Lina (12) | full set | yes |

Scenarios are **fixture selection only**: each id maps to a deterministic fixture that `AccountProvider` resolves into a `HomeFeedBuildInput`. No screen, service, or builder branches on scenario ids (§3 data flow).

**Interests** (docs/09 §18.3): Sarah — Calisthenics, Pilates, Padel; Adam — Swimming, Football, Robotics; Lina — Coding, Art, Languages. Stored as activity-type ids on the participant records.

**Collections:** `childFocused: true` on `kids-teens`, `after-school`, `camps`; `false` on `ladies-only`, `beat-the-heat`, and any other adult/general entry.

## 5. Feed assembly rules (`buildHomeFeed`)

Pure, synchronous, fully unit-tested. Section order = docs/18 §4. Every condition reads the **resolved input data**, never a scenario id:

1. `welcome` — `account === null` (reuses hero card language; seasonal copy, no fabricated personalization).
2. `upcoming` — earliest `ScheduleEntry`; omitted when `scheduleEntries` is empty.
3. `week` — only days with ≥ 1 entry render rows in the strip; section omitted when `scheduleEntries` is empty.
4. `plans` — omitted when `activePlans` is empty.
5. Program sections, each built with eligibility → interests → docs/05 §9 ranking, budgets ≈ 3–5 cards, omitted below the docs/18 §5 minimums:
   - `Based on your interests` — `account !== null` (primary participant's declared interests).
   - Per additional profile in `participants` order: `For {name}` (age-eligibility first); plus at most one supplemental rail `After school for {name}` or `Camps for {name}` only when ≥ 2 age-eligible matches exist (docs/18 §5.1) — supplemental rails are inherently child-gated (§6) because they derive from a real child profile.
   - `Popular near {area}` — `scheduleEntries.length === 0` (discovery aid without history; yields once real schedule content exists, docs/18 §9 C).
   - `Available today for you` (`Available today` when `account === null`, area-scoped) — programs with today availability, scoped to household eligibility when participants exist.
   - `Offers for you` (`Offers` when `account === null`) — 2–3 offer/trial cards, personalized ranking when participants exist.
6. `action` — `account === null` only: one `setup` card (interests/profiles invitation; inert until auth ships). **No `add-child` card is ever emitted** (docs/18 §6, docs/09 §19.6): signed-in feeds contain no child-related prompt regardless of account composition; participant creation belongs to future Profile/onboarding.
7. `credit` — when `credit` is provided (fixtures provide it for signed-in accounts only).

**Child-visibility on Home:** no section sourced from child-focused content may appear unless a child profile exists with age-eligible supply — enforced structurally (child rails derive from profiles) plus a guard test (§7).

**Discover gate (`buildFeed` change):** a `childFocused` collection renders only when `childParticipants.length > 0` **and** its preset resolves to ≥ 1 program age-eligible for ≥ 1 of those children. Existing participant-context and supply-threshold rules compose unchanged (docs/16 §4, docs/14 §13). Guest: chip row hidden when the participant list is empty; collections follow the docs/18 §18 temporary assumption (unfiltered).

## 6. Screen and components

- `home-screen.tsx` composes `HomeFeedBuildInput` from `AccountProvider` + `AreaProvider` as a pure pass-through, then renders `feed.sections` with a `kind`-switch — no scenario or participant conditionals in the screen; the builder decides everything from data.
- New components compose existing primitives (`AppImage`, `SectionHeader`, `PressableFeedback`, card surfaces/tokens). Upcoming card is prominent but calm (no countdown, no urgency). Week strip rows: day label · time · participant · short title; rows grow with Dynamic Type.
- Inert taps with press feedback: upcoming card + week strip (→ future Bookings), plan card (→ future plan detail), action cards, credit strip. Program cards stay inert per docs/09 §17.2.
- `home-skeleton.tsx` mirrors the new shapes; header/dock render immediately; reduced-motion safe.
- Accessibility: cards labelled (“Upcoming activity: Junior Swim Squad for Adam, today at 10:00 AM, Blue Wave Swimming”); week strip is a labelled list; all targets ≥ 44 pt.

## 7. Test plan (write failing tests first, per step)

Home feed core (`buildHomeFeed`) — every test calls the **pure builder directly with a hand-built `HomeFeedBuildInput`**, never through scenario ids or the QA resolver:
- three-participant input (demo fixture data): exact section order per docs/18 §4; `For Adam` and `For Lina` generated from the participant array.
- dynamic labels with arbitrary names: one synthetic child `Lena` → `For Lena`; child `Omar` with camp-eligible age → `Camps for Omar`. No test relies on demo names for logic.
- zero-child signed-in input, no bookings: no upcoming/week/plans; **no camps, after-school, or Kids & Teens content anywhere; no child-implying prompt and no `add-child`/setup card of any kind**; popular-near present.
- zero-child signed-in input with bookings/plan: upcoming + week + plans appear; popular-near absent; still **no child-focused content and no child-related prompt**.
- guest input (`account: null`, empty participants): welcome + popular-near + available-today + offers + setup action only; no credit, no fabricated data.
- multiple synthetic children: one `For {name}` rail per child, in participant order.
- child with no age-eligible supply (synthetic dob 2023 → age 3): no supplemental camp rail, and no child-focused sections for that child.
- removing the last child from the input (same input minus the child) removes every child-focused section.
- rail minimums: 1-card base rail renders; supplemental rail with 1 match does not.
- fixture resolver (separately, thin): each `AccountScenarioId` resolves to the §4 fixture as a `HomeFeedBuildInput`; resolver output feeds the same builder — no other code path.

Schedule core (`buildWeek` / upcoming):
- upcoming = offset-0 10:00 AM entry, labelled `Today`; week strip contains only days with entries; all offsets within 0–6; every `programId` resolves in the catalogue.

Discover feed (`buildFeed`):
- `childParticipants: []` → `camps`, `after-school`, `kids-teens` absent from collections; adult collections unchanged.
- one eligible child → child-focused collections with eligible supply appear.
- child present but zero age-eligible supply for a given collection → that collection hidden.
- no branching on collection titles (gate reads `childFocused` only — assert via a synthetic `childFocused` collection).

All existing suites (search, results, catalogue, map) must pass unchanged; jest total grows from 104.

## 8. Implementation sequence (each step: failing test → minimal code → green)

- [ ] 1. Domain + data: add `interests`/`childFocused` types, `src/data/mock/schedule.ts`, collection flags. Data-invariant tests (program refs resolve, offsets 0–6, scenario definitions complete).
- [ ] 2. Schedule contract + `MockScheduleService` with pure cores; tests above.
- [ ] 3. `AccountProvider` (`?qa-scenario` → fixture → resolved account data) + `ParticipantProvider` derivation + root mounting; resolver unit tests (fixture → participant lists/entries/plans; guest → null account, empty lists).
- [ ] 4. Home feed contract v2 (`HomeFeedBuildInput`) + pure `buildHomeFeed` + full §7 Home test matrix (direct builder-input tests).
- [ ] 5. Discover gate: input change + `buildFeed` visibility rule + §7 Discover tests; update `discover-screen` call site to pass `childParticipants`.
- [ ] 6. Components (`upcoming-activity-card`, `week-strip`, `plan-card`, `home-action-card`) — tokens only.
- [ ] 7. Rewrite `home-screen.tsx` + `home-skeleton.tsx`; wire `?qa-scenario`.
- [ ] 8. QA script: scenario matrix (A–D renders, forbidden-section assertions for `me-only`/`me-active` incl. no add-child/child-prompt cards, child-visibility on Discover default feed), `visible=true` locator rule, `clearDevOverlay()` before dock taps.
- [ ] 9. Web review at 390 and 360 widths, all four scenarios; fix visual/a11y issues found.
- [ ] 10. Screenshots: new Home baseline per scenario (`artifacts/home-review/`, re-baselined by design); Discover default (household) screenshots must stay **byte-identical** (the §6 gate is invisible in the default demo); other Discover-surface screenshots byte-identical.
- [ ] 11. Full checks: `npx tsc --noEmit` · `npx eslint src scripts --max-warnings=0` · `npx jest` · `npx expo-doctor` · all QA scripts · zero console errors.
- [ ] 12. Update HANDOFF.md; single commit `feat(home): rebuild Home as personalized activity hub` (+ Claude co-author line). **Stop and report** with the docs/12 three-level status (native validation: pending).

## 9. Risks and mitigations

- **Participant chips regressed on Discover** by the provider refactor → step 3 keeps `useParticipantContext`'s public shape identical; Discover QA scripts re-run in step 11.
- **Home regression baseline churn** — intentional; old baselines archived, new per-scenario set becomes the approved baseline on owner sign-off.
- **Hidden coupling to removed Home sections** (quick filters/context chips) → `getQuickFilters` removal is compile-checked by tsc; grep for dead imports before commit.
- **Week labels vs catalogue schedule labels drifting** → data-invariant test asserts each booking's `timeLabel`/day pattern is consistent with its program's `scheduleLabel`.

## 10. Exit criteria

Everything in docs/18 §17 (acceptance) and §15 (tests), checks green, screenshots captured, HANDOFF updated, one commit, report delivered — then stop for owner review. Program details, provider storefronts, Bookings, auth, and real scheduling remain out of scope.
