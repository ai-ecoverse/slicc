// @vitest-environment jsdom
/**
 * Regression test: stale-session hydration must be skipped for tray followers
 * (cloud cone join URL in localStorage) and cherry embeds (?cherry=1), so the
 * leader's snapshot lands without a stale-IndexedDB flash.
 */

import { describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { shouldSkipSessionHydration } from '../../../src/ui/wc/wc-live.js';

function fakeWindow(
  href: string,
  storageEntries: Record<string, string> = {}
): { location: { href: string }; localStorage: Storage } {
  const store = new Map(Object.entries(storageEntries));
  return {
    location: { href },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } as Storage,
  };
}

describe('shouldSkipSessionHydration', () => {
  it('returns false for a plain standalone boot (no join URL, no cherry)', () => {
    const win = fakeWindow('http://localhost:5710/');
    expect(shouldSkipSessionHydration(null, win)).toBe(false);
  });

  it('returns true when localStorage has a stored tray join URL (cloud cone follower)', () => {
    const win = fakeWindow('https://www.sliccy.ai/join/trayId.secret', {
      'slicc.trayJoinUrl': 'https://www.sliccy.ai/join/trayId.secret',
    });
    expect(shouldSkipSessionHydration(null, win)).toBe(true);
  });

  it('returns true for a cherry embed (?cherry=1)', () => {
    const win = fakeWindow('https://www.sliccy.ai/?cherry=1');
    expect(shouldSkipSessionHydration(null, win)).toBe(true);
  });

  it('returns true when pendingUrlContext is a non-cone deep link', () => {
    const win = fakeWindow('http://localhost:5710/?ctx=scoop:researcher');
    expect(shouldSkipSessionHydration('scoop:researcher', win)).toBe(true);
  });

  it('returns true for a freezer deep link', () => {
    const win = fakeWindow('http://localhost:5710/?ctx=freezer:session.md');
    expect(shouldSkipSessionHydration('freezer:session.md', win)).toBe(true);
  });

  it('returns false when pendingUrlContext is explicitly "cone"', () => {
    const win = fakeWindow('http://localhost:5710/?ctx=cone');
    expect(shouldSkipSessionHydration('cone', win)).toBe(false);
  });
});
