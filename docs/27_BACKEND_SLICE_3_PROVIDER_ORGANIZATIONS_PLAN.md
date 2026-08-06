# Backend Slice 3 — Provider Organizations, Public Provider Profiles, Branches, Staff Memberships, and Provider Authorization Foundation

**Status: approved in structure by the owner (2026-08-07, at `6b5b6a3`), subject to the D-S3-1…D-S3-5 rulings applied in place as Amendment A1 (2026-08-07). Documentation and technical design only — no migration, service, route, portal, or frontend code accompanies this document, and implementation begins only commit-by-commit per §16 after this amended plan is approved.**

**Amendment A1 (owner rulings, 2026-08-07, applied in place):** D-S3-1 — invitation acceptance requires a normalized VERIFIED email match (details §9). D-S3-2 — admin-initiated organization creation approved, with a schema origin seam so future self-signup is additive (§2, §10). D-S3-3 — verification boundary approved WITH a production safeguard: production `verified`/`live` transitions fail closed until the authoritative VerificationCase/document-review capability exists (§10, §13.3); storefront discoverability requires `live` AND a published public profile (§3). D-S3-4 — no separate Partner entity; Organization with an extensible classification seam (§11). D-S3-5 — REVISED from the draft recommendation: production provider-private management access requires MFA at baseline, with recent step-up additionally required for higher-risk actions (§7, §8, §13.2). The pre-amendment draft recommendations are superseded where they differ.

This plan implements docs/24 §13 row 3 (provider organizations & branches) within the docs/25 engineering contract, on the closed Slice-2 identity/authorization foundation (docs/26 §15). It follows the docs/26 planning pattern: entities → state machines → authorization → database design → API contracts → tests → commit sequence → owner decisions. Where docs/24 already fixed a shape (entity rows §1.3, state machines §5.1–5.2, transaction §7.10, permission matrix §10.2, mock mapping §12), this plan applies it and adds implementation detail; it re-decides nothing that is already owner-approved.

**Product model (binding restatement).** Himma is three separate products: the customer iOS/Android app (end users only), the provider/partner management website (responsive web portal), and the internal Himma admin website. Providers and Himma staff never manage businesses through the customer app. Slice 3 builds the BACKEND foundation those portals and the customer storefront read from — no portal UI is built here (W2/W3 own their surfaces). Launch is English-only; the schema keeps the docs/24 bilingual-column pattern (nullable `_ar` columns) so localization is additive, never a redesign — Arabic/RTL is not a Slice-3 blocker.

**Storefront ownership chain (binding; reaffirmed by Amendment A1).** `Organization → OrganizationPublicProfile (storefront) → Branch → future Listings/Offerings (Program, Slice 4)`. Search later operates at the listing/offering level across providers; every future listing belongs to exactly ONE provider organization, must resolve its owning organization and public storefront in one hop (`Program.organization_id` already binds this in docs/24 §1.4), and must expose a safe navigation path back to that provider's public storefront (listing payloads carry the organization id + display identity only — never private organization data). A storefront must enumerate its organization's published listings by one indexed query. Providers may later offer membership plans, individual sessions, multi-session packages, recurring classes, private/group sessions, term programs, after-school programs, and camp weeks WITHOUT changing this foundation — those are all listing-level shapes over the same spine. Slice 3 builds the ownership spine; it deliberately builds NO listing schema — §12.8 proves the spine admits the docs/24 Program shape without redesign.

---

## 1. Slice boundary

**In Slice 3:**

1. `organization` — the canonical commercial counterparty (docs/24 §1.3), with legal vs public trading identity separated.
2. `organization_public_profile` — the customer-facing storefront record, a structurally separate table so public reads can never touch private organization data.
3. `branch` — organization-owned locations with address/geo/hours/facilities and public-visibility state.
4. `staff_membership` + `staff_membership_branch` — provider staff on the canonical Himma `User` (no second authentication system), org-owned, optionally branch-scoped.
5. `staff_invitation` — single-use, expiring, digest-stored invitations (docs/24 §5.2, §7.10) through the existing `MailSender` abstraction (production sending stays disabled, D2).
6. Provider role assignments — the approved docs/23 §7 vocabulary as membership roles with a typed capability vocabulary (Slice-3-enforceable capabilities active; future-entity capabilities named but inert).
7. Organization lifecycle per docs/24 §5.1 (draft → submitted → in_review → verified/rejected → live → suspended → offboarded), database-enforced transitions, admin-actor transition API.
8. Verification-status foundation: the §5.1 state machine plus the audited admin transition API, with the D-S3-3 production safeguard — production `verified`/`live` transitions fail closed until the authoritative evidence/review capability exists (§10). (The `VerificationCase` entity and the full W3 verification workflow stay with the admin workstream per the ruling.)
9. Organization suspension/offboarding state with immediate authorization effect (the future-booking guard is a stub interface only — bookings don't exist yet).
10. Principal-context extension: `orgScope` (typed empty since B2-4) becomes a PostgreSQL-resolved provider membership context; new `provider` route-policy category in the B2-4 registry.
11. Provider HTTP/API foundation: provider-private management APIs, the admin org-lifecycle APIs, membership resolution, and the customer-public storefront read foundation — three separated surfaces (§13).
12. Audit/outbox vocabulary for every state change (§12.7).

**Outside Slice 3 (explicit):** programs/listings and the listing state machine (§5.3) · sessions/schedules · memberships/packages/pricing · availability/capacity/holds · customer bookings · provider payouts, statements, bank details (no bank/payout column exists anywhere in Slice 3) · the full provider verification workflow, `VerificationCase` entity, checklists, and document handling (admin workstream, D-S3-3) · provider-portal UI (W2) and admin-portal UI (W3) · customer storefront redesign (none needed, §15) · search/catalogue/taxonomy implementation (Slice 4) · reviews/ratings · provider expression-of-interest public page (W2) · production email delivery (D2 unchanged) · Cognito pool provisioning (docs/26 §15 unchanged).

## 2. Organization

Per docs/24 §1.3, realized as:

| Column | Notes |
|---|---|
| `id` uuid PK | Canonical organization id — the ownership root every provider-owned row FKs. |
| `legal_name` text NOT NULL | PRIVATE. The registered legal identity; never in any public read model. |
| `trade_name` text NOT NULL | The customer-facing "provider" name; mirrored into the public profile (§3). |
| `org_kind` text CHECK (`provider`) | Classification/relationship seam (D-S3-4 ruling): Organization is the ONE canonical entity; `provider` is the only value today, and later commercial classifications (`partner`, other relationships) arrive as additive CHECK widenings — with NO differing authorization behavior until a later owner-approved requirement establishes it. |
| `origin` text NOT NULL CHECK (`admin_created`) | Creation-path seam (D-S3-2 ruling): Slice 3 is admin-initiated only, but the schema never encodes that as the only possible path — future self-signup adds a value (e.g. `self_signup`) additively; Organization/PublicProfile/Branch/StaffMembership need no redesign for it (creation path is a service concern; every table is origin-agnostic). |
| `verification_state` text CHECK per §5.1 | `draft · submitted · in_review · verified · rejected · live · suspended · offboarded`. Transition trigger enforces the §5.1 edges; actor legality is service-enforced (admin vs provider-owner edges). |
| `commercial_terms_ref` uuid NULL | Structure only — commission/terms content is owner-open (docs/24 §14.B4); no semantics in Slice 3. |
| `suspended_at`, `offboarded_at` timestamptz NULL | CHECK-tied to state; `offboarded` is terminal (trigger). |
| `created_at`, `updated_at`, `version` | Slice-1 conventions; optimistic concurrency on every mutation. |

Rules: one organization per legal counterparty regardless of branch count — a multi-branch academy is ONE organization with N branches; nothing about a branch or future listing is ever modeled as its own organization. Media, description, and all customer-visible content live on the public profile (§3), not here. Ownership/admin metadata (who created it, verification decisions) is audit-trail data (`audit_event`), not columns. Retention: organizations are never hard-deleted; offboarding is a terminal state; erasure obligations touch people (staff/invitation emails), not the commercial record — `retention_class` comments per docs/24 §4.14.

## 3. Public provider profile / storefront

`organization_public_profile` — 1:1 with `organization` (PK = organization_id), created with it, holding ONLY customer-safe fields:

`display_name` (defaults from trade_name; the only name customers ever see) · `description_en` / `description_ar` (nullable) · `logo_media_ref`, `cover_media_ref`, `gallery_media_refs` (opaque media ids; asset pipeline is later work) · `public_phone`, `public_email`, `public_website`, `public_instagram` (each individually nullable — a field is public because the provider explicitly put it in THIS table; nothing defaults in) · `published` boolean NOT NULL DEFAULT false (Amendment A1/D-S3-3: the storefront's own publish switch — content readiness, controlled by the provider/admin, distinct from the organization lifecycle) · `created_at/updated_at/version`.

*Realization note:* docs/24 §1.3 lists `description`/`media_refs` on the Organization entity; this plan realizes them in the 1:1 public-profile satellite so the public/private boundary is structural rather than filtered. This is DDL-review-level realization latitude (docs/24 header: "final DDL reviewed per docs/25 §9"), not a model change — the entity's field set is unchanged.

**Hard separation (structural, not conventional):** the customer read model (§13.1) selects from `organization_public_profile` + public `branch` columns + `organization.verification_state` (for the verified indicator and liveness gate) and NOTHING else. Licence documents, bank details, payout data, internal staff, verification notes, private contacts, and administrative metadata are not excluded by filtering — they are absent from the tables the public read model is allowed to touch (most don't exist until later slices; those that do live on `organization`/`staff_*`). A structural test (§14.9) locks the public projection's column sources.

**Visibility rule (Amendment A1/D-S3-3):** a storefront is publicly readable IFF `organization.verification_state = 'live'` AND `organization_public_profile.published = true`. Existence of an organization row never makes it discoverable (§10); suspension/offboarding removes public availability through the lifecycle state regardless of the publish flag. Verified indicator: derived in the read model from state (`live` ⇒ verified badge); never a settable boolean. Ratings/reviews: later slice; the projection reserves the field names as absent-until-built (mock mapping §15).

## 4. Branch

| Column | Notes |
|---|---|
| `id` uuid PK, `organization_id` uuid NOT NULL FK | Plus `UNIQUE (id, organization_id)` — the composite-FK target that makes cross-org branch references structurally impossible (same pattern as Slice-2's session binding). |
| `label` text NOT NULL | e.g. "Khalifa Park", "Marina". |
| `address_line`, `city` text | Real address data (replaces the mock's fictional `addressLine`). |
| `area_id` uuid NULL | Column exists now; the FK to the canonical Area taxonomy table is added by the Slice-4 taxonomy migration (additive). Until then the read model serves `area_label` below. |
| `area_label` text NOT NULL | Denormalized display label ("Khalifa City") so customer reads work before the taxonomy lands; reconciled to `area_id` in Slice 4. |
| `geo_point` point NULL | Coordinates for the map surface. |
| `opening_hours` jsonb NULL | Structured weekly hours (validated shape at the service layer; display formatting is a client concern). |
| `facilities` text[] NOT NULL DEFAULT '{}' | Free-text platform-curated strings for now; vocabulary alignment is Slice-4 taxonomy work (recorded, not blocking). |
| `active` boolean NOT NULL DEFAULT true | Inactive branches vanish from public reads and future listing association; history preserved. |
| `created_at/updated_at/version` | Conventions. |

Public visibility of a branch = `active` AND owning organization `live`. Every organization must have ≥ 1 branch before it can enter `submitted` (service-enforced completeness per §5.1's "submission completeness validated"). Branches are never deleted — deactivated only (no DELETE grant).

**Future listings (supported, not built):** docs/24 fixes `Program.organization_id` + `branch_ids (≥1, same org)`. The Slice-4 join table (`program_branch(program_id, branch_id, organization_id)`) will use this slice's `UNIQUE (branch.id, branch.organization_id)` composite target so a listing can be offered at one or many branches of the SAME organization only — nothing in Slice 3 blocks or presupposes that shape beyond providing the unique key (§12.8 acceptance test).

## 5. Staff membership

`staff_membership` extends the canonical Himma `User` — provider employees authenticate exactly like every user (Cognito via the Slice-2 adapter); there is no second authentication system, no provider password table, nothing.

| Column | Notes |
|---|---|
| `id` uuid PK · `user_id` FK app_user · `organization_id` FK | Plus `UNIQUE (id, organization_id)` for scope-join FKs. |
| `role` text CHECK (§6 vocabulary) | One role per membership row (docs/24 §1.3). |
| `branch_scope_kind` text CHECK (`all` \| `branches`) | `all` = org-wide within the role's reach; `branches` = restricted to the join rows below. CHECK: org-wide-only roles (`owner`, `org_manager`, `finance`) require `all`. |
| `state` text CHECK (`active` \| `revoked`) | Canonical §1.3 set. Revocation is terminal; re-granting = a NEW membership row (clean audit). |
| `invited_by` uuid NULL FK app_user · `invitation_id` uuid NULL FK | Provenance. NULL invitation only for the admin-created founding Owner membership (§10). |
| `revoked_at`, `revoked_by` | Write-once with the transition. |
| `created_at/updated_at/version` | Conventions. |

`staff_membership_branch(membership_id, branch_id, organization_id)` — composite FKs `(membership_id, organization_id)` → membership and `(branch_id, organization_id)` → branch force every scope row inside ONE organization; a membership cannot be scoped to another org's branch even by direct SQL.

Invariants (database-enforced): partial unique — one ACTIVE membership per `(user_id, organization_id)` (multi-org membership for one user is allowed per docs/24 §1.3, one row per org) · at least one active `owner` per non-offboarded organization (trigger refuses revoking/downgrading the last owner; offboarding is the sanctioned end state) · only rows whose `branch_scope_kind='branches'` may have scope rows (trigger). Role or scope CHANGE = revoke + new row (memberships are append-only history, like admin role assignments), each audit-evented. Only an active `owner` membership manages staff (invite/revoke/role) — docs/24 §1.3; service- and test-enforced.

## 6. Provider roles

The approved docs/23 §7 / docs/24 §10.2 vocabulary, as membership `role` values:

| role | scope shape | Slice-3-active capabilities | Reserved capabilities (named now, enforced when their entities land) |
|---|---|---|---|
| `owner` | org-wide (`all`) | everything below plus: staff invite/revoke/role management, offboarding request, commercial-terms sight | payout bank details (payments slice) |
| `org_manager` | org-wide | public-profile edit, branch create/edit/deactivate, org read | listings/schedules/sessions/capacity/offers, bookings view, org reports, bulk import (Slice 4+) |
| `branch_manager` | scoped branches | branch edit (assigned branches only), org read | the org-manager set scoped to assigned branches (Slice 4+) |
| `listings_editor` | org or scoped branches | org read | create/edit/submit listings, schedules, media, import previews (Slice 4) |
| `coach` | scoped (future: assigned sessions) | org read (own membership + org public data only) | roster view (minimal PII), attendance for own sessions (booking slice) |
| `front_desk` | scoped branches | org read | today's sessions, attendance, booking lookup minimal PII (booking slice) |
| `finance` | org-wide | org read | statements, payout history, refund-impact reports (payments slice) — and NEVER catalogue mutation |

No provider read-only role exists in the approved matrix — none is invented (an addition would be an owner decision; not recommended now). Capabilities are a typed vocabulary (`provider-capabilities.ts` registry) mapped from role + scope; policies check capabilities, not role names, so Slice 4+ activates reserved capabilities without touching route policy code. Negative rules that hold from day one: `finance` cannot mutate profile/branches; `listings_editor`/`coach`/`front_desk` cannot touch staff or org settings; nobody but `owner` touches staff; no provider role grants any Himma-admin capability (§7).

## 7. Ownership and authorization

Binding rules (extends docs/26 §6; all server-side, deny-by-default):

1. Provider authority comes ONLY from an active `staff_membership` row in Himma PostgreSQL, resolved fresh per request — never from Cognito groups/custom claims, never cached, never carried in tokens.
2. Every provider-owned row carries `organization_id`; every branch-scoped row is composite-FK-bound to its organization (docs/24 §4.4). Every provider-surface query is org-scoped server-side from the resolved membership — the org id in the URL is an addressing input that must MATCH a membership, never a grant.
3. Cross-organization access is not-found-shaped: Provider A probing Provider B's resources receives the same 404-shaped response as probing a nonexistent id (docs/26 §11.2 enumeration posture) — `forbidden` is reserved for "right org, insufficient role/scope".
4. Branch scoping: a `branches`-scoped membership mutates only its scope rows' branches; Branch Manager A cannot mutate Branch B unless explicitly scoped (negative-tested).
5. Suspension/revocation bite immediately: membership revocation, organization `suspended`, and organization `offboarded` all deny on the next request (same per-request-resolution property as Slice-2 roles). Suspended organizations: provider-private reads still work (providers must see their suspended state), ALL provider mutations are refused (`organizationSuspended`), and the public storefront read vanishes (state ≠ `live`). Offboarded: terminal; mutations and public reads refused permanently.
6. Provider principals never reach Himma-admin surfaces (the `admin` policy resolves `admin_role_assignment` rows only) and admin principals hold no implicit provider membership — the two authority tables are disjoint by construction; explicit negative tests both ways.
7. Instructor (`coach`) data minimization is a capability reservation now (their Slice-3 reach is org public data + own membership) and a binding constraint on later slices (roster = minimal PII for assigned sessions only).
8. Row-level security: docs/24 §4.4 recommends RLS as a backstop. Slice 3 enforces isolation via composite FKs + mandatory service-layer org scoping + the §14 negative suite; adopting RLS additionally is recorded as a hardening evaluation item for the Slice-3 closeout commit, not silently adopted or rejected.
9. **Provider MFA (Amendment A1/D-S3-5 — production security rule, not deferrable to the portal):** PRODUCTION provider-private management access requires, at baseline: a live Himma session + an active `staff_membership` + valid organization/branch scope + **MFA enrollment and an MFA-verified session factor per the approved Slice-2 capability model** (`app_user.mfa_enrolled` true AND an MFA-verified login or a live TOTP/recovery-code `step_up_grant` — the same machinery the admin surface uses; `mfaRequired` otherwise). **Higher-risk actions additionally require a sufficiently recent step-up** (the Slice-2 recency window): inviting/removing staff · changing staff roles/scopes · organization offboarding · ownership-sensitive changes (Owner-role membership changes) — and, when the features later exist, payout-bank-detail changes and comparable financial actions. Provider-PUBLIC storefront reads remain public with no provider authentication. Dev/test exercise the full behavior through the deterministic Slice-2 fake providers; the backend policy foundation ships this rule in Slice 3 even though the portal UI is later — it is never weakened or deferred. (Operational note: production TOTP step-up itself remains gated on the §14.E′ real-pool smoke per docs/26 §15 — consistent, since no production portal exists before that validation.)

## 8. Principal-context extension

The B2-4 `RequestPrincipal.orgScope: null` slot becomes:

```
orgScope?: {
  organizationId: string;
  role: ProviderRole;
  capabilities: ProviderCapability[];   // derived, typed
  branchScope: 'all' | string[];        // branch ids
  organizationState: OrganizationState; // for suspended-read/mutation split
}
```

Resolution: a new `provider` route-policy category in the B2-4 registry. Provider routes are addressed `/provider/organizations/:organizationId/...`; the pipeline (after session liveness) resolves the caller's ACTIVE membership for that organization from PostgreSQL — no membership → not-found-shaped; suspended org + mutating method → `organizationSuspended`. The `provider` policy ALSO enforces the D-S3-5 MFA baseline (§7.9) exactly as the `admin` policy does — enrollment + MFA-verified factor, resolved fresh per request; higher-risk provider routes layer the recent-step-up requirement on top (the Slice-2 `stepUpRequired` semantics composed with the provider policy). A user with memberships in several organizations acts in exactly ONE organization per request (the addressed one) — one principal context per request (docs/24 §10.1). `GET /provider/me` (policy `authenticatedCustomer`) lists the caller's memberships so the portal can offer an org switcher without any multi-org token state. Nothing organization-shaped enters tokens.

*Consistency note (recorded, owner-visible):* docs/24 §10.1 (pre-Cognito-ruling wording) says "provider-staff tokens are org-bound; a user with multiple memberships selects one context per session". The LATER owner ruling D1/Amendment A1.1 (docs/26) forbids Himma business state in tokens — Slice 2 resolves all authority from PostgreSQL per request. This plan follows the later ruling: the org context binds per REQUEST via the addressed organization, preserving §10.1's "exactly one principal context per request" invariant while keeping tokens state-free. If the owner instead wants session-sticky org binding, it becomes a `login_session` column (still never a token claim) — flag at review if desired.

Provider assurance (Amendment A1/D-S3-5): the MFA baseline (§7.9) applies to EVERY `provider`-policy route; the higher-risk set (staff invite/remove, role/scope changes, offboarding, ownership-sensitive changes) additionally requires the Slice-2 recent-step-up window.

## 9. Staff invitation flow

Canonical lifecycle (docs/24 §5.2, §7.10): `sent → accepted | revoked | expired`.

- **Issue** (owner-role, step-up): insert invitation — org, email (PII, retention-classed), role, branch scope (validated against org branches), `token_digest` = HMAC-SHA-256 of a 256-bit CSPRNG token under the configured pepper version (identical boundary pattern to B2-6B recovery codes; raw token exists only in the issuance response/mail payload), `expires_at` = now + configured TTL, `invited_by`. The raw token travels through the existing `MailSender` capture abstraction (dev/test capture; production delivery stays disabled per D2 — no new email infrastructure).
- **Accept** (authenticated route; **D-S3-1 APPROVED rules, binding**): the caller is an authenticated Himma user (existing user signs in; a not-yet-existing user first completes normal Cognito first-login, which creates the canonical `User` — invitation acceptance never creates a parallel identity). Acceptance requires a **VERIFIED email on the accepting user's active identities whose NORMALIZED form (the Slice-2 `lower(email)` normalization) matches the invitation's normalized target email**. Explicitly: an unverified email can never accept · a display name never participates in matching · the Cognito subject alone never bypasses the email target (holding the token + a session is insufficient without the verified matching email) · **Apple private-relay users may first link and verify the invited address through the existing Slice-2 identity-linking flow, then accept** — the relay address itself will simply not match. Transaction: validate digest + expiry + state → verified-email match → CAS `sent → accepted` (single-use; the CAS admits exactly one winner under concurrent acceptance) → insert `staff_membership` active (+ scope rows) → audit + outbox `staff.joined` — one transaction (docs/24 §7.10). Wrong-user acceptance (any mismatch) → the same typed `invitationInvalid` as every other failure, revealing neither the intended recipient nor any organization information beyond what the caller already holds; the invitation stays `sent`.
- **Revoke** (owner-role): CAS `sent → revoked`; a revoked invitation's token is dead even if unexpired (single CAS answers both).
- **Expire**: TTL sweep job finalizes overdue `sent` rows (same pattern as the B2-5 role-expiry sweep: state transition + audit + outbox in one transaction; validation also refuses expired-but-unswept tokens at acceptance). Resend = a NEW invitation row (old one revoked), never a mutated token.

Failure modes normalized into ONE `invitationInvalid` outcome for: unknown token, expired, revoked, already accepted, email mismatch — no oracle distinguishing them.

## 10. Organization creation / onboarding boundary

Four distinct steps, only the middle two in Slice 3:

1. **Expression of interest** — public partnership page (docs/01 §future, W2 scope). NOT Slice 3.
2. **Organization creation** (Slice 3; **D-S3-2 APPROVED**): a Himma admin (`operations` role, existing `admin` policy surface) creates the organization in `draft` (`origin = 'admin_created'`) with its public-profile shell and issues the FOUNDING Owner invitation in the same transaction (the only membership whose `invitation_id` provenance is admin-recorded). Provider self-service registration waits for the W2 provider/partner portal specification — and the §2 `origin` seam guarantees its later arrival is additive: no redesign of Organization, PublicProfile, Branch, or StaffMembership.
3. **Verification** (Slice 3 = state machine + audited internal transition services/API foundation; **D-S3-3 APPROVED with a production safeguard**): provider owner submits (`draft → submitted`, completeness-validated: profile essentials + ≥1 branch); admin operations moves `submitted → in_review → verified | rejected`; `rejected → submitted` on resubmission. The complete `VerificationCase`, document-review queues, and admin-portal workflow remain with their owning admin workstream. **Production safeguard (fail-closed, binding):** in production, the `in_review → verified` and `verified → live` transitions REFUSE until the authoritative VerificationCase/document-review capability exists and reports ready — a capability flag in the B2-6C `AdminProductionReadiness` pattern (`verificationEvidenceCapabilityReady`), defaulting false with no bypass. There is NO production path where an administrator marks a provider verified/live without a real evidence/review record. Development/test exercise the full lifecycle deterministically.
4. **Go-live** (Slice 3): `verified → live` is an EXPLICIT admin action — never automatic — and production-gated per the D-S3-3 safeguard above. Public discoverability requires `live` AND the profile `published` flag (§3); suspension/offboarding removes public availability per §5.1. No organization becomes discoverable by existing.

## 11. Provider vs partner

**D-S3-4 APPROVED (Amendment A1):** no separate canonical Partner identity/entity in Slice 3 — `Organization` is the common canonical entity. The `org_kind` classification/relationship seam (§2) is the extensibility point through which later commercial rules may distinguish `provider`, approved `partner`, and other organization relationships — as additive CHECK widenings (+ targeted columns if a future ruling requires them). **No materially different authorization behavior attaches to `partner` until a later owner-approved requirement establishes it.**

## 12. Database design (proposed; final DDL at migration review per docs/25 §9)

**Migration `0005_provider_organizations.sql`** (one transaction, reviewed Down, Slice-1 conventions: UUIDv7, UTC, created/updated/version + shared triggers, CHECK-backed states, himma_app grants with NO DELETE anywhere):

1. Tables: `organization`, `organization_public_profile` (PK = organization_id FK), `branch` (+ `UNIQUE (id, organization_id)`), `staff_membership` (+ `UNIQUE (id, organization_id)`), `staff_membership_branch` (composite FKs both sides carrying organization_id), `staff_invitation`.
2. State CHECKs as in §2/§4/§5/§9; timestamp-state tie CHECKs (`suspended_at`/`offboarded_at`/`revoked_at`/acceptance columns each present IFF the state says so).
3. Transition triggers (B2-5/B2-6A pattern): `enforce_organization_transition` — §5.1 edges only, `offboarded` terminal, identity/provenance columns immutable · `enforce_staff_membership_transition` — `active → revoked` only, terminal immutability, write-once revocation columns · `enforce_staff_invitation_transition` — `sent → accepted|revoked|expired` only, terminal immutability, token_digest/email/role/scope immutable after insert · last-active-owner guard trigger (refuses revoking the final owner of a non-offboarded org, serialized per-organization via advisory xact lock — the B2-1 exclusivity pattern) · scope-consistency trigger (`branches` kind ⇔ scope rows; org-wide roles ⇒ `all`).
4. Uniques/indexes: partial unique active membership `(user_id, organization_id) WHERE state='active'` · unique `token_digest` · partial index for the public read (`verification_state='live'`, joined with `published=true` on the profile — the A1 visibility rule) · `branch (organization_id, active)` · `staff_membership (organization_id, state)` · `staff_invitation (organization_id, state, expires_at)`.
5. Optimistic concurrency: every mutable table via the shared version trigger; service CAS on version for provider-facing mutations (profile/branch edits) exactly as Slice-2 does.
6. Grants: `SELECT, INSERT, UPDATE` to `himma_app`, no DELETE; invitation email pseudonymization on erasure (retention-classed comments per docs/24 §4.14); audit/outbox append-only unchanged.
7. Audit actions (`auth.`→`org.` namespace): `org.created`, `org.submitted`, `org.review_started`, `org.verified`, `org.rejected`, `org.went_live`, `org.suspended`, `org.reinstated`, `org.offboarded`, `org.profile_updated`, `org.profile_published`, `org.profile_unpublished`, `org.branch_created/updated/deactivated`, `org.staff_invited`, `org.staff_joined`, `org.staff_revoked`, `org.invitation_revoked/expired` — each with a same-transaction outbox event (`organization.*`, `staff.*` aggregate = organization; ids-only payloads, invitation emails NEVER in payloads).
8. **Forward-compatibility acceptance (structural test, not implementation):** a scratch-schema test proves the docs/24 Program shape (`organization_id` FK, `program_branch` join with same-org composite FKs) attaches to this slice's keys with zero alteration to Slice-3 tables.
9. `SCHEMA_CHECKS`/`db:verify` extended; codegen regenerated; migrate-from-zero + rollback per policy.

## 13. API contracts (three separated surfaces; TypeBox; every route policy-declared; no field-switching endpoints)

**13.1 Customer-public storefront read foundation (policy `public`; no provider authentication of any kind):**
- `GET /providers/:organizationId` → the public projection ONLY: display name, description, media refs, verified indicator, public contact fields, active branches (label, area label, address line, geo, hours, facilities). Served exclusively from `organization_public_profile` + public `branch` columns; orgs that are not (`live` AND `published`) are not-found-shaped (A1 visibility rule, §3). Listings composition, ratings, and search integration arrive with Slice 4 — the projection is forward-shaped for them (absent fields, not fake ones).

**13.2 Provider-private management (policy `provider` + capability; org-addressed; suspended-org mutation refusal; D-S3-5 MFA baseline on EVERY route below, with the higher-risk set additionally step-up-gated):**
- `GET /provider/me` (`authenticatedCustomer`) → membership list (org id, display name, role, branch scope, org state).
- `GET /provider/organizations/:orgId` → private management record (org + profile + branches + own capabilities). NOT the public projection.
- `PATCH /provider/organizations/:orgId/profile` (capability `profile.edit`; CAS version).
- `POST /provider/organizations/:orgId/submit` (owner; §5.1 draft/rejected → submitted).
- `POST /provider/organizations/:orgId/branches` · `PATCH .../branches/:branchId` · `POST .../branches/:branchId/deactivate` (capability `branches.manage`, branch-scope-checked; CAS).
- `GET /provider/organizations/:orgId/staff` (owner) · `POST .../staff/invitations` (owner, + recent step-up) · `POST .../staff/invitations/:id/revoke` (owner, + recent step-up) · `POST .../staff/memberships/:id/revoke` (owner, + recent step-up) — the D-S3-5 higher-risk set; role/scope changes (revoke + new membership) and the future offboarding-request route carry the same step-up requirement.
- `POST /provider/invitations/accept` (`authenticatedCustomer`; body = token; §9 acceptance transaction).
- Typed outcomes added: `organizationSuspended`, `invitationInvalid`, `lastOwnerProtected`, plus the existing vocabulary (`forbidden`, `staleVersion`, not-found-shaping per §7.3).

**13.3 Himma-admin org lifecycle (existing `admin` policy surface; production admin gate unchanged from B2-6C):**
- `POST /admin/organizations` (operations role) → draft org + profile shell + founding Owner invitation (one transaction).
- `POST /admin/organizations/:orgId/verification/(start-review|verify|reject)` · `POST /admin/organizations/:orgId/(go-live|suspend|reinstate|offboard)` — §5.1 admin edges, CAS + typed outcomes, each audit/outbox-evented. **`verify` and `go-live` are production-fail-closed behind `verificationEvidenceCapabilityReady` (D-S3-3 safeguard) — refused in production until the admin workstream's evidence/review capability exists; dev/test deterministic.** Checklist/document tooling deferred to that workstream.

Admin and provider surfaces never share endpoints or schemas with the public read; the three surfaces have three read models.

## 14. Testing / acceptance (real PostgreSQL, Fastify injection, deterministic adapters; docs/24 §13 row 3 cells included)

1. Migrate-from-zero, rollback, `db:verify`, codegen drift — the Slice-2 battery extended.
2. §5.1/§5.2 machines: every legal edge; every illegal edge refused at trigger level; `offboarded`/`revoked`/terminal immutability; concurrent verification decisions → single CAS winner.
3. **Organization isolation:** org-A staff reading/mutating ANY org-B resource → not-found-shaped, proven per route; direct-SQL cross-org scope rows refused by composite FKs.
4. **Branch isolation:** branch-scoped manager mutating an unassigned branch → `forbidden`; scope rows crossing orgs → FK refusal.
5. Membership: one active membership per user+org (concurrent double-invite acceptance → one membership); revocation denies on next request; last-owner revocation refused; role-change-by-new-row audit trail.
6. Invitation races and D-S3-1 binding: concurrent acceptance of one token → exactly one winner; revoked/expired/accepted/mismatched-email all → byte-identical `invitationInvalid` (no organization detail leaked); an UNVERIFIED matching email cannot accept; a matching display name with a different email cannot accept; a valid session + token WITHOUT the verified matching email (Cognito-subject-only) cannot accept; an Apple private-relay user who links + verifies the invited address through the Slice-2 flow THEN accepts succeeds; expiry sweep idempotent + evented (B2-5 expiry pattern).
7. Suspension: suspended org → provider mutations refused, provider reads allowed, public read 404-shaped, staff unaffected in other orgs; offboarded → terminal everywhere.
8. Authorization matrix: every role × every Slice-3 route (capability grid); customer (no membership) → provider routes not-found-shaped; provider staff → every `/admin/*` route `forbidden` (no admin rows); admin principal → provider-private routes refused without membership; Cognito claims grant nothing (existing guard extended). **D-S3-5:** a provider staffer WITHOUT MFA enrollment/assurance → `mfaRequired` on every management route; MFA-assured but stale on a higher-risk route → `stepUpRequired`; fully assured + recent step-up → passes (dev/test via deterministic adapters); public storefront reads need no authentication at all.
9. **Public/private separation:** structural test locks the §13.1 projection to `organization_public_profile` + public branch columns; response-shape test proves no legal_name, no private field, no staff data in any public payload; orgs that are not (`live` AND `published`) not-found-shaped, including live-but-unpublished and published-but-suspended.
9b. **D-S3-3 production safeguard:** a production-configured app refuses `verify`/`go-live` transitions while `verificationEvidenceCapabilityReady` is false (typed refusal, audited attempt); dev/test transitions work deterministically; no bypass path exists (structural test on the gate flag defaulting false).
10. Secret/PII hygiene: invitation raw tokens never persisted (digest sweep, B2-6B pattern); invitation emails absent from audit/outbox payloads; no bank/payout/licence column exists anywhere (schema scan).
11. §12.8 forward-compatibility: scratch Program/program_branch attach test.
12. Route-policy inventory snapshot re-run (+ new `provider` category); undeclared route still refuses registration.

## 15. Migration compatibility (mock → production mapping; target: zero customer-screen redesign)

Per docs/24 §12 (already owner-approved) plus this slice's split:

| Mock (customer app today) | Production home | Class |
|---|---|---|
| `Provider.id` | `organization.id` | direct |
| `Provider.name` | `organization_public_profile.display_name` (backed by `trade_name`) | direct |
| `Provider.verified` | derived: `verification_state = 'live'` (+ badge semantics) | calculated |
| `Provider.rating` | reviews read-model (later slice) | mock-only until reviews |
| `Provider.categories: string[]` | derived from published programs via taxonomy join (docs/24 §12; storefront already renders taxonomy-joined `categories`) | mock-only field |
| `Provider.areaId` | primary branch `area_id`/`area_label` | calculated (from branches) |
| `ProviderBranch.{id,label,areaId}` | `branch.{id,label,area_id/area_label}` | direct |
| `ProviderBranch.addressLine` (fictional) | `branch.address_line` (real) | direct (content replaced) |
| `ProviderBranch.openingHours` | `branch.opening_hours` (structured; client formats) | extended |
| `ProviderDetailExtras.description` | `organization_public_profile.description_en` | direct |
| `ProviderDetailExtras.coverImageKey` | `cover_media_ref` (media pipeline later) | extended |
| `ProviderDetailExtras.facilities` | `branch.facilities` | direct (moves org→branch level; the storefront already renders per-selected-branch) |
| `ProviderDetailExtras.team` | future instructor public profiles (session slice) | mock-only until then |
| `ProviderDetailExtras.policyId` | `organization.default_policy_refs` semantics (policy templates slice, docs/24 §2.7) | mock-only until policies |
| `ProviderStorefrontPage` composition (program groups, eligibility, offers) | Slice-4 listing read models composed WITH this slice's storefront projection | Slice 4 |
| `monogram` (fictional logo) | `logo_media_ref` when real assets exist; monogram stays the client fallback | unchanged behavior |

**No approved customer screen requires redesign.** The storefront screen consumes `DetailsService.getProviderStorefrontPage` behind a typed contract; the production implementation swaps mocks per the frontend-first rule. `team` and `rating` render conditionally already (absent-safe). No contradiction found.

## 16. Implementation commit sequence (one concern per commit; stop for owner approval after each; do NOT execute now)

| # | Commit | Scope | Acceptance / verification (proportional) |
|---|---|---|---|
| S3-1 | `feat(backend): provider organization schema` | Migration 0005: organization (incl. `org_kind` + `origin` seams) + public profile (incl. `published`) + branch, §5.1 machine, triggers, grants, codegen, SCHEMA_CHECKS | Machine edge tests, isolation FKs, public/private structural split incl. the (`live` AND `published`) visibility rule, §12.8 forward-compat test; backend tsc/lint/focused jest + migrate-from-zero + `db:verify` + rollback → **stop** |
| S3-2 | `feat(backend): staff memberships and invitations` | staff_membership(+branch scope) + staff_invitation tables (same migration file if S3-1 unapplied, else 0006), §5.2 machine, last-owner guard, invitation services (issue/accept/revoke/expire sweep) with token-digest boundary + MailSender capture + the D-S3-1 verified-email acceptance rules, audit/outbox | §14.5–6 races + D-S3-1 matrix (unverified/display-name/subject-only/private-relay cases) + hygiene; focused suites green → **stop** |
| S3-3 | `feat(backend): provider principal and management routes` | `provider` policy category incl. the D-S3-5 MFA baseline + higher-risk step-up composition, orgScope resolution, capability registry, §13.2 routes, typed outcomes, rate limits | §14.3–4, §14.8 matrix incl. the D-S3-5 rows, policy snapshot; full backend suite → **stop** |
| S3-4 | `feat(backend): admin org lifecycle and public storefront read` | §13.3 admin routes (existing admin policy + production gate) incl. the D-S3-3 `verificationEvidenceCapabilityReady` fail-closed gate on verify/go-live, §13.1 public projection route | §5.1 admin-edge route tests, §14.7 suspension matrix, §14.9/§14.9b projection lock + production-safeguard tests; full backend suite → **stop** |
| S3-5 | `chore(backend): slice 3 hardening and closeout` | Bounded isolation/authz hardening review (incl. the RLS evaluation, §7.8), docs/27 §15-style status section, HANDOFF | Full Slice-3 certification: backend tsc/lint/full jest, migrate-from-zero, `db:verify`, codegen drift, root non-regression → milestone report, **stop before Slice 4** |

## 17. Owner decisions

**RESOLVED by the owner rulings of 2026-08-07 (Amendment A1):**
- **D-S3-1 · Invitation acceptance binding — DECIDED:** normalized VERIFIED-email match required; unverified emails, display names, and Cognito subject alone never accept; private-relay users link+verify first; failures reveal nothing; tokens stay single-use and concurrency-safe (§9).
- **D-S3-2 · Organization creation path — DECIDED:** admin-initiated in Slice 3, with the `origin` schema seam so future self-registration (specified with the W2 portal) is additive — no redesign of Organization/PublicProfile/Branch/StaffMembership (§2, §10).
- **D-S3-3 · Verification boundary — DECIDED with a production safeguard:** Slice 3 owns the lifecycle states, transition rules, and audited internal transition services/API foundation; `VerificationCase`/document-review/admin-portal workflow stay with the admin workstream; production `verified`/`live` transitions fail closed behind `verificationEvidenceCapabilityReady` (default false, no bypass) until that capability exists; dev/test deterministic; discoverability = `live` AND `published` (§3, §10, §13.3).
- **D-S3-4 · Partner classification — DECIDED:** no separate canonical Partner entity; Organization is the common entity with the extensible `org_kind` classification/relationship seam; no differing authorization behavior for `partner` until a later owner-approved requirement (§2, §11).
- **D-S3-5 · Provider MFA — DECIDED (revises the draft recommendation):** production provider-private management requires MFA at baseline (live session + active membership + valid scope + Slice-2 MFA enrollment/assurance); higher-risk actions (staff invite/remove, role/scope changes, offboarding, ownership-sensitive changes; later payout-bank-detail changes) additionally require recent step-up; public storefront reads stay public; the backend policy foundation ships this in Slice 3 without weakening (§7.9, §8, §13.2).

**Configurable values (defaults in code, env-tunable; no owner blocking):** invitation TTL (default 7 days) · invitation token pepper version/value (secret-store boundary, fails closed in production like B2-6B) · invitation resend/rate limits · provider-route rate limits · storefront read cache headers.

**Can wait for Slice 4 / catalogue:** Area taxonomy FK + facilities vocabulary reconciliation · listing↔branch join · storefront listing composition + search integration · category derivation.

**Can wait for the provider portal UI (W2):** expression-of-interest page + self-signup (D-S3-2 seam ready) · org switcher UX · bulk tooling · any read-only role addition · design-partner-driven contract adjustments (docs/23 §8.6 gates provider-API freeze). *(Provider MFA is NOT on this list — D-S3-5 resolved it as a Slice-3 backend rule, §7.9.)*

**Explicitly NOT decided here (later slices own them):** commercial commission/terms content (§14.B4) · payout cadence/bank details · listing taxonomy · membership/package structures · review/rating mechanics · provider-partner commercial terms.

---

*This plan writes no code and provisions nothing. Implementation begins only after owner approval, commit by commit per §16, within the docs/23 §16 phase gates. Production identity activation items (docs/26 §15) remain independent operational work.*
