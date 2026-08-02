# 13 — Dependency Advisories and Hygiene

Status as of 2026-08-02 (Expo SDK 57, `npm audit`).

## Current advisories: 11 moderate, one root cause

Every advisory reported by `npm audit` chains back to a single package:

- **Root**: `uuid < 11.1.1` — [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), "Missing buffer bounds check in v3/v5/v6 when `buf` is provided". Severity: moderate.
- **Path**: `uuid` ← `xcode` ← `@expo/config-plugins` ← `@expo/cli` / `@expo/config` / `@expo/metro-config` / `@expo/prebuild-config` / `expo-splash-screen` ← `expo`.

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
