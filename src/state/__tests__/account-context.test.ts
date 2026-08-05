import { scenarioFromParam } from '@/state/account-context';
import { describe, expect, test } from '@jest/globals';

describe('scenarioFromParam — QA fixture selection only (docs/19 §3, router param)', () => {
  test('valid qa-scenario values select their fixture', () => {
    expect(scenarioFromParam('guest')).toBe('guest');
    expect(scenarioFromParam('me-only')).toBe('me-only');
    expect(scenarioFromParam('me-active')).toBe('me-active');
    expect(scenarioFromParam('household')).toBe('household');
  });

  test('router array params use the first value', () => {
    expect(scenarioFromParam(['me-only', 'guest'])).toBe('me-only');
  });

  test('missing or unknown values resolve undefined (provider falls back to the demo household)', () => {
    expect(scenarioFromParam(undefined)).toBeUndefined();
    expect(scenarioFromParam('')).toBeUndefined();
    expect(scenarioFromParam('sarah')).toBeUndefined();
    expect(scenarioFromParam(1)).toBeUndefined();
    expect(scenarioFromParam([])).toBeUndefined();
  });
});
