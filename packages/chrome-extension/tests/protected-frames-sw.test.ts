import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('protected-frames-sw', () => {
  let session: Record<string, unknown>;
  let headers: Array<(d: { tabId: number; type: string; url: string }) => void>;
  let removed: Array<(tabId: number) => void>;

  beforeEach(() => {
    session = {};
    headers = [];
    removed = [];
    (globalThis as any).chrome = {
      storage: {
        session: {
          get: vi.fn(async (k: string) => (k in session ? { [k]: session[k] } : {})),
          set: vi.fn(async (o: Record<string, unknown>) => Object.assign(session, o)),
        },
      },
      webRequest: { onHeadersReceived: { addListener: (fn: any) => headers.push(fn) } },
      tabs: { onRemoved: { addListener: (fn: any) => removed.push(fn) } },
    };
    vi.resetModules();
  });

  async function load() {
    const mod = await import('../src/protected-frames-sw.js');
    mod.installProtectedFrameTracker();
    return mod;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('marks a tab on a protected sub-frame only, clears it on main-frame navigation and removal', async () => {
    const { tabHasProtectedFrame } = await load();
    const fire = (tabId: number, type: string, url: string) => {
      for (const h of headers) h({ tabId, type, url });
    };

    fire(1, 'sub_frame', 'https://example.org/embed');
    fire(1, 'main_frame', 'https://vault.sliccy.ai/');
    fire(-1, 'sub_frame', 'https://vault.sliccy.ai/');
    await flush();
    expect(await tabHasProtectedFrame(1)).toBe(false);

    fire(2, 'sub_frame', 'https://vault.sliccy.ai/embed');
    fire(2, 'sub_frame', 'https://seven.sliccy.ai/embed');
    fire(3, 'sub_frame', 'https://www.sliccy.ai/x');
    await flush();
    expect(await tabHasProtectedFrame(2)).toBe(true);
    vi.resetModules();
    const again = await import('../src/protected-frames-sw.js');
    expect(await again.tabHasProtectedFrame(2)).toBe(true);

    fire(2, 'main_frame', 'https://example.com/');
    for (const r of removed) r(3);
    await flush();
    expect(await tabHasProtectedFrame(2)).toBe(false);
    expect(await tabHasProtectedFrame(3)).toBe(false);
  });

  it('fails closed when session storage is unreadable', async () => {
    const { tabHasProtectedFrame } = await load();
    (globalThis as any).chrome.storage.session.get = vi.fn(async () => {
      throw new Error('gone');
    });
    expect(await tabHasProtectedFrame(9)).toBe(true);
  });
});
