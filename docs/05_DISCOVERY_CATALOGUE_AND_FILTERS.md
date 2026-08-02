# 05 — Discovery, Catalogue, and Filters

## 1. Discovery philosophy

Himma should support two behaviors at the same time:

### Known intent

The user knows what they want.

Examples:

- Kickboxing near Khalifa City
- Ladies-only Pilates tonight
- Quran memorization for an eight-year-old
- Calisthenics gym
- Swimming camp this weekend

The app should support direct search and fast filtering.

### Exploratory intent

The user wants to see what is available.

Examples:

- What can I do tonight?
- What can my children do after school?
- What is popular near me?
- What can I try this weekend?
- What new activity could help Adam develop a skill?

The app should support a visual feed, image-backed categories, curated collections, provider features, and personalized recommendations.

Do not force the user through a sequence of questions before showing useful content.

## 2. Home versus Discover

### Home

Home is personalized and timely.

It should primarily surface:

- Specific bookable programs
- Offers
- Trials
- Relevant providers
- Recommendations for Me
- Recommendations for each child
- Activities available today
- Activities near the selected location
- Seasonal or weekend content
- Rewards and credit

Home should help the user act immediately.

### Discover

Discover shows the breadth of Himma.

It should combine:

- Categories
- Activity types
- Programs
- Providers
- Collections
- Trends
- Nearby content
- Adult activities
- Children and teen activities
- Body-development activities
- Mind-development activities

Discover should feel scrollable and visual, not like a form.

## 3. Provider-first and program-first content

Himma needs both.

### Program-first content

Home, search, and activity-type results should usually prioritize specific bookable programs because they answer:

- What exactly is offered?
- Who is it for?
- When is it?
- How much does it cost?
- Is it available?
- Is it ladies only or otherwise restricted?
- Is there a trial?

Example:

> Beginner Calisthenics  
> Gravity Movement Studio  
> Today, 7:30 PM · AED 85 drop-in

### Provider-first content

Provider carousels and provider search should help users discover complete businesses.

Example:

> Falcon Combat Academy  
> Boxing · Kickboxing · Jiu-jitsu  
> Khalifa City · 4.8 rating

Opening the provider shows all of its relevant programs, branches, memberships, packages, and offers.

## 4. Underlying product structure

The customer should not be forced to understand the technical hierarchy, but the frontend should represent it consistently:

```text
Provider
  → Branch
  → Offering
  → Program
  → Session or recurring schedule
  → Capacity and availability
  → Booking
```

Discovery structure:

```text
Category
  → Activity type
  → Relevant programs and providers
```

## 5. Initial catalogue direction

The catalogue must support adults and children without duplicating the same activity data.

### Fitness and gyms

Possible activity types:

- Weight training
- Calisthenics
- Functional fitness
- Cross-training
- Personal training
- Group fitness
- Strength and conditioning

"Gyms" may appear as a customer-facing browse category, while individual programs and gym types remain structured underneath.

### Martial arts and combat sports

- Boxing
- Kickboxing
- Muay Thai
- Jiu-jitsu
- Karate
- Taekwondo
- Judo
- Wrestling
- Self-defence

### Swimming and water activities

- Swimming
- Water safety
- Diving
- Kayaking
- Sailing
- Other supported water activities

### Padel and racquet sports

- Padel
- Tennis
- Badminton
- Squash

### Pilates, yoga, and movement

- Pilates
- Reformer Pilates
- Yoga
- Mobility
- Stretching
- Dance and movement

### Team, individual, and outdoor sports

- Football
- Basketball
- Volleyball
- Cricket
- Athletics
- Cycling
- Golf
- Horse riding
- Hiking
- Climbing
- Outdoor adventure

### Wellness and recovery

- Massage
- Sports massage
- Recovery
- Stretching
- Sauna
- Meditation
- Breathwork
- Relaxation services

Medical or regulated treatment services must not be casually introduced without legal and licensing review.

### Learning and languages

- Arabic
- English
- Other languages
- Public speaking
- Reading and writing
- Academic support
- Life skills

### Quran and Islamic learning

- Quran reading
- Quran memorization
- Tajweed
- Islamic studies
- Arabic for Quran

### Technology and STEM

- Coding
- Robotics
- Artificial intelligence
- Engineering
- Electronics
- Game development
- 3D design

### Arts, music, and creativity

- Drawing
- Painting
- Crafts
- Pottery
- Photography
- Music
- Piano
- Guitar
- Singing
- Theatre
- Cooking
- Other creative workshops

### Camps and seasonal programs

- Summer camps
- Winter camps
- Spring camps
- Holiday camps
- Weekend programs
- After-school programs

These are program formats or curated collections and should not duplicate the underlying activity taxonomy.

### Children and teens

"Kids & Teens" may be a prominent discovery collection.

It is not a separate duplicated catalogue.

A child's martial arts program and an adult martial arts program can share the same activity type while differing in eligibility, schedule, price model, and presentation.

## 6. Program and pricing models

The frontend should be able to represent:

- Free activity
- Free trial
- Paid trial
- Drop-in or price per session
- Weekly price
- Monthly program
- Recurring membership
- Term program
- Session package
- Private lesson
- Group lesson
- Camp price
- One-time workshop
- Ongoing enrollment

Program cards must emphasize the information most important for that model.

Examples:

### Drop-in

> AED 85 per session  
> Today, 7:30 PM

### Monthly

> AED 450/month  
> Tuesdays and Thursdays

### Term

> AED 1,800 per term  
> Sunday and Tuesday after school

### Camp

> AED 1,250/week  
> 10–14 August

### Package

> AED 400 for five sessions

## 7. Required filters

### Participant and eligibility

- Me
- Specific child
- Age range
- Adults
- Children
- Ladies only
- Girls only
- Men only
- Boys only
- Mixed
- Family where relevant

The customer-facing label **Ladies only** must be prominent and easy to use.

Internally, eligibility may use structured canonical values, but the UI wording must be natural for the UAE audience.

Eligibility can vary by session even when the provider is mixed.

### Time

- Today
- Tomorrow
- This weekend
- Date range
- Day of week
- Morning
- Afternoon
- Evening
- After school

### Location

- Area
- Distance
- Near me
- Map bounds
- Branch

### Activity and format

- Category
- Activity type
- Camp
- Recurring class
- Monthly program
- Drop-in
- Trial
- Private
- Group
- Indoor
- Outdoor

### Commercial

- Price range
- Free
- Offers
- Trial available
- Instant booking
- Available places
- Package
- Membership

### Suitability

- Skill level
- Language
- Accessibility support
- Rating
- Instructor or provider attributes where appropriate

## 8. Sorting

Potential sorts:

- Recommended
- Nearest
- Soonest available
- Highest rated
- Most popular
- Lowest price
- Newest

Sponsored content must be clearly identified later and must never bypass eligibility, verification, or availability rules.

## 9. Recommendation principles

Recommendations may eventually use:

- Selected participant
- Age
- Interests
- Previous bookings
- Completed attendance
- Favourites
- Search behavior
- Reviews
- Preferred area
- Preferred times
- Budget
- Skill progression
- Accessibility needs
- Current availability
- Season
- Provider quality

The first frontend should use deterministic mock recommendations.

Customer-facing explanations should be understandable:

- Recommended for you
- Recommended for Adam
- Because you viewed Pilates
- Continue Lina's robotics journey
- Available near Khalifa City
- Suitable for age 8

Do not label every personalized section as "AI."
