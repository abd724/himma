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

We are building the real customer mobile frontend first.

The frontend will use realistic mock data and mock service boundaries. The backend, database, real authentication, real payment processing, provider portal, and administration portal will be implemented later, after the customer experience is approved.

The current app is English-only. Arabic and RTL are planned later.

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
13. `CLAUDE.md`
14. `FIRST_PROMPT.md`

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
11. Approved screen specifications (`docs/11_HOME_SCREEN_SPEC.md` and successors)
12. Task-specific prompts

Claude must not silently resolve a real contradiction. It must report the conflict and propose the smallest safe resolution.
