import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FsWatcher, RestrictedFS, VirtualFS } from '../../src/fs/index.js';
import { ScriptCatalog } from '../../src/shell/script-catalog.js';
import { createMutableDirectoryHandle } from '../fs/fsa-test-helpers.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { newMountId } from '../../src/fs/mount/mount-id.js';

function backendOf(handle: FileSystemDirectoryHandle): LocalMountBackend {
  return LocalMountBackend.fromHandle(handle, { mountId: newMountId() });
}

class MockScriptFs {
  readonly files = new Map<string, string>();
  readonly walkRoots: string[] = [];
  private mounts: string[] = [];

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, content);
    }
  }

  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  listMounts(): string[] {
    return [...this.mounts];
  }

  setMounts(mounts: string[]): void {
    this.mounts = [...mounts];
  }

  async exists(path: string): Promise<boolean> {
    if (path === '/') return true;
    const prefix = path.endsWith('/') ? path : `${path}/`;
    return [...this.files.keys()].some(
      (filePath) => filePath === path || filePath.startsWith(prefix)
    );
  }

  async *walk(root: string): AsyncGenerator<string> {
    this.walkRoots.push(root);
    const prefix = root === '/' ? '/' : `${root}/`;
    for (const path of [...this.files.keys()].sort()) {
      if (root === '/' ? path.startsWith('/') : path === root || path.startsWith(prefix)) {
        yield path;
      }
    }
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }
}

let dbCounter = 0;

describe('ScriptCatalog', () => {
  let watcher: FsWatcher;

  beforeEach(() => {
    watcher = new FsWatcher();
  });

  it('caches JSH discovery until FsWatcher invalidates it', async () => {
    const fs = new MockScriptFs({
      '/workspace/skills/test/run.jsh': 'console.log("run");',
    });
    const catalog = new ScriptCatalog({ jshFs: fs, watcher });

    expect(await catalog.getJshCommandNames()).toEqual(['run']);
    expect(fs.walkRoots).toEqual(['/workspace/skills', '/']);

    expect(await catalog.getJshCommandNames()).toEqual(['run']);
    expect(fs.walkRoots).toEqual(['/workspace/skills', '/']);

    fs.setFile('/tools/extra.jsh', 'console.log("extra");');
    watcher.notify([{ type: 'create', path: '/tools/extra.jsh', entryType: 'file' }]);

    expect((await catalog.getJshCommands()).get('extra')).toBe('/tools/extra.jsh');
    expect(fs.walkRoots).toEqual(['/workspace/skills', '/', '/workspace/skills', '/']);
  });

  it('falls back to fresh JSH scans when no FsWatcher is available', async () => {
    const fs = new MockScriptFs({
      '/workspace/skills/test/run.jsh': 'console.log("run");',
    });
    const catalog = new ScriptCatalog({ jshFs: fs });

    expect(await catalog.getJshCommandNames()).toEqual(['run']);
    expect(await catalog.getJshCommandNames()).toEqual(['run']);

    expect(fs.walkRoots).toEqual(['/workspace/skills', '/', '/workspace/skills', '/']);
  });

  it('deduplicates concurrent uncached JSH scans', async () => {
    class DelayedMockScriptFs extends MockScriptFs {
      private gate = Promise.withResolvers<void>();
      private delayed = false;

      release(): void {
        this.gate.resolve();
      }

      override async *walk(root: string): AsyncGenerator<string> {
        this.walkRoots.push(root);
        const prefix = root === '/' ? '/' : `${root}/`;
        const snapshot = [...this.files.keys()]
          .sort()
          .filter((path) =>
            root === '/' ? path.startsWith('/') : path === root || path.startsWith(prefix)
          );

        if (!this.delayed) {
          this.delayed = true;
          await this.gate.promise;
        }

        for (const path of snapshot) {
          yield path;
        }
      }
    }

    const fs = new DelayedMockScriptFs({
      '/workspace/skills/test/run.jsh': 'console.log("run");',
    });
    const catalog = new ScriptCatalog({ jshFs: fs });

    const first = catalog.getJshCommands();
    const second = catalog.getJshCommands();
    fs.release();

    expect((await first).get('run')).toBe('/workspace/skills/test/run.jsh');
    expect((await second).get('run')).toBe('/workspace/skills/test/run.jsh');
    expect(fs.walkRoots).toEqual(['/workspace/skills', '/']);
  });

  it('does not let an invalidated in-flight JSH scan repopulate stale cache state', async () => {
    class DelayedMockScriptFs extends MockScriptFs {
      private readonly gate: Promise<void>;
      private readonly releaseGate: () => void;
      private delayed = false;

      constructor(files: Record<string, string>) {
        super(files);
        let release: (() => void) | null = null;
        this.gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        this.releaseGate = release!;
      }

      release(): void {
        this.releaseGate();
      }

      override async *walk(root: string): AsyncGenerator<string> {
        this.walkRoots.push(root);
        const prefix = root === '/' ? '/' : `${root}/`;
        const snapshot = [...this.files.keys()]
          .sort()
          .filter((path) =>
            root === '/' ? path.startsWith('/') : path === root || path.startsWith(prefix)
          );

        if (!this.delayed) {
          this.delayed = true;
          await this.gate;
        }

        for (const path of snapshot) {
          yield path;
        }
      }
    }

    const fs = new DelayedMockScriptFs({
      '/workspace/skills/test/run.jsh': 'console.log("run");',
    });
    const catalog = new ScriptCatalog({ jshFs: fs, watcher });

    const firstScan = catalog.getJshCommands();

    fs.setFile('/tools/extra.jsh', 'console.log("extra");');
    watcher.notify([{ type: 'create', path: '/tools/extra.jsh', entryType: 'file' }]);

    fs.release();
    await firstScan;

    expect((await catalog.getJshCommands()).get('extra')).toBe('/tools/extra.jsh');
    expect(fs.walkRoots).toEqual(['/workspace/skills', '/', '/workspace/skills', '/']);
  });

  it('caches BSH discovery until FsWatcher invalidates it', async () => {
    const fs = new MockScriptFs({
      '/workspace/-.okta.com.bsh': 'console.log("okta");',
    });
    const catalog = new ScriptCatalog({ jshFs: fs, bshFs: fs, watcher });

    expect((await catalog.getBshEntries()).map((entry) => entry.path)).toEqual([
      '/workspace/-.okta.com.bsh',
    ]);
    expect(fs.walkRoots).toEqual(['/workspace']);

    expect((await catalog.getBshEntries()).map((entry) => entry.path)).toEqual([
      '/workspace/-.okta.com.bsh',
    ]);
    expect(fs.walkRoots).toEqual(['/workspace']);

    fs.setFile('/shared/login.example.com.bsh', 'console.log("shared");');
    watcher.notify([{ type: 'create', path: '/shared/login.example.com.bsh', entryType: 'file' }]);

    expect((await catalog.getBshEntries()).map((entry) => entry.path)).toEqual([
      '/workspace/-.okta.com.bsh',
      '/shared/login.example.com.bsh',
    ]);
    expect(fs.walkRoots).toEqual(['/workspace', '/workspace', '/shared']);
  });

  it('bypasses the JSH cache when mounts are present so external mounted changes stay visible', async () => {
    const vfs = await VirtualFS.create({
      dbName: `test-script-catalog-jsh-mount-${dbCounter++}`,
      wipe: true,
    });
    vfs.setWatcher(watcher);

    const mounted = createMutableDirectoryHandle({
      'one.jsh': 'console.log("one");',
    });
    await vfs.mount('/mnt/repo', backendOf(mounted.handle));

    const catalog = new ScriptCatalog({ jshFs: vfs, watcher });
    expect((await catalog.getJshCommands()).get('one')).toBe('/mnt/repo/one.jsh');

    mounted.setFile('two.jsh', 'console.log("two");');
    // External changes require mount refresh to update the index
    await vfs.refreshMount('/mnt/repo');
    expect((await catalog.getJshCommands()).get('two')).toBe('/mnt/repo/two.jsh');
  });

  it('detects underlying mounts when discovery runs through RestrictedFS', async () => {
    const vfs = await VirtualFS.create({
      dbName: `test-script-catalog-restricted-mount-${dbCounter++}`,
      wipe: true,
    });
    vfs.setWatcher(watcher);

    const mounted = createMutableDirectoryHandle({
      'one.jsh': 'console.log("one");',
    });
    await vfs.mount('/workspace/repo', backendOf(mounted.handle));

    const restricted = new RestrictedFS(vfs, ['/workspace']);
    const catalog = new ScriptCatalog({ jshFs: restricted, watcher });
    expect((await catalog.getJshCommands()).get('one')).toBe('/workspace/repo/one.jsh');

    mounted.setFile('two.jsh', 'console.log("two");');
    // External changes require mount refresh to update the index
    await vfs.refreshMount('/workspace/repo');
    expect((await catalog.getJshCommands()).get('two')).toBe('/workspace/repo/two.jsh');
  });

  it('bypasses the BSH cache for mounts under /workspace or /shared', async () => {
    const vfs = await VirtualFS.create({
      dbName: `test-script-catalog-bsh-mount-${dbCounter++}`,
      wipe: true,
    });
    vfs.setWatcher(watcher);

    const mounted = createMutableDirectoryHandle({
      '-.okta.com.bsh': 'console.log("okta");',
    });
    await vfs.mount('/workspace/repo', backendOf(mounted.handle));

    const catalog = new ScriptCatalog({ jshFs: vfs, bshFs: vfs, watcher });
    expect((await catalog.getBshEntries()).map((entry) => entry.path)).toEqual([
      '/workspace/repo/-.okta.com.bsh',
    ]);

    mounted.setFile('login.example.com.bsh', 'console.log("example");');
    // External changes (via mock handle, not VirtualFS) require a mount refresh
    // to update the MountIndex. This simulates running `mount refresh /workspace/repo`.
    await vfs.refreshMount('/workspace/repo');
    expect((await catalog.getBshEntries()).map((entry) => entry.path)).toEqual([
      '/workspace/repo/-.okta.com.bsh',
      '/workspace/repo/login.example.com.bsh',
    ]);
  });

  it('deduplicates concurrent BSH scans when persistent caching is disabled by mounts', async () => {
    class DelayedMockScriptFs extends MockScriptFs {
      private gate = Promise.withResolvers<void>();
      private delayed = false;

      release(): void {
        this.gate.resolve();
      }

      override async *walk(root: string): AsyncGenerator<string> {
        this.walkRoots.push(root);
        const prefix = root === '/' ? '/' : `${root}/`;
        const snapshot = [...this.files.keys()]
          .sort()
          .filter((path) =>
            root === '/' ? path.startsWith('/') : path === root || path.startsWith(prefix)
          );

        if (!this.delayed) {
          this.delayed = true;
          await this.gate.promise;
        }

        for (const path of snapshot) {
          yield path;
        }
      }
    }

    const fs = new DelayedMockScriptFs({
      '/workspace/repo/-.okta.com.bsh': 'console.log("okta");',
    });
    fs.setMounts(['/workspace/repo']);

    const catalog = new ScriptCatalog({ jshFs: fs, bshFs: fs, watcher });
    const first = catalog.getBshEntries();
    const second = catalog.getBshEntries();
    fs.release();

    expect((await first).map((entry) => entry.path)).toEqual(['/workspace/repo/-.okta.com.bsh']);
    expect((await second).map((entry) => entry.path)).toEqual(['/workspace/repo/-.okta.com.bsh']);
    expect(fs.walkRoots).toEqual(['/workspace']);
  });

  it('updates cached script discovery after rename notifications', async () => {
    const vfs = await VirtualFS.create({
      dbName: `test-script-catalog-rename-${dbCounter++}`,
      wipe: true,
    });
    vfs.setWatcher(watcher);

    await vfs.writeFile('/workspace/tool.txt', 'console.log("tool");');
    await vfs.writeFile('/workspace/page.txt', 'console.log("page");');

    const catalog = new ScriptCatalog({ jshFs: vfs, bshFs: vfs, watcher });
    expect(await catalog.getJshCommandNames()).toEqual([]);
    expect(await catalog.getBshEntries()).toEqual([]);

    await vfs.rename('/workspace/tool.txt', '/workspace/tool.jsh');
    await vfs.rename('/workspace/page.txt', '/workspace/login.example.com.bsh');

    expect(await catalog.getJshCommandNames()).toEqual(['tool']);
    expect((await catalog.getBshEntries()).map((entry) => entry.path)).toEqual([
      '/workspace/login.example.com.bsh',
    ]);
  });
});
