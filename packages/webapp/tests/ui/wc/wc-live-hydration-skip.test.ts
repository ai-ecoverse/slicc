// @vitest-environment jsdom
/**
 * Regression test: stale-session hydration must be skipped for tray followers
 * (cloud cone join URL in localStorage) and cherry embeds (?cherry=1), so the
 * leader's snapshot lands without a stale-IndexedDB flash.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const sessionLoads: string[] = [];
const STORED_SESSIONS: Record<string, { id: string; messages: unknown[] }> = {
  'session-cone': {
    id: 'session-cone',
    messages: [{ id: 'm1', role: 'user', content: 'primary history', timestamp: 1 }],
  },
  'session-cone-research': {
    id: 'session-cone-research',
    messages: [{ id: 'm2', role: 'user', content: 'research history', timestamp: 1 }],
  },
};
vi.mock('../../../src/scoops/chat-session-store.js', () => ({
  SessionStore: class {
    async init(): Promise<void> {}
    async load(id: string): Promise<unknown> {
      sessionLoads.push(id);
      return STORED_SESSIONS[id] ?? null;
    }
  },
}));

import {
  hydratePersistedConeSession,
  shouldSkipSessionHydration,
} from '../../../src/ui/wc/wc-live-thinking-hydration.js';

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

beforeEach(() => {
  sessionLoads.length = 0;
});

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

  it('returns false for an extra cone deep link — it has its own history (#2272)', () => {
    const win = fakeWindow('http://localhost:5710/?ctx=cone:cone-research');
    expect(shouldSkipSessionHydration('cone:cone-research', win)).toBe(false);
  });

  it('still skips an extra cone deep link inside a cherry embed', () => {
    const win = fakeWindow('https://www.sliccy.ai/?cherry=1&ctx=cone:cone-research');
    expect(shouldSkipSessionHydration('cone:cone-research', win)).toBe(true);
  });
});

describe('hydratePersistedConeSession (#2272)', () => {
  const win = fakeWindow('http://localhost:5710/');

  async function hydrate(pendingUrlContext: string | null) {
    const loaded: import('../../../src/ui/types.js').ChatMessage[][] = [];
    await hydratePersistedConeSession({
      pendingUrlContext,
      win,
      hasSelection: () => false,
      loadMessages: (messages) => loaded.push(messages),
      onHydrated: () => {},
    });
    return loaded;
  }

  it('hydrates the primary cone on a bare boot', async () => {
    const loaded = await hydrate(null);
    expect(sessionLoads).toEqual(['session-cone']);
    expect(loaded[0]?.[0]?.content).toBe('primary history');
  });

  it('hydrates the cone the URL context addresses, not the primary one', async () => {
    const loaded = await hydrate('cone:cone-research');
    expect(sessionLoads).toEqual(['session-cone-research']);
    expect(loaded[0]?.[0]?.content).toBe('research history');
  });

  it('never touches the store for a non-cone context', async () => {
    expect(await hydrate('scoop:worker')).toEqual([]);
    expect(sessionLoads).toEqual([]);
  });
});
