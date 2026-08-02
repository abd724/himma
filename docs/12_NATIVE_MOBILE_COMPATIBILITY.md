# 12 — Native Mobile Compatibility Rules

Himma is an iOS and Android phone app. Expo web exists only as an additional preview and automated-review surface. Every screen and shared component must be native-safe from its first implementation, even when it is first reviewed in a browser.

These rules are permanent and apply to every milestone.

## 1. Approval levels

Every screen moves through three distinct approval levels. Never conflate them.

1. **Design approved** — the product owner has approved the screen specification (hierarchy, behavior, visual direction).
2. **Frontend implementation approved** — the product owner has approved the implemented screen after web-based visual review and automated checks.
3. **Native validated** — the implemented screen has been verified in an iOS Simulator or on a physical iPhone (and ideally an Android device or emulator). A screen must never be reported as native validated on the strength of web review alone.

Current status of Home (HMA-004), as of 2026-08-02:

| Level | Status |
|---|---|
| Design approved | ✅ Approved |
| Frontend implementation approved | ✅ Provisionally approved; 360-pt search clipping fixed same day, owner confirmation pending |
| Native validated | ⏳ Pending — no full Xcode on the development machine yet |

When Xcode becomes available, run the native pass for Home before or alongside the next screen's native pass.

## 2. Platform API rules

- Use React Native and Expo-SDK-compatible APIs only. No bare-native modules without an Expo config plugin and explicit justification.
- No DOM APIs (`document`, `window`, `localStorage`, `navigator`), no CSS-only behavior, no browser-only libraries in app code.
- No hover-dependent interactions. Hover may enhance the web preview but nothing may require it.
- Persistent state, when it arrives, uses native-safe storage (e.g. `expo-secure-store`, AsyncStorage), never browser storage.
- `Platform.select` / `.ios.tsx` / `.android.tsx` / `.web.tsx` splits are allowed but must default to correct native behavior.

## 3. Safe areas

- Every screen respects top and bottom safe-area insets via `react-native-safe-area-context` (`SafeAreaView` edges or `useSafeAreaInsets`).
- Support notches, Dynamic Island, and the iOS home indicator: nothing interactive within the inset regions.
- The floating dock must never use a fixed bottom offset. Its position is always `insets.bottom + dockTokens.safeAreaOffset` (already implemented in `src/components/domain/floating-dock.tsx`).
- Scroll content adds bottom padding derived from dock tokens plus insets so no content is trapped behind the dock.
- Bottom sheets pad their content by `insets.bottom`.

## 4. Typography and Dynamic Type

- All text styles come from `src/theme/typography.ts` tokens. No ad-hoc font sizes in screens.
- Support iOS Dynamic Type and Android font scaling: layouts must tolerate larger text without clipping or overlap. Do not set `allowFontScaling={false}` as a fix; fix the layout instead.
- Where unbounded scaling would genuinely break a dense control (e.g. dock labels), cap with `maxFontSizeMultiplier` (≈1.3–1.5) rather than disabling scaling.
- Tolerate font-metric differences across iOS, Android, and web: never rely on exact pixel text widths; use `numberOfLines`, flexible containers, and min-heights.
- Manrope loads through `expo-font`; until fonts load, the splash screen stays visible (no unstyled-text flash).

## 5. Keyboard handling

- Any screen with text input must plan keyboard avoidance (`KeyboardAvoidingView` with platform-appropriate `behavior`, or an equivalent) so focused inputs are never hidden.
- Inputs define `returnKeyType` and sensible focus order; multi-field forms move focus on submit.
- Tapping outside an input dismisses the keyboard where that matches platform convention (`keyboardShouldPersistTaps="handled"` on scroll views with inputs).
- The floating dock hides or yields during focused transactional flows (docs/04 §2); keyboard appearance must not push the dock over content.

## 6. Navigation, sheets, and back behavior

- Expo Router is the only navigation system. No web-style routing assumptions; deep links map through the router.
- Android hardware/gesture back must always do something sensible: close the top-most sheet or modal first, then navigate back.
- Modals and bottom sheets use native-appropriate presentation (`Modal`, router modals) and respect `onRequestClose` for Android back.
- iOS swipe-back stays enabled on pushed screens unless a flow explicitly requires confirmation before leaving.
- Full-screen states are used only when the task requires them (docs/04 §3).

## 7. Touch and gesture standards

- All interactions use `Pressable`-based components (`PressableFeedback`) — never web-only click handling.
- Touch targets are at least 44 × 44 points; smaller glyphs get `hitSlop`.
- Press feedback is subtle (dim, small scale) and respects the OS reduce-motion setting via `useReducedMotion`.
- Horizontal carousels must scroll correctly inside vertical scroll views on native: horizontal `ScrollView`/`FlatList` with `showsHorizontalScrollIndicator={false}`, no gesture traps. Verify on device that vertical scrolling does not fight the carousels.
- No gesture-only functionality without a visible alternative.

## 8. Images and performance

- Use `expo-image` with local assets where practical; every image has a visible fallback (`AppImage`).
- Ship appropriately sized assets (demo set is ~900 px wide); avoid multi-megabyte images in lists.
- Carousels with many items should move to `FlatList` when content grows beyond the current small mock sets.
- Keep mock data deterministic — no per-render randomness (also required for review reproducibility).
- Avoid unnecessary re-renders: static token/style objects via `StyleSheet.create`, memoized lookups for hot paths.
- Animations must be light, subtle, and disabled under reduced motion. No decorative long-running animation loops.

## 9. Platform integration readiness

Keep these future integrations possible; do not block them with architectural shortcuts:

- **Sign in with Apple** (and Google) — auth screens represent these providers; real auth arrives with the backend.
- **Apple Pay / Google Pay** — checkout UI represents them; the payment surface must not assume card-only flows.
- **Calendar export** — confirmed bookings will offer Apple/Google calendar actions (docs/09 §13).
- **Deep links** — the `himma` scheme is configured in `app.json`; new screens should have router paths that can become deep-link targets.
- **Contextual permission prompts** — location, notifications, and calendar permissions are requested in context when the feature ships, never at app launch.

## 10. Device and simulator test matrix

Native validation for a screen means checking at minimum:

| Surface | Target | Notes |
|---|---|---|
| iOS Simulator | iPhone 16/17 class (Dynamic Island) | Primary target ~390 × 844+ |
| iOS Simulator | A smaller device (e.g. iPhone SE class) | Narrow width, no notch |
| iOS | Larger text (Dynamic Type at ~135%) | Layout tolerance |
| Android emulator or device | A ~360-dp-wide phone | Back gesture, font metrics |
| Expo web (Playwright) | 390 × 844 and 360 × 780 | Automated regression only — never a substitute for native validation |

Per screen, verify: safe areas, dock position, scroll + carousel gestures, keyboard behavior (if inputs), press feedback, text scaling, image loading, reduced motion.

If Xcode or a simulator is unavailable, continue native-safe implementation and web review, and mark iOS validation as **pending** in the milestone report. Never claim native validation without having run the screen natively.
