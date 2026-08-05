# Himma Customer Mobile App — Project Foundation

This folder is the complete context package for a fresh Claude Code session.

Claude has no access to the conversation that produced these decisions. It must treat the files in this repository as the source of truth and must not infer missing context from memory.

## What Himma is

Himma is a UAE consumer mobile marketplace for discovering, comparing, booking, paying for, gifting, and managing activities for individuals and families.

The first product focuses on two connected consumer needs:

1. Individuals who want to discover nearby activities and manage bookings across several providers in one place.
2. Parents and guardians who want to build active, beneficial routines for children and young people through activities that develop the body, mind, confidence, discipline, skills, and social life.

Himma owns the complete customer journey inside the app:

**Discover → Compare → Book → Pay → Confirm → Manage → Attend**

It is not a directory that redirects users to provider websites, phone calls, Instagram, or WhatsApp to complete a booking.

## Current stage

Himma is the **final production marketplace**, governed by `docs/23_PRODUCTION_PLATFORM_REBASELINE.md` (owner-approved and binding): **seven workstreams** and **three connected frontends** — the customer iOS/Android app, the provider management portal, and the admin/operations portal — with the backend implemented against all three approved frontends.

Execution is phased (docs/23 §16; currently P0). Frontends are built first against deterministic mock services behind typed contracts, approved per surface, and later replace mocks with real APIs without redesign. Backend, authentication, payments, portals, and infrastructure work are phase-gated by docs/23 — never started without an approved workstream specification.

The current app is English-only; the English/Arabic launch decision is docs/23 §18.9. Real payment submission remains prohibited until docs/23 §19's conditions exist.

## Technology direction

The customer product is an actual iOS and Android phone app, not a website displayed inside a phone frame.

Use Expo and React Native with Expo Router and TypeScript. The app may also run on the web for fast visual review, but the native phone experience is authoritative.

## Read order

Claude must read these files in order before changing code:

1. `docs/01_PRODUCT_CONTEXT.md`
2. `docs/02_USERS_ACCOUNTS_AND_PARTICIPANTS.md`
3. `docs/03_SCOPE_AND_PRODUCT_SURFACES.md`
4. `docs/04_APP_NAVIGATION_AND_PAGE_INVENTORY.md`
5. `docs/05_DISCOVERY_CATALOGUE_AND_FILTERS.md`
6. `docs/06_UX_AND_INTERACTION_PRINCIPLES.md`
7. `docs/07_PROVISIONAL_BRAND_SYSTEM.md`
8. `docs/08_FRONTEND_ENGINEERING_CONTRACT.md`
9. `docs/09_OPEN_DECISIONS.md`
10. `docs/11_HOME_SCREEN_SPEC.md`
11. `docs/12_NATIVE_MOBILE_COMPATIBILITY.md`
12. `docs/13_DEPENDENCY_ADVISORIES.md`
13. `docs/14_DISCOVER_AND_SEARCH_SPEC.md`
14. `docs/15_DISCOVER_INFORMATION_ARCHITECTURE.md`
15. `docs/16_DISCOVER_STATE_AND_INTERACTION_MATRIX.md`
16. `docs/17_DISCOVER_AND_SEARCH_IMPLEMENTATION_PLAN.md`
17. `docs/18_HOME_DISCOVER_DIFFERENTIATION.md`
18. `docs/19_HOME_IMPLEMENTATION_BRIEF.md`
19. `docs/20_PROGRAM_AND_PROVIDER_DETAILS_PLAN.md`
20. `docs/21_BOOKING_FLOW_PLAN.md`
21. `docs/22_CHECKOUT_PLAN.md`
22. `docs/23_PRODUCTION_PLATFORM_REBASELINE.md`
23. `CLAUDE.md`
24. `FIRST_PROMPT.md` (historical bootstrap)
25. `HANDOFF.md` (live project status)

## Starting the project

1. Copy this entire package into the new Himma repository.
2. Open the repository root in Claude Code.
3. Paste the contents of `FIRST_PROMPT.md`.
4. Do not give Claude additional product explanations unless it reports a genuine contradiction in the source documents.
5. Review and approve the first Home screen before allowing the rest of the app to be built.

## Source-of-truth rule

When documents appear to conflict, use this priority:

1. `docs/01_PRODUCT_CONTEXT.md`
2. `docs/02_USERS_ACCOUNTS_AND_PARTICIPANTS.md`
3. `docs/03_SCOPE_AND_PRODUCT_SURFACES.md`
4. `docs/04_APP_NAVIGATION_AND_PAGE_INVENTORY.md`
5. `docs/05_DISCOVERY_CATALOGUE_AND_FILTERS.md`
6. `docs/06_UX_AND_INTERACTION_PRINCIPLES.md`
7. `docs/07_PROVISIONAL_BRAND_SYSTEM.md`
8. `docs/08_FRONTEND_ENGINEERING_CONTRACT.md`
9. `docs/09_OPEN_DECISIONS.md`
10. `docs/12_NATIVE_MOBILE_COMPATIBILITY.md`
11. `docs/23_PRODUCTION_PLATFORM_REBASELINE.md` (platform strategy, workstreams, phases, and launch gates)
12. Approved screen specifications (`docs/11_HOME_SCREEN_SPEC.md` and successors)
13. Task-specific prompts

Claude must not silently resolve a real contradiction. It must report the conflict and propose the smallest safe resolution.
