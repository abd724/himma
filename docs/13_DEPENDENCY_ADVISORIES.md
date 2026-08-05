# 13 — Dependency Advisories and Hygiene

> **Rebaseline note (2026-08-05):** the risk acceptance below is scoped to the mock-frontend stage and **expires when backend (W4) implementation starts** — from that point the production security policy of `docs/23_PRODUCTION_PLATFORM_REBASELINE.md` §13 governs (CI dependency/container scanning, blocker treatment re-evaluated for a system holding customer, child, and payment data). The advisory history below is preserved as written.

Status as of 2026-08-02 (Expo SDK 57, `npm audit`).

## Current advisories: 11 moderate, one root cause

Every advisory reported by `npm audit` chains back to a single package:

- **Root**: `uuid < 11.1.1` — [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), "Missing buffer bounds check in v3/v5/v6 when `buf` is provided". Severity: moderate.
- **Path**: `uuid` ← `xcode` ← `@expo/config-plugins` ← `@expo/cli` / `@expo/config` / `@expo/metro-config` / `@expo/prebuild-config` / `@expo/inline-modules` / `@expo/local-build-cache-provider` / `expo-splash-screen` ← `expo`.

Re-checked 2026-08-03 (milestone close): still 11 moderate, same single root cause, zero advisories in shipped bundle code. The path list above was corrected to name all 11 flagged packages (`@expo/inline-modules` and `@expo/local-build-cache-provider` are additional intermediates). `npm audit fix --force` now advertises a downgrade to `expo@46` — rule 2 below stands. One dependency added since this doc was written: `playwright-core` (devDependency, QA scripts only, justified in docs/08; carries no advisory).

Re-checked 2026-08-04 (booking milestone close). Between Commits 13 and 14 the SDK 57 registry published patch bumps and **reversed its own Commit-11 prescription of `react-native-gesture-handler` 3.1.0 back to ~2.32.0**. Handled as a dedicated owner-approved commit `chore(deps): align packages with Expo SDK 57` (`npx expo install --fix`, no force flags): expo ~57.0.10, expo-router ~57.0.10, @expo/ui ~57.0.9, expo-image ~57.0.2 (whose now-required config plugin was auto-registered in app.json), expo-linking ~57.0.5, gesture-handler ~2.32.0 (no direct imports in `src/`; lockfile re-adds its own 2.x dependencies hammerjs and hoist-non-react-statics). expo-doctor restored to 20/20; `npm audit` unchanged — same 11 moderate advisories, same single `uuid` root, zero in shipped code.

## Assessment

- These packages are **development- and build-time tooling** (Expo CLI, config plugins, prebuild). None of this code ships inside the customer app bundle.
- The vulnerable `uuid` code path requires a caller-supplied buffer argument; the Expo tooling usage is not customer-input-driven.
- Practical risk to the Himma frontend milestone: **low**. No customer data flows through the affected code.

## Decision

- **No forced upgrade.** `npm audit fix --force` would install a breaking `expo-splash-screen` major and downgrade/perturb the Expo SDK — a real regression risk for zero shipped-code benefit. Per product-owner instruction, forced dependency upgrades are not applied.
- The advisory set is expected to clear upstream when Expo bumps `@expo/config-plugins`' transitive `xcode`/`uuid` pins. Re-check with `npm audit` at each Expo SDK upgrade and at each new milestone.
- `@types/jest` is intentionally pinned to `29.5.14` to match `jest-expo`'s expectation (keeps `expo-doctor` at 20/20).

## Hygiene rules going forward

1. Run `npm audit` and `npx expo-doctor` at every milestone; record changes here.
2. Never run `npm audit fix --force` on this repository without explicit product-owner approval.
3. Prefer `npx expo install` (SDK-aligned versions) over raw `npm install` for runtime packages.
4. New nontrivial dependencies require a written justification (docs/08 §18) and a note here if they carry advisories.
5. Advisories in **shipped app code** (anything bundled into the binary) are treated as blockers, unlike build-tooling advisories, and reported to the product owner immediately.
