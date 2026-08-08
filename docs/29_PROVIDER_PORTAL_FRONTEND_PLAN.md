# W2-0 — Provider Portal Frontend Implementation Plan and Information Architecture

**Status: OWNER-APPROVED and binding (2026-08-07, closed at `7fbb4ba`), with rulings D-W2-1 (separate `portal/` Vite + React SPA — option (a) ratified) and D-W2-2 (self-registration deferred — option (a) ratified). Implementation proceeds task-by-task per §16 within the docs/23 §16 phase gates; see §22 for implementation status.**

This is the docs/23 §8 (W2) planning artifact on the docs/20–22/26–28 pattern: it turns the approved PP-01…PP-17 surface inventory into a concrete information architecture, route plan, role matrix, backend-capability mapping, and a small-step sequential implementation decomposition — grounded in the backend that actually exists today (Slices 1–4 closed at `a1e782d`; migration head `0010_search`).

---

## 1. Purpose and scope

The provider portal is Himma's second product surface: the responsive web application through which approved provider organizations operate their Himma presence — onboarding, storefront, branches, staff, catalogue, moderation states, and (as later slices land) schedules, bookings, attendance, and finance. It shares the production backend and identity spine with the customer app but is a **separate product** with its own navigation, route hierarchy, authentication boundary, layouts, and experience.

**In scope for this plan:** the complete production information architecture (including future areas), role-based access presentation, backend-readiness mapping, onboarding journey, UX-state completeness, responsive strategy, frontend architecture recommendation, mock/API boundary, testing strategy, sequential W2 task decomposition, the provider-outreach milestone, admin-portal (W3) dependencies, and deployment implications.

**Out of scope:** any implementation; the internal admin portal (W3 — its own plan); customer-app changes; backend changes; brand redesign (provisional Orbit Indigo stands per docs/07 until the §18.6 engagement); Arabic/RTL implementation (W7 — the portal must remain localization-ready per docs/08 §13 discipline, nothing more).

**Binding product separation (restated):** no Himma internal-admin functionality enters the provider portal (moderation decisions, verification decisions, taxonomy administration, org lifecycle transitions are W3); no provider-management functionality enters the customer app. The portal never uses the customer app's bottom-dock navigation.

## 2. Binding decisions applied (not re-decided here)

- **Identity:** one identity spine (docs/26, D1) — staff are `app_user`s; Cognito behind `AuthProviderAdapter`; sessions are Himma `login_session`s established from provider evidence; **no raw token persistence in frontend architecture** — token acquisition lives in one auth-adapter module, everything else sees a typed session facade. MFA baseline is mandatory on the provider surface (D-S3-5); staff-management actions additionally require recent step-up.
- **Roles:** exactly the seven approved provider roles (docs/23 §7, docs/24 §10.2) — Owner, Organization Manager, Branch Manager, Listings Editor/Scheduler, Coach/Instructor, Front Desk/Booking Employee, Finance. No eighth role. UI authority derives ONLY from the backend capability model (`/provider/me` + per-org resolution); Cognito groups grant nothing; the frontend hides unavailable UI for usability but is never the security boundary.
- **Organizations:** admin-created with a founding Owner invitation (D-S3-2); verification/go-live is admin-side and **fail-closed in production** until the VerificationCase/document-review capability exists (D-S3-3). The portal presents state; it cannot self-approve.
- **Catalogue:** the D-S4-1 model (Program = listing; ProgramPriceOption = commercial options under it), D-S4-2 publication authority (publish/unpublish/pause = Owner + Organization Manager only; approval never auto-publishes), the §7 sensitive-revision flow, and DB-managed taxonomy (D-S4-3).
- **Money:** integer fils, AED; ProgramPriceOption is catalogue metadata only; PriceQuote remains future booking-time truth; no payment submission anywhere (docs/23 §19).

## 3. Current backend readiness (authoritative, from HANDOFF at `a1e782d`)

**Real now (Slices 2–4, code-complete):** provider identity/session/MFA/TOTP/recovery/step-up (routes under `/auth/*`) · `GET /provider/me` membership listing · per-org provider surface (`/provider/organizations/:orgId/...`): org view, profile edit (incl. storefront publish flag), submit-for-verification, branches (create/edit/deactivate), staff (list, invite, revoke, with branch scopes, last-owner protection), and the full catalogue surface (19 routes): listings CRUD, price options, branch associations, media reference metadata, offers, submit/publish/pause/archive, sensitive-edit revision submission. Customer-public reads and search exist and consume published catalogues.

**Admin-controlled, provider-read dependency (backend exists; internal admin FRONTEND does not):** organization creation + founding invitation · verification lifecycle edges (verify/go-live fail-closed pending evidence capability) · suspension/reinstatement · listing review (approve/changes-requested) · revision decisions · taxonomy administration.

**Backend not yet implemented (do not fake):** verification-document upload/VerificationCase · sessions/schedules/camp weeks/cohorts · capacity · bookings · attendance · payments/payouts/statements/refunds · reviews/ratings · analytics/occupancy/revenue · bulk import/batch engine · notifications · support-case system · provider self-registration.

**Operational (not code) gaps that bind W2 deployment:** production Cognito pool/region + real-pool MFA smoke (provider surface fail-closed until ready) · production email · distributed rate-limiter store · hosting region (§18.3) · brand/domain (§18.6).

## 4. Information architecture

Ten top-level areas (mapping the PP inventory), plus the pre-authenticated zone:

| Area | PP | Purpose | Backend status |
|---|---|---|---|
| **Access** (sign-in, invitation, MFA, step-up) | PP-01 | Enter and secure the portal | **Real now** |
| **Onboarding** | PP-02 | Guided path from accepted invitation to submitted-for-verification and beyond | **Real now** except document upload (backend-later) and bank details (W5-later) |
| **Dashboard** | PP-03 | Status + required actions from source-of-truth data | **Real now** (catalogue/org truth); booking/session widgets backend-later |
| **Listings** | PP-07, PP-09, PP-17 | The catalogue workspace: programs, price options, media, offers, lifecycle, revisions; bulk import (UI-first) | **Real now** (import engine backend-later) |
| **Schedule** | PP-08 | Recurring schedules, sessions, capacity, camp weeks | Backend-later (Slice 6) |
| **Bookings** | PP-10, PP-11 | Booking operations + attendance | Backend-later (Slice 7) |
| **Branches** | PP-05 | Locations, hours, facilities, active state | **Real now** |
| **Team** | PP-06 | Staff directory, invitations, roles, branch scopes | **Real now** |
| **Business Profile** | PP-04 | Organization details + public storefront content + publication readiness | **Real now** |
| **Finance** | PP-14, PP-13 (revenue) | Statements, payouts, bank details (Owner), reports | Backend-later (W5/commercial model) |
| **Settings & Support** | PP-15, PP-16 | Account security (MFA), notifications, support entry, reviews later (PP-12) | Security **real now**; support cases/notifications backend-later |

Public/private separation inside the portal: Business Profile explicitly separates the PRIVATE organization record (legal name, verification state — read-only fields per capability) from the PUBLIC storefront projection (display name, descriptions, media refs, contacts, published flag), mirroring the structural table separation.

## 5. Navigation

**Pattern: persistent desktop sidebar (grouped, icon+label) + top bar (org switcher, account/security menu, sign-out) → collapsible rail on tablet → drawer + top app bar on narrow/mobile.** This is the SaaS-standard shape for a data-heavy management product; nothing in the repo prescribes another pattern, and the customer dock is explicitly not reused. Feel: professional, clean, trustworthy UAE SaaS — Orbit Indigo tokens, Manrope, generous whitespace, obvious hierarchy; not a developer console, not gamified.

Sidebar order (launch set): Dashboard · Listings · Schedule† · Bookings† · Branches · Team · Business Profile · Finance† · Settings & Support. († = present in IA from day one as **designed placeholder areas with honest "coming later" states** — never fabricated data; hidden entirely for roles with no future stake in them.) Sections a role cannot access do not render in its navigation; direct URL access renders the authorization-denied state (backend remains the boundary).

**Organization context:** every org-scoped route carries the organization id in the path (mirrors backend addressing `/provider/organizations/:orgId/...`, keeps deep links unambiguous for multi-org staff). The top-bar switcher (fed by `GET /provider/me`) switches context; single-org users never notice it.

## 6. Route architecture (proposed; final names may be refined in W2-1 within these conventions)

Pre-authenticated: `/sign-in` · `/invitation/:token` (acceptance) · `/mfa` (challenge) · `/mfa/enroll` · `/step-up` (re-auth interstitial) · `/signed-out`. **[launch-needed]**

Org-scoped (`/o/:organizationId` prefix):

| Route | Content | Classification |
|---|---|---|
| `/o/:orgId` | Dashboard | launch-needed |
| `/o/:orgId/onboarding` (+ steps) | Guided onboarding checklist/wizard | launch-needed |
| `/o/:orgId/profile` (tabs: business · storefront · publication) | PP-04 | launch-needed |
| `/o/:orgId/branches` · `/branches/new` · `/branches/:branchId` | PP-05 | launch-needed |
| `/o/:orgId/team` · `/team/invite` · `/team/:membershipId` | PP-06 | launch-needed |
| `/o/:orgId/listings` (+ state filters) | PP-07 index | launch-needed |
| `/o/:orgId/listings/new` | Create listing | launch-needed |
| `/o/:orgId/listings/:programId` (tabs: details · eligibility · pricing · branches · media · offers · status) | Listing detail/editor | launch-needed |
| `/o/:orgId/listings/:programId/revision` | Open-revision status/diff view | launch-needed |
| `/o/:orgId/listings/import` | PP-17 bulk import (dry-run preview UX) | frontend-first / backend-later |
| `/o/:orgId/schedule` | PP-08 | frontend-first / backend-later (Slice 6) |
| `/o/:orgId/bookings` · `/bookings/:bookingId` | PP-10 | frontend-first / backend-later (Slice 7) |
| `/o/:orgId/attendance` | PP-11 (or nested under schedule day view — decide at W2 schedule design) | deferred until sessions exist |
| `/o/:orgId/finance` (statements · payouts · bank details) | PP-14 | frontend-first / backend-later (W5) |
| `/o/:orgId/reports` | PP-13 | deferred |
| `/o/:orgId/settings` (security/MFA · notifications) | PP-16 | security launch-needed; notifications backend-later |
| `/o/:orgId/support` | PP-15 entry | launch-needed as contact entry; case system backend-later |

Route guards: authenticated → membership-resolved → org-context valid → capability-gated per section; failures render typed states (§11), never blank screens.

## 7. Role × surface matrix

Legend: ● manage · ◐ read-only · ▲ branch-scoped manage · — no access. Rows marked *(proposed)* cover future domains and are **proposed pending canonical backend authority** — they become binding only with their owning backend slice's approved authorization.

| Surface | Owner | Org Mgr | Branch Mgr | Listings Ed. | Coach | Front Desk | Finance |
|---|---|---|---|---|---|---|---|
| Dashboard | ● | ● | ▲ (scoped view) | ◐ | ◐ (minimal) | ◐ | ◐ |
| Business/Profile | ● (incl. legal + commercial view) | ● (legal view, no commercial) | ◐ | ◐ | ◐ (minimized) | ◐ | ◐ |
| Branches | ● | ● | ▲ (edit assigned) | ◐ | ◐ | ◐ | ◐ |
| Team | ● (invite/revoke, step-up) | — | — | — | — | — | — |
| Listings (create/edit/submit) | ● | ● | ▲ | ● | — | — | — |
| **Publication (publish/pause/archive)** | **●** | **●** | **—** | **—** | **—** | **—** | **—** |
| Schedule *(proposed)* | ● | ● | ▲ | ● | ◐ (own sessions) | ◐ | — |
| Bookings *(proposed)* | ● | ● | ▲ | ◐ | ◐ (own sessions) | ● (operational) | ◐ |
| Attendance *(proposed)* | ● | ● | ▲ | — | ● (own sessions) | ● | — |
| Finance *(proposed)* | ● (incl. bank details) | ◐ | — | — | — | — | ● (no bank details) |
| Reports *(proposed)* | ● | ● | ▲ | ◐ | — | — | ◐ (financial) |
| Settings (own account security) | ● | ● | ● | ● | ● | ● | ● |

**Reconciliation (owner-ratified at W2-6 closure, 2026-08-08, binding):** the Team row originally showed Organization Manager as ◐ read-only; the SHIPPED capability registry makes `staff.read` and `staff.manage` Owner-only (docs/24 §1.3, docs/27 §6), and per §2 the registry is authoritative. The matrix above is reconciled to the implemented registry; the backend registry was not changed.

The launch rows (Dashboard through Publication, Settings) restate the EXISTING capability registry exactly (`org.read`/`org.legal.view`/`commercial_terms.view`/`profile.edit`/`branch.*`/`staff.*`/`org.submit`/`catalogue.read`/`listings.manage`/`listings.publish`/`media.manage`); no new authority is invented. Branch-scoped staff see and mutate only listings whose active associations lie inside their scope, and only their assigned branches — as the backend already enforces.

## 8. Portal workflow → backend mapping

| Workflow | Backend | Connects to real API |
|---|---|---|
| Sign-in / session / MFA / TOTP / recovery / step-up | **Real now** (Slice 2) | Yes — at integration task |
| Invitation acceptance | **Real now** (`POST /provider/invitations/accept`) | Yes |
| Org switcher | **Real now** (`GET /provider/me`) | Yes |
| View org + verification state | **Real now** | Yes |
| Edit storefront profile / publish flag | **Real now** | Yes |
| Submit org for verification | **Real now** (`org.submit`) | Yes |
| Verification decision / go-live | Admin-side; **fail-closed pending evidence capability** | Provider sees state only |
| Verification document upload | **Backend absent** | Mock/disabled; flagged |
| Branch create/edit/deactivate | **Real now** | Yes |
| Staff invite/revoke/scopes | **Real now** (step-up gated) | Yes |
| Listings CRUD + price options + media refs + offers + associations | **Real now** | Yes |
| Submit for moderation / changes-requested loop | **Real now** (decision is admin-side) | Yes |
| Publish / pause / archive | **Real now** (`listings.publish`) | Yes |
| Protected-edit revisions (view pending state) | **Real now** (submission; decision admin-side) | Yes |
| Media binary upload/library | **Backend absent** (references only) | Mock/disabled; flagged |
| Bulk import / batch scheduling (PP-17) | **Backend absent** | UI dry-run mock only |
| Schedules/sessions/capacity | **Backend absent** (Slice 6) | Mock/disabled |
| Bookings/attendance | **Backend absent** (Slice 7) | Mock/disabled |
| Finance/payouts/statements/bank details | **Backend absent** (W5 + commercial model §18.7) | Mock/disabled |
| Reports/analytics | **Backend absent** | Mock/disabled |
| Support cases | **Backend absent** (W3-coupled) | Contact-entry only |
| Notifications preferences | **Backend absent** | Mock/disabled |

## 9. Onboarding journey (PP-02)

Stages (state-driven checklist, not a forced linear wizard — providers resume anywhere):

1. **Entry:** founding-Owner (or staff) invitation link → sign-in/first-login via Cognito → verified-email acceptance (D-S3-1 rules surface as friendly errors) → land in org context.
2. **Business basics:** confirm trade/display identity; read-only legal identity as recorded by Himma (admin-created).
3. **Storefront:** display name, descriptions, contacts, media references; publication-readiness explained (published flag may be set pre-live; EFFECTIVE visibility = live AND published — the UI states this honestly).
4. **Branches:** ≥1 active branch (submission completeness mirror).
5. **Team (optional):** invite staff with roles/scopes.
6. **Review & submit:** completeness check mirroring backend rules (display name + ≥1 active branch); submit → `submitted`.
7. **Verification status:** state banner driven by `verification_state` — draft / submitted / in review / verified (awaiting go-live) / live / rejected (with bounded reason + resubmit path) / suspended (support contact). **Document requests: the portal shows a "Himma will contact you to complete verification" panel until the VerificationCase backend exists — no fake upload flow pretends otherwise.** Bank details are explicitly NOT collected at onboarding (no backend field exists; arrives with W5 under Owner-only Finance).
8. **First listing prompt** once live.

Provider-visible vs admin-only: providers see lifecycle state + bounded reason codes; admin decision tooling, reviewer identity, and internal queues are W3-only and never surface here.

## 10. Launch-critical pages and dashboard content

Launch-critical set: sign-in/MFA/step-up · invitation acceptance · onboarding checklist · dashboard · profile (business/storefront/publication) · branches (list/detail/form) · team (directory/invite/detail) · listings index · listing editor (all tabs) · listing status/lifecycle panel · revision status · settings-security. **Initial real dashboard (no fabricated metrics):** verification/storefront status card · required-actions list (incomplete profile, no active branch, no active price option, drafts to submit, changes-requested listings, pending revisions, pending invitations, approaching-nothing else) · listing state summary (counts by lifecycle state) · team/pending-invite summary · "what's next" guidance. Booking/session/revenue widgets appear only with their backend slices.

## 11. UX state completeness (binding per launch-critical screen)

Every launch-critical screen specifies and QA-covers: initial loading (skeletons) · empty (first-use guidance) · populated · client validation error · server validation (typed vocabulary: `programIncomplete` with `missing[]`, `invalidPriceOption`, `invalidTaxonomy`, `invalidEligibility`, `invalidOffer`, `invalidBranchScope`…) · server error (retryable) · authorization denied (role-appropriate copy) · branch-scope limitation (explains scoped reach) · MFA required (`mfaRequired` → enrollment/challenge path) · step-up required (`stepUpRequired` → re-auth interstitial, staff actions) · stale-version conflict (`staleVersion` → reload-and-reapply pattern, never silent overwrite) · suspended organization (`organizationSuspended`: reads work, mutations disabled with banner) · verification-blocked (`organizationNotLive` on publish) · moderation pending (submitted/in_review lock states) · changes requested (reason + edit path) · revision pending (`revisionPending`: protected fields locked with pending diff) · archived/frozen (terminal, read-only). Mapping table from backend outcome codes → UI states is a W2-1 deliverable and stays 1:1 with `http-outcomes.ts`.

## 12. Responsive behavior

Desktop-first (primary: ~1280–1440), tablet-usable (≥768), narrow-browser-usable (≥360) — a responsive web product, not a native app. Complex screens get explicit adaptations, never shrunken tables: listings index (table → card list with state chips) · listing editor (side-tabbed → stacked accordion sections, sticky save bar) · team matrix (table → per-person cards; scope editor becomes a full-screen sheet) · branch scope picker (checklist sheet) · price-option editor (row grid → stacked option cards) · future finance tables (column priority + horizontal scroll within cards) · future calendars (week grid → agenda list). Keyboard navigation and WCAG 2.1 AA targets per docs/23 §8.4; touch targets ≥44px on touch layouts.

## 13. Frontend architecture recommendation

Repository facts: the customer app is Expo SDK 57 / React Native / expo-router with Playwright web-QA; the backend is an independent plain npm package (`backend/`, Node 24, Jest, ESLint flat config); there is no monorepo workspace tooling and no portal placeholder. docs/23 §18.15 registers the portal stack as an owner decision with §8.3 naming the two candidates.

**Recommendation (D-W2-1, owner ratification required): a NEW independent package `portal/` — Vite + React 19 + TypeScript SPA** (react-dom, not react-native-web), following the `backend/` package pattern (own package.json/tsconfig/ESLint/Jest; root tooling excludes it).

- *Why not Expo web reuse:* the customer app's components are phone-first RN primitives built for a 390-pt dock-navigation product; a desktop-first, data-table/forms SaaS built in RN-web would fight the medium (tables, focus management, dense forms, hover/keyboard idioms) and couple two products' release trains. Brand cohesion comes from shared TOKENS, not shared components.
- *Why SPA not SSR/Next:* fully authenticated product — no SEO/public pages; static hosting + the existing API keeps W6 surface minimal; no server runtime to operate.
- **Design tokens:** port the docs/07 token structure (colors/spacing/type/radii) into `portal/src/theme` as the same named values; single-source extraction into a shared package is deliberately deferred until a second consumer proves the need (recorded, revisit at rebrand).
- **Contracts:** `portal/src/api/contracts` — TypeScript DTO types + client mirroring the backend TypeBox contracts and typed error vocabulary; **contract-shape tests import the real backend's `buildApp` (same repo) and assert fixture compatibility against real responses** on real PostgreSQL, so drift fails CI rather than production.
- **API client boundary:** one fetch-based typed client; TanStack Query for caching/invalidation/retries; every mutation carries `expectedVersion` CAS and maps `staleVersion` to the conflict UX.
- **Auth boundary:** one `auth/` module owning Cognito interaction (hosted-UI/SDK — resolved at W2-2 design within docs/26 architecture), Himma session establishment, MFA/step-up choreography, and session state; deterministic fake adapter for dev/test (the backend's `FakeAccessTokenVerifier` pattern mirrored client-side). No token material outside this module; storage strategy decided inside it with security review at integration.
- **Forms/validation:** react-hook-form + zod schemas mirroring backend constraints (client validation is UX only; backend stays authoritative per docs/08 §14).
- **Routing/guards:** React Router with layout-nested guards (session → membership → org → capability).
- **Testing stack:** Jest + Testing Library (repo convention) for unit/component; Playwright (already in-repo) for route/navigation/responsive/visual QA; jest-axe for accessibility assertions.

## 14. Mock / real-API boundary

Per CLAUDE.md, screens are built mock-driven behind typed contracts and must swap to real APIs without redesign. Rules: mock services live in `portal/src/services/mock/` implementing the SAME contract interfaces as the real client; **for backend-ready workflows, fixtures are shaped byte-compatibly with real DTOs and locked by the contract-shape tests**; for backend-later workflows (import, schedules, bookings, finance), fixtures are clearly labelled design fixtures and their screens carry honest "not yet operational" affordances in mock mode; no mock ships as a production data source; integration (W2-12) replaces adapters area-by-area with zero screen redesign as the acceptance bar.

## 15. Testing strategy (proportional)

Per task: unit (reducers/validators/formatters) · component (Testing Library; states of §11 per screen) · route/navigation tests (guards, org scoping, deep links) · permission-state tests (seven-role × surface rendering matrix — UI mirror of the backend matrix) · contract-shape tests (backend-ready areas, against real `buildApp`) · accessibility (jest-axe + manual keyboard pass per milestone) · responsive checks (Playwright at 1366/768/390 widths) · visual evidence (Playwright screenshots into `artifacts/portal-*/`) · production build check (`vite build` + preview smoke) per milestone. Real-browser validation (Playwright headed/cross-browser) becomes required at W2-12 integration and W2-13 hardening; **no native iOS/Android certification applies to the portal**. Zero-console-error discipline throughout (docs/23 §8.4).

## 16. Sequential implementation decomposition (each: implement → verify → commit → owner review; no parallel major tasks)

| # | Task | Scope | Excluded | Backend dep | Acceptance / verification | Owner visual approval |
|---|---|---|---|---|---|---|
| **W2-1** | Portal foundation & app shell | `portal/` package (per D-W2-1), tokens/theme, app shell (sidebar/topbar/drawer), route skeleton with honest placeholders, base state components (loading/empty/error/denied), org-switcher shell, QA harness (Jest/Playwright/axe), production build | Any real screen content; auth logic | None (mock session) | Shell renders at 3 breakpoints; nav per proposed IA; zero console errors; build passes | **Yes** |
| **W2-2** | Access & session UX | Sign-in, invitation acceptance, MFA enroll/challenge, recovery codes, step-up interstitial, signed-out/suspended/denied states, session facade + guards (mock auth adapter shaped on real contracts) | Real Cognito wiring | Real now (contracts) | All §11 auth states demonstrable; guard tests; a11y pass | **Yes** |
| **W2-3** | Onboarding & verification status | §9 journey: checklist, business basics, review/submit, verification state banners incl. rejected/resubmit, suspended; document-request placeholder panel | Document upload UI beyond placeholder; bank details | Real now (org/submit); verification decisions admin-side | Journey walkable end-to-end on mocks; every verification state rendered | **Yes** |
| **W2-4** | Business profile | Business (private, capability-shaped) + storefront editor + publication readiness tab; public/private separation explicit | Media binary upload (refs only) | Real now | CAS conflict + validation states; role matrix rendering (Owner/OrgMgr vs read-only) | **Yes** |
| **W2-5** | Branches | List/detail/create/edit/deactivate, hours/facilities editors, active-state semantics, branch-scope read behavior | Area admin (taxonomy is admin-owned; area picker read-only) | Real now | Branch-manager scoped rendering; empty/deactivation states | **Yes** |
| **W2-6** | Team & staff | Directory (memberships + history), invite flow (role + branch scopes), pending invitations, revoke, role-change = revoke+re-invite explanation, last-owner protection state, step-up gating UX | Any new role/permission semantics | Real now | Seven-role vocabulary exact; scope editor responsive; step-up + lastOwnerProtected states | **Yes** |
| **W2-7** | Listings index & detail (read) | Index with lifecycle filters/search-by-title (client-side), state chips, listing detail read view (all sections), branch-scope filtered reach | Editing | Real now | Index ↔ detail navigation; every lifecycle state represented; scoped-role rendering | **Yes** |
| **W2-8** | Listing editor | Create + draft/changes-requested editing: details, taxonomy picker (active-only), eligibility (five-value gender model), price options (stable-id semantics, kind ties), branch associations, media reference metadata, offers; completeness panel mirroring `missing[]` | Lifecycle actions; revision flow | Real now | All validation/typed-error states; responsive editor; contract-shaped fixtures | **Yes** |
| **W2-9** | Lifecycle, moderation & revisions + dashboard | Submit / publish / pause / resume / archive with exact authority rendering (publish = Owner+OrgMgr ONLY, approval ≠ publication made explicit), submitted/in-review locks, changes-requested loop, revision-pending diff view; the §10 dashboard | Admin decision UI (W3) | Real now (decisions admin-side) | Full lifecycle walk on mocks; publication-matrix UI tests; dashboard actions derive from fixtures | **Yes** |
| **W2-10** | Bulk import & batch UX (PP-17) | Template download stub, column mapping, full dry-run preview, per-row error report, validated-subset re-batch flow, duplicate warnings — pure frontend against design fixtures | Any real import engine; media batch upload beyond metadata | **Backend absent** (flagged) | §8.5 rules 1–5 demonstrated in mock; atomicity semantics honestly labelled | **Yes** |
| **W2-11** | Design-partner walkthrough round (§8.6) | Structured walkthroughs of W2-1…10 mock portal with recruited partners (terms per §18.16), findings report, spec amendments | Implementation changes beyond approved amendments | None | Findings dispositioned; amendments owner-approved | **Yes (gate)** |
| **W2-12** | Real-API integration | Replace mock adapters area-by-area (auth/session/MFA → org/profile → branches → staff → catalogue/lifecycle/revisions) against the real backend; contract tests; E2E happy paths + typed-error paths on real PostgreSQL | Backend changes; backend-later areas stay mocked/disabled | Real now | Zero screen redesign; E2E green; permission matrix re-proven against real 403/404 shapes | No (functional review) |
| **W2-13** | Hardening & outreach-readiness certification | Full §11 state audit, seven-role UI matrix suite, a11y audit, responsive audit, error-copy pass, production build + deployment readiness checklist (§19), evidence pack | New features | — | Full portal certification green; closeout doc | **Yes (milestone gate)** |

**Later, backend-gated tasks (planned placement, not started):** W2-14 Schedules UI (after Slice 6) · W2-15 Bookings (after Slice 7) · W2-16 Attendance (with sessions) · W2-17 Finance/payouts + bank details (after W5 + §18.7) · W2-18 Reports · W2-19 Reviews (PP-12, after review content ships) · W2-20 Support cases + notifications (with W3/notification backend) · W2-21 Import/batch engine integration (after its backend slice) · W2-22 Provider self-registration (only if D-W2-2 approves; needs a small backend addition on the `origin` seam).

## 17. Provider-outreach milestone

**Himma can begin onboarding real providers after W2-1 through W2-13 are production-ready, TOGETHER WITH the non-portal dependencies listed below.** This is sufficient for controlled initial onboarding because it covers the complete loop that exists in the backend today: invited owner signs in with MFA → completes onboarding → submits for verification → (Himma verifies/goes-live) → builds storefront/branches/team → creates listings → submits for moderation → (Himma approves) → publishes → appears in the live customer-facing catalogue APIs. Quality is production-grade throughout; the scope line excludes only backend-later domains.

**Hard non-portal dependencies for real outreach (carried honestly):**
1. **W3-minimum admin capability** — verification decisions, go-live, listing moderation, revision decisions, org creation/founding invitations have backend APIs but NO internal frontend; Himma staff cannot operate the other side of the loop without a minimal W3 slice (or explicitly owner-approved interim operational tooling). This plan's W3 counterpart must precede or accompany outreach.
2. **Verification-evidence capability** — production verify/go-live stays fail-closed until the VerificationCase/document backend exists (D-S3-3).
3. **Operational activation** — production Cognito pool + real-pool MFA smoke (provider surface is fail-closed), production email (invitations!), rate-limiter store, hosting/domain decisions.

Scale note: CONTROLLED outreach (the §8.6 design-partner cohort and first real providers, with assisted catalogue entry) does not require the §8.5 import ENGINE; broad outreach does — the import backend slice should be scheduled before scaling beyond assisted onboarding. **Public marketplace launch readiness is a separate, larger bar** (customer-app integration, sessions/bookings/payments, docs/23 §15 gates) and is NOT claimed here.

## 18. Admin-portal (W3) dependencies

Provider-portal flows that display pending state whose completion requires Himma-side tooling: organization verification decisions + go-live (incl. future document review) · listing moderation (approve/changes-requested) · revision decisions · suspension/reinstatement · founding org creation + owner invitation issuance · taxonomy administration (areas especially — branch area assignment depends on admin-created area data) · future support-case handling and finance approval. Backend APIs for the first six EXIST; the W3 plan should sequence a minimal "operations console" covering exactly these before provider outreach.

## 19. Infrastructure/deployment implications (planning only)

New at W2: a second deployed frontend — static SPA hosting + CDN (region pending §18.3) · portal (sub)domain **TBD — no domain is owner-approved; placeholder never ships** (§18.6 brand engagement) · per-environment config (API base URL, Cognito pool/client ids) · Cognito app-client callback/sign-out URLs per environment · strict CSP (self + API origin; no third-party scripts), HSTS, frame-ancestors none, nosniff · error reporting/observability product selection (W6, TBD) · no feature-flag system needed beyond build-time environment flags (mock vs real adapters are build-configured, not runtime flags). CI: portal tsc/ESLint/Jest/Playwright/build join the repo's certification set.

## 20. Explicitly deferred (restated)

Sessions/schedules/capacity · bookings/attendance · payments/payouts/statements/bank details · reviews · reports/analytics · notifications · support-case system · import/batch engine · media binary upload/library/CDN · verification-document upload · provider self-registration (pending D-W2-2) · Arabic/RTL (W7; structure stays localization-ready) · native provider app (none planned — responsive web only) · admin portal (W3, separate plan).

## 21. Owner decisions required

**D-W2-1 — Portal stack ratification (registered as docs/23 §18.15; blocks W2-1).**
Conflict: docs/23 §8.3 leaves "Expo web/React reusing the design system versus a separate web stack" open.
Options: **(a) Separate Vite + React SPA package `portal/` sharing design TOKENS and typed contracts (RECOMMENDED — §13 rationale: right medium for desktop-first SaaS, decoupled release trains, minimal ops via static hosting);** (b) second Expo-web app reusing customer RN components (maximum component reuse, but phone-first primitives fight tables/forms/keyboard idioms and couple the products); (c) Next.js SSR (adds a server runtime and SSR complexity with no SEO benefit for an authenticated product).
Consequences: (a) small token/type duplication with a documented sync rule until a shared package is justified; (b) faster first screens, slower every-screen-after and heavier W6 surface; (c) most infrastructure for least benefit.

**D-W2-2 — Provider self-registration scope (docs/27 D-S3-2 deferred this to the W2 spec).**
Conflict: the `organization.origin` seam anticipates self-signup, but onboarding-before-outreach does not require it and it needs a new backend addition.
Options: **(a) Defer — admin-invited onboarding only for the outreach phase (RECOMMENDED: matches D-S3-2, keeps verification quality high during controlled outreach, zero new backend);** (b) include a self-registration request flow in W2 (public "apply" form → admin triage; needs a small approved backend slice + spam controls); (c) full self-signup to draft org (largest backend/security surface now, weakest quality control).
Consequences: (a) outreach cadence is bounded by Himma's invitation operations (acceptable at design-partner scale); (b)/(c) add scope before the portal core exists.

No other owner decisions are raised: remaining open items (§18.3 region, §18.6 brand/domain, §18.16 partner terms, §18.7 commercial model) are ALREADY registered in docs/23 §18 and are referenced, not duplicated; all other choices in this plan are derivable from canon and are decided herein.

## 22. Implementation status

| Task | Status |
|---|---|
| **W2-1** Portal foundation & app shell | **Owner-approved and CLOSED at `11bab0d` (2026-08-07).** |
| **W2-2** Access & session UX | **Owner-approved and CLOSED at `cb8d038` (2026-08-07).** The recorded W2-12 gap (no proactive MFA-enrollment/assurance read) stays accepted. |
| **W2-3** Onboarding & verification status | **Owner-approved and CLOSED at `09e66a4` (2026-08-08).** The recorded contract gaps stay accepted: no invitation preview read (B), founding-owner distinction is composition-only (A), no provider-facing rejection reason (B), plus the carried W2-2 MFA-read gap. |
| **W2-4** Business profile | **Owner-approved and CLOSED at `784c2e2` (2026-08-08).** The final `/o/:organizationId/profile` experience with the §6 tabs (business · storefront · publication): private organization record read-only and capability-shaped (`org.legal.view` legal identity; lifecycle in provider language; no admin-owned field editable); public storefront editor (react-hook-form + zod mirroring the real PATCH limits; `profile.edit` = Owner + Organization Manager exactly; read-only truthful rendering otherwise; suspended orgs mutation-free); dirty-field-only PATCH with `expectedVersion` CAS and reload-and-reapply stale-conflict UX (never silent overwrite); customer storefront preview restricted to the canonical public projection (verified badge only when actually `live`; no fabricated ratings/counts/hours); publication as the exact `published` field of the same PATCH with the live-AND-published visibility truth table and no go-live control; onboarding readiness fed by the shared fixture store; unsaved-change blocker incl. org-switch; media refs honestly read-only (Class-C media-backend gap recorded). New `OrganizationProfilePort` seam mirrors `GET /provider/organizations/:orgId` + `PATCH .../profile`; unconfigured production port fail-closed. Jest 222/222 incl. jest-axe; Playwright 64-pass at 1440/1024/390; evidence in `artifacts/portal-w2-4/`. The recorded gaps stay accepted by owner instruction. |
| **W2-5** Branches | **Implemented 2026-08-08** — the final Branches experience at `/o/:organizationId/branches` · `/branches/new` · `/branches/:branchId`: index/create/detail-editor over the REAL Slice-3 contracts (reads composed from the org view — no branch list route exists; mutations mirror `POST /branches`, `PATCH /branches/:branchId`, `POST .../deactivate` with `expectedVersion` CAS and dirty-field-only patches); exact capability matrix (owner/org_manager create+edit+deactivate org-wide; branch_manager edit on assigned ACTIVE branches only; all other roles truthful read-only); branch-scope UX mirrors the real semantics (org-wide read, scoped mutation, "Assigned to you" marking, safe byte-identical not-found for unknown/foreign ids); deactivation presented as the one-way non-delete it canonically is (no reactivation route exists — recorded Class-B gap); area picker read-only over `GET /catalogue/areas` fixtures sending the canonical `areaLabel` (historical labels preserved, never re-offered); structured weekly opening-hours editor over a RECORDED encoding assumption (backend shape validation absent — Class B, ratify before W2-12); facilities chips within the real ≤20×40 limits; onboarding readiness round-trip through the shared fixture store (first-active-branch completes, deactivating-last reverts, lifecycle never moved); suspended orgs mutation-free; `BranchPort`/`AreaReadPort` seams fail-closed unconfigured. Jest 280/280 incl. jest-axe; Playwright 85-pass at 1440/1024/390; evidence in `artifacts/portal-w2-5/`. **FULLY APPROVED and CLOSED at `fad8e5a` (2026-08-08).** Owner ruling at closure (binding): the weekly opening-hours representation may remain for fixture/design purposes, but its production WIRE ENCODING is NOT ratified — W2-12 must resolve the backend opening-hours contract before real writes are enabled. |
| **W2-6** Team & staff | **Owner-approved and CLOSED at `4c83b72` (2026-08-08).** Owner reconciliation at closure (binding): the shipped Owner-only `staff.read`/`staff.manage` registry is authoritative — the §7 Team-row ◐ for Organization Manager was stale and the matrix is reconciled in place; the backend registry is unchanged. All previously accepted gaps/rulings carry forward (MFA-enrollment/assurance read · invitation preview/resolution read · founding-owner composition · rejection-reason read · media binaries · opening-hours wire encoding unratified · provider-safe staff display identity · production invitation email disabled). Original record: **Implemented 2026-08-08** — the final Team experience at `/o/:organizationId/team` · `/team/invite` · `/team/:membershipId` over the REAL Slice-3 staff contracts: ONE composed staff read (`GET /provider/organizations/:orgId/staff` → memberships incl. revoked history + all four invitation lifecycle states; `staff.read` is OWNER-ONLY per the shipped registry — docs/24 §1.3, docs/27 §6; the §7 matrix ◐ for Org Manager diverges from the registry and the registry was followed, divergence recorded); mutations mirror the three real `providerStepUp` routes verbatim (`POST .../staff/invitations` · `POST .../staff/invitations/:id/revoke` idempotent · `POST .../staff/memberships/:id/revoke` with `expectedVersion` CAS); exact seven-role vocabulary with the canonical backend display labels; org-wide-only roles (owner/org_manager/finance) scope-locked to `all`; branch scope = explicit `all` XOR 1–50 ACTIVE branches of the addressed org; role/scope change presented as the canonical revoke + NEW invitation (memberships are append-only history — no edit exists); last-active-owner protection surfaced as the backend refusal plus a truthful no-control state for the sole owner (pending owner invitations never count); every staff mutation routes `stepUpRequired` through the existing W2-2 `/step-up` interstitial with an in-memory pending intent and EXPLICIT re-confirmation (never auto-retry, never browser storage); Team navigation is the first capability-aware item (`staff.read`); roles without it get a truthful no-access surface with zero staff data fetched; suspended orgs read-only; invitations rendered apart from members with time-truth expiry; no token/digest ever rendered; member display identity is a recorded Class-B gap (staff read exposes `userId` only). `TeamPort` seam fail-closed unconfigured. Jest 352/352 incl. jest-axe; Playwright 106-pass at 1440/1024/390; evidence in `artifacts/portal-w2-6/`. Awaiting owner review. |
| **W2-7** Listings index & detail (read) | **Implemented 2026-08-08** — the read-oriented catalogue foundation at `/o/:organizationId/listings` (index) · `/o/:organizationId/listings/:programId` (detail), replacing the W2-1 placeholder, over the REAL S4 provider-private read contracts: `GET /provider/organizations/:orgId/listings` (seven-field summary rows; opaque-id keyset cursor, limit 1–100 — no server filter/search params exist, so status filter + title search are honestly client-side over loaded rows) and `GET .../listings/:programId` (full ProgramDetailView: content, eligibility, price options, branch associations, media refs, offers, open revision). Exact `catalogue.read` matrix (owner/org_manager/branch_manager/listings_editor; coach/front_desk/finance = truthful no-access, zero fetches; Listings is the second capability-aware nav item). Branch-scope semantics proven from shipped code and mirrored exactly: the LIST filters to reachable listings (branchless drafts + ≥1 active association in assigned ACTIVE branches, `some`-semantics) while the DETAIL read is organization-wide (no scope filter exists in `getProviderProgram`); unknown/foreign ids collapse into one byte-identical not-found. Detail renders: exact §5.3 lifecycle vocabulary (Approved ≠ Published explicit; paused reversible vs archived terminal), the COMPLETE derived public-visibility predicate (listing published ∧ org live ∧ storefront published ∧ ≥1 active branch — every gate tested), multi-option pricing under ONE listing (fils→AED display, archived options apart, derived "From AED X" only), W2-5-coherent branch truth, media reference metadata (Class-C binary gap carried), offers distinct from price options, read-only revision-pending state, and the exact 4-rule S4 readiness mirror on drafts/changes-requested. NO mutation surface of any kind (test-swept). `ListingsReadPort` + `ActivityTypeReadPort` seams fail closed unconfigured. Recorded gap: backend scoped-list pagination truncation (scope filter applied after the limit+1 window — mirrored, flagged for W2-12/backend). Jest 410/410 incl. jest-axe; Playwright 121-pass at 1440/1024/390; evidence `artifacts/portal-w2-7/`. **CONDITIONALLY APPROVED at `5396366` (2026-08-08); reconciliation (2026-08-08, the ordered catalogue-read-scope correction, applied post-`5396366`):** the recorded backend pagination defect is FIXED (Branch Manager reachability now participates in the authoritative SQL query BEFORE ordering/cursor/limit — no more silent truncation), and Branch Manager catalogue LIST and DETAIL now share ONE canonical branch-scope reachability rule (branchless drafts OR ≥1 active association to an assigned ACTIVE branch — the already-approved list semantics, centralized as `programReadableInBranchScope`): an in-organization out-of-scope Program's detail is now not-found-shaped exactly like unknown/foreign ids. The portal mirror was reconciled accordingly — the prior "out-of-scope detail readable with the scope explained" behavior (which truthfully mirrored the defective backend) is corrected to the same safe not-found surface, and the scoped index now serves the full reachable set (8 rows, incl. the previously window-truncated listing). Org-wide reader roles, the capability matrix, all mutation authority, and everything else in this record are UNCHANGED; W2-7 was not otherwise redesigned. See the HANDOFF "Provider catalogue read-scope correction" section for the correction record. |
| W2-8 … W2-13 | Not started — sequential, each gated on owner review of its predecessor. |

---

*Implementation follows this plan task-by-task per §16, within the docs/23 §16 phase gates. The customer application remains mock-driven; Slices 1–4 backend remains the sole production backend truth.*
