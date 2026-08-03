import { initialScenarioFromSearch } from '@/state/account-context';
import { describe, expect, test } from '@jest/globals';

describe('initialScenarioFromSearch — QA fixture selection only (docs/19 §3)', () => {
  test('valid qa-scenario values select their fixture', () => {
    expect(initialScenarioFromSearch('?qa-scenario=guest')).toBe('guest');
    expect(initialScenarioFromSearch('?qa-scenario=me-only')).toBe('me-only');
    expect(initialScenarioFromSearch('?qa-scenario=me-active')).toBe('me-active');
    expect(initialScenarioFromSearch('?qa-scenario=household')).toBe('household');
  });

  test('missing, empty, or unknown values fall back to the default demo household', () => {
    expect(initialScenarioFromSearch(undefined)).toBe('household');
    expect(initialScenarioFromSearch('')).toBe('household');
    expect(initialScenarioFromSearch('?qa-scenario=sarah')).toBe('household');
    expect(initialScenarioFromSearch('?other=1')).toBe('household');
  });
});
