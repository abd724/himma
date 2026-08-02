# 04 — Customer App Navigation and Page Inventory

## 1. Navigation principle

Himma should feel like a simple consumer phone app, not a nested enterprise system.

The customer should be able to browse naturally, search directly, open a provider or program, and complete a booking without navigating through a questionnaire.

## 2. Primary bottom navigation — floating dock

Himma's primary navigation is a **floating bottom navigation dock**, not a standard built-in, edge-to-edge bottom tab bar.

Five destinations:

1. **Home**
2. **Discover**
3. **Bookings**
4. **Saved**
5. **Profile**

Search remains prominent in the page header and the Discover experience. It is not a sixth dock control.

Dock requirements:

- The dock floats above the bottom safe area, visually detached from the left, right, and bottom screen edges.
- Large rounded capsule container.
- Each destination shows an icon and a short text label.
- The active destination sits inside its own larger rounded pill within the dock.
- Unselected destinations remain visually quiet.
- Soft elevated surface, subtle border, restrained shadow.
- App content remains visible behind the floating region.
- Scroll content receives sufficient bottom padding so no card or action is covered.
- Touch targets are at least 44 × 44 logical pixels.
- iPhone and Android bottom safe areas are respected.
- The dock is hidden during focused transactional flows such as checkout and payment.
- Do not use a full-width rectangular bar attached to the bottom edge.

The dock must be a reusable component with centralized tokens for: background, active pill, icon color, label color, radius, elevation, height, safe-area offset, and horizontal margin.

BEANZ-style floating navigation may be used as a structural reference only. Do not copy BEANZ's colors, coffee icon, exact measurements, or exact destinations.

Map discovery should initially live inside Discover and search results rather than consuming a permanent dock position.

This can be revisited after usability testing.

## 3. Global app elements

Common mobile elements may include:

- Safe-area-aware header
- Current location
- Notification access
- Account avatar or sign-in action
- Search entry
- Participant context selector
- Bottom navigation
- Bottom sheets for filters and selections
- Toasts or lightweight confirmation messages
- Full-screen states only when the task requires them

## 4. Screen count

The planned customer frontend contains:

- **32 primary screens**
- **8 reusable overlays or bottom-sheet surfaces**

Not every state requires a separate route. Loading, empty, failure, success, and permission states should reuse the relevant screen structure.

## 5. Primary screen inventory

### Entry and access

#### HMA-001 — Splash

Purpose:
- Brief branded launch state
- Route returning users into the app
- Route first-time users to onboarding

Design:
- Minimal
- Bright
- No long animation
- No login wall

#### HMA-002 — Onboarding

Purpose:
- Explain the value of Himma in a few concise panels

Core messages:
- Discover activities for you and your family
- Book and pay in one place
- Manage every activity in one schedule

Actions:
- Continue as guest
- Create account
- Sign in

#### HMA-003 — Sign in and create account

Purpose:
- Authenticate only when account functionality is required

Represent:
- Sign in with Apple
- Google
- Email
- Password recovery
- Account creation

Do not build real authentication during the frontend stage.

### Main navigation screens

#### HMA-004 — Home

Purpose:
- Personalized, scrollable marketplace feed
- Show useful activities without forcing a search

Core content:
- Location
- Search
- Participant context
- Quick filters
- Seasonal or campaign feature
- Popular categories
- Recommended for Me
- Recommended for children
- Available today
- Popular providers nearby
- Offers and trials
- Credits or rewards preview

Home should be program-first while still including provider and category sections.

#### HMA-005 — Discover

Purpose:
- Visual, browsable marketplace catalogue similar in ease to a strong social or commerce discovery feed

Core content:
- Search
- Categories
- Activity types
- Provider collections
- Popular programs
- Adult fitness and wellness
- Learning and skills
- Children and teens
- Camps and seasonal content
- Nearby and trending content

Do not make Discover a step-by-step questionnaire.

#### HMA-006 — Bookings

Purpose:
- Unified schedule across all providers

Views:
- Upcoming
- Calendar or agenda
- Past

Core information:
- Date and time
- Participant
- Provider
- Program
- Location
- Package or membership status
- Changes or cancellations

#### HMA-007 — Saved

Purpose:
- Keep favourite content easy to return to

Tabs:
- Programs
- Providers
- Collections

#### HMA-008 — Profile

Purpose:
- Account hub

Core content:
- Personal information
- Participants
- Payment methods
- Credits and rewards
- Gifts
- Referrals
- Notifications
- Help
- Privacy
- Account deletion

### Discovery screens

#### HMA-009 — Search

Purpose:
- Support direct intent

Content:
- Search field
- Recent searches
- Suggested searches
- Popular searches
- Suggestions grouped by activity, provider, category, and location

#### HMA-010 — Search results

Purpose:
- Show relevant marketplace results

Tabs:
- All
- Programs
- Providers
- Categories

Actions:
- Filter
- Sort
- Map

#### HMA-011 — All categories

Purpose:
- Show the complete visual catalogue without overcrowding Home

Design:
- Image-backed category grid
- Clear labels
- No long text descriptions
- Seasonal and supply-aware ordering

#### HMA-012 — Category

Example:
- Martial Arts
- Wellness
- Learning and Languages

Content:
- Featured activity types
- Popular bookable programs
- Relevant providers
- Offers
- Nearby options
- Category-specific filters

#### HMA-013 — Activity type

Example:
- Kickboxing
- Calisthenics
- Pilates
- Quran memorization

Content:
- Programs as the default result
- Providers
- Map
- Filters
- Relevant schedules and pricing models

#### HMA-014 — Provider storefront

Purpose:
- Show everything available from one verified provider

Content:
- Provider identity
- Verification
- Cover imagery
- Description
- Branches
- Facilities
- Accessibility
- Categories
- Programs
- Sessions
- Memberships
- Packages
- Offers
- Reviews
- Policies

The provider name on a program card should open this screen.

#### HMA-015 — Program details

Purpose:
- Explain one bookable program clearly enough for the customer to decide

Content:
- Program imagery
- Title
- Provider
- Participant suitability
- Gender/session eligibility
- Schedule
- Program format
- Price model
- Capacity or availability
- Trial
- Location
- Instructor where relevant
- Description
- Requirements
- Policies
- Reviews
- Book action
- Gift action

#### HMA-016 — Map results

Purpose:
- Explore nearby providers and programs geographically

Frontend stage:
- Use a deterministic mock map or map-like representation
- Do not integrate a production map provider yet

### Booking screens

#### HMA-017 — Session, membership, or package selector

Purpose:
- Let the customer choose what is being purchased

Supports:
- One-time session
- Drop-in
- Trial
- Recurring class
- Monthly program
- Term program
- Camp
- Session package
- Membership
- Private lesson

#### HMA-018 — Participant selection

Purpose:
- Confirm who will attend

Options:
- Me
- One child
- Multiple eligible children
- Mixed household participants where the program allows it

#### HMA-019 — Eligibility review

Purpose:
- Explain eligibility results per participant

States:
- Eligible
- Ineligible
- Additional information required
- Session-specific restriction

Do not hide the reason for an ineligible result.

#### HMA-020 — Booking summary and policy

Purpose:
- Confirm selection before payment

Content:
- Program
- Provider
- Branch
- Date or recurring schedule
- Participants
- Price
- Add-ons
- Capacity hold
- Cancellation policy snapshot
- Terms acceptance

#### HMA-021 — Checkout

Purpose:
- Complete payment inside Himma

Content:
- Price breakdown
- Marketplace Credit checkbox
- Remaining amount
- Payment method
- Gift or promotional code
- Final action

#### HMA-022 — Payment status

States:
- Processing
- Successful
- Failed
- Pending
- Capacity lost
- Retry-safe result

The frontend simulates these states only.

#### HMA-023 — Booking confirmation

Purpose:
- Give immediate confidence that the booking exists

Content:
- Booking reference
- Provider
- Program
- Participants
- Schedule
- Location
- Directions
- Add to Apple Calendar
- Add to Google Calendar
- View booking
- Gift or share only where appropriate

### Booking management screens

#### HMA-024 — Booking detail

Content:
- Booking status
- Participant
- Schedule
- Provider instructions
- Location
- Policy
- Calendar action
- Cancel or reschedule action where permitted
- Support entry

#### HMA-025 — Cancellation and refund

Content:
- Policy explanation
- Refund amount
- Refund to original payment method
- Immediate Marketplace Credit where offered
- Confirmation
- Result state

#### HMA-026 — Package or membership detail

Content:
- Active dates
- Remaining sessions
- Upcoming sessions
- Renewal status
- Usage history
- Provider
- Policy
- Manage action

### Credits, growth, and retention screens

#### HMA-027 — Credits and rewards

Content:
- Marketplace Credit balance
- Credit history
- Rewards points
- Available benefits
- Birthday reward
- Referral reward status
- Explanation of how credit applies at checkout

#### HMA-028 — Gifts

Supports:
- Gift a specific session
- Gift a package
- Gift Marketplace Credit
- Received gifts
- Redeem gift

#### HMA-029 — Referrals

Content:
- Share code or link
- Configurable demo reward
- Pending referrals
- Completed referrals
- Eligibility explanation

### Account screens

#### HMA-030 — Participants

Content:
- Me
- Child profiles
- Add child
- Edit participant
- Interests
- Age and eligibility information
- Accessibility preferences

#### HMA-031 — Notifications

Content:
- Booking updates
- Schedule changes
- Offers
- Reward events
- Support replies

#### HMA-032 — Settings, privacy, and help

Content:
- Personal settings
- Notification preferences
- Help and support
- Privacy information
- Data request entry
- Account deletion
- Language later

## 6. Reusable overlays and sheets

### HMS-001 — Location selector

- Current area
- Recent areas
- Search area
- Use current location later

### HMS-002 — Participant context selector

- Everyone
- Me
- Each managed child

### HMS-003 — Filters

- Eligibility
- Date
- Time
- Location
- Price
- Program format
- Availability
- Trial
- Rating
- Accessibility
- Other relevant criteria

### HMS-004 — Sort

- Recommended
- Nearest
- Soonest available
- Highest rated
- Lowest price
- Most popular
- Newest

### HMS-005 — Payment methods

- Saved method placeholders
- Apple Pay representation
- Google Pay representation
- Add method

### HMS-006 — Add or edit child

- Minimal fields
- Progressive disclosure
- No unnecessary sensitive data

### HMS-007 — Add to calendar

- Apple Calendar
- Google Calendar
- Other supported calendar later

### HMS-008 — Policy details

- Cancellation
- Refund
- Attendance
- Program requirements

## 7. Primary connection map

```text
Splash
  ├─ Returning user → Home
  └─ First visit → Onboarding
                       ├─ Continue as guest → Home
                       └─ Sign in / Create account

Home
  ├─ Search → Search → Results
  ├─ Category → Category → Activity Type
  ├─ Program card → Program Details
  ├─ Provider card → Provider Storefront
  ├─ Quick filter → Filtered Results
  └─ Credit preview → Credits and Rewards

Discover
  ├─ All Categories
  ├─ Category
  ├─ Activity Type
  ├─ Program Details
  ├─ Provider Storefront
  └─ Map Results

Program Details
  ├─ Provider name → Provider Storefront
  ├─ Gift → Gifts
  └─ Book → Session/Package Selector
               → Participant Selection
               → Eligibility Review
               → Booking Summary
               → Checkout
               → Payment Status
               → Booking Confirmation
               → Booking Detail

Bookings
  ├─ Booking Detail
  ├─ Package/Membership Detail
  └─ Cancellation and Refund

Profile
  ├─ Participants
  ├─ Credits and Rewards
  ├─ Gifts
  ├─ Referrals
  ├─ Notifications
  └─ Settings, Privacy, and Help
```

## 8. First milestone

The first implementation milestone builds only:

- Mobile app foundation
- Provisional theme
- Home screen
- Visual bottom navigation
- Minimal local interactions required to review Home

No other primary screen should be designed in detail until Home is approved.
