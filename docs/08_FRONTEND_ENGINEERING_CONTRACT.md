# 08 — Frontend Engineering Contract

## 1. Platform decision

The Himma customer product is an actual iOS and Android mobile app.

Use:

- Expo
- React Native
- Expo Router
- TypeScript in strict mode

The app may run through Expo web for rapid visual review and Playwright inspection, but native mobile behavior is authoritative.

Do not build the customer app as a Next.js website.

## 2. Repository goal

This repository should become the real customer frontend foundation.

It is not a throwaway screenshot prototype.

The code should be suitable for later connection to production services.

## 3. Initialization

Initialize the Expo project at the repository root.

Preserve:

- `README.md`
- `CLAUDE.md`
- `FIRST_PROMPT.md`
- `/docs`
- Existing Git history

If the Expo scaffolding command refuses to initialize a non-empty directory, scaffold into a temporary directory and copy only the required project files into the root without deleting documentation or Git metadata.

Use the current stable Expo template available in the environment.

## 4. Navigation

Use Expo Router.

Expected long-term route grouping may include:

```text
app/
  _layout.tsx
  (entry)/
  (tabs)/
    _layout.tsx
    index.tsx
    discover.tsx
    bookings.tsx
    saved.tsx
    profile.tsx
  search/
  category/
  activity/
  provider/
  program/
  booking/
  credits/
  gifts/
  referrals/
  participants/
  settings/
```

Do not create every future route during the first Home milestone.

## 5. Suggested source structure

```text
src/
  components/
    ui/
    domain/
  features/
    home/
    discovery/
    booking/
    account/
  data/
    mock/
  services/
    contracts/
    mock/
  theme/
    colors.ts
    typography.ts
    spacing.ts
    radii.ts
    shadows.ts
    index.ts
  types/
  hooks/
  utils/
  assets/
```

Keep domain logic out of route files.

## 6. Styling

Use React Native `StyleSheet` with centralized typed theme tokens, or a comparably small typed styling approach.

Do not introduce a large UI framework or design system dependency for the first milestone.

Do not scatter raw colors, spacing values, or typography choices through screens.

## 7. Components

Create reusable primitives only when they serve the current milestone.

Likely early primitives:

- Screen container
- Safe-area header
- Search field
- Filter chip
- Section header
- Category tile
- Program card
- Provider card
- Reward or credit card
- Avatar action
- Icon button
- Bottom navigation
- Image fallback
- Loading skeleton

Avoid creating an abstract component system before real screen needs exist.

## 8. Mock service boundary

Screens should not import raw mock arrays directly from many locations.

Use clear service or repository contracts, for example:

```ts
interface HomeFeedService {
  getHomeFeed(input: HomeFeedInput): Promise<HomeFeed>;
}
```

The first implementation may return deterministic local data.

Later, the mock implementation can be replaced by an API implementation.

## 9. Domain types

Define enough type structure to keep the frontend coherent.

Relevant concepts include:

- Customer
- Participant
- ChildParticipant
- Provider
- Branch
- Category
- ActivityType
- Program
- Session
- PriceModel
- Eligibility
- Availability
- Offer
- RecommendationSection
- CreditSummary

Do not prematurely model the complete production database.

## 10. State

For the first milestone:

- Use local component state and a small context only where necessary
- Do not install a global state library without a demonstrated need
- Keep mock data deterministic
- Do not generate random values on each render
- Keep current location and participant context easy to replace later

## 11. Images and assets

- Use local demo assets where practical
- Optimize image dimensions
- Use `expo-image` or the appropriate Expo image solution
- Provide a visible fallback
- Record attribution in `docs/ASSET_ATTRIBUTION.md`
- Do not use real provider logos
- Do not imply affiliation with real businesses

## 12. Accessibility

Use:

- Accessible labels
- Correct roles
- Logical reading order
- Sufficient touch targets
- Screen-reader-friendly icon buttons
- Reduced-motion consideration
- Text that scales without destroying layout
- Contrast-safe token usage

## 13. Localization readiness

English only now.

Keep user-facing strings organized so Arabic can be introduced later.

Do not implement RTL or duplicate content during the current milestone.

Do not hard-code English strings across dozens of domain components if a simple centralized content layer is practical.

## 14. Frontend validation versus backend authority

The frontend may provide immediate user feedback, but future backend services remain authoritative.

Examples:

- Frontend may display eligibility; backend must revalidate later.
- Frontend may display capacity; backend must protect the final place later.
- Frontend may calculate a preview total; backend must calculate the authoritative charge later.
- Frontend may show credit; backend ledger must authorize use later.

Do not fake production correctness in the frontend.

## 15. Quality commands

Define scripts for:

- Type checking
- Linting
- Tests where introduced
- Expo diagnostics

Before reporting a milestone complete, run at minimum:

- TypeScript check
- Lint
- Expo Doctor
- Expo web preview
- Any existing tests

If an iOS simulator is available, inspect the screen there as well.

## 16. Visual QA

For each approved screen:

- Inspect at approximately 390 × 844
- Inspect a smaller phone width
- Check safe areas
- Check horizontal overflow
- Check text wrapping
- Check card clipping
- Check bottom-navigation overlap
- Check scroll behavior
- Check touch target size
- Check image loading and fallback
- Check selected and unselected states

Use Playwright against Expo web for repeatable visual checks when useful.

## 17. Git

- Initialize Git if needed
- Make one focused commit per approved milestone
- Do not bundle unrelated refactors into a screen commit
- Do not rewrite approved history casually
- Do not commit secrets or generated build output

## 18. Dependency discipline

- Prefer Expo-supported packages
- Avoid unnecessary dependencies
- Do not perform forced dependency upgrades without reviewing impact
- Document every nontrivial dependency and why it is needed
- Do not install backend, database, payment, or admin packages during the Home milestone
