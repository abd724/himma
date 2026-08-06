import { describe, expect, test } from '@jest/globals';
import { hasMidWordLineBreak, nextTitleScaleCap } from '@/utils/text-fit';

/**
 * Long-word card-title fitting (audit-observation correction, 2026-08-06):
 * Android's default break strategy splits an overflowing word across lines
 * without a hyphen ("Beginner C" / "alisthenics"). The detector recognizes
 * that split from onTextLayout lines; the step function walks the title's
 * font-scale cap toward — never below — base size.
 */
describe('hasMidWordLineBreak', () => {
  test('detects the audited Android overflow split', () => {
    expect(
      hasMidWordLineBreak('Beginner Calisthenics', [
        { text: 'Beginner C' },
        { text: 'alisthenics' },
      ]),
    ).toBe(true);
  });

  test('a word-boundary wrap is clean — trailing space on the first line', () => {
    expect(
      hasMidWordLineBreak('Beginner Calisthenics', [
        { text: 'Beginner ' },
        { text: 'Calisthenics' },
      ]),
    ).toBe(false);
  });

  test('a word-boundary wrap is clean — space leading the next line', () => {
    expect(
      hasMidWordLineBreak('Beginner Calisthenics', [
        { text: 'Beginner' },
        { text: ' Calisthenics' },
      ]),
    ).toBe(false);
  });

  test('single-line text never reports a break', () => {
    expect(hasMidWordLineBreak('Boxing Fundamentals', [{ text: 'Boxing Fundamentals' }])).toBe(
      false,
    );
    expect(hasMidWordLineBreak('Boxing', [])).toBe(false);
  });

  test('detects the iOS overflow mode — tail ellipsis cutting inside a word', () => {
    expect(
      hasMidWordLineBreak('Boxing Fundamentals', [
        { text: 'Boxing ' },
        { text: 'Fundament…' },
      ]),
    ).toBe(true);
  });

  test('detects the Android ellipsis variant with trailing BOM characters', () => {
    expect(
      hasMidWordLineBreak('Ladies Boxing Fitness', [
        { text: 'Ladies ' },
        { text: 'Boxing Fit…﻿﻿﻿' },
      ]),
    ).toBe(true);
  });

  test('a tail ellipsis dropping whole words only is not a mid-word cut', () => {
    // "Ladies Boxing Fitness Foundations" cut exactly after "Fitness ".
    expect(
      hasMidWordLineBreak('Ladies Boxing Fitness Foundations', [
        { text: 'Ladies Boxing ' },
        { text: 'Fitness …' },
      ]),
    ).toBe(false);
  });

  test('a full untruncated layout reports no cut', () => {
    expect(
      hasMidWordLineBreak('Boxing Fundamentals', [{ text: 'Boxing ' }, { text: 'Fundamentals' }]),
    ).toBe(false);
  });

  test('detects a split at any boundary of a three-line layout', () => {
    expect(
      hasMidWordLineBreak('Junior Football Development', [
        { text: 'Junior ' },
        { text: 'Football Dev' },
        { text: 'elopment' },
      ]),
    ).toBe(true);
  });
});

describe('nextTitleScaleCap', () => {
  test('steps 1.2 → 1.1 → 1.0 and then stops', () => {
    expect(nextTitleScaleCap(undefined)).toBe(1.2);
    expect(nextTitleScaleCap(1.2)).toBe(1.1);
    expect(nextTitleScaleCap(1.1)).toBe(1);
    expect(nextTitleScaleCap(1)).toBeUndefined();
  });

  test('never returns a cap below base size', () => {
    let cap: number | undefined;
    for (let i = 0; i < 10; i += 1) {
      const next = nextTitleScaleCap(cap);
      if (next === undefined) break;
      expect(next).toBeGreaterThanOrEqual(1);
      cap = next;
    }
    expect(cap).toBe(1);
  });
});
