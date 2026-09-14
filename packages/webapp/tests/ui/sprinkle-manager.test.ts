// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsWatcher } from '../../src/fs/fs-watcher.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createRemoteSprinkleVfs } from '../../src/kernel/remote-sprinkle-vfs.js';
import type { LickEvent } from '../../src/scoops/lick-manager.js';
import {
  pruneKnownSprinkleNames,
  readKnownSprinkleNames,
  readOpenSprinklesFromUrl,
  SprinkleManager,
  writeOpenSprinklesToUrl,
} from '../../src/ui/sprinkle-manager.js';

const rendererState = vi.hoisted(() => ({ closeOnActivate: false }));

vi.mock('../../src/ui/sprinkle-renderer.js', () => ({
  SprinkleRenderer: class {
    constructor(
      _c: unknown,
      private readonly api: { close(): void }
    ) {}
    async render() {}
    activateBridgeLifecycle() {
      if (rendererState.closeOnActivate) this.api.close();
    }
    dispose() {}
    pushUpdate() {}
  },
}));

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => {
      data.set(k, String(v));
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => {
      data.clear();
    },
  };
}

interface FakeElement {
  className: string;
  style: { cssText: string };
  dataset: Record<string, string>;
  appendChild(child: FakeElement): void;
  remove(): void;
}

function makeFakeDocument() {
  return {
    createElement: (_tag: string): FakeElement => ({
      className: '',
      style: { cssText: '' },
      dataset: {},
      appendChild() {},
      remove() {},
    }),
  };
}

describe('SprinkleManager', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;
  let lickHandler: (event: LickEvent) => void;
  let addSprinkle: ReturnType<typeof vi.fn>;
  let removeSprinkle: ReturnType<typeof vi.fn>;
  let minimizeSprinkle: ReturnType<typeof vi.fn>;
  let registerSprinkle: ReturnType<typeof vi.fn>;
  let unregisterSprinkle: ReturnType<typeof vi.fn>;
  let closeSprinkleContent: ReturnType<typeof vi.fn>;
  let mgr: SprinkleManager;

  beforeEach(async () => {
    rendererState.closeOnActivate = false;
    vi.stubGlobal('localStorage', makeMemoryStorage());
    vi.stubGlobal('document', makeFakeDocument());

    try {
      window.history.replaceState(null, '', '/');
    } catch {}
    vfs = await VirtualFS.create({
      dbName: `test-sprinkle-manager-${dbCounter++}`,
      wipe: true,
    });
    lickHandler = vi.fn() as unknown as (event: LickEvent) => void;
    addSprinkle = vi.fn();
    removeSprinkle = vi.fn();
    minimizeSprinkle = vi.fn();
    registerSprinkle = vi.fn();
    unregisterSprinkle = vi.fn();
    closeSprinkleContent = vi.fn();
    mgr = new SprinkleManager(
      vfs,
      lickHandler,
      {
        addSprinkle: addSprinkle as unknown as (
          name: string,
          title: string,
          element: HTMLElement
        ) => void,
        removeSprinkle: removeSprinkle as unknown as (name: string) => void,
        minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
        registerSprinkle: registerSprinkle as unknown as (name: string, title: string) => void,
        unregisterSprinkle: unregisterSprinkle as unknown as (name: string) => void,
        closeSprinkleContent: closeSprinkleContent as unknown as (name: string) => void,
      },
      vi.fn()
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('refresh discovers available sprinkles', async () => {
    await vfs.writeFile(
      '/shared/sprinkles/dash/dash.shtml',
      '<title>Dashboard</title><div>hi</div>'
    );
    await mgr.refresh();
    const sprinkles = mgr.available();
    expect(sprinkles.length).toBe(1);
    expect(sprinkles[0].name).toBe('dash');
    expect(sprinkles[0].title).toBe('Dashboard');
  });

  it('discovers sprinkles through createRemoteSprinkleVfs adapter (OPFS wiring)', async () => {
    const canonical = await VirtualFS.create({
      dbName: `test-sprinkle-manager-canonical-${dbCounter++}`,
      wipe: true,
    });
    await canonical.writeFile(
      '/shared/sprinkles/remote/remote.shtml',
      '<title>Remote</title><div>via RPC</div>'
    );
    const adapter = createRemoteSprinkleVfs({ reader: canonical, writer: canonical });
    const remoteMgr = new SprinkleManager(
      adapter,
      lickHandler,
      {
        addSprinkle: addSprinkle as unknown as (
          name: string,
          title: string,
          element: HTMLElement
        ) => void,
        removeSprinkle: removeSprinkle as unknown as (name: string) => void,
        minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
        registerSprinkle: registerSprinkle as unknown as (name: string, title: string) => void,
        unregisterSprinkle: unregisterSprinkle as unknown as (name: string) => void,
        closeSprinkleContent: closeSprinkleContent as unknown as (name: string) => void,
      },
      vi.fn()
    );
    await remoteMgr.refresh();
    const sprinkles = remoteMgr.available();
    expect(sprinkles.length).toBe(1);
    expect(sprinkles[0].name).toBe('remote');
    expect(sprinkles[0].title).toBe('Remote');

    expect(await vfs.exists('/shared/sprinkles/remote/remote.shtml')).toBe(false);
  });

  it('available() returns empty when no sprinkles', async () => {
    await mgr.refresh();
    expect(mgr.available()).toEqual([]);
  });

  it('opened() returns empty initially', () => {
    expect(mgr.opened()).toEqual([]);
  });

  it('open throws for unknown sprinkle', async () => {
    await expect(mgr.open('nonexistent')).rejects.toThrow('Sprinkle not found: nonexistent');
  });

  it('sendToSprinkle does not throw for closed sprinkle', () => {
    expect(() => mgr.sendToSprinkle('unknown', {})).not.toThrow();
  });

  it('minimize() calls the minimizeSprinkle callback when the sprinkle is open', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
    await mgr.refresh();
    await mgr.open('dash');
    minimizeSprinkle.mockClear();

    mgr.minimize('dash');

    expect(minimizeSprinkle).toHaveBeenCalledWith('dash');
  });

  it('minimize() is a no-op when the sprinkle is not open', () => {
    mgr.minimize('not-open');
    expect(minimizeSprinkle).not.toHaveBeenCalled();
  });

  it('sendToSprinkle fires the onSendToSprinkle hook when sprinkle is open (leader broadcast wiring)', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
    const onSendToSprinkle = vi.fn();
    const mgrWithHook = new SprinkleManager(
      vfs,
      lickHandler,
      {
        addSprinkle: addSprinkle as unknown as (
          name: string,
          title: string,
          element: HTMLElement
        ) => void,
        removeSprinkle: removeSprinkle as unknown as (name: string) => void,
        minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
      },
      vi.fn(),
      { onSendToSprinkle }
    );
    await mgrWithHook.refresh();
    await mgrWithHook.open('dash');

    mgrWithHook.sendToSprinkle('dash', { progress: 0.42 });

    expect(onSendToSprinkle).toHaveBeenCalledTimes(1);
    expect(onSendToSprinkle).toHaveBeenCalledWith('dash', { progress: 0.42 }, undefined);
  });

  it('sendToSprinkle STILL fires the hook for a sprinkle closed on the leader', () => {
    const onSendToSprinkle = vi.fn(() => ({ followers: ['follower-1'] }));
    const mgrWithHook = new SprinkleManager(
      vfs,
      lickHandler,
      {
        addSprinkle: addSprinkle as unknown as (
          name: string,
          title: string,
          element: HTMLElement
        ) => void,
        removeSprinkle: removeSprinkle as unknown as (name: string) => void,
        minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
      },
      vi.fn(),
      { onSendToSprinkle }
    );

    const report = mgrWithHook.sendToSprinkle('not-open', { foo: 1 });

    expect(onSendToSprinkle).toHaveBeenCalledWith('not-open', { foo: 1 }, undefined);
    expect(report).toEqual({ leader: false, followers: ['follower-1'] });
  });

  it('sendToSprinkle reports a push that reached nothing', () => {
    const report = mgr.sendToSprinkle('not-open', { foo: 1 });
    expect(report).toEqual({ leader: false, followers: [] });
  });

  it('sendToSprinkle with a follower target skips the local renderer', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title>hi');
    const onSendToSprinkle = vi.fn(() => ({ followers: ['follower-8a47'] }));
    const mgrWithHook = new SprinkleManager(
      vfs,
      lickHandler,
      {
        addSprinkle: addSprinkle as unknown as (
          name: string,
          title: string,
          element: HTMLElement
        ) => void,
        removeSprinkle: removeSprinkle as unknown as (name: string) => void,
        minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
      },
      vi.fn(),
      { onSendToSprinkle }
    );
    await mgrWithHook.refresh();
    await mgrWithHook.open('dash');

    const report = mgrWithHook.sendToSprinkle(
      'dash',
      { progress: 1 },
      { runtime: 'follower-8a47' }
    );

    expect(report).toEqual({ leader: false, followers: ['follower-8a47'] });
    expect(onSendToSprinkle).toHaveBeenCalledWith(
      'dash',
      { progress: 1 },
      { runtime: 'follower-8a47' }
    );
  });

  it('sendToSprinkle with --runtime=leader does not touch the follower transport', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title>hi');
    const onSendToSprinkle = vi.fn(() => ({ followers: ['follower-8a47'] }));
    const mgrWithHook = new SprinkleManager(
      vfs,
      lickHandler,
      {
        addSprinkle: addSprinkle as unknown as (
          name: string,
          title: string,
          element: HTMLElement
        ) => void,
        removeSprinkle: removeSprinkle as unknown as (name: string) => void,
        minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
      },
      vi.fn(),
      { onSendToSprinkle }
    );
    await mgrWithHook.refresh();
    await mgrWithHook.open('dash');

    const report = mgrWithHook.sendToSprinkle('dash', { progress: 1 }, { runtime: 'leader' });

    expect(report).toEqual({ leader: true, followers: [] });
    expect(onSendToSprinkle).not.toHaveBeenCalled();
  });

  it('hook errors do not propagate or skip the local renderer push', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title>hi');
    const onSendToSprinkle = vi.fn(() => {
      throw new Error('broadcaster blew up');
    });
    const mgrWithHook = new SprinkleManager(
      vfs,
      lickHandler,
      {
        addSprinkle: addSprinkle as unknown as (
          name: string,
          title: string,
          element: HTMLElement
        ) => void,
        removeSprinkle: removeSprinkle as unknown as (name: string) => void,
        minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
      },
      vi.fn(),
      { onSendToSprinkle }
    );
    await mgrWithHook.refresh();
    await mgrWithHook.open('dash');

    expect(() => mgrWithHook.sendToSprinkle('dash', { x: 1 })).not.toThrow();
    expect(onSendToSprinkle).toHaveBeenCalledTimes(1);
  });

  it('setSendToSprinkleHook installed after open() fires on the next sendToSprinkle', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
    const onSendToSprinkle = vi.fn();
    await mgr.refresh();
    await mgr.open('dash');

    mgr.setSendToSprinkleHook(onSendToSprinkle);

    mgr.sendToSprinkle('dash', { progress: 0.5 });

    expect(onSendToSprinkle).toHaveBeenCalledTimes(1);
    expect(onSendToSprinkle).toHaveBeenCalledWith('dash', { progress: 0.5 }, undefined);
  });

  it('setSendToSprinkleHook(undefined) detaches a previously-installed hook', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
    const onSendToSprinkle = vi.fn();
    await mgr.refresh();
    await mgr.open('dash');
    mgr.setSendToSprinkleHook(onSendToSprinkle);
    mgr.sendToSprinkle('dash', { a: 1 });
    expect(onSendToSprinkle).toHaveBeenCalledTimes(1);

    mgr.setSendToSprinkleHook(undefined);
    mgr.sendToSprinkle('dash', { b: 2 });

    expect(onSendToSprinkle).toHaveBeenCalledTimes(1);
  });

  it('setSendToSprinkleHook overrides a constructor-supplied hook', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
    const constructorHook = vi.fn();
    const setterHook = vi.fn();
    const mgrWithBoth = new SprinkleManager(
      vfs,
      lickHandler,
      {
        addSprinkle: addSprinkle as unknown as (
          name: string,
          title: string,
          element: HTMLElement
        ) => void,
        removeSprinkle: removeSprinkle as unknown as (name: string) => void,
        minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
      },
      vi.fn(),
      { onSendToSprinkle: constructorHook }
    );
    await mgrWithBoth.refresh();
    await mgrWithBoth.open('dash');
    mgrWithBoth.setSendToSprinkleHook(setterHook);

    mgrWithBoth.sendToSprinkle('dash', { x: 1 });

    expect(constructorHook).not.toHaveBeenCalled();
    expect(setterHook).toHaveBeenCalledTimes(1);
    expect(setterHook).toHaveBeenCalledWith('dash', { x: 1 }, undefined);
  });

  it('setupWatcher refreshes available list when new .shtml files appear', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const watcher = new FsWatcher();
    vfs.setWatcher(watcher);
    mgr.setupWatcher(watcher);
    await mgr.refresh();
    expect(mgr.available()).toEqual([]);

    await vfs.writeFile(
      '/workspace/skills/migrate/migrate-page.shtml',
      '<title>Migrate Page</title><div/>'
    );

    await vi.advanceTimersByTimeAsync(200);
    await mgr.openNewAutoOpenSprinkles();

    const names = mgr.available().map((s) => s.name);
    expect(names).toContain('migrate-page');
  });

  it('setupWatcher leaves a previously-closed auto-open sprinkle closed when an unrelated .shtml is added', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const watcher = new FsWatcher();
    vfs.setWatcher(watcher);
    mgr.setupWatcher(watcher);

    await vfs.writeFile(
      '/shared/sprinkles/dash/dash.shtml',
      '<title>Dash</title><div data-sprinkle-autoopen>hi</div>'
    );
    await mgr.refresh();
    expect(mgr.available().find((s) => s.name === 'dash')?.autoOpen).toBe(true);
    addSprinkle.mockClear();

    await vfs.writeFile('/shared/sprinkles/other/other.shtml', '<title>Other</title><div>hi</div>');
    await vi.advanceTimersByTimeAsync(200);
    await mgr.openNewAutoOpenSprinkles();

    const names = addSprinkle.mock.calls.map((c) => c[0]);
    expect(names).toContain('other');
    expect(names).not.toContain('dash');
  });

  it('attention-mode opens are not persisted into slicc-open-sprinkles', async () => {
    await vfs.writeFile('/shared/sprinkles/quiet/quiet.shtml', '<title>Quiet</title><div>hi</div>');
    await mgr.refresh();
    await mgr.open('quiet', undefined, { attention: true });

    const stored = JSON.parse(localStorage.getItem('slicc-open-sprinkles') ?? '[]');
    expect(stored).toEqual([]);
    expect(mgr.opened()).toContain('quiet');
  });

  it('markActivated promotes an attention-mode sprinkle into the persisted set', async () => {
    await vfs.writeFile('/shared/sprinkles/q/q.shtml', '<title>Q</title><div>hi</div>');
    await mgr.refresh();
    await mgr.open('q', undefined, { attention: true });
    expect(JSON.parse(localStorage.getItem('slicc-open-sprinkles') ?? '[]')).toEqual([]);

    mgr.markActivated('q');
    expect(JSON.parse(localStorage.getItem('slicc-open-sprinkles') ?? '[]')).toEqual(['q']);
  });

  it('persistKnownSprinkles unions with the existing ledger so absent names are not forgotten', async () => {
    localStorage.setItem('slicc-known-sprinkles', JSON.stringify(['mounted-only']));

    await vfs.writeFile('/shared/sprinkles/local/local.shtml', '<title>Local</title><div>hi</div>');
    await mgr.refresh();
    await mgr.restoreOpenSprinkles();

    const known = new Set(JSON.parse(localStorage.getItem('slicc-known-sprinkles') ?? '[]'));
    expect(known.has('mounted-only')).toBe(true);
    expect(known.has('local')).toBe(true);
  });

  it('openNewAutoOpenSprinkles dedupes back-to-back calls within the cooldown', async () => {
    await vfs.writeFile('/shared/sprinkles/a/a.shtml', '<title>A</title><div>hi</div>');
    await mgr.refresh();
    addSprinkle.mockClear();

    await vfs.writeFile('/shared/sprinkles/b/b.shtml', '<title>B</title><div>hi</div>');
    await Promise.all([mgr.openNewAutoOpenSprinkles(), mgr.openNewAutoOpenSprinkles()]);

    const surfaced = addSprinkle.mock.calls.filter((c) => c[0] === 'b');
    expect(surfaced.length).toBe(1);
  });

  it('open throws descriptive error when file content is undefined', async () => {
    await vfs.writeFile('/shared/sprinkles/broken/broken.shtml', '<title>Broken</title><div/>');
    await mgr.refresh();

    const originalReadFile = vfs.readFile.bind(vfs);
    vfs.readFile = vi.fn().mockResolvedValue(undefined) as typeof vfs.readFile;

    await expect(mgr.open('broken')).rejects.toThrow(
      'Failed to read sprinkle content: /shared/sprinkles/broken/broken.shtml'
    );

    vfs.readFile = originalReadFile;
  });

  describe('SprinkleManager.onChange', () => {
    it('fires once after refresh() completes', async () => {
      const calls: number[] = [];
      const off = mgr.onChange(() => calls.push(Date.now()));
      await mgr.refresh();
      await Promise.resolve();
      expect(calls.length).toBe(1);
      off();
    });

    it('fires once per open()/close() state change', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      await mgr.refresh();
      await Promise.resolve();
      const calls: number[] = [];
      mgr.onChange(() => calls.push(Date.now()));
      await mgr.open('dash');
      await Promise.resolve();
      expect(calls.length).toBe(1);
      mgr.close('dash');
      await Promise.resolve();
      expect(calls.length).toBe(2);
    });

    it('returns an unsubscribe that stops firing', async () => {
      const calls: number[] = [];
      const off = mgr.onChange(() => calls.push(Date.now()));
      off();
      await mgr.refresh();
      await Promise.resolve();
      expect(calls.length).toBe(0);
    });

    it('coalesces multiple refreshes within one microtask', async () => {
      const calls: number[] = [];
      mgr.onChange(() => calls.push(Date.now()));
      await Promise.all([mgr.refresh(), mgr.refresh(), mgr.refresh()]);
      await Promise.resolve();
      expect(calls.length).toBe(1);
    });

    it('markActivated() fires the change listener', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      await mgr.refresh();
      await Promise.resolve();
      const calls: number[] = [];
      mgr.onChange(() => calls.push(Date.now()));

      await mgr.open('dash', undefined, { attention: true });
      await Promise.resolve();
      expect(calls.length).toBe(1);
      calls.length = 0;
      mgr.markActivated('dash');
      await Promise.resolve();
      expect(calls.length).toBe(1);
    });
  });

  it('handles a close lifecycle call released immediately after renderer registration', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>hi</div>');
    await mgr.refresh();
    rendererState.closeOnActivate = true;

    await expect(mgr.open('dash')).resolves.toBeUndefined();

    expect(mgr.opened()).not.toContain('dash');
    expect(closeSprinkleContent).toHaveBeenCalledWith('dash');
  });

  describe('one-shot auto-open consumption ledger (slicc-autoopened-once)', () => {
    it('first-run restoreOpenSprinkles auto-opens and records the autoopen sprinkle', async () => {
      await vfs.writeFile(
        '/shared/sprinkles/intro/intro.shtml',
        '<title>Intro</title><div data-sprinkle-autoopen>hi</div>'
      );
      await mgr.refresh();
      await mgr.restoreOpenSprinkles();

      expect(mgr.opened()).toContain('intro');
      const ledger = JSON.parse(localStorage.getItem('slicc-autoopened-once') ?? '[]');
      expect(ledger).toContain('intro');
    });

    it('second restoreOpenSprinkles does NOT auto-open a previously-consumed sprinkle after user closes it', async () => {
      await vfs.writeFile(
        '/shared/sprinkles/intro/intro.shtml',
        '<title>Intro</title><div data-sprinkle-autoopen>hi</div>'
      );
      await mgr.refresh();
      await mgr.restoreOpenSprinkles();
      expect(mgr.opened()).toContain('intro');

      mgr.close('intro');
      localStorage.removeItem('slicc-open-sprinkles');

      const addSprinkle2 = vi.fn();
      const mgr2 = new SprinkleManager(
        vfs,
        lickHandler,
        {
          addSprinkle: addSprinkle2 as unknown as (
            name: string,
            title: string,
            element: HTMLElement
          ) => void,
          removeSprinkle: vi.fn() as unknown as (name: string) => void,
          minimizeSprinkle: vi.fn() as unknown as (name: string) => void,
        },
        vi.fn()
      );
      await mgr2.refresh();
      await mgr2.restoreOpenSprinkles();

      expect(mgr2.opened()).not.toContain('intro');
      const names = addSprinkle2.mock.calls.map((c) => c[0]);
      expect(names).not.toContain('intro');
    });

    it('surfaceUnseenSprinkles skips an autoopen sprinkle already in the ledger even when known-sprinkles is empty', async () => {
      localStorage.setItem('slicc-autoopened-once', JSON.stringify(['hello']));
      await vfs.writeFile(
        '/shared/sprinkles/hello/hello.shtml',
        '<title>Hello</title><div data-sprinkle-autoopen>hi</div>'
      );

      localStorage.setItem('slicc-open-sprinkles', JSON.stringify([]));
      await mgr.refresh();
      await mgr.restoreOpenSprinkles();

      expect(mgr.opened()).not.toContain('hello');
    });

    it('non-auto-open sprinkles are not added to the consumption ledger', async () => {
      await vfs.writeFile(
        '/shared/sprinkles/plain/plain.shtml',
        '<title>Plain</title><div>hi</div>'
      );
      await mgr.refresh();
      await mgr.restoreOpenSprinkles();

      const ledger = JSON.parse(localStorage.getItem('slicc-autoopened-once') ?? '[]');
      expect(ledger).not.toContain('plain');
    });

    it('runOpenNewAutoOpenSprinkles records a freshly-installed autoopen sprinkle and skips it on a second install burst', async () => {
      await vfs.writeFile('/shared/sprinkles/seed/seed.shtml', '<title>Seed</title><div>hi</div>');
      await mgr.refresh();
      await mgr.restoreOpenSprinkles();
      addSprinkle.mockClear();

      await vfs.writeFile(
        '/shared/sprinkles/onboard/onboard.shtml',
        '<title>Onboard</title><div data-sprinkle-autoopen>hi</div>'
      );
      await mgr.openNewAutoOpenSprinkles();
      expect(mgr.opened()).toContain('onboard');
      const ledger = JSON.parse(localStorage.getItem('slicc-autoopened-once') ?? '[]');
      expect(ledger).toContain('onboard');

      mgr.close('onboard');
      await vfs.rm('/shared/sprinkles/onboard/onboard.shtml');

      await new Promise((r) => setTimeout(r, 260));
      await mgr.openNewAutoOpenSprinkles();
      addSprinkle.mockClear();

      await vfs.writeFile(
        '/shared/sprinkles/onboard/onboard.shtml',
        '<title>Onboard</title><div data-sprinkle-autoopen>hi</div>'
      );
      await new Promise((r) => setTimeout(r, 260));
      await mgr.openNewAutoOpenSprinkles();

      expect(mgr.opened()).not.toContain('onboard');
    });
  });

  it('open forwards the declared icon spec to the addSprinkle callback', async () => {
    await vfs.writeFile(
      '/shared/sprinkles/iconic/iconic.shtml',
      '<title>Iconic</title><link rel="icon" href="music" /><div>hi</div>'
    );
    await mgr.refresh();
    await mgr.open('iconic');

    expect(addSprinkle).toHaveBeenCalledTimes(1);
    const [name, , , , options] = addSprinkle.mock.calls[0] as [
      string,
      string,
      unknown,
      unknown,
      { icon?: string } | undefined,
    ];
    expect(name).toBe('iconic');
    expect(options?.icon).toBe('music');
  });

  describe('URL-based open-state persistence (?sprinkles=)', () => {
    function urlSprinklesParam(): string | null {
      return new URLSearchParams(window.location.search).get('sprinkles');
    }

    it('readOpenSprinklesFromUrl returns null when no param is present', () => {
      window.history.replaceState(null, '', '/');
      expect(readOpenSprinklesFromUrl()).toBeNull();
    });

    it('readOpenSprinklesFromUrl returns [] for an empty param', () => {
      window.history.replaceState(null, '', '/?sprinkles=');
      expect(readOpenSprinklesFromUrl()).toEqual([]);
    });

    it('readOpenSprinklesFromUrl splits CSV names', () => {
      window.history.replaceState(null, '', '/?sprinkles=migrate-page,llm-wiki');
      expect(readOpenSprinklesFromUrl()).toEqual(['migrate-page', 'llm-wiki']);
    });

    it('writeOpenSprinklesToUrl sets the param and preserves other params (tray)', () => {
      window.history.replaceState(null, '', '/?tray=https%3A%2F%2Fexample.com');
      writeOpenSprinklesToUrl(['dash', 'wiki']);
      const params = new URLSearchParams(window.location.search);
      expect(params.get('sprinkles')).toBe('dash,wiki');

      expect(params.get('tray')).toBe('https://example.com');
    });

    it('writeOpenSprinklesToUrl with empty array removes the param entirely', () => {
      window.history.replaceState(null, '', '/?sprinkles=a,b&detached=1');
      writeOpenSprinklesToUrl([]);
      const params = new URLSearchParams(window.location.search);
      expect(params.has('sprinkles')).toBe(false);
      expect(params.get('detached')).toBe('1');
    });

    it('restoreOpenSprinkles reopens URL panels in BACKGROUND (no focus steal) yet persisted', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      window.history.replaceState(null, '', '/?sprinkles=dash');
      await mgr.refresh();
      await mgr.restoreOpenSprinkles();

      const call = addSprinkle.mock.calls.find((c) => c[0] === 'dash');
      expect(call?.[4]).toMatchObject({ background: true });

      await Promise.resolve();
      expect(urlSprinklesParam()).toBe('dash');
    });

    it('restoreOpenSprinkles is safely re-runnable (kernel-ready resync contract)', async () => {
      window.history.replaceState(null, '', '/?sprinkles=dash');

      await mgr.restoreOpenSprinkles();
      expect(mgr.opened()).toEqual([]);

      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      await mgr.refresh();
      await mgr.restoreOpenSprinkles();
      expect(mgr.opened()).toEqual(['dash']);

      const addCalls = addSprinkle.mock.calls.length;
      await mgr.restoreOpenSprinkles();
      expect(mgr.opened()).toEqual(['dash']);
      expect(addSprinkle.mock.calls.length).toBe(addCalls);
    });

    it('readKnownSprinkleNames exposes the discovery ledger for rail seeding', async () => {
      expect(readKnownSprinkleNames()).toEqual([]);
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      window.history.replaceState(null, '', '/');
      await mgr.refresh();

      await mgr.restoreOpenSprinkles();
      expect(readKnownSprinkleNames()).toContain('dash');
    });

    it('pruneKnownSprinkleNames drops ledger entries discovery did not confirm', () => {
      localStorage.setItem(
        'slicc-known-sprinkles',
        JSON.stringify(['dash', 'deleted-long-ago', 'wiki'])
      );
      pruneKnownSprinkleNames(['dash', 'wiki']);
      expect(readKnownSprinkleNames()).toEqual(['dash', 'wiki']);
    });

    it('pruneKnownSprinkleNames empties the ledger when nothing was confirmed', () => {
      localStorage.setItem('slicc-known-sprinkles', JSON.stringify(['ghost']));
      pruneKnownSprinkleNames([]);
      expect(readKnownSprinkleNames()).toEqual([]);
    });

    it('pruneKnownSprinkleNames survives a corrupt ledger', () => {
      localStorage.setItem('slicc-known-sprinkles', '{not json');
      pruneKnownSprinkleNames(['dash']);
      expect(readKnownSprinkleNames()).toEqual([]);
    });

    it('open() writes the sprinkle name to the URL (coalesced microtask flush)', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('dash');

      await Promise.resolve();
      expect(urlSprinklesParam()).toBe('dash');
    });

    it('close() removes the sprinkle from the URL', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      await vfs.writeFile('/shared/sprinkles/wiki/wiki.shtml', '<title>W</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('dash');
      await mgr.open('wiki');
      await Promise.resolve();
      expect(urlSprinklesParam()).toBe('dash,wiki');

      mgr.close('dash');
      await Promise.resolve();
      expect(urlSprinklesParam()).toBe('wiki');

      mgr.close('wiki');
      await Promise.resolve();

      expect(urlSprinklesParam()).toBeNull();
    });

    it('attention-only opens are excluded from the URL', async () => {
      await vfs.writeFile('/shared/sprinkles/quiet/quiet.shtml', '<title>Q</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('quiet', undefined, { attention: true });
      await Promise.resolve();
      expect(urlSprinklesParam()).toBeNull();

      mgr.markActivated('quiet');
      await Promise.resolve();
      expect(urlSprinklesParam()).toBe('quiet');
    });

    it('persistOpenSprinkles preserves the tray param across open/close', async () => {
      window.history.replaceState(null, '', '/?tray=https%3A%2F%2Ftray.example');
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('dash');
      await Promise.resolve();
      const params = new URLSearchParams(window.location.search);
      expect(params.get('sprinkles')).toBe('dash');
      expect(params.get('tray')).toBe('https://tray.example');

      mgr.close('dash');
      await Promise.resolve();
      const after = new URLSearchParams(window.location.search);
      expect(after.has('sprinkles')).toBe(false);
      expect(after.get('tray')).toBe('https://tray.example');
    });

    it('synchronous open+close burst collapses into a single URL write', async () => {
      await vfs.writeFile('/shared/sprinkles/a/a.shtml', '<title>A</title><div>hi</div>');
      await vfs.writeFile('/shared/sprinkles/b/b.shtml', '<title>B</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('a');
      await mgr.open('b');
      await Promise.resolve();

      const replaceSpy = vi.spyOn(window.history, 'replaceState');

      mgr.close('a');
      mgr.close('b');
      await Promise.resolve();

      expect(replaceSpy).toHaveBeenCalledTimes(1);
      expect(urlSprinklesParam()).toBeNull();
      replaceSpy.mockRestore();
    });

    it('restoreOpenSprinkles reads the URL and reopens those panels', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      await vfs.writeFile('/shared/sprinkles/wiki/wiki.shtml', '<title>W</title><div>hi</div>');
      window.history.replaceState(null, '', '/?sprinkles=dash,wiki');

      await mgr.refresh();
      await mgr.restoreOpenSprinkles();

      expect(mgr.opened()).toContain('dash');
      expect(mgr.opened()).toContain('wiki');
    });

    it('restoreOpenSprinkles migrates from legacy localStorage when URL has no param, then clears the key', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');

      window.history.replaceState(null, '', '/');
      localStorage.setItem('slicc-open-sprinkles', JSON.stringify(['dash']));

      await mgr.refresh();
      await mgr.restoreOpenSprinkles();
      await Promise.resolve();

      expect(mgr.opened()).toContain('dash');
      expect(urlSprinklesParam()).toBe('dash');
      expect(localStorage.getItem('slicc-open-sprinkles')).toBeNull();
    });

    it('restoreOpenSprinkles with explicit URL param does NOT surface other unseen sprinkles', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      await vfs.writeFile('/shared/sprinkles/other/other.shtml', '<title>O</title><div>hi</div>');
      window.history.replaceState(null, '', '/?sprinkles=dash');

      expect(localStorage.getItem('slicc-known-sprinkles')).toBeNull();

      await mgr.refresh();
      await mgr.restoreOpenSprinkles();

      expect(mgr.opened()).toEqual(['dash']);
      expect(mgr.opened()).not.toContain('other');
    });

    it('restoreOpenSprinkles prefers URL over legacy localStorage when both exist', async () => {
      await vfs.writeFile('/shared/sprinkles/url-one/url-one.shtml', '<title>U</title><div/>');
      await vfs.writeFile('/shared/sprinkles/legacy/legacy.shtml', '<title>L</title><div/>');
      window.history.replaceState(null, '', '/?sprinkles=url-one');
      localStorage.setItem('slicc-open-sprinkles', JSON.stringify(['legacy']));

      await mgr.refresh();
      await mgr.restoreOpenSprinkles();
      await Promise.resolve();

      expect(urlSprinklesParam()).toBe('url-one');

      expect(localStorage.getItem('slicc-open-sprinkles')).not.toBeNull();
    });
  });

  describe('always-visible rail icons', () => {
    it('refresh registers a rail icon for every discovered sprinkle', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>hi</div>');
      await vfs.writeFile('/shared/sprinkles/wiki/wiki.shtml', '<title>Wiki</title><div>hi</div>');

      await mgr.refresh();

      const names = registerSprinkle.mock.calls.map((c) => c[0]);
      expect(names).toContain('dash');
      expect(names).toContain('wiki');
    });

    it('refresh forwards icon spec to registerSprinkle so the rail glyph resolves on register', async () => {
      await vfs.writeFile(
        '/shared/sprinkles/iconic/iconic.shtml',
        '<title>Iconic</title><link rel="icon" href="music" /><div>hi</div>'
      );
      await mgr.refresh();

      const call = registerSprinkle.mock.calls.find((c) => c[0] === 'iconic');
      expect(call).toBeDefined();
      const opts = call![2] as { icon?: string } | undefined;
      expect(opts?.icon).toBe('music');
    });

    it('refresh does not re-register an already-registered sprinkle', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>hi</div>');
      await mgr.refresh();
      registerSprinkle.mockClear();

      await mgr.refresh();

      expect(registerSprinkle).not.toHaveBeenCalled();
    });

    it('inlineSprinkles names are filtered out of registerSprinkle (and unset lets them through)', async () => {
      await vfs.writeFile('/shared/sprinkles/foo/foo.shtml', '<title>Foo</title><div>hi</div>');
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>hi</div>');

      const inlineMgr = new SprinkleManager(
        vfs,
        lickHandler,
        {
          addSprinkle: addSprinkle as unknown as (
            name: string,
            title: string,
            element: HTMLElement
          ) => void,
          removeSprinkle: removeSprinkle as unknown as (name: string) => void,
          minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
          registerSprinkle: registerSprinkle as unknown as (name: string, title: string) => void,
          unregisterSprinkle: unregisterSprinkle as unknown as (name: string) => void,
        },
        vi.fn(),
        { inlineSprinkles: new Set(['foo']) }
      );

      await inlineMgr.refresh();

      const filteredNames = registerSprinkle.mock.calls.map((c) => c[0]);
      expect(filteredNames).toContain('dash');
      expect(filteredNames).not.toContain('foo');

      registerSprinkle.mockClear();
      const defaultMgr = new SprinkleManager(
        vfs,
        lickHandler,
        {
          addSprinkle: addSprinkle as unknown as (
            name: string,
            title: string,
            element: HTMLElement
          ) => void,
          removeSprinkle: removeSprinkle as unknown as (name: string) => void,
          minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
          registerSprinkle: registerSprinkle as unknown as (name: string, title: string) => void,
          unregisterSprinkle: unregisterSprinkle as unknown as (name: string) => void,
        },
        vi.fn()
      );

      await defaultMgr.refresh();

      const defaultNames = registerSprinkle.mock.calls.map((c) => c[0]);
      expect(defaultNames).toContain('dash');
      expect(defaultNames).toContain('foo');
    });

    it('refresh unregisters sprinkles that disappear from the VFS', async () => {
      await vfs.writeFile('/shared/sprinkles/gone/gone.shtml', '<title>Gone</title><div>hi</div>');
      await mgr.refresh();
      unregisterSprinkle.mockClear();

      await vfs.rm('/shared/sprinkles/gone/gone.shtml');
      await mgr.refresh();

      expect(unregisterSprinkle).toHaveBeenCalledWith('gone');
    });

    it('close routes through closeSprinkleContent so the rail icon stays', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('dash');
      removeSprinkle.mockClear();
      closeSprinkleContent.mockClear();

      mgr.close('dash');

      expect(closeSprinkleContent).toHaveBeenCalledWith('dash');
      expect(removeSprinkle).not.toHaveBeenCalled();
    });

    it('close falls back to removeSprinkle when closeSprinkleContent is unset (legacy callers)', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>hi</div>');
      const legacyMgr = new SprinkleManager(
        vfs,
        lickHandler,
        {
          addSprinkle: addSprinkle as unknown as (
            name: string,
            title: string,
            element: HTMLElement
          ) => void,
          removeSprinkle: removeSprinkle as unknown as (name: string) => void,
          minimizeSprinkle: minimizeSprinkle as unknown as (name: string) => void,
        },
        vi.fn()
      );
      await legacyMgr.refresh();
      await legacyMgr.open('dash');
      removeSprinkle.mockClear();

      legacyMgr.close('dash');

      expect(removeSprinkle).toHaveBeenCalledWith('dash');
    });

    it('activate opens a registered-but-closed sprinkle', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>hi</div>');
      await mgr.refresh();
      expect(mgr.opened()).not.toContain('dash');

      await mgr.activate('dash');

      expect(mgr.opened()).toContain('dash');
    });

    it('activate promotes and places an attention-mode sprinkle without recreating its content', async () => {
      await vfs.writeFile('/shared/sprinkles/q/q.shtml', '<title>Q</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('q', undefined, { attention: true });
      expect(JSON.parse(localStorage.getItem('slicc-open-sprinkles') ?? '[]')).toEqual([]);
      const container = addSprinkle.mock.calls[0]?.[2];
      addSprinkle.mockClear();

      await mgr.activate('q', 'left');

      expect(JSON.parse(localStorage.getItem('slicc-open-sprinkles') ?? '[]')).toEqual(['q']);
      expect(addSprinkle).toHaveBeenCalledExactlyOnceWith('q', 'Q', container, 'left', {
        icon: undefined,
      });
    });

    it('activate re-places an already user-opened sprinkle (reopen after minimize)', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('dash');
      addSprinkle.mockClear();

      await mgr.activate('dash');

      expect(addSprinkle).toHaveBeenCalledTimes(1);
      expect(addSprinkle.mock.calls[0]?.[0]).toBe('dash');
    });
  });

  describe('reload', () => {
    it('re-renders an open sprinkle with fresh VFS content', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>v1</div>');
      await mgr.refresh();
      await mgr.open('dash');
      expect(mgr.opened()).toContain('dash');

      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>v2</div>');
      await mgr.reload('dash');

      expect(mgr.opened()).toContain('dash');
    });

    it('does not re-run addSprinkle on reload (keeps parked/minimized placement)', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>v1</div>');
      await mgr.refresh();
      await mgr.open('dash');
      expect(addSprinkle).toHaveBeenCalledTimes(1);
      addSprinkle.mockClear();

      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>v2</div>');
      await mgr.reload('dash');

      expect(addSprinkle).not.toHaveBeenCalled();
      expect(mgr.opened()).toContain('dash');
    });

    it('no-ops for a sprinkle that is not open', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>v1</div>');
      await mgr.refresh();

      await mgr.reload('dash');
      expect(mgr.opened()).not.toContain('dash');
    });

    it('fires the onSprinkleReloaded hook', async () => {
      const reloadHook = vi.fn();
      mgr.setReloadHook(reloadHook);

      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>v1</div>');
      await mgr.refresh();
      await mgr.open('dash');

      await mgr.reload('dash');
      expect(reloadHook).toHaveBeenCalledWith('dash');
    });

    it('setupWatcher triggers reload for already-open sprinkle on file change', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const watcher = new FsWatcher();
      vfs.setWatcher(watcher);
      mgr.setupWatcher(watcher);

      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>v1</div>');
      await mgr.refresh();
      await mgr.open('dash');

      const reloadHook = vi.fn();
      mgr.setReloadHook(reloadHook);

      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>v2</div>');
      await vi.advanceTimersByTimeAsync(400);

      expect(reloadHook).toHaveBeenCalledWith('dash');
    });
  });
});
