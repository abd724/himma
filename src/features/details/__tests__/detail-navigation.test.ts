import { describe, expect, test } from '@jest/globals';
import {
  crossLinkAction,
  programHref,
  providerHref,
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
