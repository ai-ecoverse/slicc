import { describe, expect, it, vi } from 'vitest';
import {
  GELATIERE_SUGGESTIONS_PATH,
  type GelatiereVfs,
} from '../../../src/base/gelatiere-store.js';
import { makeGelatiereCardFallback } from '../../../src/ui/wc/wc-gelatiere-fallback.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeVfs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return text;
    },
    writeFile: async (path: string, body: string) => {
      files.set(path, body);
    },
    mkdir: async () => {},
  } satisfies GelatiereVfs & { files: Map<string, string> };
}

function storeWith(id: string): string {
  return JSON.stringify([
    { id, kind: 'tip', title: 'Try scoops', body: 'b', createdAt: '2026-09-01T00:00:00.000Z' },
  ]);
}

function cardLick(action: string, id?: string) {
  return {
    type: 'sprinkle' as const,
    sprinkleName: 'welcome',
    targetScoop: 'cone',
    timestamp: '2026-09-10T00:00:00.000Z',
    body: { action, ...(id ? { data: { id } } : {}) },
  };
}

async function settled(vfs: ReturnType<typeof fakeVfs>, field: 'dismissedAt' | 'takenAt') {
  await vi.waitFor(() => {
    const store = JSON.parse(vfs.files.get(GELATIERE_SUGGESTIONS_PATH) ?? '[]');
    expect(store[0]?.[field]).toBeTruthy();
  });
}

describe('makeGelatiereCardFallback (cherry / hosted-leader floats)', () => {
  it('consumes a dismiss after stamping the store — the cone never wakes for it', async () => {
    const vfs = fakeVfs({ [GELATIERE_SUGGESTIONS_PATH]: storeWith('tip-scoops') });
    const intercept = makeGelatiereCardFallback({ openVfs: async () => vfs, log });
    expect(intercept(cardLick('gelatiere-dismiss', 'tip-scoops'))).toBe(true);
    await settled(vfs, 'dismissedAt');
  });

  it('stamps takenAt for install/try but forwards the lick to the cone', async () => {
    for (const action of ['gelatiere-install', 'gelatiere-try']) {
      const vfs = fakeVfs({ [GELATIERE_SUGGESTIONS_PATH]: storeWith('tip-scoops') });
      const intercept = makeGelatiereCardFallback({ openVfs: async () => vfs, log });
      expect(intercept(cardLick(action, 'tip-scoops'))).toBe(false);
      await settled(vfs, 'takenAt');
    }
  });

  it('ignores everything that is not a gelatiere card lick', () => {
    const vfs = fakeVfs();
    const intercept = makeGelatiereCardFallback({ openVfs: async () => vfs, log });
    expect(intercept(cardLick('first-run'))).toBe(false);
    expect(intercept({ ...cardLick('gelatiere-dismiss', 'x'), sprinkleName: 'other' })).toBe(false);
    expect(
      intercept({ type: 'cron', name: 'n', timestamp: 't' } as unknown as Parameters<
        typeof intercept
      >[0])
    ).toBe(false);
  });

  it('still consumes a dismiss with a malformed id, and survives a broken vfs', async () => {
    const intercept = makeGelatiereCardFallback({
      openVfs: async () => {
        throw new Error('vfs gone');
      },
      log,
    });
    // No id → nothing to settle, but the dismiss must not reach the cone.
    expect(intercept(cardLick('gelatiere-dismiss'))).toBe(true);
    expect(intercept(cardLick('gelatiere-install', 'x'))).toBe(false);
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith('gelatiere card settlement failed', expect.any(Error))
    );
  });
});
