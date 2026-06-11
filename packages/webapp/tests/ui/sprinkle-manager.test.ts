// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsWatcher } from '../../src/fs/fs-watcher.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createRemoteSprinkleVfs } from '../../src/kernel/remote-sprinkle-vfs.js';
import type { LickEvent } from '../../src/scoops/lick-manager.js';
import {
  readKnownSprinkleNames,
  readOpenSprinklesFromUrl,
  SprinkleManager,
  writeOpenSprinklesToUrl,
} from '../../src/ui/sprinkle-manager.js';

vi.mock('../../src/ui/sprinkle-renderer.js', () => ({
  SprinkleRenderer: class {
    constructor(_c: unknown, _api: unknown) {}
    async render() {}
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
    vi.stubGlobal('localStorage', makeMemoryStorage());
    vi.stubGlobal('document', makeFakeDocument());
    // Reset the URL to a known state so URL-persistence tests start
    // clean and a leaked `?sprinkles=...` from a previous test can't
    // restore unexpected panels in the next one.
    try {
      window.history.replaceState(null, '', '/');
    } catch {
      /* jsdom may already be in a clean state */
    }
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

  // Regression: under `slicc_opfs_vfs=opfs` the page-side `localFs` is
  // an empty memory VFS — passing it straight to `SprinkleManager`
  // stranded discovery (`fs.walk('/')` yielded nothing) so
  // `sprinkle list` returned zero even when `.shtml` files lived in the
  // OPFS-owned tree. `main.ts` now wraps the worker-RPC clients with
  // `createRemoteSprinkleVfs`; this test pins that wiring shape end-
  // to-end: a manager built over the adapter discovers a sprinkle that
  // only exists in the backing (canonical) VFS, not in any
  // page-side memory shadow.
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
    // The page-side `vfs` in this describe block has no entries — the
    // adapter must NOT be reading from it.
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
    // The hook is what `ui/main.ts:mainStandaloneWorker` wires to
    // `pageLeaderTray.sync.broadcastSprinkleUpdate` so followers receive the
    // agent's push. Without it, `sendToSprinkle` updates only the local
    // renderer and followers see nothing until the next snapshot refresh.
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
    expect(onSendToSprinkle).toHaveBeenCalledWith('dash', { progress: 0.42 });
  });

  it('sendToSprinkle does NOT fire the hook for a closed sprinkle (matches local-render behaviour)', () => {
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

    mgrWithHook.sendToSprinkle('not-open', { foo: 1 });

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

    // Local push must succeed first; hook failure must be swallowed so
    // a broken broadcaster doesn't break local sprinkles.
    expect(() => mgrWithHook.sendToSprinkle('dash', { x: 1 })).not.toThrow();
    expect(onSendToSprinkle).toHaveBeenCalledTimes(1);
  });

  // The standalone-leader boot path (`ui/main.ts:mainStandaloneWorker`)
  // builds `SprinkleManager` unconditionally early, then calls
  // `setSendToSprinkleHook` AFTER `startPageLeaderTray` returns with the
  // `LeaderSyncManager`. The constructor-options path covered above is
  // not exercised by that flow — only the runtime setter is. These tests
  // close that coverage gap so dropping the `setSendToSprinkleHook` call
  // would surface here, not in production with a manual-test bug report.
  it('setSendToSprinkleHook installed after open() fires on the next sendToSprinkle', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
    const onSendToSprinkle = vi.fn();
    await mgr.refresh();
    await mgr.open('dash');
    // Hook installed AFTER open — mirrors the leader boot path where
    // `pageLeaderTray.sync` is constructed lazily inside the
    // `storedWorkerBaseUrl` branch, well after the manager exists.
    mgr.setSendToSprinkleHook(onSendToSprinkle);

    mgr.sendToSprinkle('dash', { progress: 0.5 });

    expect(onSendToSprinkle).toHaveBeenCalledTimes(1);
    expect(onSendToSprinkle).toHaveBeenCalledWith('dash', { progress: 0.5 });
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

    // Still called only once — detach took effect.
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
    expect(setterHook).toHaveBeenCalledWith('dash', { x: 1 });
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

    // Drain the 150ms debounce. The timer callback fires a
    // void-async openNewAutoOpenSprinkles(); awaiting an explicit
    // call here joins (or no-ops via cooldown if already done) so
    // we get a deterministic flush without wall-clock waits.
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

    // Pre-existing auto-open sprinkle that the user has already
    // dismissed (never present in openSprinkles after close).
    await vfs.writeFile(
      '/shared/sprinkles/dash/dash.shtml',
      '<title>Dash</title><div data-sprinkle-autoopen>hi</div>'
    );
    await mgr.refresh();
    expect(mgr.available().find((s) => s.name === 'dash')?.autoOpen).toBe(true);
    addSprinkle.mockClear();

    // Unrelated .shtml lands in the VFS — must NOT pop dash open.
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
    // Seed a previously-known sprinkle that is no longer present
    // (e.g. mounted folder unavailable this session).
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

    // Second sprinkle appears, then two refreshes fire (e.g.
    // watcher event + post-install hook). The cooldown should
    // collapse them into a single surfacing pass.
    await vfs.writeFile('/shared/sprinkles/b/b.shtml', '<title>B</title><div>hi</div>');
    await Promise.all([mgr.openNewAutoOpenSprinkles(), mgr.openNewAutoOpenSprinkles()]);

    const surfaced = addSprinkle.mock.calls.filter((c) => c[0] === 'b');
    expect(surfaced.length).toBe(1);
  });

  it('open throws descriptive error when file content is undefined', async () => {
    await vfs.writeFile('/shared/sprinkles/broken/broken.shtml', '<title>Broken</title><div/>');
    await mgr.refresh();

    // Mock readFile to return undefined (simulating VFS corruption)
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
      await mgr.refresh(); // seed
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
      await mgr.refresh(); // seed
      await Promise.resolve();
      const calls: number[] = [];
      mgr.onChange(() => calls.push(Date.now()));
      // attention: true so markActivated has work to do (promotes the
      // attention-mode entry into the persisted open set + notifies).
      await mgr.open('dash', undefined, { attention: true });
      await Promise.resolve();
      expect(calls.length).toBe(1);
      calls.length = 0;
      mgr.markActivated('dash');
      await Promise.resolve();
      expect(calls.length).toBe(1);
    });
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

      // User closes the intro panel. close() persists the now-empty
      // open set, so the next restore will hit the no-localStorage-entry
      // branch again (well, an empty-array branch — verify both shapes).
      mgr.close('intro');
      localStorage.removeItem('slicc-open-sprinkles');

      // Fresh manager simulating a reload: same VFS, same localStorage,
      // ledger should keep the auto-open from firing again.
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
      // Pre-seed the consumption ledger as if a prior session had
      // already auto-opened it; leave known-sprinkles empty to force
      // the unseen branch.
      localStorage.setItem('slicc-autoopened-once', JSON.stringify(['hello']));
      await vfs.writeFile(
        '/shared/sprinkles/hello/hello.shtml',
        '<title>Hello</title><div data-sprinkle-autoopen>hi</div>'
      );
      // Also put an empty open-sprinkles entry so restoreOpenSprinkles
      // takes the localStorage-present branch and only surfaceUnseenSprinkles
      // is exercised for hello.
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
      // Seed an existing sprinkle so the known-sprinkles ledger is
      // non-empty and the new one is genuinely "isNew".
      await vfs.writeFile('/shared/sprinkles/seed/seed.shtml', '<title>Seed</title><div>hi</div>');
      await mgr.refresh();
      await mgr.restoreOpenSprinkles();
      addSprinkle.mockClear();

      // New autoopen sprinkle lands — should auto-open and consume.
      await vfs.writeFile(
        '/shared/sprinkles/onboard/onboard.shtml',
        '<title>Onboard</title><div data-sprinkle-autoopen>hi</div>'
      );
      await mgr.openNewAutoOpenSprinkles();
      expect(mgr.opened()).toContain('onboard');
      const ledger = JSON.parse(localStorage.getItem('slicc-autoopened-once') ?? '[]');
      expect(ledger).toContain('onboard');

      // Simulate user closing it, then a fresh install burst (e.g.
      // uninstall + reinstall via upskill) — the sprinkle is no
      // longer in availableSprinkles, then reappears as "new".
      mgr.close('onboard');
      await vfs.rm('/shared/sprinkles/onboard/onboard.shtml');
      // Force the cooldown to elapse so the next call doesn't no-op.
      await new Promise((r) => setTimeout(r, 260));
      await mgr.openNewAutoOpenSprinkles();
      addSprinkle.mockClear();

      await vfs.writeFile(
        '/shared/sprinkles/onboard/onboard.shtml',
        '<title>Onboard</title><div data-sprinkle-autoopen>hi</div>'
      );
      await new Promise((r) => setTimeout(r, 260));
      await mgr.openNewAutoOpenSprinkles();

      // Ledger keeps it from re-auto-opening.
      expect(mgr.opened()).not.toContain('onboard');
    });
  });

  it('open forwards the declared icon spec to the addSprinkle callback', async () => {
    // Custom icon contract: a sprinkle declaring <link rel="icon">
    // must surface the raw spec in the addSprinkle options so the
    // layout can resolve it (Lucide / VFS path / inline SVG / data URL)
    // and swap the rail glyph. Regression guard: if the manager stops
    // forwarding `icon`, every per-sprinkle rail glyph reverts to the
    // generic Sparkles default and the breakage is silent.
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
      // tray param must be preserved exactly (decoded URLSearchParams view)
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

      // The layout receives background:true — restoring must not activate
      // the panel (what's focused after a reload is the ws param's call).
      const call = addSprinkle.mock.calls.find((c) => c[0] === 'dash');
      expect(call?.[4]).toMatchObject({ background: true });
      // Unlike attention, a background restore still counts as user-opened:
      // the name stays in the URL for the NEXT reload.
      await Promise.resolve();
      expect(urlSprinklesParam()).toBe('dash');
    });

    it('readKnownSprinkleNames exposes the discovery ledger for rail seeding', async () => {
      expect(readKnownSprinkleNames()).toEqual([]);
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      window.history.replaceState(null, '', '/');
      await mgr.refresh();
      // The plain-URL restore runs surfaceUnseenSprinkles, which persists
      // the known-sprinkles ledger the rail seeds from.
      await mgr.restoreOpenSprinkles();
      expect(readKnownSprinkleNames()).toContain('dash');
    });

    it('open() writes the sprinkle name to the URL (coalesced microtask flush)', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('dash');
      // URL write is queued onto a microtask — drain it.
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
      // Empty open set → param removed entirely.
      expect(urlSprinklesParam()).toBeNull();
    });

    it('attention-only opens are excluded from the URL', async () => {
      await vfs.writeFile('/shared/sprinkles/quiet/quiet.shtml', '<title>Q</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('quiet', undefined, { attention: true });
      await Promise.resolve();
      expect(urlSprinklesParam()).toBeNull();

      // Promotion to user-opened should land in the URL.
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
      // The coalescer collapses persist calls scheduled within the
      // same microtask (e.g. close-then-open during a tab swap, or
      // close-many during a "close all" action). Two awaited
      // open()s are separated by file-read microtask boundaries and
      // each flushes its own URL write — that's expected.
      await vfs.writeFile('/shared/sprinkles/a/a.shtml', '<title>A</title><div>hi</div>');
      await vfs.writeFile('/shared/sprinkles/b/b.shtml', '<title>B</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('a');
      await mgr.open('b');
      await Promise.resolve();

      const replaceSpy = vi.spyOn(window.history, 'replaceState');
      // Two synchronous mutations in the same tick — both schedule
      // microtask URL writes, the second is deduped by `urlWriteScheduled`.
      mgr.close('a');
      mgr.close('b');
      await Promise.resolve();

      // Exactly one replaceState reflecting the final empty set.
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
      // No URL param, but the legacy key carries a prior session's set.
      window.history.replaceState(null, '', '/');
      localStorage.setItem('slicc-open-sprinkles', JSON.stringify(['dash']));

      await mgr.refresh();
      await mgr.restoreOpenSprinkles();
      await Promise.resolve();

      // Sprinkle reopened, URL now carries the migrated set, legacy
      // key cleared so a future reload takes the URL branch.
      expect(mgr.opened()).toContain('dash');
      expect(urlSprinklesParam()).toBe('dash');
      expect(localStorage.getItem('slicc-open-sprinkles')).toBeNull();
    });

    it('restoreOpenSprinkles with explicit URL param does NOT surface other unseen sprinkles', async () => {
      // Regression guard for the Codex P2 review on PR #773: when the
      // URL carries `?sprinkles=dash`, the function used to fall
      // through to `surfaceUnseenSprinkles()` after the URL-controlled
      // restore. On a fresh profile (empty `slicc-known-sprinkles`),
      // that surfaced every OTHER discoverable sprinkle in attention
      // mode — so opening a shared link `?sprinkles=dash` quietly
      // popped icons for everything else the user had never seen.
      // The URL must restore exactly the panels it names.
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>D</title><div>hi</div>');
      await vfs.writeFile('/shared/sprinkles/other/other.shtml', '<title>O</title><div>hi</div>');
      window.history.replaceState(null, '', '/?sprinkles=dash');
      // Fresh profile: known-sprinkles ledger is empty.
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

      // The URL drives restore; the legacy entry is NOT user-opened
      // (it may still surface in attention mode via the unseen-
      // sprinkles pass, but only `url-one` lands in the persisted
      // open set that defines what reloads come back).
      expect(urlSprinklesParam()).toBe('url-one');
      // Legacy key is preserved on the URL-wins branch — it'll be
      // overwritten by the next user-driven open via the safety-net
      // localStorage write in `persistOpenSprinkles`.
      expect(localStorage.getItem('slicc-open-sprinkles')).not.toBeNull();
    });
  });

  // ── Always-visible rail icons ──────────────────────────────────────
  //
  // Every discovered sprinkle gets a rail icon at boot independent of
  // open state. The icon acts as a launcher when the sprinkle is
  // closed and indicates the active item when open. Closing only
  // clears content via `closeSprinkleContent`; the icon stays.
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
      // `welcome` would also work in principle, but it's already
      // removed upstream by HIDDEN_SPRINKLES in sprinkle-discovery.ts,
      // so the assertion would pass even if `inlineSprinkles` were
      // ignored. Use a non-hidden name to actually exercise the
      // `inlineSprinkles` filter in `syncRegisteredIcons`.
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

      // Control: without `inlineSprinkles`, the same `foo` IS
      // registered. Proves the absence above is caused by the
      // option, not by upstream discovery filtering.
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

    it('activate promotes an attention-mode sprinkle to user-opened', async () => {
      await vfs.writeFile('/shared/sprinkles/q/q.shtml', '<title>Q</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('q', undefined, { attention: true });
      expect(JSON.parse(localStorage.getItem('slicc-open-sprinkles') ?? '[]')).toEqual([]);

      await mgr.activate('q');

      expect(JSON.parse(localStorage.getItem('slicc-open-sprinkles') ?? '[]')).toEqual(['q']);
    });

    it('activate is a no-op when the sprinkle is already user-opened', async () => {
      await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>hi</div>');
      await mgr.refresh();
      await mgr.open('dash');
      addSprinkle.mockClear();

      await mgr.activate('dash');

      expect(addSprinkle).not.toHaveBeenCalled();
    });
  });
});
