# 19 — Home Rework Implementation Brief (`feat(home)`)

Status: prepared for product-owner approval. No Home code changes until the owner approves this brief. Governing specs: docs/18 (differentiation + §6 child-dependent visibility), docs/09 §19, docs/11 §7/§9/§10/§11 (still in force), docs/12 (native), docs/05 §9 + docs/09 §18 (rule-based recommendations).

**Goal:** rebuild Home as the personalized, schedule-aware activity hub defined in docs/18 §4, add the child-dependent collection visibility gate to Home and the default Discover feed, and keep every approved visual token, card, and Discover surface otherwise unchanged.

**Architecture:** a new `AccountProvider` supplies the dynamic participant list, deterministic mock bookings/plans, and the review scenario (docs/18 §9 A–D); a rewritten `HomeFeedService` assembles a typed, ordered section list from pure, unit-tested build functions; the Discover feed service gains one account-composition input for the §6 gate. Screens keep consuming services only — no raw arrays.

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
| `src/state/account-context.tsx` | `AccountProvider`: scenario, participants, childParticipants, bookings, plans, credit |
| `src/features/home/upcoming-activity-card.tsx` | Lead card: program, participant, day/time, provider, area |
| `src/features/home/week-strip.tsx` | Compact 7-day schedule preview |
| `src/features/home/plan-card.tsx` | Routine card with progress line + next session |
| `src/features/home/home-action-card.tsx` | Lightweight action card (welcome/setup, add-child) — one component, variants by props |

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
  | { kind: 'action'; id: 'setup' | 'add-child'; title: string; body: string }
  | { kind: 'credit'; credit: CreditSummary };

export interface HomeFeedInput { areaId: AreaId; scenario: AccountScenarioId; }
export interface HomeFeed { sections: HomeSection[]; }

export interface HomeFeedService {
  getHomeFeed(input: HomeFeedInput): Promise<HomeFeed>;
  getAreas(): Area[];
}
```

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

**Interests** (docs/09 §18.3): Sarah — Calisthenics, Pilates, Padel; Adam — Swimming, Football, Robotics; Lina — Coding, Art, Languages. Stored as activity-type ids on the participant records.

**Collections:** `childFocused: true` on `kids-teens`, `after-school`, `camps`; `false` on `ladies-only`, `beat-the-heat`, and any other adult/general entry.

## 5. Feed assembly rules (`buildHomeFeed`)

Pure, synchronous, fully unit-tested. Section order = docs/18 §4. Per scenario:

1. `welcome` — guest only (reuses hero card language; seasonal copy, no fabricated personalization).
2. `upcoming` — earliest `ScheduleEntry` across all participants; omitted when no bookings.
3. `week` — only days with ≥ 1 entry render rows in the strip; section omitted when no bookings.
4. `plans` — active plans; omitted when none.
5. Program sections, each built with eligibility → interests → docs/05 §9 ranking, budgets ≈ 3–5 cards, omitted below the docs/18 §5 minimums:
   - `Based on your interests` (primary participant; all non-guest scenarios).
   - Per additional profile, in account order: `For {name}` (age-eligibility first); plus at most one supplemental rail `After school for {name}` or `Camps for {name}` only when ≥ 2 age-eligible matches exist (docs/18 §5.1) — supplemental rails are inherently child-gated (§6) because they derive from a real child profile.
   - `Popular near {area}` — guest and `me-only` only (discovery useful without history).
   - `Available today for you` (guest: `Available today`, area-scoped) — programs with today availability, scoped to household eligibility for non-guest scenarios.
   - `Offers for you` (guest: `Offers`) — 2–3 offer/trial cards, personalized ranking for non-guest.
6. `action` — guest: one `setup` card (interests/profiles invitation; inert until auth ships). `me-only`/`me-active`: one lightweight `add-child` card. Never rendered when child profiles exist; never imagery-led (docs/18 §6).
7. `credit` — all non-guest scenarios.

**Child-visibility on Home:** no section sourced from child-focused content may appear unless a child profile exists with age-eligible supply — enforced structurally (child rails derive from profiles) plus a guard test (§7).

**Discover gate (`buildFeed` change):** a `childFocused` collection renders only when `childParticipants.length > 0` **and** its preset resolves to ≥ 1 program age-eligible for ≥ 1 of those children. Existing participant-context and supply-threshold rules compose unchanged (docs/16 §4, docs/14 §13). Guest: chip row hidden when the participant list is empty; collections follow the docs/18 §18 temporary assumption (unfiltered).

## 6. Screen and components

- `home-screen.tsx` renders `feed.sections` with a `kind`-switch — no scenario/participant conditionals in the screen; the service decides everything.
- New components compose existing primitives (`AppImage`, `SectionHeader`, `PressableFeedback`, card surfaces/tokens). Upcoming card is prominent but calm (no countdown, no urgency). Week strip rows: day label · time · participant · short title; rows grow with Dynamic Type.
- Inert taps with press feedback: upcoming card + week strip (→ future Bookings), plan card (→ future plan detail), action cards, credit strip. Program cards stay inert per docs/09 §17.2.
- `home-skeleton.tsx` mirrors the new shapes; header/dock render immediately; reduced-motion safe.
- Accessibility: cards labelled (“Upcoming activity: Junior Swim Squad for Adam, today at 10:00 AM, Blue Wave Swimming”); week strip is a labelled list; all targets ≥ 44 pt.

## 7. Test plan (write failing tests first, per step)

Home feed core (`buildHomeFeed`):
- household: exact section order per docs/18 §4; `For Adam` and `For Lina` generated from the profile list.
- dynamic labels: synthetic account with one child `Lena` → `For Lena`; child `Omar` with camp-eligible age → `Camps for Omar`. No test relies on demo names for logic.
- `me-only`: no upcoming/week/plans; **no camps, after-school, or Kids & Teens content anywhere**; no child-implying prompts; `add-child` action present and last-before-credit.
- `me-active`: upcoming + week + plans appear with Sarah-only entries.
- guest: welcome + popular-near + available-today + offers + setup action only; no credit, no fabricated data.
- child with no age-eligible supply (synthetic dob 2023 → age 3): no `For {name}` supplemental camp rail, and no child-focused sections for that child.
- removing the last child from the input removes every child-focused section.
- rail minimums: 1-card base rail renders; supplemental rail with 1 match does not.

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
- [ ] 3. `AccountProvider` + `ParticipantProvider` derivation + root mounting; provider unit tests (scenario → participant lists; guest → empty).
- [ ] 4. Home feed contract v2 + `buildHomeFeed` + full §7 Home test matrix.
- [ ] 5. Discover gate: input change + `buildFeed` visibility rule + §7 Discover tests; update `discover-screen` call site to pass `childParticipants`.
- [ ] 6. Components (`upcoming-activity-card`, `week-strip`, `plan-card`, `home-action-card`) — tokens only.
- [ ] 7. Rewrite `home-screen.tsx` + `home-skeleton.tsx`; wire `?qa-scenario`.
- [ ] 8. QA script: scenario matrix (A–D renders, forbidden-section assertions for `me-only`, child-visibility on Discover default feed), `visible=true` locator rule, `clearDevOverlay()` before dock taps.
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
