# 25 — Backend Engineering Contract (W4)

Status: **binding for all backend (W4) work**, created with Backend Slice 1 per the owner's stack rulings (2026-08-06). This is the W4 engineering contract anticipated by docs/23 §17 C8. It contains engineering rules only — scope, sequencing, and domain semantics live in docs/23 and docs/24. Where this document and docs/24 could ever disagree, docs/24 governs.

Approved stack (owner rulings, 2026-08-06 — do not reopen without a demonstrated compatibility failure): TypeScript on Node.js 24 LTS (backend-pinned; the Expo app's runtime is independent) · Fastify 5 as a modular monolith · PostgreSQL (18.4 locally until the hosting decision, docs/24 §14.A3) · `pg` + Kysely (SQL-first; no ORM; Kysely is never the schema authority) · node-pg-migrate with plain-SQL migrations · npm · Jest on real PostgreSQL.

## 1. Package boundary

- The backend lives in `backend/` as an independent npm package with its own `package.json`, lockfile, tsconfig, ESLint, and Jest. The repository root is **not** an npm workspace; sharing code with the frontends is a future, separately approved change.
- The backend never imports from the Expo app and the Expo app never imports from `backend/`. Root tooling excludes `backend/` (root tsconfig `exclude`, root eslint ignore); backend tooling never runs against the app.
- Backend Node version: `engines` + `.nvmrc` pin Node 24; `.npmrc` sets `engine-strict`. The Expo app's verified Node toolchain is never changed by backend work.

## 2. Modular monolith and dependency direction

- One deployable Fastify 5 application. Domain modules (identity, catalogue, booking, payments, …) land in `src/modules/<module>/` as Fastify plugins in their owning slices (docs/24 §13).
- **Dependency direction:** modules may depend on the shared kernel (`src/app`, `src/config`, `src/db`, `src/outbox`); the shared kernel never depends on a module; a module never imports another module's internals. Cross-module calls go through a module's exported public API (its `index.ts`), and adding a cross-module dependency is a reviewed decision, recorded in the consuming module.
- **Table ownership:** every table belongs to exactly one module (Slice-1 foundation tables — `audit_event`, `outbox_event`, `inbox_event`, `idempotency_key` — belong to the shared kernel). **A module must not query another module's private tables.** Cross-module data access happens through the owning module's API, a database view the owning module publishes deliberately, or a domain event — anything else requires an owner-approved boundary change. Migration review enforces this (§9).
- No microservices, no NestJS, no Express (owner ruling 2).

## 3. API layer rules

- Every route is registered by a module plugin with **JSON Schema (TypeBox) request and response validation** — no unvalidated inputs, no unserialized ad-hoc responses. The TypeBox type provider gives static inference from the same schemas.
- Responses follow docs/24 §11: typed success or typed error `{ code, message, … }` from the published vocabulary; pagination, idempotency-key, and version rules per docs/24 §11.3–11.5.
- Schema-driven OpenAPI generation is added when the first business routes land (owner ruling 2) — schemas are written from day one as if it were already on.
- Route handlers stay thin: parse/validate → call the module service → map the result. No business logic and no SQL in handlers.

## 4. Transactions

- Database transactions begin and end **only in module service functions**, via the shared `withTransaction` helper (`src/db/transaction.ts`). Route handlers, plugins/hooks, and repository helpers never open transactions of their own.
- One docs/24 §7 operation = one transaction; multi-operation flows are sagas (docs/24 §8), never long transactions.
- **No network or external call may occur inside a transaction** (docs/24 §7). Gateway and third-party calls happen between transactions.
- Every domain event is written to the outbox **inside** the transaction of its causing state change (`appendOutboxEvent` requires a `Trx` by type). Audit events likewise ride the causing transaction.
- State transitions are single-statement compare-and-set (`WHERE id = … AND state = … AND version = …`); 0 affected rows is a typed rejection, never a retry-with-force.

## 5. Configuration and secrets

- All configuration comes from the environment through `src/config/env.ts` (typed, validated). Modules read config objects, never `process.env`.
- **No secrets in the repository, ever** — no committed `.env`, credentials, tokens, or connection strings ( `.env*` is gitignored; `.env.example` documents shape only). Production secrets come from the managed secret store (docs/23 §10.3).
- Development, test, and production configuration are separated: production requires an explicit `DATABASE_URL` and fails closed without it; it never assembles connections from defaults. Test config is subject to the §8 safety guards.

## 6. Database access

- All access goes through the shared kernel: the `pg` pool (`src/db/pool.ts`, UTC sessions) and Kysely (`src/db/kysely.ts`). Modules never create their own pools or clients.
- Kysely is the type-safe query builder **only**. The migrated PostgreSQL schema is authoritative; `src/db/generated/db.ts` is generated from the live schema (`npm run db:codegen`), committed, and never hand-edited. Explicit SQL (via `sql` templates) is the norm for locking, CAS, advisory locks, and anything the builder obscures.
- Conventions (established in migration `0001_foundation`, binding for every later table): snake_case singular table names; `pk_/uq_/ck_/fk_/ix_/trg_` constraint‑and‑index prefixes; opaque UUID ids generated via `newId()` (UUIDv7); `timestamptz` UTC timestamps; money as `money_fils` + `currency_code` domains; mutable aggregates carry `created_at`, `updated_at` (trigger `set_updated_at`), `version` (trigger `bump_row_version`; app CAS uses `WHERE version = $expected` and never writes `version`); append-only tables get the `forbid_mutation` trigger and/or no UPDATE/DELETE grants for `himma_app`.
- Capacity-bearing writes lock the unit row first, in the docs/24 §7 lock order (unit → hold → booking).

## 7. Errors and logging

- PostgreSQL errors are translated to typed `DbError` values at the db boundary (`src/db/errors.ts`); nothing above the boundary branches on SQLSTATE codes. The API layer maps `DbError` kinds and domain errors to the docs/24 §11 vocabulary; raw SQL details never reach a response.
- Logging is structured (Fastify/pino) with request ids end-to-end (docs/23 §10.10). **Never log PII, credentials, tokens, or payment references**; log opaque ids. Errors are logged where handled, once.

## 8. Testing

- Jest, Node environment, **real PostgreSQL** — never SQLite, mocks, or in-memory stand-ins for constraint, transaction, trigger, role, or concurrency behavior (owner ruling 7).
- Test-database safety is layered and mandatory: localhost-only, mandatory `himma_test` name prefix, guards asserted in config, pool creation, the migration runner, and the test helper. Tests provision fresh `himma_test_<random>` databases and drop them deterministically.
- Every slice ships: acceptance tests for its criteria, **negative authorization tests** (each relevant docs/24 §10 "Cannot" proven denied), and transaction/concurrency tests (docs/24 §13). Green gates before any commit: `npm run typecheck` · `npm run lint` · `npm test` (plus the root app's own checks when root files were touched).
- Type checking is `tsc --noEmit`; the Jest transform (@swc/jest) never type-checks.

## 9. Migrations

- One migrations directory, `backend/migrations/`, plain SQL, ordinal-numbered (`NNNN_name.sql`), created with `npm run db:new`. Each migration runs in its own transaction; a failed migration aborts with nothing partially applied.
- **Applied migrations are immutable**: sha256 checksums are recorded at apply time and re-verified by `db:migrate` and `db:verify`, which fail closed on any edit, rename, or deletion of an applied file. Fix forward with a new migration.
- Every migration has a reviewed, explicit Down section. Irreversible migrations mark the Down section with `-- IRREVERSIBLE:` plus justification and a failing statement. **Down migrations never run in production** (`db:down` refuses; roll forward instead). Production migrations follow the two-phase, backward-compatible pattern (docs/23 §10.9).
- Migration review checks: naming conventions, docs/24 §6 invariant coverage, table ownership (§2), grants for `himma_app`, and rollback correctness. A migration that creates another module's table or forgets its append-only/grant posture is rejected in review.
- After schema changes: `npm run db:codegen` regenerates the Kysely types; the diff is committed with the migration.

## 10. Authorization (rules for later slices)

- Enforcement is **server-side, per request, deny-by-default** (docs/24 §10). A shared authorization kernel resolves exactly one principal context per request; module services perform the permission and scope checks (org/branch/account ownership) before any data access — never route handlers alone, never the client.
- Provider-scoped queries are always filtered by the token's organization (and branch scope); PostgreSQL row-level security is the planned backstop, not the primary mechanism.
- PII access follows the docs/24 §10.3 tiers; support/admin PII views emit audit events; dual-control invariants (docs/24 §6.5) are database CHECKs, and services must present two distinct principals — no service-level bypass.
- Until the identity slice (Slice 2) exists, no route may pretend to authenticate or authorize; the only routes are unauthenticated internal infrastructure endpoints (health).

## 11. Prohibitions (restated)

No ORM · no second schema authority · no cross-module private-table queries · no transactions spanning network calls · no client-trusted money or permission input · no secrets in the repo · no down migrations in production · no editing applied migrations · no SQLite/mocked-Postgres proofs · no backend imports into the Expo app or vice versa · and the docs/23 §19 payment prohibition binds every payment surface until formally lifted.
