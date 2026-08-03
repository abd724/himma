# 03 — Current Scope and Product Surfaces

## 1. Current product being built

The current repository is for the **Himma customer mobile app**.

It is the real frontend foundation for the intended iOS and Android product, not a disposable website mockup.

The current development strategy is:

1. Design and build the customer mobile frontend using mock data.
2. Review and approve every major page, navigation path, and state.
3. Define backend contracts against the accepted frontend.
4. Implement the backend later in vertical slices.
5. Replace mock services with real APIs without redesigning the approved customer experience.

## 2. Current audience

The current customer app serves:

- Adults booking for themselves
- Parents and guardians booking for themselves and managed children

The app should work naturally for an adult with no children, an adult with children, or an adult who adds children later.

## 3. Current customer capabilities

The complete customer frontend is expected to represent:

- Guest browsing
- Home feed
- Discover
- Visual categories and collections
- Search
- Filters
- Map-based discovery
- Provider storefronts
- Program details
- Sessions
- Packages
- Memberships
- Camps
- Trials
- Participant selection
- Multi-participant booking
- Checkout
- Marketplace Credit
- Payment outcome states
- Booking confirmation
- Unified booking schedule
- Calendar export or connection entry points
- Cancellations and refund choices
- Saved items
- Gifts
- Referrals
- Rewards
- Notifications
- Profile
- Managed child profiles
- Help, privacy, and account deletion

The first implementation milestone builds only the Home screen and the minimal mobile shell necessary to review it.

## 4. Explicitly not being built now

Do not implement during the customer-frontend stage:

- Production backend
- Production database
- Real authentication
- Real payment gateway
- Real capacity transactions
- Real push notifications
- Real calendar integration
- Real maps integration
- Behavioral or machine-learning recommendation engine (simple deterministic rule-based recommendations are in scope — see `docs/05_DISCOVERY_CATALOGUE_AND_FILTERS.md` section 9)
- Real provider integrations
- Provider web portal
- Administration web portal
- Public customer website
- Provider application website
- School or university accounts
- Company or organization accounts
- Institutional trips
- Requests for quotation
- Purchase orders
- Organization invoicing
- Arabic or RTL
- Final company branding

Mock interfaces may anticipate these later systems, but must not pretend that they are functional.

## 5. Future product surface: customer web

A future customer website may support public discovery, search-engine indexing, shareable provider pages, shareable program pages, and browser checkout.

It is not the current repository's priority.

## 6. Future product surface: provider partnership website

A future public website will explain provider benefits and allow providers to submit an expression of interest.

It will not immediately publish a provider into the marketplace.

## 7. Future product surface: provider portal

A future responsive provider web portal will allow approved providers to manage:

- Organization profile
- Verification
- Branches
- Storefront
- Activities and programs
- Sessions and schedules
- Pricing models
- Capacity
- Media
- Offers
- Bookings
- Attendance
- Cancellations
- Reviews
- Transactions
- Reports
- Staff and permissions

Approved information will reflect in the customer app through the shared backend.

## 8. Future product surface: administration portal

A future secured administration portal will control:

- Provider onboarding and verification
- Categories
- Content approval
- Customers
- Bookings
- Payments
- Refunds
- Credits
- Rewards
- Support
- Reviews
- Finance
- Roles
- Permissions
- Audit logs
- Platform configuration

## 9. Future product surface: Himma for Business

A separate future business product may support schools, universities, companies, and organizations.

It must not be mixed into the current consumer navigation or Home feed.

## 10. Frontend approval gate

The production backend should not dictate an unapproved customer experience.

Before serious backend implementation begins, the customer frontend should have approved:

- Navigation
- Page inventory
- Visual system
- Discovery model
- Provider and program presentation
- Booking journey
- Schedule management
- Credits, gifts, and rewards presentation
- Loading, empty, error, and success states
- Accessibility and mobile usability

Technical feasibility and data contracts should still be considered during frontend work so the approved design remains implementable.
