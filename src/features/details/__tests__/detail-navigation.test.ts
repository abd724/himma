import { describe, expect, test } from '@jest/globals';
import {
  crossLinkAction,
  detailHrefForRoute,
  programHref,
  providerHref,
  rootStackRoutes,
} from '@/features/details/detail-navigation';
import { buildShareUrl, SHARE_BASE_URL } from '@/features/details/share-url';

describe('Detail navigation policy (docs/20 §2.3)', () => {
  test('href builders target the root-level detail contracts', () => {
    expect(programHref('junior-swim-squad')).toBe('/program/junior-swim-squad');
    expect(providerHref('blue-wave')).toBe('/provider/blue-wave');
  });

  test('navigating to the route directly beneath goes back instead of pushing', () => {
    expect(crossLinkAction('/provider/falcon', providerHref('falcon'))).toBe('back');
    expect(crossLinkAction('/program/junior-karate', programHref('junior-karate'))).toBe('back');
  });

  test('distinct targets push — legitimate stack growth', () => {
    expect(crossLinkAction('/provider/falcon', providerHref('gravity'))).toBe('push');
    expect(crossLinkAction('/program/junior-karate', programHref('karate-foundations'))).toBe(
      'push',
    );
    expect(crossLinkAction('/discover', programHref('junior-karate'))).toBe('push');
  });

  test('no previous route (cold deep link) always pushes', () => {
    expect(crossLinkAction(undefined, programHref('junior-karate'))).toBe('push');
  });

  test('navigation-state entries resolve to detail hrefs only for detail routes', () => {
    expect(detailHrefForRoute('program/[programId]', { programId: 'junior-karate' })).toBe(
      '/program/junior-karate',
    );
    expect(detailHrefForRoute('provider/[providerId]', { providerId: 'falcon' })).toBe(
      '/provider/falcon',
    );
    expect(detailHrefForRoute('(tabs)', {})).toBeUndefined();
    expect(detailHrefForRoute('search', undefined)).toBeUndefined();
    expect(detailHrefForRoute(undefined, undefined)).toBeUndefined();
    expect(detailHrefForRoute('program/[programId]', {})).toBeUndefined();
  });

  test('rootStackRoutes unwraps the synthetic __root container', () => {
    const stack = [
      { name: '(tabs)' },
      { name: 'program/[programId]', params: { programId: 'beginner-calisthenics' } },
      { name: 'provider/[providerId]', params: { providerId: 'gravity' } },
    ];
    expect(rootStackRoutes({ routes: [{ name: '__root', state: { routes: stack } }] })).toBe(
      stack,
    );
    // Already-unwrapped states and empty states pass through safely.
    expect(rootStackRoutes({ routes: stack })).toBe(stack);
    expect(rootStackRoutes(undefined)).toBeUndefined();
    expect(rootStackRoutes({ routes: [{ name: '__root' }] })).toBeUndefined();
  });

  test('the round-trip policy resolves via navigation-state entries', () => {
    // provider A → program X → provider A tap resolves as back.
    const beneath = detailHrefForRoute('provider/[providerId]', { providerId: 'falcon' });
    expect(crossLinkAction(beneath, providerHref('falcon'))).toBe('back');
    // program X → provider A → program Y is legitimate stack growth.
    expect(crossLinkAction(beneath, programHref('ladies-boxing'))).toBe('push');
  });
});

describe('Share URLs (docs/09 §20.5)', () => {
  test('placeholder canonical web links, never a custom scheme', () => {
    expect(buildShareUrl('program', 'junior-swim-squad')).toBe(
      'https://himma.app/program/junior-swim-squad',
    );
    expect(buildShareUrl('provider', 'blue-wave')).toBe('https://himma.app/provider/blue-wave');
    expect(SHARE_BASE_URL.startsWith('https://')).toBe(true);
    expect(buildShareUrl('program', 'x').includes('himma://')).toBe(false);
  });
});
