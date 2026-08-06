# 26 — Backend Slice 2 Plan: Identity and Authorization

Status: **draft for product-owner approval. No implementation has started.** Prepared 2026-08-06 after Slice 1 approval (`d9b5fff`). Governing documents: docs/24 (approved canonical model — §1 identity spine, §10 authorization, §13 slice 2 row), docs/25 (binding backend engineering contract), docs/23 §7 (authorization authority), docs/02 (accounts/participants), docs/09 §§21–22 (frontend owner decisions this slice must stay compatible with). Recommendations are marked ★; the slice is built to the starred defaults unless the owner chooses otherwise. Nothing here starts implementation: §13's first commit begins only after this plan and the §14.D1 decision are approved.

## 1. Slice boundary

**Slice 2 implements** (docs/24 §13 row 2, expanded):

1. **User** — the authentication principal (docs/24 §1.1), with status (`active` \| `locked` \| `deleted`) and version.
2. **AuthIdentity** — Apple, Google, and email identities linked to one User; email/password credential storage for the email provider.
3. **CustomerAccount** — one per adult customer (docs/02 §1), created on first customer sign-in/registration.
4. **Adult self-participant creation** — the `Me` participant row created atomically with the account (docs/24 §1.2). Slice 2 creates only the `self` participant; full participant CRUD (children) remains Slice 5.
5. **Login sessions and refresh-token families** — session inventory, short-lived access tokens, rotating hashed refresh tokens, replay-driven family revocation.
6. **Account status and revocation** — lock/suspend/unlock with immediate session revocation; deletion *request* recording (the full erasure workflow is a later data-subject deliverable, docs/24 §6.14).
7. **Provider/admin identity foundations** — the principal-context model carries admin roles now and organization/branch staff scopes as typed empty slots for Slice 3; staff logins themselves arrive with StaffMembership (Slice 3). *Reconciliation with docs/24 §13 row 2's "token org-binding" acceptance item:* organizations do not exist until Slice 3, so Slice 2 delivers the org-binding **mechanism** (claims shape, principal slot, and the enforcement point that refuses any org-scoped request whose token lacks a scope) with a structural test, and Slice 3 proves it against real StaffMemberships — recorded here rather than silently narrowed.
8. **AdminRoleAssignment** — access-administrator grants with dual approval for finance-capable roles (docs/24 §1.4), plus the audited bootstrap procedure (§7.5).
9. **Principal-context middleware** — per-request authentication → principal resolution → deny-by-default route authorization (§6).
10. **Authentication/authorization audit events** — every grant, denial, login, revocation, and sensitive access as append-only `audit_event` rows plus outbox events (§8.9).
11. **Provider/admin MFA foundation** — TOTP enrolment/challenge + recovery codes, mandatory for admin principals from day one (docs/23 §7); wired so Slice-3 staff logins inherit it unchanged.

**Explicitly outside Slice 2:** provider organizations and branches (Slice 3) · provider business roles tied to real organizations (Slice 3) · catalogue (Slice 4) · participants beyond `self` (Slice 5) · sessions/availability, holds, bookings (Slices 6–7) · payments (W5; docs/23 §19 stands) · provider/admin portal screens (W2/W3) · customer onboarding/auth UI changes (W1 milestone, later; §12) · production email/SMS delivery **except as the selected authentication approach requires** (§14.D2: flows are built against a `MailSender` port with a dev capture implementation; a production provider is selected before production enablement, not before implementation) · WebAuthn/passkeys (recorded future option) · SSO for admin staff (future option).

## 2. Authentication-provider decision (owner decision §14.D1)

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

**Recommendation ★ C — self-managed authentication behind an `AuthProviderAdapter` port**, because: (a) the canonical-ownership constraint already forces Himma to keep the authoritative user/role store, so options A/B still require all of §3's linking rules *plus* vendor reconciliation; (b) the §18.3 hosting/residency decision is open — A adds a second residency negotiation and B pre-empts the cloud choice; (c) the genuinely hard part Himma must own either way (authorization, principal context, dual control, audit) is identical in all three options; the remaining delta — email/password + OIDC validation + TOTP — is a well-trodden, testable surface this plan specifies completely. **Not silently selected: §14.D1 is the owner decision, and no vendor account, SDK, or integration is created in this task.**

**Provider-independent by construction:** everything except `src/modules/identity/providers/*`. The `AuthProviderAdapter` port exposes `verifyAppleIdToken`, `verifyGoogleIdToken`, and (if C) `verifyPassword`/`hashPassword` + challenge flows; sessions, principal context, authorization, admin roles, MFA policy, audit, and every table in §8 are Himma-owned and would survive a later switch to A/B with only the adapter and login routes changing.

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

1. **Access tokens ★:** short-lived (default 10 min, §14.C) signed JWTs (EdDSA, kid-rotated signing keys held in the secret store), claims: `user_id`, `session_id`, principal kind, `account_id?`, assurance level, expiry. Stateless verification **plus** a per-request session-liveness lookup (single indexed read) so revocation is immediate at Tier-1 scale; caching that lookup is a recorded later optimization, never a correctness change.
2. **Refresh tokens:** opaque 256-bit random values, delivered once, **stored only as SHA-256 hashes** (owner requirement: no raw refresh tokens in PostgreSQL — same discipline as Slice 1's invitation-token digests). Organized as **rotating families**: login creates a family; every refresh issues a child and marks the parent used (§9.4, atomic CAS).
3. **Replay detection:** presenting a used or revoked refresh token **revokes the entire family and its session** (§9.5), emits `auth.refresh_replay_detected` audit + outbox events, and returns `tokenReplayDetected`.
4. **Device/session inventory:** each login session records client kind (`customer_app` \| `admin_portal` \| `provider_portal` future), a coarse device label, created/last-used timestamps, and an IP-address digest (no raw IPs at rest; §8.4). `GET /auth/sessions` lists them; customers and staff see only their own.
5. **Logout:** one device (revoke that session + family) or all devices (revoke every session/family of the User) — §9.6.
6. **Forced revocation:** admin lock/suspend, replay detection, password change, and MFA reset all revoke sessions server-side; the next request fails the liveness check regardless of unexpired JWTs.
7. **Mobile storage expectation (W1, later):** access + refresh tokens in `expo-secure-store` (docs/12 §2); never AsyncStorage, never in JS-visible globals beyond memory.
8. **Future web portals (W2/W3):** refresh tokens ride **Secure, HttpOnly, SameSite=Strict cookies** scoped to the auth path; access tokens stay in memory. **CSRF:** SameSite=Strict plus a double-submit/custom-header check on every cookie-authenticated mutation. Concrete cookie/CSRF wiring lands with the first portal (§14.E) — Slice 2 keeps token issuance transport-neutral.
9. **Expiry and inactivity are configurable values (§14.C):** access TTL, refresh TTL, family absolute lifetime, session inactivity window, step-up max-age — all environment configuration with safe defaults, never literals in code (docs/25 §5).

## 5. Authentication security

1. **Password hashing:** argon2id (memory-hard; parameters configurable §14.C, calibrated at implementation and recorded), per-password salt, versioned hash format for future migration. Passwords only ever touch the identity module; never logged, never in audit payloads (docs/25 §7).
2. **Email verification:** single-use, hashed, expiring challenge codes/links (§8.5); consuming is CAS-atomic; resend is rate-limited.
3. **Login throttling and rate limiting:** per-identity and per-IP-digest counters with exponential backoff and temporary lock (`User.locked` after the configured threshold, §14.C); rate limits on register/login/refresh/reset per docs/23 §10.7. Implemented server-side in Slice 2 (the API gateway/WAF layer of W6 adds defense-in-depth later).
4. **Credential-stuffing protection:** the above throttles plus breach-list rejection of known-compromised passwords (offline k-anonymity list, no external call at login time — the list ships as data; refresh cadence configurable) and audit-evented velocity alerts.
5. **Enumeration-safe responses:** register, resend-verification, and reset-request always return the same accepted response; login returns one `invalidCredentials` for unknown identity *and* wrong password; timing is equalized (hash always runs). §10's schemas encode this.
6. **Secure reset flow:** hashed single-use expiring token, delivered by mail port; consuming it requires setting a new password, revokes all sessions and families (§9.6 variant), and emits audit + outbox events. Reset never confirms account existence.
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
4. **No universal super-admin** (docs/24 §10): no role or combination grants business-data mutation + financial execution + role granting + infrastructure power; `access_admin` itself cannot hold `finance` (mutually exclusive pair enforced by constraint, per docs/23 §7's separation intent — flagged §14.D4 for explicit confirmation since docs/23 implies but does not state the exclusivity).
5. **Bootstrap:** the first `access_admin` cannot be granted through the API (no approver exists). ★ An audited operational CLI (platform-engineer, direct DB access, break-glass discipline: ticket reference recorded, audit event written, usable only when zero active `access_admin` assignments exist). §14.D3 approves this procedure.
6. **Audit:** every request, approval, denial, revocation, expiry sweep, and every *failed* authorization attempt against admin surfaces emits `audit_event` (+ outbox for state changes).

## 8. Database design (proposed; final DDL reviewed per docs/25 §9)

All tables follow the Slice-1 conventions (naming, UUIDv7 ids, timestamptz UTC, `created_at`/`updated_at`/`version` with the shared triggers where mutable, `himma_app` grants). New enums as CHECK constraints or Postgres enums per migration review.

| # | Table | Key columns | Constraints and indexes |
|---|---|---|---|
| 8.1 | `app_user` (docs/24 "User"; `user` is reserved) | id, status (`active`\|`locked`\|`deleted`), locked_reason?, mfa_enrolled bool, last_login_at?, created/updated/version | — |
| 8.2 | `auth_identity` | id, user_id FK, provider (`apple`\|`google`\|`email`), subject, email?, email_verified bool, is_private_relay bool, password_hash? , status (`active`\|`ended`), created/updated/version | `uq_auth_identity_provider_subject (provider, subject)`; partial unique `uq_auth_identity_verified_email ON (lower(email)) WHERE email_verified AND status='active'`; CHECK password_hash only when provider='email'; ix by user_id |
| 8.3 | `customer_account` | id, user_id FK unique, display_name, contact_email, status (`active`\|`suspended`\|`deletion_requested`\|`anonymized`), created/updated/version | one per user; participant table (exists Slice 5-lite: `participant` with kind `self` only this slice) carries partial unique `uq_participant_one_self ON (account_id) WHERE kind='self'` |
| 8.4 | `login_session` | id, user_id FK, principal_kind, client_kind, device_label?, ip_digest?, created_at, last_seen_at, expires_at, revoked_at?, revoke_reason?, version | ix (user_id, revoked_at); liveness lookup by pk |
| 8.5 | `refresh_token` | id, session_id FK, family_id, token_hash, parent_id?, created_at, expires_at, used_at?, revoked_at? | `uq_refresh_token_hash (token_hash)`; ix (family_id); ix (session_id). **Raw tokens never stored** |
| 8.6 | `auth_challenge` | id, kind (`email_verification`\|`password_reset`), user_id FK, auth_identity_id FK, token_hash, expires_at, consumed_at?, attempt_count | uq (token_hash); single-use via CAS on consumed_at |
| 8.7 | `admin_role_assignment` | id, user_id FK, role, state (`requested`\|`active`\|`denied`\|`revoked`\|`expired`), requested_by FK, approved_by? FK, denied_by? FK, expires_at?, created/updated/version | `CHECK (requested_by <> approved_by)`; CHECK finance-capable ⇒ approved_by NOT NULL when active; partial unique `uq_admin_role_active ON (user_id, role) WHERE state='active'`; exclusivity constraint access_admin ∦ finance (§7.4, pending D4) |
| 8.8 | `mfa_method` + `mfa_recovery_code` | method: id, user_id FK, kind (`totp`), secret_encrypted, confirmed_at?, version · code: id, user_id FK, code_hash, used_at? | partial unique one confirmed totp per user; uq (code_hash) |
| 8.9 | Security events & outbox | **No new event tables**: append-only `audit_event` (Slice 1) carries all §5.10 events under the `auth.*` action namespace; outbox events: `user.created`, `account.created`, `identity.linked`, `identity.unlinked`, `session.revoked_all`, `account.suspended`, `admin_role.requested/approved/denied/revoked`, `mfa.enrolled`, `auth.refresh_replay_detected` | Volume note: routine login-success events may move to a dedicated high-volume table later if audit growth demands it — recorded, not built |

**Ownership/relationship constraints:** every child row FKs its owner (identity→user, session→user, token→session, challenge→identity/user, account→user, participant→account); refresh-token family integrity via family_id + parent chain. **Retention/pseudonymization** (docs/24 §6.14): sessions, refresh tokens, and consumed challenges carry `retention_class` short-lived tags (sweep job deletes expired rows after the configured window — these are credentials, not history); `app_user`/`auth_identity` pseudonymize on erasure (subject and email replaced by digests, status `deleted`), audit rows survive with opaque ids.

## 9. Transaction boundaries (each = one transaction, outbox rows inside; provider JWKS/network validation always *before* the transaction — docs/25 §4)

| # | Operation | Inside the single transaction |
|---|---|---|
| 9.1 | **First login / registration** | Insert `app_user` + `auth_identity` + `customer_account` + `self` participant → audit + outbox (`user.created`, `account.created`) → insert `login_session` + root `refresh_token`. Concurrency: unique `(provider,subject)` / verified-email indexes make the duplicate loser fail cleanly; the loser's request re-resolves as a normal login (tested §11.3) |
| 9.2 | **Link identity** | Step-up already verified → insert `auth_identity` (unique indexes enforce `identityAlreadyLinked`/conflict) → audit + outbox |
| 9.3 | **Unlink identity** | Count remaining usable methods with row locks → CAS identity `active → ended` → audit + outbox; refuse when last method |
| 9.4 | **Refresh rotation** | CAS `used_at` on the presented token **where used_at IS NULL and revoked_at IS NULL** → insert child token (same family) → update session last_seen → audit. The CAS is the race gate: two concurrent presentations — exactly one rotates |
| 9.5 | **Replay-driven family revocation** | Presented token already used/revoked → revoke every token in the family + the session (single UPDATE each) → audit + outbox (`auth.refresh_replay_detected`) |
| 9.6 | **Logout / revocation** | One device: revoke session + its family. All devices / password reset: revoke all the User's sessions + families → audit (+ outbox for revoke-all) |
| 9.7 | **Admin-role request & approval** | Request: insert `requested` + audit + outbox. Approval (separate transaction, different principal): CAS `requested → active` setting approved_by (CHECK enforces distinctness) + audit + outbox |
| 9.8 | **Account suspension / lock** | CAS status → revoke all sessions and families → audit + outbox (`account.suspended`) — one transaction so no revoked account retains a live session |

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

## 11. Testing and acceptance gates (real PostgreSQL throughout, Slice-1 harness; per docs/24 §13 row 2 + owner requirements)

1. Migration-from-zero + `db:verify` green with the new tables; codegen diff committed.
2. **Negative authorization:** guest → every authenticated route `authenticationRequired`; customer A → customer B's sessions/identities not-found-shaped; customer → every `/admin/*` route `forbidden`; expired/revoked session → denied; missing route policy declaration → app refuses to boot (structural deny-by-default test).
3. **Concurrent first-login/linking:** N parallel first logins with one subject → exactly one `app_user`/account/self-participant; concurrent link of one subject to two users → one winner, loser typed; concurrent email registration → one identity.
4. **Refresh replay:** rotate-once under concurrent presentation (exactly one child); replay of used token → family + session revoked, subsequent valid-looking tokens of that family rejected.
5. **Session revocation:** logout-one/logout-all/suspension/password-reset each make live JWTs fail the liveness check immediately.
6. **Dual control:** finance-capable approval by the requester → rejected at API *and* CHECK layer; non-finance single-admin grant works; denial recorded; expiry resolves to no role.
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

## 13. Commit sequence (implementation begins only after this plan + §14.D1 are approved; do not execute now)

| # | Commit | Scope | Stop line / verification |
|---|---|---|---|
| B2-1 | `feat(backend): identity schema` | Migrations for §8 tables + grants + codegen diff; data-invariant and constraint tests | Backend tsc/lint/jest + migrate-from-zero + `db:verify` green → **stop-and-report** |
| B2-2 | `feat(backend): identity core` | Identity module services: user/identity/account/self-participant creation (§9.1–9.3), argon2id, `AuthProviderAdapter` port + fake adapter + real Apple/Google JWKS validation, mail port + dev capture | Unit/integration tests for §3 rules incl. concurrency → **stop-and-report** |
| B2-3 | `feat(backend): sessions and tokens` | Session/refresh families, rotation/replay/revocation (§9.4–9.6), JWT issuance/verification, liveness middleware | §11.4–11.5 tests → **stop-and-report** |
| B2-4 | `feat(backend): auth routes and principal context` | §10 customer routes, principal middleware, route-policy declarations + boot-time deny-by-default check, rate limiting, enumeration-safe flows | §11.2, 11.8–11.10 tests; focused route QA → **stop-and-report** |
| B2-5 | `feat(backend): admin roles and dual control` | AdminRoleAssignment flows, bootstrap CLI (§7.5), admin routes | §11.6 + bootstrap rehearsal on a scratch DB → **stop-and-report** |
| B2-6 | `feat(backend): mfa and slice closeout` | TOTP + recovery codes, step-up, admin MFA enforcement; full-slice hardening pass; docs/25 additions if any; HANDOFF | **Full** backend suite + root non-regression (frontend untouched) + expo-doctor only if root config changed → milestone report, **stop for owner review before Slice 3** |

Proportional verification: per-commit = backend typecheck/lint + the commit's focused suites + migrate-from-zero; root checks only when root files change (none planned); no native/device matrix (no UI change).

## 14. Owner decisions

**D — required before Slice 2 implementation starts:**
1. **D1 · Authentication approach** (§2): ★ self-managed behind the `AuthProviderAdapter`. Blocks every commit.
2. **D2 · Transactional email dependency model** (§1 exclusion): ★ build against the `MailSender` port with dev capture; select the production email provider before production enablement of verification/reset (that selection itself can then be a W6-adjacent owner decision). Confirm this sequencing — it is what keeps "production email" out of Slice 2.
3. **D3 · Admin bootstrap procedure** (§7.5): ★ audited zero-state CLI. Blocks B2-5.
4. **D4 · `access_admin` ∦ `finance` exclusivity** (§7.4): ★ enforce as a constraint (docs/23 §7 separation intent). Blocks B2-1's CHECK; a "no" removes one constraint only.

**C — configurable security values (do not block schema; env-configured with safe defaults, docs/25 §5):** access/refresh/family/inactivity/step-up TTLs · lockout thresholds and backoff curve · rate limits per endpoint class · argon2id parameters · verified-email gate for booking-capable actions · finance-capable role set · recovery-code count · challenge expiries · retention windows for sessions/tokens/challenges · breach-list refresh cadence.

**E — can wait for provider/admin portal implementation (recorded, not decided):** cookie/CSRF concrete wiring (first portal) · admin login UI and WebAuthn/passkey option · SSO for internal staff · support-assisted recovery for OIDC-only users (support tooling, W3) · customer-facing MFA · high-volume auth-event table split · production email/SMS provider selection (per D2 sequencing).

---

*This plan implements docs/24 §13 row 2 within the docs/25 engineering contract. It writes no code, selects no vendor, and starts nothing: B2-1 begins only after owner approval of this document and D1–D4.*
