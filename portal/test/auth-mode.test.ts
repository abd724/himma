import { resolveAuthMode } from '../src/auth/auth-mode';

describe('resolveAuthMode (production fail-closed)', () => {
  test('development defaults to fixture mode', () => {
    expect(resolveAuthMode({ configuredMode: undefined, isProduction: false })).toBe('fixture');
  });

  test('a production build with no configuration is UNCONFIGURED (fail-closed), never fixture', () => {
    expect(resolveAuthMode({ configuredMode: undefined, isProduction: true })).toBe('unconfigured');
    expect(resolveAuthMode({ configuredMode: '', isProduction: true })).toBe('unconfigured');
  });

  test('fixture mode in production requires the explicit opt-in switch', () => {
    expect(resolveAuthMode({ configuredMode: 'fixture', isProduction: true })).toBe('fixture');
  });

  test('unknown configuration values fail closed in every environment', () => {
    expect(resolveAuthMode({ configuredMode: 'live', isProduction: true })).toBe('unconfigured');
    expect(resolveAuthMode({ configuredMode: 'nonsense', isProduction: false })).toBe('unconfigured');
  });
});
