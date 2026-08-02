# 07 — Provisional Himma Brand and UI System

## 1. Status

This is a temporary working identity for the frontend.

It is not the final company branding.

A future professional branding team may replace:

- Logo
- Color palette
- Typography
- Illustration direction
- Photography direction
- Iconography
- Motion
- Tone of voice

The frontend must therefore use centralized, semantic design tokens and reusable components.

## 2. Brand personality

The working Himma experience should feel:

- Energetic
- Optimistic
- Modern
- Warm
- Trustworthy
- Helpful
- Aspirational
- Active
- Suitable for adults and families
- Suitable for body and mind activities
- Not childish
- Not dark
- Not corporate
- Not gamer-like

## 3. Provisional color direction: Orbit Indigo

### Core colors

| Token | Value | Intended use |
|---|---:|---|
| `brand.primary` | `#5146E5` | Primary actions, active navigation, selected controls |
| `brand.primaryPressed` | `#4035C4` | Pressed and active action state |
| `brand.primarySoft` | `#F0EEFF` | Selected chips, soft highlights, subtle surfaces |
| `brand.accentWarm` | `#FF7A66` | Warm promotional accent, decorative emphasis |
| `brand.reward` | `#FFD86A` | Rewards, credits, gifts, celebratory moments |
| `background.main` | `#FBFAFF` | Main app background |
| `surface.card` | `#FFFFFF` | Cards and sheets |
| `text.primary` | `#20223A` | Main text |
| `text.secondary` | `#6D7085` | Supporting text |
| `border.default` | `#E8E7F0` | Dividers and card borders |
| `status.success` | `#2DBA7F` | Positive status with text/icon support |
| `status.error` | `#DC4C5A` | Error status with appropriate contrast treatment |

### Usage rules

- Keep the app predominantly light.
- Use the primary indigo for important interactions, not large full-screen backgrounds.
- Use warm coral sparingly.
- Use yellow as a surface or highlight with dark text; do not use it as small text on white.
- Do not use coral as normal body text on white.
- Never use color as the only status indicator.
- Photography should carry much of the visual energy.

## 4. Theme token structure

Use semantic tokens rather than raw hex values in components.

Suggested structure:

```ts
export const colors = {
  brand: {
    primary: '#5146E5',
    primaryPressed: '#4035C4',
    primarySoft: '#F0EEFF',
    accentWarm: '#FF7A66',
    reward: '#FFD86A',
  },
  background: {
    main: '#FBFAFF',
    elevated: '#FFFFFF',
  },
  text: {
    primary: '#20223A',
    secondary: '#6D7085',
    inverse: '#FFFFFF',
  },
  border: {
    default: '#E8E7F0',
  },
  status: {
    success: '#2DBA7F',
    error: '#DC4C5A',
  },
};
```

No screen should contain repeated raw brand hex values.

## 5. Typography

Provisional family:

**Manrope**

Fallbacks should remain clean and platform-appropriate.

Suggested mobile hierarchy:

| Role | Approximate size | Weight |
|---|---:|---:|
| Hero title | 28–32 | 700 |
| Screen title | 24–28 | 700 |
| Section title | 19–22 | 700 |
| Card title | 16–18 | 600–700 |
| Body | 15–16 | 400–500 |
| Supporting | 13–14 | 400–500 |
| Caption | 12–13 | 500 |

Guidelines:

- Do not use a decorative serif for the customer app.
- Avoid very small essential information.
- Use weight and spacing before introducing extra colors.
- Keep prices and schedules highly readable.

## 6. Spacing

Use a consistent 4-point-based scale.

Suggested tokens:

- 4
- 8
- 12
- 16
- 20
- 24
- 32
- 40

Default phone page horizontal padding:

- 16 or 20 logical pixels

Section spacing should create rhythm without making the feed feel empty.

## 7. Shape language

Suggested radii:

- Small chip: fully rounded
- Button: 14–16
- Search bar: 16–20
- Card: 18–22
- Image: 16–20
- Bottom sheet: 24–28 top corners
- Hero: 22–26

Avoid making every element a pill.

## 8. Shadows and borders

Prefer:

- Soft borders
- Subtle elevation
- Clear spacing

Avoid:

- Heavy black shadows
- Floating-card overload
- Glassmorphism
- Neon glows
- Dashboard-style outlines

## 9. Iconography

Use one consistent rounded icon family.

Icons should:

- Be immediately recognizable
- Have accessible labels
- Use consistent stroke weight
- Avoid overly playful cartoon styling
- Avoid mixing several icon sets visibly

## 10. Photography

Photography is central to the Himma experience.

Use imagery that feels:

- Active
- Authentic
- Diverse
- Aspirational
- Relevant to UAE life
- Suitable for adults and young people
- Focused on real participation

Represent both:

- Body activities
- Mind and skill activities

Avoid:

- Unrelated generic stock imagery
- Childish cartoon art for all youth content
- Visible third-party logos
- Images with embedded marketing text
- Inconsistent photographic treatments
- Unlicensed assets

For development assets:

- Store images locally where practical
- Record source and license information in `docs/ASSET_ATTRIBUTION.md`
- Use fictional provider branding

## 11. Logo treatment

Until final branding exists:

- Use a clean text wordmark: `Himma`
- Do not invent a complicated permanent logo
- Keep the wordmark implementation replaceable
- Do not use a symbol that becomes embedded throughout the app before brand review

## 12. Motion

Suggested duration:

- Fast feedback: 120–180 ms
- Standard transition: 180–250 ms

Use platform-appropriate easing.

Respect reduced-motion preferences.

## 13. Rebranding requirement

The future branding team should be able to change the customer identity by updating:

- Theme tokens
- Typography configuration
- Logo assets
- Icon wrapper
- Shared component variants
- Image guidelines

A rebrand must not require editing every screen individually.
