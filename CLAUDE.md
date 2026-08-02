# Himma — Permanent Claude Code Instructions

## Context discipline

You are working in a fresh repository and have no access to the product-owner conversation that produced these documents.

Before planning or coding, read every numbered file under `/docs` in order and read the root `README.md`.

Do not reduce Himma to a generic booking app, gym directory, children's entertainment app, or responsive website.

Do not invent permanent business rules. When a decision is genuinely unresolved, follow `docs/09_OPEN_DECISIONS.md`, use only the documented temporary assumption if the current task requires it, and record any new assumption.

## Product priority

Himma is an actual consumer phone app for iOS and Android.

Ease of use and visual quality are primary competitive requirements. The customer should prefer Himma because discovering and booking an activity feels clearer, faster, and more enjoyable than using fragmented provider websites, Instagram pages, WhatsApp conversations, or weaker marketplace interfaces.

## Current delivery strategy

Build the real customer frontend first with realistic mock data and mock service interfaces.

Do not implement the production backend, database, authentication, payment gateway, provider portal, administration portal, or school/business product during the current frontend stage.

The frontend must remain technically realistic and replace mock services with real APIs later without redesigning screens.

## Scope protection

Current users are:

- Adults booking for themselves
- Adults who also manage child participant profiles

The current product does not include schools, universities, companies, institutional trips, quotation workflows, purchase orders, or organization workspaces. Those belong to a possible future Himma for Business product.

## Account model

Every adult customer owns one account.

That account always includes the account holder as a participant called `Me` and may include zero or more parent-managed child profiles.

A parent can book for themselves and their children from the same account. Do not create separate rigid parent and individual products.

## Customer journey ownership

All of the following happen inside Himma:

- Discovery
- Comparison
- Participant selection
- Booking
- Payment
- Confirmation
- Schedule management
- Cancellation and refund handling
- Credits
- Gifts
- Rewards
- Booking history

Do not design redirects to external providers to complete a purchase.

## Mobile and design rules

- Primary target: approximately 390 × 844 logical pixels
- Light theme only during this stage
- English only during this stage
- Touch-first and one-handed where practical
- No desktop dashboard patterns
- No dark default surfaces
- No childish visual treatment
- No developer-facing labels, phase badges, scaffold messages, or internal terminology
- No real provider logos or implied affiliations
- Use the provisional Himma design tokens from `docs/07_PROVISIONAL_BRAND_SYSTEM.md`
- Keep all brand values centralized and replaceable

## Working method

For each major screen or connected flow:

1. Re-read the relevant product documents.
2. Write a concise screen or flow specification.
3. Implement one coherent milestone.
4. Run the app.
5. Inspect the actual rendered result at phone size.
6. Fix visual, accessibility, navigation, and interaction problems.
7. Run type checking, linting, Expo diagnostics, and applicable tests.
8. Commit the milestone separately.
9. Stop for product-owner approval when the task prompt requires it.

Use installed design, browser, planning, and Git skills when helpful, but do not let process replace product judgment.

Do not build the entire app in one uncontrolled pass.
