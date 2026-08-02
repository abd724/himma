# 06 — UX and Interaction Principles

## 1. UI is a core competitive advantage

Himma's user interface is not decoration.

A customer may choose one marketplace over another because it is:

- Easier to understand
- Faster to browse
- More pleasant to use
- More transparent
- Better organized
- More reliable during checkout

The quality benchmark is the ease and polish of strong UAE consumer applications such as Talabat and BEANZ.

Himma may learn from established patterns, but it must not copy another company's brand, colors, logo, exact screens, proprietary assets, or distinctive layout.

## 2. Phone app first

Himma is first and foremost a phone app.

Design priority:

1. iPhone-sized phone layout
2. Android phone layout
3. Larger phones
4. Tablet adaptation later
5. Web preview only for development and review

Do not design a desktop website and shrink it.

Use:

- Native-feeling navigation
- Safe areas
- Floating navigation dock (see `docs/04` section 2)
- Bottom sheets
- Touch-first controls
- Horizontal carousels where useful
- Clear back behavior
- One-handed actions where practical

## 3. Immediate comprehension

A first-time customer should understand the purpose of a screen without explanation.

Every screen needs:

- One clear primary purpose
- A clear visual hierarchy
- A clear primary action where applicable
- Familiar labels
- Visible important information
- Minimal competing emphasis

Do not expose internal terms such as offering, entity, record, phase, scaffold, route, or implementation state to customers.

## 4. Minimize friction

Prefer:

- Browsing before login
- Saved location and preferences
- One-tap quick filters
- Progressive disclosure
- Smart defaults
- Bottom sheets rather than long forms
- Clear participant selection
- Pre-filled known information
- Concise policy summaries with full detail available
- Visible payment totals
- Visible availability
- Simple confirmation screens

Avoid:

- Forced onboarding questionnaires
- Deep nested category funnels
- Re-entering the same information
- Large forms on one screen
- Hidden fees
- Hidden eligibility
- Ambiguous button labels
- Too many modal interruptions

## 5. Home-feed behavior

Home should feel alive and useful.

It may combine:

- Seasonal or timely feature
- Search
- Quick filters
- Popular categories
- Program recommendations
- Provider recommendations
- Available-today content
- Children-specific sections
- Adult sections
- Offers
- Trials
- Credits and rewards

Home should not look like a static directory grid or an admin dashboard.

## 6. Discover behavior

Discover should be visual and scrollable.

The user may:

- Browse categories
- Explore collections
- Open a provider
- Open a program
- Search directly
- Apply filters
- Switch to map results

Do not require the user to answer "body or mind?" and then several additional questions before seeing content.

Those ideas may organize content behind the scenes, but the interface should expose useful options immediately.

## 7. Cards

### Program cards

Prioritize:

- Program title
- Useful image
- Provider name
- Area
- Schedule
- Price model
- Participant suitability
- Rating
- Trial, offer, or availability badge
- Favourite action

Do not overload every card with every field.

### Provider cards

Prioritize:

- Provider identity
- Categories
- Area
- Rating
- Verification where meaningful
- Starting price or program count where useful

### Category cards

Use:

- Strong representative image
- Short label
- Consistent visual treatment
- No text embedded inside the image

## 8. Children and young people

Content for children and teens must not automatically look childish.

A serious swimming, robotics, Quran, football, boxing, language, or coding program should look aspirational and capable.

The visual treatment should communicate:

- Energy
- Development
- Trust
- Safety
- Progress
- Confidence

Avoid preschool visual language unless the specific program is actually for preschool-age participants.

## 9. Ladies-only and eligibility UX

"Ladies only" must be easy to discover.

Use it where relevant as:

- A quick filter
- A filter option
- A visible program or session badge
- A search suggestion
- A saved preference later

Eligibility should be attached to the program or session, not assumed from the provider alone.

## 10. Trust

Trust signals may include:

- Verified provider status
- Reviews from verified bookings
- Clear policies
- Clear pricing
- Realistic availability
- Branch location
- Facilities
- Instructor information where relevant
- Cancellation information
- Customer support entry

Do not use fake urgency, misleading scarcity, or unsupported safety claims.

## 11. Accessibility

Frontend requirements include:

- Semantic accessible labels
- Sufficient contrast
- Readable text
- Scalable layouts
- Screen-reader-friendly controls
- Logical focus order where applicable
- Visible focus for web preview
- Touch targets generally no smaller than 44 × 44 logical pixels
- Reduced-motion support
- Do not rely on color alone for status
- Clear error messages and recovery actions

## 12. States

Each major screen eventually needs:

- Default
- Loading
- Empty
- Partial data
- Error
- Offline or network failure where relevant
- Success
- Disabled action
- Permission denied where relevant
- Full capacity
- Price or availability changed
- Missing image fallback

The first Home milestone needs at least:

- Normal content
- Loading skeleton concept
- Missing image fallback
- Empty recommendation fallback
- Selected and unselected filter states

## 13. Motion

Motion should:

- Reinforce navigation
- Confirm interaction
- Feel responsive
- Remain subtle

Avoid:

- Long entrance animations
- Excessive bouncing
- Decorative motion that delays use
- Motion that makes the app feel like a game

## 14. Copywriting

Customer copy should be:

- Direct
- Friendly
- Brief
- Helpful
- Specific

Prefer:

> 4 places left

over:

> Capacity availability status: limited

Prefer:

> Who is joining?

over:

> Select booking participants

Prefer:

> Use AED 65 credit

over:

> Apply stored marketplace balance
