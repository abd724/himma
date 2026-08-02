# First Claude Code Prompt — Himma Home Foundation

Paste everything below into Claude Code from the repository root.

---

You are entering a fresh project and have zero access to the conversation that produced it.

The repository documents are the complete product context. Do not rely on memory, assumptions, or a generic marketplace template.

## Mandatory context pass

Before changing code:

1. Read `README.md`.
2. Read `CLAUDE.md`.
3. Read every numbered file under `/docs` in order from `01` through `09`.
4. Use the source-of-truth priority defined in `README.md`.

Then create a concise file:

`docs/10_CONTEXT_CONFIRMATION.md`

It must confirm, in your own words:

- What Himma is
- The two primary consumer needs
- The social purpose for children and young people
- Why Himma is not a directory
- The adult-account and participant model
- The current customer-mobile-app scope
- What is deliberately deferred
- The Home-versus-Discover model
- The required Ladies-only discovery behavior
- The provisional brand status
- The frontend-first and mock-service strategy
- The exact first milestone

Keep this confirmation under approximately 1,200 words.

If the source documents contain a real contradiction that changes the first milestone, stop and report it before coding. Do not manufacture questions that the documents already answer.

## Product-design posture

Act as:

- A senior consumer mobile product designer
- A senior React Native frontend engineer
- A UX reviewer focused on simplicity
- A careful product implementer

Use the installed frontend-design and Playwright capabilities where helpful.

Use Superpowers only to keep the work disciplined; do not turn this one-screen milestone into a large planning ceremony.

Himma's UI quality is a competitive requirement. The result must feel like an original, polished UAE consumer phone app. Learn from the clarity and convenience of strong apps such as Talabat and BEANZ, but do not copy their identity, colors, logo, exact layout, assets, or proprietary screens.

## Milestone objective

Build the real frontend foundation and **one excellent Home screen only**.

Do not build the rest of the app in this milestone.

Do not build:

- Discover in detail
- Search results
- Provider pages
- Program details
- Booking
- Checkout
- Credits flow
- Gifts flow
- Profile
- Provider portal
- Admin portal
- School or business product
- Backend
- Database
- Real authentication
- Real payments
- Real maps
- Real notifications
- Arabic or RTL

Other bottom-navigation items may be visually represented, but do not create customer-facing scaffold pages, phase labels, "coming soon" pages, or developer messages.

## Technical foundation

This is an actual iOS and Android phone app.

Use:

- Expo
- React Native
- Expo Router
- TypeScript strict mode

Do not use Next.js.

Initialize the Expo project in the current repository root without deleting:

- `README.md`
- `CLAUDE.md`
- `FIRST_PROMPT.md`
- `/docs`
- Existing `.git` history

If standard Expo scaffolding refuses a non-empty directory, scaffold safely in a temporary directory and move the required app files into the root.

Use the current stable Expo template available in the environment.

Use React Native StyleSheet with centralized typed theme tokens unless a very small equivalent is clearly better.

Do not install a large UI framework.

## Brief screen specification

Before implementing Home, create:

`docs/11_HOME_SCREEN_SPEC.md`

Keep it concise and practical.

It must define:

- Home's job
- The default mock persona
- Above-the-fold hierarchy
- Full scroll order
- Card types
- Interactions
- States
- Accessibility checks
- What is excluded
- Acceptance criteria

Do not create a giant project plan or route catalogue.

## Default mock context

Use deterministic fictional data.

Default signed-in customer:

- Sarah
- Participant: Me
- Child: Adam, age 8
- Child: Lina, age 12
- Current area: Khalifa City, Abu Dhabi

Use fictional provider names only.

Possible examples:

- Gravity Movement Studio
- Falcon Combat Academy
- Blue Wave Swimming
- Core Pilates House
- Noor Learning Centre
- Future Makers Robotics
- Horizon Padel Club
- Restore Wellness Studio

Use realistic AED prices and realistic Abu Dhabi areas.

Do not imply affiliation with real companies.

## Home-screen product requirements

Home is a personalized, scrollable marketplace feed.

It must not look like:

- A dashboard
- A directory
- A grid of admin modules
- A children's toy app
- A dark SaaS product
- A web page shrunk into a phone
- A generic AI-generated landing page

Design for approximately 390 × 844 logical pixels first.

### Required Home content

Use professional design judgment to create a coherent hierarchy. Do not force every section above the fold.

Include:

1. Safe-area-aware top area
   - Simple Himma wordmark
   - Khalifa City, Abu Dhabi location action
   - Notification action
   - Profile or sign-in action

2. Prominent search entry
   - Suggested placeholder:
     `Search activities, providers or classes`

3. Lightweight participant context
   - Everyone
   - Me
   - Adam
   - Lina
   - It may be a compact selector or sheet trigger
   - Do not create isolated Netflix-style profile sessions

4. Timely feature or hero
   - Relevant to active UAE life
   - Bright and image-led
   - Concise
   - One clear action
   - No generic startup slogan

5. Quick discovery filters
   - Today
   - This weekend
   - Near me
   - Ladies only
   - Camps
   - Offers

6. Popular categories
   - Image-backed
   - Approximately 6–8 initially visible
   - Include a balanced set such as:
     - Fitness
     - Boxing
     - Pilates
     - Swimming
     - Padel
     - Wellness
     - Learning
     - Kids & Teens
   - Provide a clear View all action
   - Do not use childish cartoon treatment

7. Recommended for you
   - Specific bookable program cards
   - Program title first
   - Provider secondary
   - Area
   - Schedule
   - Price model
   - Rating
   - Useful eligibility or offer badge
   - Favourite action

8. Recommended for Adam
   - Serious, age-appropriate body or mind activities
   - Examples may include swimming, football, Quran, robotics, or martial arts
   - Do not reduce children's content to simple play

9. Popular providers near you
   - Provider-first cards
   - Clearly different from program cards

10. Available today or tonight

11. Offers and trials

12. Marketplace Credit or rewards preview
   - Simple preview only
   - No real balance logic

13. Five-item floating navigation dock
   - Home
   - Discover
   - Bookings
   - Saved
   - Profile
   - Floating rounded capsule detached from the screen edges, per `docs/04_APP_NAVIGATION_AND_PAGE_INVENTORY.md` section 2
   - Active destination in its own rounded pill; icon plus short label per destination
   - Reusable component with centralized dock tokens
   - Not a full-width edge-to-edge tab bar

Home is active.

Do not route other tabs to unfinished customer-facing pages during this milestone.

## Visual system

Use the provisional Himma Orbit Indigo system from `docs/07_PROVISIONAL_BRAND_SYSTEM.md`.

Core direction:

- Light
- Bright
- Image-rich
- Modern
- Warm
- Energetic
- Premium
- Trustworthy
- Easy to scan
- Suitable for adults and families
- Not childish
- Not dark
- Not gamer-like
- Not corporate

Use:

- Centralized tokens
- Clean Manrope typography
- Rounded cards
- Soft borders
- Restrained shadows
- Consistent icons
- Large tap targets
- Strong photography
- Clear spacing

Do not hard-code brand values in screen components.

Use a simple replaceable text wordmark for Himma. Do not invent a permanent logo.

## Images

Use locally stored, commercially safe demo images where practical.

Create:

`docs/ASSET_ATTRIBUTION.md`

Record:

- Asset filename
- Source
- License or usage basis

Do not use:

- Real provider logos
- Images with third-party branding
- Images with embedded text
- Inconsistent cartoon art
- Unattributed assets

Provide graceful image fallbacks.

## Local interactions

The Home milestone should locally demonstrate:

- Location selector opening and closing
- Participant context selection
- Quick-filter selected state
- Ladies-only selected state
- Favourite toggle
- Horizontal category or card scrolling
- Search entry focus
- Reward or credit preview tap feedback
- Bottom navigation visuals

Do not simulate a fake full booking flow.

## Mock-service requirement

Do not import arbitrary mock arrays directly into the route screen.

Create a small typed Home feed contract and deterministic mock implementation so a future real API can replace it.

Keep this proportional to one screen. Do not model the entire backend.

## Accessibility and mobile quality

Ensure:

- Safe-area handling
- Readable type
- Screen-reader labels for icon buttons
- Touch targets generally at least 44 × 44
- Contrast-safe token use
- Text scaling tolerance
- Reduced-motion consideration
- No horizontal page overflow
- No card clipping
- Bottom navigation does not cover content
- Missing-image fallback
- Loading skeleton
- Empty recommendation fallback
- Selected states do not rely on color alone

## Visual review

After implementation:

1. Start the Expo app.
2. Run Expo web for repeatable browser inspection.
3. Use Playwright to inspect at:
   - 390 × 844
   - A smaller phone width
4. If an iOS simulator is available, inspect the native screen there too.
5. Capture:
   - Top of Home
   - Mid-feed
   - Bottom of Home
   - Ladies-only selected
   - Participant context changed
6. Save screenshots under:
   - `artifacts/home-review/`
7. Fix issues found before reporting.

Do not judge visual quality from code alone.

## Required checks

Run and report:

- TypeScript check
- Lint
- Expo Doctor
- Expo web launch
- Any tests you introduce
- Playwright visual and interaction checks

Do not hide warnings or failed checks.

## Git

Initialize Git if needed.

Commit this milestone as one focused commit after checks pass.

Suggested commit:

`feat(home): establish Himma mobile design foundation`

Do not begin Discover or any other primary screen after committing.

## Final report

Stop after Home.

Report:

- Exact command to run the app
- Exact Expo web URL
- Whether native simulator review was completed
- Files created
- Main design decisions
- Mock-service structure
- Screenshots saved
- Checks and results
- Known limitations
- Specific visual decisions the product owner should approve or reject

Do not continue until the Home screen is reviewed and approved.
