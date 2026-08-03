# Asset Attribution

Demo photography for the mock frontend. All photos are served from Unsplash and used under the [Unsplash License](https://unsplash.com/license) (free for commercial use, no attribution required; attribution recorded here anyway). Each file was downloaded from `https://images.unsplash.com/<photo-id>?w=900&q=75&fm=jpg&fit=crop` and stored locally under `assets/images/demo/`. Images were visually reviewed to exclude readable third-party logos and embedded marketing text; the 2026-08-03 milestone re-review found four residual marks that survived the first pass — see "Pre-release replacements" below.

These are placeholder assets for design review only; final launch photography will be sourced and licensed separately.

| File | Unsplash photo ID | Depicts | Used for |
|---|---|---|---|
| gym.jpg | photo-1517836357463-d25dfeac3438 | Barbell training | Fitness category, strength programs |
| fitness-woman.jpg | photo-1571019613454-1cb2f99b2d8b | Woman doing core workout | Ladies fitness programs |
| boxing.jpg | photo-1549719386-74dfcbf7dbed | Boxing gloves on mat | Boxing category and programs |
| yoga-pose.jpg | photo-1544367567-0f2fcb009e0b | Sunset yoga pose | Pilates category, mind-body programs |
| pool-lanes.jpg | photo-1530549387789-4c1017266635 | Butterfly swimmer in lane pool | Swimming category and programs |
| swim-race.jpg | photo-1560090995-01632a28895b | Aerial lap-pool race | Home hero (Indoor this August) |
| tennis.jpg | photo-1554068865-24cecd4e34b8 | Clay-court tennis serve | Padel & racquet category (depicts tennis; padel photo to be sourced later) |
| wellness.jpg | photo-1540555700478-4be289fbecef | Spa towel and candle still life | Wellness category and programs |
| yoga-calm.jpg | photo-1506126613408-eca07ce68773 | Morning meditation | Wellness and recovery programs |
| books.jpg | photo-1503676260728-1c00da094a0b | Classroom books and letters | Learning category |
| library.jpg | photo-1567168544813-cc03465b4fa8 | Student reading in library | Learning and academic programs |
| quran.jpg | photo-1609599006353-e629aaabfeae | Ornamented Quran | Quran and Islamic learning programs |
| football.jpg | photo-1431324155629-1a6deb1dec8d | Night football match, wide shot | Kids football programs |
| karate.jpg | photo-1555597673-b21d5c935865 | Young karate practitioner at sunset | Kids & Teens category, martial arts |
| robotics.jpg | photo-1587654780291-39c9404d746b | Building bricks | Junior robotics/engineering programs |
| coding.jpg | photo-1581091226825-a6a2a5aee158 | Engineer working with electronics | Teen coding and engineering programs |
| art.jpg | photo-1513364776144-60967b0f800f | Paint brushes and color | Art and creativity programs |

Rejected during review (deleted, not shipped): images containing readable Nike, Brooks, Reyes, SoftBank Pepper, or hotel branding, an off-brief black-and-white gym, and a massage photo unsuited to a family app.

## Pre-release replacements (2026-08-03 re-review)

Acceptable for internal design review; replace before anything customer-facing or externally distributed:

- **gym.jpg** — readable sportswear marks (shoe swoosh, striped shorts) survived the first review pass.
- **robotics.jpg** — full-frame branded building bricks (protected trade dress; moulded wordmark visible on studs).
- **boxing.jpg** — legible manufacturer wordmark with ® on the glove cuff.
- **books.jpg** — small legible pencil-manufacturer wordmark in the foreground.
- Second-pass candidates (marks present but not clearly legible at 900 px): fitness-woman.jpg (shoe sidewall pattern, smartwatch), karate.jpg (gi patches), library.jpg (book cover art).

Known polish debt: 17 photos cover 62 surfaces (~3.6× reuse), so the same photo can appear as a category tile, a collection card, and several program cards in one scroll; some pairings are semantic placeholders (tennis for padel, karate for a multi-activity camp, meditation for mat pilates, adult imagery on two junior programs). Final launch photography resolves both.

## Fonts and icons (shipped in the app bundle)

| Asset | Source | License |
|---|---|---|
| Manrope (5 weights) | `@expo-google-fonts/manrope` | SIL Open Font License 1.1 — © 2018 The Manrope Project Authors; the OFL notice must ship with the font (add to a future in-app licences screen) |
| Ionicons | `@expo/vector-icons` | MIT — © Ionic |

App icon, splash, and favicon are the default Expo-generated placeholders pending final branding. Note the iOS icon (`assets/expo.icon/`) composes the **Expo logo mark** itself — it must be replaced before any build leaves internal review.
