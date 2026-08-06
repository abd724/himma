# 26 — Backend Slice 2 Plan: Identity and Authorization

Status: **approved in structure by the product owner at `d2074ce`, subject to the final rulings applied as Amendment A1 below; awaiting final owner approval. No implementation has started.** Prepared 2026-08-06 after Slice 1 approval (`d9b5fff`). Governing documents: docs/24 (approved canonical model — §1 identity spine, §10 authorization, §13 slice 2 row), docs/25 (binding backend engineering contract), docs/23 §7 (authorization authority), docs/02 (accounts/participants), docs/09 §§21–22 (frontend owner decisions this slice must stay compatible with). Nothing here starts implementation: §13's first commit begins only after final approval of this amended plan.

**Amendment A1 (2026-08-06, final owner rulings D1–D4 — documentation-only, applied in place):**

1. **D1 — Amazon Cognito User Pools** is Himma's managed authentication provider, implemented behind the planned `AuthProviderAdapter`. Cognito authenticates credentials, federates Apple/Google, provides TOTP MFA, and issues/rotates/revokes authentication tokens. **Himma PostgreSQL remains canonical** for `User`, `AuthIdentity`, `CustomerAccount`, participants, staff memberships, admin role assignments, account status, and every business authorization decision; Cognito groups/custom claims are never authoritative business-role storage; identity matching is provider **issuer + subject**, never silent email merges; the adapter boundary keeps the provider replaceable. Token architecture revised (§4): **no second Himma-owned refresh-token family**; Himma keeps `LoginSession`/device records keyed to normalized provider session identifiers (issuer, subject, `origin_jti`) and the per-request Himma liveness/status/authorization check. **The production region is unresolved: no production user pool is hardcoded or provisioned by this plan; the AWS UAE-region health situation and the identity disaster-recovery strategy are recorded as open under the docs/23 §18.3 hosting/data-residency decision.**
2. **D2 — Email sequencing confirmed:** email/password, verification, reset, and recovery **contracts stay in Slice 2**; development/test use a non-delivering captured `MailSender`; production email sending stays disabled until the identity region and email-delivery service are approved; production email-provider selection blocks neither the schema nor the provider-independent core.
3. **D3 — Production bootstrap approved** as a one-time audited CLI (§7.5): zero-admin precondition, two existing verified users, exactly two initial Access Administrators created in one transaction, explicit bootstrap secret + confirmation phrase + reviewed manifest, audit + outbox events, permanent self-sealing, structurally incapable of creating a universal super-admin; development/test seeding is a separate mechanism.
4. **D4 — Role exclusivity enforced** (§7.4, §8.7): Access Administrator ∦ Finance Administrator; Platform Engineer ∦ any business-admin role; Auditor ∦ any mutating platform role; finance-capable grants require distinct requesting and approving Access Administrators.

Corrected sections: §§1, 2, 4, 5 (consistency), 7.4–7.5, 8, 9, 10, 11, 13, 14.

## 1. Slice boundary

**Slice 2 implements** (docs/24 §13 row 2, expanded):

1. **User** — the authentication principal (docs/24 §1.1), with status (`active` \| `locked` \| `deleted`) and version.
2. **AuthIdentity** — Apple, Google, and email identities linked to one User; email/password credential storage for the email provider.
3. **CustomerAccount** — one per adult customer (docs/02 §1), created on first customer sign-in/registration.
4. **Adult self-participant creation** — the `Me` participant row created atomically with the account (docs/24 §1.2). Slice 2 creates only the `self` participant; full participant CRUD (children) remains Slice 5.
5. **Login sessions and provider-token liveness** (Amendment A1.1) — Himma-owned session/device inventory keyed to normalized provider session identifiers, per-request liveness checks, logout/forced revocation; access/refresh token issuance, rotation, and revocation are Cognito's, mediated by the adapter (§4). No Himma-owned refresh-token family exists.
6. **Account status and revocation** — lock/suspend/unlock with immediate session revocation; deletion *request* recording (the full erasure workflow is a later data-subject deliverable, docs/24 §6.14).
7. **Provider/admin identity foundations** — the principal-context model carries admin roles now and organization/branch staff scopes as typed empty slots for Slice 3; staff logins themselves arrive with StaffMembership (Slice 3). *Reconciliation with docs/24 §13 row 2's "token org-binding" acceptance item:* organizations do not exist until Slice 3, so Slice 2 delivers the org-binding **mechanism** (claims shape, principal slot, and the enforcement point that refuses any org-scoped request whose token lacks a scope) with a structural test, and Slice 3 proves it against real StaffMemberships — recorded here rather than silently narrowed.
8. **AdminRoleAssignment** — access-administrator grants with dual approval for finance-capable roles (docs/24 §1.4), plus the audited bootstrap procedure (§7.5).
9. **Principal-context middleware** — per-request authentication → principal resolution → deny-by-default route authorization (§6).
10. **Authentication/authorization audit events** — every grant, denial, login, revocation, and sensitive access as append-only `audit_event` rows plus outbox events (§8.9).
11. **Provider/admin MFA foundation** — TOTP enrolment/challenge + recovery codes, mandatory for admin principals from day one (docs/23 §7); wired so Slice-3 staff logins inherit it unchanged.

**Explicitly outside Slice 2:** provider organizations and branches (Slice 3) · provider business roles tied to real organizations (Slice 3) · catalogue (Slice 4) · participants beyond `self` (Slice 5) · sessions/availability, holds, bookings (Slices 6–7) · payments (W5; docs/23 §19 stands) · provider/admin portal screens (W2/W3) · customer onboarding/auth UI changes (W1 milestone, later; §12) · production email/SMS delivery **except as the selected authentication approach requires** (§14.D2: flows are built against a `MailSender` port with a dev capture implementation; a production provider is selected before production enablement, not before implementation) · WebAuthn/passkeys (recorded future option) · SSO for admin staff (future option).

## 2. Authentication-provider decision (owner decision §14.D1 — **resolved: Amazon Cognito**, Amendment A1.1)

**Non-negotiable regardless of choice (docs/24 §1.1, owner constraint):** Himma's PostgreSQL `User`, `AuthIdentity`, `CustomerAccount`, staff, and role records are canonical. Any external provider only *proves who is at the keyboard*; it never owns identities, roles, scopes, sessions-of-record, or authorization. All authorization is Himma-server-side (docs/24 §10).

| Criterion | A · Managed identity provider (Auth0/Clerk/WorkOS class) | B · Cloud-platform-native (Cognito / GCP Identity Platform class) | C ★ · Self-managed authentication (direct OIDC validation + own email/password) |
|---|---|---|---|
| Email/password | Hosted flows, hosted reset | Hosted, less polished | Own implementation: argon2id, enumeration-safe flows (§5) — the real build cost of C |
| Sign in with Apple / Google | Built-in | Built-in | Direct token validation (JWKS-verified `id_token`, nonce) — small, standard, well-documented surface |
| Provider/admin MFA | Built-in TOTP | Built-in | TOTP via standard library + recovery codes (§5.9) |
| Mobile + future web portals | SDKs both | SDKs both | Native flows call Apple/Google SDKs directly; backend verifies tokens — no vendor SDK in the app |
| **UAE hosting / data residency** | Second residency problem: identity PII lives in the vendor's regions; UAE-region guarantees vary by vendor/tier — entangles the open docs/23 §18.3 hosting decision | Region-pinnable but **binds the platform to one cloud before §18.3 is decided** | Identity data lives only in Himma's PostgreSQL — residency follows the §18.3 decision automatically, nothing extra to negotiate |
| Account linking | Vendor linking model must be mirrored/reconciled into Himma's canonical records — two sources of truth to keep honest | Same reconciliation burden | One linking model, in Himma's schema, exactly as §3 specifies |
| Vendor lock-in | High: user store + flows + tokens; migration = password-hash export negotiations and forced relink | Medium-high: cloud + service coupling | None beyond Apple/Google's own OIDC (unavoidable in every option) |
| Cost | Per-MAU pricing; meaningful at Tier-2 (150k customers, docs/23 §11) | Modest per-MAU | Engineering time now; no per-user fees |
| Operational complexity | Low day-1; vendor outage = login outage outside Himma's §10.11 recovery control | Medium | Highest day-1 (secure flows are Himma's responsibility); fully inside Himma's own SLOs, load gates, and DR classes |

**DECIDED (owner ruling D1, 2026-08-06 — Amendment A1.1): Amazon Cognito User Pools**, a cloud-platform-native option in the comparison above, selected by the owner over this plan's original self-managed recommendation (the table stands as the decision record). Binding boundaries:

- **Cognito's job:** credential authentication (email/password), Apple/Google federation, TOTP MFA execution, and issuing/rotating/revoking authentication tokens.
- **Himma PostgreSQL stays canonical** for `User`, `AuthIdentity`, `CustomerAccount`, participants, staff memberships, `AdminRoleAssignment`, account status, and **every business authorization decision**. Cognito groups and custom claims are never authoritative business-role storage; the principal context (§6) is built from Himma's tables, and a token claim can never grant a Himma role (§11.10).
- **Identity matching is provider issuer + subject** (§3); accounts are never silently merged by email.
- **The `AuthProviderAdapter` boundary is preserved** so the provider remains replaceable: only `src/modules/identity/providers/cognito/*` may import Cognito SDKs or reference pool endpoints. The adapter exposes token validation (JWKS), sign-in/refresh/revocation mediation, MFA enrolment/challenge mediation, and normalization of provider errors into the §10 typed vocabulary; sessions-of-record, principal context, authorization, admin roles, dual control, audit, and every §8 table are Himma-owned and survive a provider switch with only the adapter and route internals changing.
- **Production region and identity disaster recovery are OPEN** (recorded, not guessed): no production user pool is hardcoded or provisioned by this plan; the AWS UAE-region health situation and the identity DR strategy (pool backup/export limits, cross-region posture, RTO/RPO class per docs/23 §10.11) are decided under the docs/23 §18.3 hosting/data-residency decision before production enablement. Implementation uses a non-production development pool (region and AWS account setup recorded in §14.E′) plus a deterministic fake adapter for tests (§11).

## 3. Identity and account rules

1. **One canonical User, many linked AuthIdentities.** Unique `(provider, subject)`; a subject can never attach to two Users. Login resolves identity → User; a User with `status ≠ active` cannot authenticate.
2. **Matching is by provider subject, never by email.** Emails are attributes; the `sub` claim is the identity.
3. **Apple private-relay addresses** are stored verbatim as the identity's email (verified — Apple asserts it), flagged `is_private_relay`. They are excluded from any email-based duplicate detection or linking suggestions (a relay address proves nothing about other accounts) and are usable for transactional mail while Apple's relay forwards.
4. **Verified vs unverified email.** Email identities start unverified; Apple/Google emails are verified per the provider's claim (`email_verified`). Unverified email identities may browse-as-guest-equivalent only: **booking/checkout-capable actions and linking require a verified email** (configurable gate, §14.C). Verification is challenge-based (§5.2).
5. **Duplicate-email behavior.** One *verified* email may belong to at most one User (partial unique index, §8.2). Registering with an email that is already a verified identity fails **enumeration-safe** (§5.5: the API returns the same "check your inbox" response; the mail sent is a "you already have an account" notice, not a verification link). An Apple/Google sign-in whose verified email matches an existing User's verified email does **not** auto-merge: it returns `accountLinkConflict` guidance — sign in with the existing method, then link explicitly (§3.6). No silent merges, ever.
6. **Linking** requires an authenticated session **plus step-up reauthentication** (§3.10) and, for OIDC, a fresh provider token proving present control of the identity being linked. `identityAlreadyLinked` when the subject already belongs to any User.
7. **Unlinking** requires step-up and is refused when it would leave the User without a usable login method (`lastLoginMethod` error). Unlinked identity rows are ended (status), not deleted — audit history survives.
8. **Disabled / suspended / deleted.** `User.locked` (security lock: too many failures, admin action) and `CustomerAccount.suspended` (business action, docs/24 §1.2) both: refuse new logins with `accountSuspended` (one shared, non-specific customer message) and revoke all sessions in the same transaction (§9.8). `deletion_requested` records the data-subject request; erasure/pseudonymization execution is the later retention deliverable (docs/24 §6.14).
9. **Customer account creation.** First customer authentication (any provider) creates User + AuthIdentity + CustomerAccount + the **`self` participant** in one transaction (§9.1). The one-`self`-per-account invariant is the Slice-1-style partial unique index (§8.3). **Child accounts and child logins remain prohibited** (docs/02, docs/24 §1.2): participants are never principals, no identity may reference a participant, and nothing in this slice creates a login for anyone but an adult account holder.
10. **Recovery and reauthentication.** Email-identity recovery = enumeration-safe reset flow (§5.6). Apple/Google-only Users recover through their provider; a support-assisted recovery path (verified manually by support with audit) is deliberately **not** built in Slice 2 and is recorded as a later support-tooling item (§14.E). **Step-up reauthentication** (fresh password/OIDC/MFA proof, max-age configurable) is required for: linking/unlinking, password change, MFA enrolment/removal, session-inventory revocation of *other* devices, deletion request, and (admins) role administration.

## 4. Session and token architecture

*(Revised throughout by Amendment A1.1 — Cognito issues and rotates tokens; Himma owns sessions-of-record, liveness, and all business authorization.)*

1. **Access tokens:** Cognito-issued JWTs, short-lived (TTL configured on the pool, §14.C). Every request is validated **through the adapter**: signature against the pool's JWKS (cached, kid-rotation aware), `iss`/`aud`/`exp`/`token_use` checks, then issuer + subject resolution to `auth_identity` → `app_user`. **Himma mints no parallel access token.**
2. **Refresh tokens:** Cognito's, with **Cognito refresh-token rotation and revocation** as the sole refresh mechanism. **There is no second Himma-owned refresh-token family, and no refresh token — raw or hashed — is ever stored in PostgreSQL** (client-held only; §4.7 storage rules). The prior §8.5 refresh-token table is removed from the schema (§8).
3. **Rotation/replay semantics** are provider-owned: Cognito rotation invalidates prior refresh tokens and its revocation invalidates the session's token chain. The adapter normalizes provider reuse/revocation failures to the typed `tokenReplayDetected`/`sessionExpired` outcomes (§10), and every such event is audit-evented by Himma; Himma's own revocation authority is the session liveness check (§4.6–4.7).
4. **Device/session inventory (Himma-owned):** every login creates a Himma `login_session` row keyed to the **normalized provider session identifiers — issuer, subject, and `origin_jti`** — plus client kind (`customer_app` \| `admin_portal` \| `provider_portal` future), a coarse device label, created/last-used timestamps, and an IP-address digest (no raw IPs at rest; §8.4). Refreshed Cognito access tokens carry the same `origin_jti`, so the session row tracks the whole provider session. `GET /auth/sessions` lists them; principals see only their own.
5. **Logout:** one device or all devices = revoke the matching Himma `login_session` row(s) in one transaction (immediate liveness denial, §9.6), then request Cognito token revocation through the adapter — a network call strictly **after** the transaction (docs/25 §4); if the provider call fails, Himma liveness already blocks the session and the revocation is retried.
6. **Forced revocation:** admin lock/suspend, password change/reset, and MFA reset revoke Himma sessions in-transaction (§9.8) with provider revocation following per §4.5; a still-unexpired Cognito JWT is refused by the liveness check on its next request.
7. **Per-request Himma liveness check (retained unchanged):** after adapter validation, every request performs the Himma-side lookup — `login_session` live (by issuer/subject/`origin_jti`), `app_user`/`customer_account` status active, principal context built **only** from Himma PostgreSQL (§6). Cognito groups/claims never short-circuit this; business authorization is server-side and database-backed, always.
8. **Mobile storage expectation (W1, later):** Cognito access + refresh tokens in `expo-secure-store` (docs/12 §2); never AsyncStorage, never JS-visible globals beyond memory.
9. **Future web portals (W2/W3):** refresh tokens ride **Secure, HttpOnly, SameSite=Strict cookies** scoped to the auth path; access tokens stay in memory. **CSRF:** SameSite=Strict plus a double-submit/custom-header check on every cookie-authenticated mutation. Concrete cookie/CSRF wiring lands with the first portal (§14.E).
10. **Expiry and inactivity are configurable values (§14.C):** pool-side access/refresh TTLs plus Himma-side session inactivity window, absolute session lifetime, and step-up max-age — environment/pool configuration with safe defaults, never literals in code (docs/25 §5).

## 5. Authentication security

*(Consistency note, Amendment A1.1: under D1, credential storage/verification (item 1), federated token validation mechanics (item 7), and TOTP execution (item 8) run inside Cognito, mediated by the adapter. Himma retains in full: its own rate limiting and lockout policy on its API surface, enumeration-safe response contracts, challenge sequencing via the `MailSender` port per D2, recovery-code policy, step-up policy, and all §5.10 audit obligations.)*

1. **Password hashing:** provider-managed (Cognito) under D1 — no password hash column exists in Himma PostgreSQL (§8.2). Passwords transit only the identity module's adapter calls; never logged, never in audit payloads (docs/25 §7). (The original argon2id specification is retained in git history as the self-managed fallback should the provider ever be replaced.)
2. **Email verification:** single-use, hashed, expiring challenge codes/links (§8.5); consuming is CAS-atomic; resend is rate-limited.
3. **Login throttling and rate limiting:** per-identity and per-IP-digest counters with exponential backoff and temporary lock (`User.locked` after the configured threshold, §14.C); rate limits on register/login/refresh/reset per docs/23 §10.7. Implemented server-side in Slice 2 (the API gateway/WAF layer of W6 adds defense-in-depth later).
4. **Credential-stuffing protection:** the above throttles plus breach-list rejection of known-compromised passwords (offline k-anonymity list, no external call at login time — the list ships as data; refresh cadence configurable) and audit-evented velocity alerts.
5. **Enumeration-safe responses:** register, resend-verification, and reset-request always return the same accepted response; login returns one `invalidCredentials` for unknown identity *and* wrong password; timing is equalized (hash always runs). §10's schemas encode this.
6. **Secure reset flow:** adapter-mediated Cognito reset with Himma's enumeration-safe API contract on top; completing a reset revokes all Himma sessions (§9.6 variant) with provider revocation following (§4.5), and emits audit + outbox events. Reset never confirms account existence. Delivery follows D2: `MailSender` capture in dev/test; production sending disabled until the identity region and email service are approved.
7. **Apple/Google token validation:** verify `id_token` signature against the provider JWKS (cached, kid-rotation aware), `iss`, `aud` (Himma's client ids), `exp`, and **nonce** binding to the client-generated value; native-app flows use the platform SDKs with nonce; any future web OAuth flow uses `state` + **PKCE**. Provider JWKS fetches happen outside DB transactions (docs/25 §4).
8. **Provider/admin MFA:** TOTP (RFC 6238) mandatory for admin principals: enrolment (QR/secret, confirm with a valid code) → challenge at every login and at step-up. Secrets encrypted at rest with an application key from the secret store (never plaintext, never the signing key).
9. **Recovery codes:** ten single-use codes issued at MFA enrolment, stored hashed, each use audit-evented; regeneration invalidates the old set and requires step-up.
10. **Security-event auditing:** every authentication outcome that matters — login success/failure (by class, no credential detail), lockout, verification, reset request/consume, link/unlink, MFA enrol/challenge success/failure/recovery-code use, session revocations, replay detections, role grant/approve/deny/revoke — is an append-only `audit_event` row; state-changing ones also emit outbox events (§8.9). PII in audit payloads is limited to opaque ids (docs/25 §7).

## 6. Authorization foundation

**PrincipalContext (resolved per request, exactly one):**

```
{ kind: 'guest' | 'customer' | 'admin' | 'provider_staff'(Slice 3) | 'system',
  userId?, sessionId?, accountId?,            // customer
  adminRoles?: AdminRole[],                   // admin
  orgScope?: { organizationId, role, branchIds } // typed now, populated Slice 3
  assurance: 'none' | 'single_factor' | 'mfa',
  stepUpAt?: timestamp,                       // recent reauthentication proof
  breakGlass?: { ticketRef, expiresAt } }     // typed now; grant flow is W6/ops, not Slice 2
```

**Layer boundaries (binding, extends docs/25 §10):**

| Layer | Responsibility | Never does |
|---|---|---|
| **Authentication** (middleware) | Verify token signature/expiry, load + liveness-check the session | Business rules, role checks |
| **Principal resolution** (middleware) | Build the PrincipalContext from User/account/roles/scopes; exactly one context per request | Grant anything; guess anything |
| **Authorization policy** (route declaration) | Every route declares its requirement (`public`, `customer`, `admin(role…)`, `assurance`, `stepUp`); **a route without a declaration fails closed at registration time** — deny-by-default is structural | Resource-level ownership checks |
| **Business-module enforcement** (service layer) | Ownership/scope checks against the resource (own account, own session; org/branch in Slice 3), dual-control presentation, PII tiering | Re-authenticate; trust route-layer checks alone |

Client UI state remains convenience only (docs/24 §10); every rule above is server-side.

## 7. Admin role assignments

1. **Roles** (docs/24 §10.2): `operations`, `support`, `finance`, `access_admin`, `auditor`. Finance-capable set (dual approval required): `finance`, `access_admin` (§14.C makes the set configuration-visible, not hard-coded in checks).
2. **Grant flow:** an `access_admin` **requests** a grant (target user, role, optional expiry) → for finance-capable roles a **different** `access_admin` approves → activation. Non-finance-capable roles activate on request by a single access administrator (docs/23 §7). `requested_by ≠ approved_by` is a database CHECK (§8.7), presented by the service with two distinct authenticated admin principals — no service-level bypass (docs/25 §10).
3. **Lifecycle:** `requested → active → revoked | expired`; denial of a request is recorded (`denied`), never deleted. Expiry is enforced at principal resolution (an expired assignment resolves to no role) *and* swept by a job.
4. **No universal super-admin; role exclusivity (owner ruling D4, Amendment A1.4):** no role or combination grants business-data mutation + financial execution + role granting + infrastructure power. Enforced exclusivities: **Access Administrator ∦ Finance Administrator** (database constraint, §8.7) · **Auditor ∦ any mutating platform role** (`operations`, `support`, `finance`, `access_admin` — database constraint, §8.7) · **Platform Engineer ∦ any business-admin role** — platform engineers hold no `admin_role_assignment` rows at all (docs/24 §1.4: infrastructure IAM only); enforced by a registry of platform-engineer user ids checked at grant time plus procedural IAM review, both audit-evented (a purely-DB constraint is impossible because platform-engineer status lives in infrastructure IAM, recorded honestly). Finance-capable grants always require distinct requesting and approving Access Administrators (§8.7 CHECK).
5. **Production bootstrap (owner ruling D3, Amendment A1.3):** one-time audited CLI, approved with these exact properties — executable **only when zero admin role assignments exist** (any state) · requires **two existing verified users** as targets · creates **exactly two initial Access Administrators in one transaction** (§9.9) · requires an explicit **bootstrap secret** (from the secret store), a typed **confirmation phrase**, and a **reviewed manifest** naming the two users (manifest reviewed and recorded before execution) · emits audit + outbox events for every step · **permanently seals itself** on success (a `bootstrap_seal` record written in the same transaction; the CLI refuses forever after, and no code path unseals) · structurally **cannot create any role other than `access_admin`** — no universal super-admin is creatable. Development/test seeding is a **separate deterministic mechanism** (test fixtures/seed script) that never touches the production bootstrap path and never runs where a seal or any assignment exists.
6. **Audit:** every request, approval, denial, revocation, expiry sweep, and every *failed* authorization attempt against admin surfaces emits `audit_event` (+ outbox for state changes).

## 8. Database design (proposed; final DDL reviewed per docs/25 §9)

All tables follow the Slice-1 conventions (naming, UUIDv7 ids, timestamptz UTC, `created_at`/`updated_at`/`version` with the shared triggers where mutable, `himma_app` grants). New enums as CHECK constraints or Postgres enums per migration review.

| # | Table | Key columns | Constraints and indexes |
|---|---|---|---|
| 8.1 | `app_user` (docs/24 "User"; `user` is reserved) | id, status (`active`\|`locked`\|`deleted`), locked_reason?, mfa_enrolled bool, last_login_at?, created/updated/version | — |
| 8.2 | `auth_identity` | id, user_id FK, provider (`apple`\|`google`\|`email`), **issuer** (normalized provider issuer), **subject**, email?, email_verified bool, is_private_relay bool, status (`active`\|`ended`), created/updated/version | `uq_auth_identity_issuer_subject (issuer, subject)` — Amendment A1.1 matching rule; partial unique `uq_auth_identity_verified_email ON (lower(email)) WHERE email_verified AND status='active'`; ix by user_id. **No password_hash column** (credentials live in Cognito, D1) |
| 8.3 | `customer_account` | id, user_id FK unique, display_name, contact_email, status (`active`\|`suspended`\|`deletion_requested`\|`anonymized`), created/updated/version | one per user; participant table (exists Slice 5-lite: `participant` with kind `self` only this slice) carries partial unique `uq_participant_one_self ON (account_id) WHERE kind='self'` |
| 8.4 | `login_session` | id, user_id FK, principal_kind, client_kind, **provider_issuer**, **provider_subject**, **origin_jti** (normalized provider session identifiers — Amendment A1.1), device_label?, ip_digest?, created_at, last_seen_at, expires_at, revoked_at?, revoke_reason?, version | partial unique `uq_login_session_origin_jti ON (origin_jti) WHERE revoked_at IS NULL`; ix (user_id, revoked_at); liveness lookup by (issuer, subject, origin_jti) |
| 8.5 | ~~`refresh_token`~~ — **removed by Amendment A1.1 (D1)** | Refresh tokens are Cognito-issued and client-held; **no refresh token, raw or hashed, is stored in PostgreSQL.** A schema guard test proves no such table/column exists (§11.4) | — |
| 8.6 | `auth_challenge` — **reduced by Amendment A1.1** | Verification/reset code generation and validation are Cognito's (D1); Himma does not duplicate provider codes. This table is retained only as adapter-neutral challenge *bookkeeping* (kind, user/identity ref, requested_at, completed_at, attempt_count — no secrets) where Himma-side state is needed for rate limiting, enumeration-safe sequencing, and audit; exact final shape settled in B2-1 migration review | single-use/attempt semantics via CAS; no token material stored |
| 8.7 | `admin_role_assignment` | id, user_id FK, role, state (`requested`\|`active`\|`denied`\|`revoked`\|`expired`), requested_by FK, approved_by? FK, denied_by? FK, expires_at?, created/updated/version | `CHECK (requested_by <> approved_by)`; CHECK finance-capable ⇒ approved_by NOT NULL when active; partial unique `uq_admin_role_active ON (user_id, role) WHERE state='active'`; **D4 exclusivity constraints (Amendment A1.4):** access_admin ∦ finance and auditor ∦ {operations, support, finance, access_admin} — enforced via trigger-backed checks over the user's active assignments at activation (cross-row rules exceed a plain CHECK; the trigger runs in the activation transaction and is tested under concurrency, §11.6) · plus `bootstrap_seal` (single-row table: sealed_at, manifest_digest, executed_by — insert-only, §7.5) |
| 8.8 | `mfa_method` + `mfa_recovery_code` | method (Amendment A1.1): id, user_id FK, kind (`totp`), **provider_managed** — enrolment/confirmation status mirror only, **no secret material in PostgreSQL** (TOTP secrets live in Cognito), confirmed_at?, version · code: id, user_id FK, code_hash, used_at? — ★ recovery codes stay Himma-held and hashed (Cognito has no native recovery codes; admin-reset via support is the fallback path) | partial unique one confirmed totp per user; uq (code_hash) |
| 8.9 | Security events & outbox | **No new event tables**: append-only `audit_event` (Slice 1) carries all §5.10 events under the `auth.*` action namespace; outbox events: `user.created`, `account.created`, `identity.linked`, `identity.unlinked`, `session.revoked_all`, `account.suspended`, `admin_role.requested/approved/denied/revoked`, `mfa.enrolled`, `auth.refresh_replay_detected` | Volume note: routine login-success events may move to a dedicated high-volume table later if audit growth demands it — recorded, not built |

**Ownership/relationship constraints:** every child row FKs its owner (identity→user, session→user, challenge→identity/user, account→user, participant→account, role-assignment→user). **Retention/pseudonymization** (docs/24 §6.14): revoked/expired sessions and completed challenge bookkeeping carry `retention_class` short-lived tags (sweep job deletes expired rows after the configured window — operational records, not history); `app_user`/`auth_identity` pseudonymize on erasure (issuer subject and email replaced by digests, status `deleted`) with the corresponding Cognito user deletion executed through the adapter as a post-transaction step; audit rows survive with opaque ids.

## 9. Transaction boundaries (each = one transaction, outbox rows inside; provider JWKS/network validation always *before* the transaction — docs/25 §4)

| # | Operation | Inside the single transaction |
|---|---|---|
| 9.1 | **First login / registration** | (Provider token already validated by the adapter, outside the transaction.) Insert `app_user` + `auth_identity` + `customer_account` + `self` participant → audit + outbox (`user.created`, `account.created`) → insert `login_session` keyed to (issuer, subject, `origin_jti`). Concurrency: unique `(issuer, subject)` / verified-email indexes make the duplicate loser fail cleanly; the loser's request re-resolves as a normal login (tested §11.3) |
| 9.2 | **Link identity** | Step-up already verified → insert `auth_identity` (unique indexes enforce `identityAlreadyLinked`/conflict) → audit + outbox |
| 9.3 | **Unlink identity** | Count remaining usable methods with row locks → CAS identity `active → ended` → audit + outbox; refuse when last method |
| 9.4 | **Refresh (revised, Amendment A1.1)** | Provider rotation happens at Cognito, **outside any Himma transaction**. The Himma transaction: liveness-check + CAS `last_seen_at` on the `login_session` row matched by (issuer, subject, `origin_jti`) → audit on anomalies. A refresh presenting identifiers with no live session row is refused (`sessionExpired`) |
| 9.5 | **Provider replay/revocation handling (revised, Amendment A1.1)** | On an adapter-normalized provider reuse/revocation signal: CAS-revoke the matching `login_session` → audit + outbox (`auth.refresh_replay_detected`). Cognito revocation of the token chain is provider-side; Himma's row is the session-of-record |
| 9.6 | **Logout / revocation** | One device: CAS-revoke that `login_session`. All devices / password reset: revoke all the User's live sessions → audit (+ outbox for revoke-all). **Provider token revocation via the adapter runs strictly after commit** (docs/25 §4) and is retried on failure — Himma liveness already blocks the session |
| 9.7 | **Admin-role request & approval** | Request: insert `requested` + audit + outbox. Approval (separate transaction, different principal): CAS `requested → active` setting approved_by (CHECK enforces distinctness) + audit + outbox |
| 9.8 | **Account suspension / lock** | CAS status → revoke all live sessions → audit + outbox (`account.suspended`) — one transaction so no suspended account retains a live Himma session (provider revocation follows post-commit per §9.6) |
| 9.9 | **Production bootstrap (D3, Amendment A1.3)** | Verify zero admin assignments + no `bootstrap_seal` (row locks) → validate manifest digest + two verified target users → insert exactly two `access_admin` assignments (`active`, cross-referenced as each other's grant witnesses) → insert `bootstrap_seal` → audit + outbox — one transaction; any failure leaves no assignments and no seal |

## 10. API contracts (Slice 2 endpoints only; TypeBox schemas, docs/24 §11 typed results)

Routes (all under the identity module plugin; every route declares its §6 policy):

- `POST /auth/register` (email) → **always** `{ status: 'verificationRequired' }` (enumeration-safe)
- `POST /auth/verify-email` → `authenticated` \| `challengeInvalid`
- `POST /auth/login` (email) → `authenticated` \| `invalidCredentials` \| `accountSuspended` \| `verificationRequired` \| `mfaRequired` (admins)
- `POST /auth/oidc/apple` · `POST /auth/oidc/google` (id_token + nonce) → `authenticated` (creates on first login) \| `accountSuspended` \| `accountLinkConflict` \| `mfaRequired`
- `POST /auth/mfa/challenge` (TOTP or recovery code, on an `mfaRequired` continuation) → `authenticated` \| `invalidCredentials`
- `POST /auth/refresh` → `authenticated` (rotated pair) \| `sessionExpired` \| `tokenReplayDetected`
- `POST /auth/logout` · `POST /auth/logout-all`
- `GET /auth/sessions` · `DELETE /auth/sessions/:sessionId` (step-up for non-current) → \| `forbidden` \| `staleVersion`
- `POST /auth/step-up` → refreshed assurance \| `invalidCredentials`
- `POST /auth/identities/link/(apple|google|email)` (step-up) → `linked` \| `identityAlreadyLinked` \| `accountLinkConflict`
- `DELETE /auth/identities/:identityId` (step-up) → \| `lastLoginMethod` \| `staleVersion`
- `POST /auth/password/reset-request` → **always** `{ status: 'accepted' }` · `POST /auth/password/reset` → `passwordReset` (all sessions revoked) \| `challengeInvalid`
- `POST /auth/mfa/totp/enroll` · `/confirm` · `POST /auth/mfa/recovery-codes/regenerate` (step-up)
- `GET /me` → principal snapshot (user, account, self-participant, roles) — the future frontend bootstrap (§12)
- Admin: `POST /admin/role-requests` · `POST /admin/role-requests/:id/(approve|deny)` · `DELETE /admin/role-assignments/:id` · `GET /admin/role-assignments` → typed results incl. `forbidden`, `staleVersion`, `dualControlViolation`

**Typed outcome vocabulary added by this slice** (extends docs/24 §11.2): `authenticated` · `verificationRequired` · `invalidCredentials` · `accountSuspended` · `sessionExpired` · `tokenReplayDetected` · `identityAlreadyLinked` · `accountLinkConflict` · `mfaRequired` · `challengeInvalid` · `lastLoginMethod` · `stepUpRequired` · `forbidden` · `staleVersion` · `rateLimited`. **No response, error, or timing difference may reveal whether an arbitrary email has an account** (register/reset always accepted; login collapses unknown-vs-wrong into `invalidCredentials`).

*Amendment A1.1 note:* the endpoint set and typed vocabulary above are **unchanged** by the Cognito ruling — the Himma API remains the customer/portal contract; routes mediate Cognito through the `AuthProviderAdapter` (network calls strictly outside DB transactions), and the adapter normalizes every provider error into this vocabulary. Cognito error shapes, token formats, and hosted-UI concepts never leak into the API surface — this is the replaceability boundary in practice.

## 11. Testing and acceptance gates (real PostgreSQL throughout, Slice-1 harness; per docs/24 §13 row 2 + owner requirements)

1. Migration-from-zero + `db:verify` green with the new tables; codegen diff committed.
2. **Negative authorization:** guest → every authenticated route `authenticationRequired`; customer A → customer B's sessions/identities not-found-shaped; customer → every `/admin/*` route `forbidden`; expired/revoked session → denied; missing route policy declaration → app refuses to boot (structural deny-by-default test).
3. **Concurrent first-login/linking:** N parallel first logins with one subject → exactly one `app_user`/account/self-participant; concurrent link of one subject to two users → one winner, loser typed; concurrent email registration → one identity.
4. **Provider-token liveness and replay (revised, Amendment A1.1):** adapter-normalized reuse/revocation signals revoke the matching session (§9.5) and subsequent still-unexpired provider JWTs for that session are refused by the liveness check; identifiers with no live session row → `sessionExpired`; **schema guard test proves no refresh-token table or column exists in PostgreSQL** (raw or hashed). Adapter contract tests run the deterministic fake against recorded Cognito fixtures (JWKS rotation, expired/`token_use`-mismatched/wrong-audience tokens, reuse errors) so both adapter implementations satisfy one contract suite.
5. **Session revocation:** logout-one/logout-all/suspension/password-reset each make live JWTs fail the liveness check immediately.
6. **Dual control and exclusivity (extended by Amendment A1.3–4):** finance-capable approval by the requester → rejected at API *and* CHECK layer; non-finance single-admin grant works; denial recorded; expiry resolves to no role; **D4 exclusivity**: activating `finance` for an active `access_admin` (and vice versa), or any mutating role for an `auditor`, is rejected at trigger level including under concurrent activation; **bootstrap**: rehearsed on a scratch database — refuses when any assignment exists, refuses without secret/phrase/valid manifest, creates exactly two `access_admin`s atomically, seals, and refuses forever after (seal proven irreversible; dev/test seeding path proven separate).
7. **Audit/outbox:** every §9 operation asserts its audit rows and outbox events (per-aggregate ordering via Slice-1 helpers).
8. **Rate limiting:** threshold lockout, backoff, and `rateLimited` responses deterministic under the test clock.
9. **Enumeration:** register/reset responses byte-identical for existing vs unknown emails; login single error class; timing-equalization exercised.
10. **Customer cannot obtain provider/admin access:** principal built from a customer session never yields admin roles or org scopes even with forged claims (signature-verified) or crafted requests — explicit tests.
11. **MFA:** admin login without MFA enrolment forces enrolment; challenge failures throttle; recovery-code single-use.
12. Proportional verification per commit (§13); full backend suite + root non-regression (unchanged frontend) at slice close.

## 12. Frontend migration compatibility (no frontend code changes in this task or slice)

The approved customer app already contains the exact seams Slice 2 fills — by design, no approved screen needs redesign:

- **`AccountProvider` / `ResolvedAccount`** (docs/19 §3): today resolved from `?qa-scenario` fixtures; later resolved from `GET /me` + the schedule/participant endpoints of later slices. `account: null` (guest) remains the guest representation — guest browsing without login is untouched (docs/02 §2).
- **Guest sign-in contracts:** the inert `Sign in to book` state (docs/09 §21.9) and inert onboarding/HMA-003 actions activate against `/auth/*` in the future W1 auth-screens milestone (its own owner-approved plan); Sign in with Apple/Google readiness is already required by docs/12 §9.
- **Participants:** `/me` returns the account's participants — initially just `self`, exactly matching the `me-only` mock scenario shape; the dynamic-participant Home model (docs/18 §3) consumes it unchanged.
- **`ParticipantId = 'everyone'`** stays client-only (docs/24 §12.1); tokens/claims never carry it.
- Native bundle identifiers for Apple/Google client registration remain the open docs/23 §18 owner decision (B13 in docs/24 §14) — backend validation is built and tested against fixture tokens; real client ids are configuration.

## 13. Commit sequence (implementation begins only after final owner approval of this amended plan; do not execute now)

| # | Commit | Scope | Stop line / verification |
|---|---|---|---|
| B2-1 | `feat(backend): identity schema` | Migrations for §8 tables + grants + codegen diff; data-invariant and constraint tests | Backend tsc/lint/jest + migrate-from-zero + `db:verify` green → **stop-and-report** |
| B2-2 | `feat(backend): identity core` | Identity module services: user/identity/account/self-participant creation (§9.1–9.3), `AuthProviderAdapter` port + **deterministic fake adapter + Cognito adapter** (JWKS validation, issuer+subject normalization, error normalization — Amendment A1.1), mail port + dev capture (D2) | Unit/integration + adapter contract tests for §3 rules incl. concurrency → **stop-and-report** |
| B2-3 | `feat(backend): sessions and liveness` | Himma `login_session` inventory keyed to (issuer, subject, `origin_jti`), liveness middleware, logout/forced revocation with post-commit provider revocation (§9.4–9.6) | §11.4–11.5 tests incl. the no-refresh-token schema guard → **stop-and-report** |
| B2-4 | `feat(backend): auth routes and principal context` | §10 customer routes, principal middleware, route-policy declarations + boot-time deny-by-default check, rate limiting, enumeration-safe flows | §11.2, 11.8–11.10 tests; focused route QA → **stop-and-report** |
| B2-5 | `feat(backend): admin roles and dual control` | AdminRoleAssignment flows incl. D4 exclusivity triggers, D3 production-bootstrap CLI + seal + separate dev/test seeding, admin routes | §11.6 (dual control, exclusivity, bootstrap rehearsal) → **stop-and-report** |
| B2-6 | `feat(backend): mfa and slice closeout` | Cognito TOTP enrolment/challenge mediation + Himma-held recovery codes, step-up, admin MFA enforcement; full-slice hardening pass; docs/25 additions if any; HANDOFF | **Full** backend suite + root non-regression (frontend untouched) + expo-doctor only if root config changed → milestone report, **stop for owner review before Slice 3** |

Proportional verification: per-commit = backend typecheck/lint + the commit's focused suites + migrate-from-zero; root checks only when root files change (none planned); no native/device matrix (no UI change).

## 14. Owner decisions

**D — RESOLVED by the owner rulings of 2026-08-06 (Amendment A1):**
1. **D1 · Authentication approach — DECIDED: Amazon Cognito User Pools** behind the `AuthProviderAdapter`, with the binding boundaries of §2 (Himma PostgreSQL canonical; no authoritative Cognito groups/claims; issuer+subject matching; no silent email merges; replaceable adapter; no Himma refresh-token family).
2. **D2 · Email sequencing — DECIDED:** email/password, verification, reset, and recovery contracts stay in Slice 2; dev/test use the non-delivering captured `MailSender`; production sending stays disabled until the identity region and email-delivery service are approved; neither selection blocks the schema or the provider-independent core.
3. **D3 · Production bootstrap — DECIDED:** the §7.5 one-time audited, self-sealing, two-Access-Administrator CLI, with development/test seeding as a separate mechanism.
4. **D4 · Role exclusivity — DECIDED:** Access Administrator ∦ Finance Administrator; Platform Engineer ∦ business-admin roles; Auditor ∦ mutating platform roles; distinct requesting/approving Access Administrators for finance-capable grants (§7.4, §8.7).

**Open (recorded, not guessed — must be decided before production enablement, none blocks Slice 2 implementation):** production Cognito region and the identity disaster-recovery strategy (pool export/backup limits, cross-region posture, docs/23 §10.11 recovery class), decided under the docs/23 §18.3 hosting/data-residency decision **with the AWS UAE-region health situation explicitly considered** · production email-delivery service (D2) · production Apple/Google client identifiers (tied to the open bundle-identifier decision, docs/24 §14.B13).

**E′ — implementation prerequisites (operational, non-production; owner-visible, not design decisions):** an AWS account and a **non-production development user pool** (region chosen for development only, explicitly not prejudging §18.3) for B2-2's real-adapter verification; all automated tests run on the deterministic fake adapter and need no AWS access.

**C — configurable security values (do not block schema; env/pool-configured with safe defaults, docs/25 §5):** pool access/refresh TTLs · Himma session-inactivity window, absolute session lifetime, step-up max-age · lockout thresholds and backoff curve · rate limits per endpoint class · verified-email gate for booking-capable actions · finance-capable role set · recovery-code count · challenge expiries and attempt caps · retention windows for sessions/challenges · breach-list refresh cadence (if the Cognito advanced-security tier is not used — tier choice recorded under C, cost-bearing).

**E — can wait for provider/admin portal implementation (recorded, not decided):** cookie/CSRF concrete wiring (first portal) · admin login UI and WebAuthn/passkey option · SSO for internal staff · support-assisted recovery for OIDC-only users (support tooling, W3) · customer-facing MFA · high-volume auth-event table split.

---

*This plan implements docs/24 §13 row 2 within the docs/25 engineering contract, as amended by the owner's D1–D4 rulings (Amendment A1). It writes no code and provisions nothing — no production user pool exists or is configured by this document: B2-1 begins only after the owner's final approval of this amended plan.*
