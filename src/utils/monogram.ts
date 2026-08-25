/** Fictional monogram derived from a display name — never a real logo
 *  (docs/08 §11). Shared presentation helper for mock and real surfaces. */
export function providerMonogram(name: string): string {
  return name
    .split(' ')
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');
}
