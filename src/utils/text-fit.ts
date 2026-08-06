import { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import type { NativeSyntheticEvent, TextLayoutEventData } from 'react-native';

/**
 * Long-word card-title fitting (audit-observation correction, 2026-08-06).
 *
 * At large font scale on narrow widths a title's longest word can exceed its
 * column, and Android's default break strategy renders that overflow as a
 * hyphen-less mid-word split ("Beginner C" / "alisthenics"). No text API
 * prevents it directly: auto-fit APIs accept mid-word-wrapped layouts as
 * "fitting", and the greedy strategy tail-ellipsizes inside the word instead.
 *
 * So the fix is detection-driven: read the real line layout, and only when a
 * line boundary falls inside a word, cap the title's font-scale multiplier
 * one step at a time (docs/12 §4 dense-control allowance) until the word
 * wraps whole — never below base size, and never engaging at all where the
 * layout already breaks cleanly (normal scale and wide screens keep their
 * approved rendering untouched).
 */

export interface MeasuredLine {
  text: string;
}

/** Ellipsis and invisible trailing characters platforms append to a
    truncated last line (Android also emits U+FEFF padding). */
const TRUNCATION_TAIL = /[\u2026\uFEFF\u200B]+$/u;

/** True when the character boundary at `index` of `text` falls inside a word. */
function cutsWord(text: string, index: number): boolean {
  const before = text[index - 1];
  const after = text[index];
  return (
    before !== undefined && after !== undefined && !/\s/.test(before) && !/\s/.test(after)
  );
}

/**
 * True when the rendered layout cuts a word: either a line boundary inside a
 * word (Android's hyphen-less overflow split, "Beginner C" / "alisthenics")
 * or a tail ellipsis that truncates inside a word (iOS's overflow mode,
 * "Boxing " / "Fundament…").
 */
export function hasMidWordLineBreak(text: string, lines: readonly MeasuredLine[]): boolean {
  let index = 0;
  for (const line of lines.slice(0, -1)) {
    index += line.text.length;
    if (cutsWord(text, index)) return true;
  }
  const last = lines[lines.length - 1];
  if (last !== undefined) {
    const visible = last.text.replace(TRUNCATION_TAIL, '');
    const truncatedAt = index + visible.length;
    if (truncatedAt < text.length && cutsWord(text, truncatedAt)) return true;
  }
  return false;
}

/** Fitting steps: modest caps first, floored at base size (multiplier 1). */
const TITLE_SCALE_CAPS = [1.2, 1.1, 1] as const;

/** The next smaller cap to try, or undefined when the floor is reached. */
export function nextTitleScaleCap(current: number | undefined): number | undefined {
  return TITLE_SCALE_CAPS.find((cap) => cap < (current ?? Number.POSITIVE_INFINITY));
}

/**
 * Title-fitting props for a Text node. `style` scales the token base so the
 * rendered size equals base × min(cap, fontScale) — the cap semantics of
 * maxFontSizeMultiplier, expressed through style because this RN version
 * ignores the multiplier prop on Android (verified in the 2026-08-06
 * correction). `key` forces a remount per step: Android also re-fires
 * onTextLayout only on mount, so each step gets a fresh layout event until
 * the title wraps at a word boundary. Settles in at most three steps, only
 * for layouts that actually split a word; at normal font scale the factor
 * is 1 and the approved rendering is untouched.
 */
export function useMidWordFitCap(
  text: string,
  base: { fontSize: number; lineHeight: number },
  fontScale: number,
): {
  key: string;
  style: { fontSize: number; lineHeight: number } | undefined;
  onTextLayout: (event: NativeSyntheticEvent<TextLayoutEventData>) => void;
  adjustsFontSizeToFit: boolean;
  minimumFontScale: number;
} {
  const [cap, setCap] = useState<number | undefined>(undefined);

  // A different title starts from the uncapped layout again (render-time
  // derived-state reset — react.dev "storing information from previous renders").
  const [capText, setCapText] = useState(text);
  if (capText !== text) {
    setCapText(text);
    setCap(undefined);
  }

  const onTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      if (!hasMidWordLineBreak(text, event.nativeEvent.lines)) return;
      setCap((current) => nextTitleScaleCap(current) ?? current);
    },
    [text],
  );

  const factor = cap === undefined || fontScale <= 0 ? 1 : Math.min(cap, fontScale) / fontScale;
  return {
    key: `text-fit-${cap ?? 'uncapped'}`,
    style:
      factor === 1
        ? undefined
        : {
            fontSize: Math.round(base.fontSize * factor * 100) / 100,
            lineHeight: Math.round(base.lineHeight * factor * 100) / 100,
          },
    onTextLayout,
    // iOS's overflow mode is tail truncation, which its layout events do not
    // expose (lines report the un-ellipsized text) — but truncation is
    // exactly what adjustsFontSizeToFit reverses on iOS. The floor keeps the
    // rendered size at or above base: at normal scale the minimum is 1, so
    // the approved rendering cannot change. Android keeps the detector path
    // (its mid-word wrap is not truncation, so auto-fit ignores it).
    adjustsFontSizeToFit: Platform.OS === 'ios',
    minimumFontScale:
      fontScale > 1 ? Math.min(1, Math.max(1 / fontScale, 0.7)) : 1,
  };
}
