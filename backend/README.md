# Himma Backend (W4)

Production backend for the Himma marketplace — a Fastify 5 modular monolith on PostgreSQL. Governing documents: `docs/24_CANONICAL_DOMAIN_SPECIFICATION.md` (domain model, approved) and `docs/25_BACKEND_ENGINEERING_CONTRACT.md` (binding engineering rules).

**Current state: Backend Slice 1 — database and migration foundation.** No business API routes exist yet; later entities land in their owning slices (docs/24 §13).

## Requirements

- **Node.js 24 LTS** (pinned: `.nvmrc`, `engines`, `engine-strict`). The Expo app at the repository root keeps its own separately verified Node toolchain — do not mix them.
  - Homebrew: `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (keg-only install).
- **PostgreSQL running on localhost:5432** (developed against Homebrew `postgresql@18`, 18.4; the schema uses no PostgreSQL-18-only features — see the note in `migrations/0001_foundation.sql`).
- npm (aligned with the repository toolchain).

## Setup

```bash
cd backend
npm install
cp .env.example .env          # optional; defaults already target localhost dev
createdb himma_backend_dev    # once
npm run db:migrate
npm run db:codegen            # regenerates src/db/generated/db.ts after schema changes
```

## Commands

| Command | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over src, scripts, tests |
| `npm run lint` | ESLint, zero warnings |
| `npm test` | Jest against real PostgreSQL (provisions and drops `himma_test_*` databases) |
| `npm run db:migrate` | Apply pending migrations; verifies applied-migration checksums first; fails closed |
| `npm run db:verify` | Verify schema state: order, checksums, pending count, foundation objects |
| `npm run db:down` | Revert one migration — dev/test only, requires `DB_DOWN_CONFIRM=1`, refused in production |
| `npm run db:new -- <name>` | Create the next numbered SQL migration from the template |
| `npm run db:codegen` | Regenerate Kysely types from the live migrated schema (never hand-edit) |

## Safety properties (proven by `test/`)

- Test runs are localhost-only and require the `himma_test` database-name prefix — enforced in config, pool creation, the migration runner, and the test helper; production credentials are never accepted (production config requires an explicit `DATABASE_URL` and is refused everywhere test/dev tooling runs).
- Migrations are deterministic, ordered, transactional per file, and immutable once applied (sha256-checksummed); a failed migration aborts with nothing partially applied; a blank database migrates from zero to current; re-running `db:migrate` is a no-op.
- Money is integer fils with an AED-only launch constraint; sessions run in UTC; ids are opaque UUIDv7; `updated_at`/`version` maintenance is trigger-enforced; append-only tables reject UPDATE/DELETE (trigger and/or `himma_app` grants).
