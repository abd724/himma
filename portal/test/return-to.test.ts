import { safeReturnTo } from '../src/auth/return-to';

describe('safeReturnTo (open-redirect protection)', () => {
  test.each([
    ['/o/abc/listings', '/o/abc/listings'],
    ['/o/abc', '/o/abc'],
    ['/settings', '/settings'],
    ['/o/abc/listings?tab=media', '/o/abc/listings?tab=media'],
  ])('accepts internal path %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });

  test.each([
    'https://evil.example/phish',
    'http://evil.example',
    '//evil.example/phish',
    '/\\evil.example',
    '\\/evil.example',
    'javascript:alert(1)',
    'o/abc/listings',
    '',
    '   ',
    '/%2F%2Fevil.example',
  ])('rejects unsafe or external destination %p', (input) => {
    expect(safeReturnTo(input)).toBeNull();
  });

  test('rejects access-zone destinations that would loop the flow', () => {
    expect(safeReturnTo('/sign-in')).toBeNull();
    expect(safeReturnTo('/mfa')).toBeNull();
    expect(safeReturnTo('/step-up?returnTo=/o/x')).toBeNull();
    expect(safeReturnTo('/signed-out')).toBeNull();
  });
});
