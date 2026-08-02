# 02 — Users, Accounts, and Participants

## 1. Core principle

Himma does not need separate rigid products called "individual account" and "parent account."

Every adult customer has one flexible account.

That account contains:

- The account holder as a participant named **Me**
- Zero or more managed child participant profiles

This model supports adults, parents, and adults who later become parents without duplicate accounts.

## 2. Guest user

A guest should be able to:

- Open the app
- Browse Home
- Browse Discover
- Search
- View categories
- View providers
- View programs
- View general schedules, prices, reviews, and availability

Authentication becomes necessary for account-specific actions such as:

- Booking
- Paying
- Saving favourites
- Managing participants
- Viewing bookings
- Using credits
- Receiving rewards
- Gifting
- Leaving reviews

The app must not begin with a forced login wall.

## 3. Adult account owner

The adult account owner controls:

- Login identity
- Contact information
- Payment methods
- Marketplace Credit
- Rewards
- Referrals
- Gifts
- Favourites
- Notifications
- Booking history
- Calendar and schedule
- Managed child profiles
- Privacy settings
- Account deletion

The adult may book activities for themselves even when child profiles exist.

## 4. Self participant: Me

Every adult account includes one self participant represented in the interface as:

- Me
- The adult's display name where useful

The self participant can have:

- Date of birth or age band where required
- Interests
- Preferred areas
- Preferred times
- Skill levels
- Accessibility preferences
- Booking history
- Recommendation history

The product should not force an adult to create a second account merely because they originally joined to manage children.

## 5. Managed child participant

A parent or guardian may add multiple child profiles.

A child profile may eventually contain only the information necessary for eligibility, safety, personalization, and service delivery.

Possible fields include:

- First name
- Date of birth
- Interests
- Skill level
- Accessibility requirements
- Safety or medical notes where justified
- Emergency information where justified
- Consent records

The exact legally approved field set is not final and should not be overbuilt during the first Home-screen milestone.

A managed child profile is not automatically a separate login.

## 6. Onboarding model

Onboarding may ask:

> Who would you like to find activities for?

Options:

- Myself
- My children
- Both

This answer personalizes initial setup but must not create a permanent account limitation.

A user who selects "Myself" may add children later.

A user who selects "My children" still retains the `Me` participant and may book for themselves later.

## 7. Participant context in discovery

The app may allow the customer to browse with a participant context such as:

- Everyone
- Me
- Adam
- Lina

The selected context influences:

- Recommendations
- Age eligibility (a child's age, calculated from date of birth, is compared with provider-defined minimum and maximum ages; out-of-range programs are excluded from that child's recommendations and results)
- Relevant categories
- Schedule emphasis
- Program formats
- Pricing emphasis

The selected context must not silently filter the catalogue by gender. Adults see all otherwise relevant classes (men, ladies, or mixed provider classifications) by default; "Ladies only" exists only as an optional customer filter. Children's suitability is age-based, not gender-filter-based.

It must not become a restrictive Netflix-style profile session.

A parent should not need to switch into Adam's isolated account, complete one booking, exit, then enter Lina's isolated account.

## 8. Participant selection at checkout

The browsing context does not determine the final booking participant.

Checkout must explicitly ask who will attend.

Depending on the program, the customer may select:

- Me
- One child
- Multiple children
- Me and one or more children where the offering permits it

Eligibility is evaluated for each selected participant.

## 9. Personalized experience

A family Home feed may contain separate sections such as:

- Recommended for you
- Recommended for Adam
- Recommended for Lina
- Activities for the family
- Continue Adam's learning journey
- Available after school
- Weekend activities

An individual-only Home feed may emphasize:

- Recommended for you
- Available today
- Evening classes
- Fitness and wellness nearby
- Drop-ins
- Packages
- Monthly memberships
- Try something new

The overall navigation and visual language remain consistent.

## 10. Age and minor-account status

The exact policy for independent users aged 16–17 is not final and requires legal review.

For current frontend work:

- The adult-controlled account and managed-child flow is authoritative.
- Do not design a fully independent minor account flow unless a later approved specification requires it.
- Do not block age-appropriate program cards from appearing in realistic mock data.

## 11. Privacy principle

Providers should eventually receive only the participant information necessary to deliver a confirmed activity.

Child information must not be exposed broadly in discovery, social features, public profiles, or provider browsing.
