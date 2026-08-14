# W2-11 — Provider Portal Design-Partner Walkthrough (docs/23 §8.6 gate package)

**Status: walkthrough package prepared and internally preflighted (2026-08-14). The EXTERNAL design-partner gate is PENDING — no human design-partner session has taken place and none of its findings exist yet. Nothing in this document is participant feedback.**

---

## 1. Gate purpose (docs/23 §8.6, quoted exactly)

> Before the provider portal's final owner approval, its workflows must be validated with real prospective providers — the portal is the one surface we cannot design purely from our own product judgment, because its users run businesses we don't operate.
>
> - Recruit **5–8 design partners** covering the marketplace's representative shapes: a multi-branch sports academy, a ladies-only fitness studio, a swim school, a camps operator, an after-school learning/STEM provider, and a family-activity/wellness provider.
> - Method: structured discovery interviews on current tooling and catalogue shape → walkthroughs of the mock portal (PP-02→PP-11 journeys, §8.5 import with **their real spreadsheet data**, anonymized) → recorded findings → spec revisions.
> - Output: a findings report per partner cohort; portal spec amendments recorded as owner decisions.
> - **Gate:** final provider-portal approval (and therefore backend contract freeze for provider APIs) requires at least one completed design-partner walkthrough round with findings dispositioned. Recruitment terms/incentives are an owner decision (§18).

The question every session answers: **can a real provider understand and successfully operate the current provider-facing Himma flows without developer explanation, misleading states, or serious usability barriers?**

Out of scope for this gate: backend load testing · security penetration testing · final visual branding (provisional Orbit Indigo stands per docs/07) · customer-app testing · admin-portal testing.

## 2. Scope

The walkthrough covers the provider workflows implemented through W2-10, on the **production fixture build** (the same build the Playwright evidence uses — `VITE_PORTAL_AUTH_MODE=fixture npm run build && npm run preview` in `portal/`; nothing connects to a live backend and no data is real):

- **Access/session** — sign-in, MFA code entry, workspace loading (including the deliberate one-retry workspace hiccup on one demo account), organization switching, sign-out.
- **Onboarding/verification status** — the checklist, submitted/in-review/verified states, the truthful "Himma completes go-live" boundary.
- **Business profile** — private record vs public storefront, editing, publication flag, save behavior.
- **Branches** — list, create, edit, deactivate, branch-scoped visibility.
- **Team** — directory, invitations with roles/branch scopes, revoke, the revoke-and-reinvite role-change model, step-up prompts.
- **Listings** — index, detail, create, editor (details/eligibility/locations/pricing/photos metadata/offers), readiness.
- **Lifecycle/moderation** — submit, in-review lock, changes-requested loop, approved-but-unpublished, publication authority, pause/resume, archive, protected-edit (pending-review) behavior.
- **Dashboard** — organization status, catalogue counts, action items.
- **Bulk import preview** — instructions, template, column matching, validation, errors, valid-subset re-batch, and the explicit "nothing imported yet" boundary. Where the partner brings their own spreadsheet (per §8.6), it must be anonymized before the session and will be validated only — never imported.
- **Placeholder comprehension** — Schedule, Bookings, and Finance appear as honest future areas; the walkthrough verifies they read as "coming later", not as broken pages.

Not in the walkthrough (not implemented; do not script them): real schedules/sessions, bookings, attendance, finance/payouts, reports, real media upload, real import execution, admin moderation.

## 3. Facilitator guidance

- Read each task aloud exactly as written; then observe.
- Neutral clarification is fine ("what would you expect that to do?"); **teaching is not**: never point at buttons, name routes, or explain internal machinery (never say "ProgramRevision", "CAS", "fixture", or any database word).
- Let the participant get stuck for a reasonable moment before marking "needed help" — hesitation is data.
- Ask the participant to think aloud; capture their words, not your interpretation.
- If the participant is about to do something they believe is destructive, let the interface's own confirmation do its job — note whether they understood it.
- Sessions use a desktop/laptop browser (~1280–1440 wide). Tablet/mobile behavior was preflighted internally and does not need to be repeated by the partner unless they routinely manage their business from a phone — in that case run tasks 12–14 again on their device's browser and note differences.
- Do not collect personal information beyond what §16's form asks. Partner/company identity may be anonymized (e.g. "Partner 2 — swim school").

**Demo environment quick reference (facilitator only — never read to the participant):** all identities sign in with password `himma-demo` and, where asked for a verification code, `246810`. The businesses are FICTIONAL demo fixtures, not production data. Nadia's account intentionally fails its first workspace load once (a resilience state, recoverable with the on-screen retry) — treat the participant's reaction as signal about the error state's clarity, not as an environment failure.

## 4. Scenarios / personas

Exactly the approved provider roles (docs/23 §7, docs/24 §10.2); no invented roles. Owner and Organization Manager share one scenario (their portal authority is identical on every walkthrough surface except Team, which the Owner covers).

| Scenario | Sign-in | Role / business | Focus |
|---|---|---|---|
| **A — Owner** | `owner@bluewave.demo` (Rana) · plus one status task as `stages@himma.demo` (Huda) | Owner of Blue Wave Swimming (live, multi-branch swim academy); Huda owns several businesses mid-verification incl. Pearl Divers Freediving (verified, not yet live) | Organization operations end-to-end: branches, team, listings, lifecycle, publication, protected edits, dashboard, import preview, verification status |
| **B — Listings Editor** | `flaky@bluewave.demo` (Nadia) | Listings Editor at Blue Wave Swimming | Catalogue preparation and submission WITHOUT publication authority; the approved-but-unpublished boundary |
| **C — Branch Manager** | `manager@bluewave.demo` (Salem) | Branch Manager, Dubai Marina branch only | Branch-scoped reading/editing/import; understanding the scope limitation as intentional, not broken |

## 5. Task script

Tasks are read one at a time. Never mention where anything lives. Each task lists its observable success criteria (§8 defines the general bar; "no facilitator intervention" is implied everywhere).

### Scenario A — Owner (Rana, Blue Wave Swimming)

1. **"Sign in and get to the point where you can see how your business is doing on Himma."** — Completes sign-in + code; lands and recognizes the Dashboard as status ("what does this page tell you?" — expects org status, catalogue picture, team note).
2. **"Your business opened a new pool location in Jumeirah. Add it."** — Finds Branches → create; completes the form; new branch visible and active.
3. **"You hired someone to manage only that new location. Give them access."** — Finds Team → invite; picks Branch Manager; scopes to the new branch; understands an invitation was sent and is awaiting a response.
4. **"Create a listing for a new children's swimming course at the new location."** — Creates via Listings → Create; fills title/type/setting/audience; associates the branch. Understands the result is a private draft.
5. **"Parents should be able to buy it monthly, or try one paid taster session first. Set that up."** — Adds a Monthly price option; recognizes a paid trial belongs in Offers (or asks the interface's own words); no expectation that options create separate listings.
6. **"You're happy with it. Send it to Himma."** — Uses Submit for review from the listing's status area (following the readiness guidance if something is missing); understands Himma now reviews it and nothing is public yet.
7. **"Here's a listing Himma already approved — make it visible to customers."** (facilitator: have them open *Private Swim Coaching*) — Finds Publish on the status area; **states, unprompted or when asked, that approval alone had not made it public** (mandatory check §12.1); after publishing, reads the visibility conditions correctly.
8. **"Summer is over — take *Adult Beginner Swimming* off the catalogue for now, in a way you can undo later."** — Chooses Pause (not Archive); reads the confirmation correctly; understands customers can't find it and that resuming is possible.
9. **"The price description of a live listing needs a correction. Change the description of *Junior Swim Squad* and tell me what you expect customers see right now."** — Attempts the edit; encounters the pending-review state (this listing already has one); **explains in their own words that some changes on live listings wait for Himma while today's version stays live** (mandatory check §12.2).
10. **"You have a spreadsheet of next season's courses. Check whether Himma can take it."** — Finds Import listings; downloads/reviews the template or uploads the prepared sample file (facilitator provides `walkthrough-import-sample.csv`, or the partner's own anonymized sheet); runs validation; reads the result; **states that nothing has been imported yet** (mandatory check §12.5).
11. **"What are 'Schedule' and 'Bookings' in the menu?"** — Identifies them as future functionality, not errors (§13).
12. **(switch to Huda, `stages@himma.demo`) "One of your businesses, Pearl Divers, has an approved freediving course. Make it public."** — Finds the listing; encounters the organization-not-live explanation; **understands the block is the organization's verification with Himma, that Himma completes it, and that they cannot self-approve** (mandatory check §12.4); finds the verification status page from the link.
13. **(still Huda) "Where is Sunrise Pottery in its Himma journey?"** — Reads the onboarding/verification status correctly ("submitted, Himma is reviewing" — not an error, not something they can push through).

### Scenario B — Listings Editor (Nadia, Blue Wave Swimming)

14. **"Sign in and open your workspace."** — Handles the one-time workspace retry without believing the portal is broken (the error state's own words must carry this).
15. **"Himma asked for changes on *Aqua Therapy Sessions*. Handle it."** — Opens the listing, understands the changes-requested state, makes an edit in the editor, returns and resubmits; understands it went back to Himma.
16. **"*Private Swim Coaching* was approved. Can you put it live? Do whatever you can."** — Reads the status area; **concludes without frustration that publishing is an Owner/Organization-Manager step and that their own preparation/submission work is complete** (mandatory check §12.3); does not hunt for a hidden button.
17. **"What can you see on your Dashboard about the catalogue?"** — Reads counts/actions; the approved-awaiting-publication wording tells them who publishes.

### Scenario C — Branch Manager (Salem, Dubai Marina branch)

18. **"Look through the listings you work with."** — Understands the index shows their branch's listings plus unplaced drafts (the scope note carries this); does not interpret missing listings as data loss (§12.3).
19. **"Fix something on *Masters Training*."** — Opens it (readable), finds editing unavailable with the scope explanation ("runs at branches outside your scope"); understands this is intentional.
20. **"Resubmit *Aqua Therapy Sessions* after its corrections."** — Completes submit from the status area (in scope, so it works).
21. **"Validate this spreadsheet of new Marina classes."** (facilitator provides `walkthrough-import-scoped-sample.csv`, which references one out-of-scope branch) — Runs validation; understands the scope note up front and reads the out-of-scope branch row error as intentional policy, not a bug.

## 6. Expected outcomes

A session is successful when the participant completes the scenario's tasks with at most minor hesitation, no facilitator interventions beyond neutral clarification, all five §12 comprehension checks landing, no accidental destructive action (archive when pause was meant; revoking the wrong person), and no navigation dead end that required rescue. Individual task failures are findings, not session failures — record and continue.

## 7. Mandatory comprehension checks (§12 of the W2-11 task)

1. **Approval ≠ publication** (tasks 7, 16): Himma approval never makes a listing public by itself.
2. **Protected live edits** (task 9): some edits to live listings wait for Himma review while current values stay live; the provider needs no internal vocabulary to say so.
3. **Role authority** (tasks 16–19): a Listings Editor prepares and submits but does not publish; a Branch Manager's narrower view/edit reach reads as intentional scope, not breakage.
4. **Verification/go-live gate** (tasks 12–13): organization-level pending/blocked status is understood as Himma's step; no self-approval is expected.
5. **Bulk import boundary** (tasks 10, 21): validation today, import when bulk processing is enabled; "nothing has been imported yet" is understood literally.

## 8. Success criteria (per task)

Capture, per task: completed without intervention / completed with help / not completed · where the first hesitation occurred · any incorrect expectation stated · whether the resulting state was understood · whether anything unsafe was nearly done. No stopwatch targets — docs/23 sets none; comprehension and completion are the measures.

## 9. Finding severity

docs/23 defines no finding taxonomy; this compact model applies (a preference is not automatically a defect):

- **Blocker** — a launch-critical workflow cannot be completed, or the provider is materially misled about what happened.
- **Major** — completable, but with significant confusion, error, or risk.
- **Minor** — friction or clarity issue that does not prevent successful operation.
- **Observation** — preference or future idea; recorded, not a defect.

## 10. Evidence form (one row per task, one sheet per participant)

```
Participant: (anonymized id, e.g. P1)   Role scenario: A / B / C
Business shape: (e.g. multi-branch swim academy)   Date:   Facilitator:

| # | Task | Completed (yes / with help / no) | First hesitation (where/why) |
|   | Incorrect expectation voiced | Facilitator intervention (what) |
|   | Severity (Blocker/Major/Minor/Obs) | Participant's own words (short) |
|   | Screenshot ref (if any) | Recommended follow-up |
```

Also record per session: the five §7 comprehension checks (landed / partially / missed, with the participant's wording) and any spontaneous findings outside the script. Collect no personal data beyond the anonymized id and business shape.

## 11. Post-session decision rules

- **Blocker/Major product defects** → a bounded correction task BEFORE W2-12 live integration; each fix follows the normal implement→verify→owner-review loop.
- **Minor findings** → fix before outreach certification (W2-13) where reasonable, or document with rationale.
- **Preferences/future ideas** → recorded; no automatic scope expansion.
- No design partner rewrites canonical role/security/domain semantics by feedback alone — spec changes are recorded as owner decisions (docs/23 §8.6), exactly like every other amendment.
- The gate needs **at least one completed round with findings dispositioned** (§8.6); the owner decides cohort size within the 5–8 recruitment target.

## 12. Internal preflight results (2026-08-14 — NOT the external gate)

The full facilitator script was executed against the production fixture build (the same three-viewport Playwright environment as all W2 evidence), scenario by scenario, as automated journeys in [portal/e2e/walkthrough-preflight.spec.ts](../portal/e2e/walkthrough-preflight.spec.ts) plus visual inspection of the captured states. Evidence: `artifacts/portal-w2-11/`.

- All 21 script tasks are executable end-to-end with the shipped UI; every §7 comprehension state renders its carrying copy.
- Sample files for tasks 10/21 are checked in beside the spec ([walkthrough-import-sample.csv](../portal/e2e/fixtures/walkthrough-import-sample.csv), [walkthrough-import-scoped-sample.csv](../portal/e2e/fixtures/walkthrough-import-scoped-sample.csv)).
- Defects found and fixed during preflight, if any, are listed in HANDOFF (W2-11 section) with their tests.
- Tablet and mobile representative passes of the lifecycle, dashboard, and import journeys were already green in the standing three-viewport suites and were re-run.

**W2-11 INTERNAL PREFLIGHT: GO — the walkthrough package is ready for an external design partner; the external §8.6 gate remains PENDING.**

## 13. External gate status

**PENDING.** No design-partner session has occurred. Next actions (owner/team, not code): recruit the §8.6 cohort under the §18.16 terms decision → schedule sessions → run this script with a facilitator → collect §10 evidence forms → disposition findings per §11 → record the round's outcome as the §8.6 gate result. Only then may provider-API contracts freeze and W2-12 live integration begin.
