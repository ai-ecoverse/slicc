// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { FsWatcher } from '../../src/fs/fs-watcher.js';
import { SprinkleManager } from '../../src/ui/sprinkle-manager.js';
import type { LickEvent } from '../../src/scoops/lick-manager.js';

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
  let mgr: SprinkleManager;

  beforeEach(async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    vi.stubGlobal('document', makeFakeDocument());
    vfs = await VirtualFS.create({
      dbName: `test-sprinkle-manager-${dbCounter++}`,
      wipe: true,
    });
    lickHandler = vi.fn() as unknown as (event: LickEvent) => void;
    addSprinkle = vi.fn();
    removeSprinkle = vi.fn();
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
});
