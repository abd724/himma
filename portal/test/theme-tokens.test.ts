import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { colors, layout, radii, shadows, spacing } from '../src/theme';

/**
 * The CSS custom properties in tokens.css must stay in lockstep with the
 * TypeScript tokens — the single place brand values live (docs/07 §13).
 */
const tokensCss = readFileSync(join(__dirname, '../src/theme/tokens.css'), 'utf8');

function cssVar(name: string): string | null {
  const match = tokensCss.match(new RegExp(`${name}:\\s*([^;]+);`));
  return match?.[1]?.trim().toLowerCase() ?? null;
}

describe('design-token parity (tokens.css ↔ src/theme)', () => {
  test.each([
    ['--hp-color-brand-primary', colors.brand.primary],
    ['--hp-color-brand-primary-pressed', colors.brand.primaryPressed],
    ['--hp-color-brand-primary-soft', colors.brand.primarySoft],
    ['--hp-color-brand-accent-warm', colors.brand.accentWarm],
    ['--hp-color-brand-reward', colors.brand.reward],
    ['--hp-color-background-main', colors.background.main],
    ['--hp-color-background-elevated', colors.background.elevated],
    ['--hp-color-text-primary', colors.text.primary],
    ['--hp-color-text-secondary', colors.text.secondary],
    ['--hp-color-text-inverse', colors.text.inverse],
    ['--hp-color-border-default', colors.border.default],
    ['--hp-color-status-success', colors.status.success],
    ['--hp-color-status-error', colors.status.error],
    ['--hp-color-overlay-backdrop', colors.overlay.backdrop],
  ])('%s matches the TypeScript token', (variable, expected) => {
    expect(cssVar(variable)).toBe(expected.toLowerCase());
  });

  test.each(Object.entries(spacing))('spacing %s is mirrored', (name, value) => {
    expect(cssVar(`--hp-space-${name}`)).toBe(`${value}px`);
  });

  test.each([
    ['--hp-radius-chip', radii.chip],
    ['--hp-radius-control', radii.control],
    ['--hp-radius-button', radii.button],
    ['--hp-radius-card', radii.card],
    ['--hp-radius-panel', radii.panel],
    ['--hp-radius-avatar', radii.avatar],
  ])('%s is mirrored', (variable, value) => {
    expect(cssVar(variable)).toBe(`${value}px`);
  });

  test.each([
    ['--hp-shadow-card', shadows.card],
    ['--hp-shadow-popover', shadows.popover],
    ['--hp-shadow-drawer', shadows.drawer],
  ])('%s is mirrored', (variable, value) => {
    expect(cssVar(variable)).toBe(value.toLowerCase());
  });

  test('layout dimensions are mirrored', () => {
    expect(cssVar('--hp-sidebar-width')).toBe(`${layout.sidebarWidth}px`);
    expect(cssVar('--hp-rail-width')).toBe(`${layout.railWidth}px`);
    expect(cssVar('--hp-top-bar-height')).toBe(`${layout.topBarHeight}px`);
    expect(cssVar('--hp-content-max-width')).toBe(`${layout.contentMaxWidth}px`);
  });

  test('no raw brand hex value leaks outside the theme layer', () => {
    // Components must consume tokens, never raw hex (docs/07 §4).
    const output = execSync(
      `grep -rliE '#(5146e5|4035c4|f0eeff|ff7a66|ffd86a|fbfaff|20223a|6d7085|e8e7f0|2dba7f|dc4c5a)' src --include='*.tsx' --include='*.css' | grep -v 'src/theme/' || true`,
      { cwd: join(__dirname, '..'), encoding: 'utf8' },
    ).trim();
    expect(output).toBe('');
  });
});
