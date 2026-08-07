/**
 * Development fixture — shell visualization ONLY (docs/29 §14).
 *
 * These organizations exist so the W2-1 shell, organization switcher, and
 * org-scoped routing can be seen and tested before any real session exists.
 * They are fictional providers from the repository's mock universe, are not
 * fetched from anywhere, imply no real identity or membership, and W2-2
 * replaces this source with real `/provider/me` resolution behind the same
 * shape. Nothing outside the mock boundary may invent organization data.
 */
import type { ShellOrganization } from '../../organization/organization-context';

export const fixtureOrganizations: readonly ShellOrganization[] = [
  { id: '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01', displayName: 'Blue Wave Swimming' },
  { id: '0198a2f0-5b7a-7000-8000-1f4a2d9c6e02', displayName: 'Noor Learning Centre' },
];
