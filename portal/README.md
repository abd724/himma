# Himma Provider Portal (W2)

The responsive web application through which approved provider organizations
operate their Himma presence. Planned by `docs/29_PROVIDER_PORTAL_FRONTEND_PLAN.md`
(owner-approved); built as an independent package on the owner-ratified D-W2-1
stack: **Vite + React 19 + TypeScript + React Router + TanStack Query**, with
Jest + Testing Library + jest-axe and Playwright.

This package is intentionally independent of the Expo customer app and the
backend package — root tooling excludes it, and it shares the Himma brand
through mirrored design tokens (`src/theme`), not shared components.

## Commands

```bash
npm run dev        # development server (http://localhost:5183)
npm run build      # production build
npm run preview    # serve the production build (http://localhost:4318)
npm run typecheck  # TypeScript
npm run lint       # ESLint (zero warnings)
npm test           # Jest (jsdom, Testing Library, jest-axe)
npm run e2e        # Playwright shell smoke at 1440/1024/390 (builds first)
```

## Layout

| Path | Responsibility |
|---|---|
| `src/app/` | bootstrap: providers, routes, query client, error boundary |
| `src/theme/` | design tokens (TS source of truth + mirrored CSS custom properties) |
| `src/layouts/` | responsive shell: sidebar/rail/drawer, top bar, org switcher |
| `src/navigation/` | primary navigation metadata (future capability seats) |
| `src/pages/` | route-level pages (W2-1: honest placeholders) |
| `src/components/` | UI primitives and shared surfaces |
| `src/organization/` | organization scope/context resolution from the URL |
| `src/api/` | API client + environment boundary (seam only — no real calls yet) |
| `src/auth/` | auth boundary seam (W2-2 implements sessions/MFA/step-up) |
| `src/services/mock/` | isolated development fixtures (never a production data source) |
| `test/` | Jest suites; `e2e/` Playwright specs |

## Boundaries that hold in W2-1

- No authentication, session state, or Cognito interaction exists.
- No real API call exists anywhere; no production URL is configured.
- Fixture organizations live only under `src/services/mock/` and are replaced
  by real `/provider/me` resolution in W2-2 behind the same context seam.
- Navigation metadata can carry capability requirements later, but frontend
  visibility is never an authorization decision — the backend stays the
  security boundary.
