import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { FsWatcher } from '../../src/fs/fs-watcher.js';
import { SprinkleManager } from '../../src/ui/sprinkle-manager.js';
import type { LickEvent } from '../../src/scoops/lick-manager.js';

describe('SprinkleManager', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;
  let lickHandler: (event: LickEvent) => void;
  let addSprinkle: ReturnType<typeof vi.fn>;
  let removeSprinkle: ReturnType<typeof vi.fn>;
  let mgr: SprinkleManager;

  beforeEach(async () => {
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
    const watcher = new FsWatcher();
    vfs.setWatcher(watcher);
    mgr.setupWatcher(watcher);
    await mgr.refresh();
    expect(mgr.available()).toEqual([]);

    await vfs.writeFile(
      '/workspace/skills/migrate/migrate-page.shtml',
      '<title>Migrate Page</title><div/>'
    );

    // Wait past the debounce window plus the async refresh chain.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    const names = mgr.available().map((s) => s.name);
    expect(names).toContain('migrate-page');
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
